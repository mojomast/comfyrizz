// IP17: crash-consistent persistence for the production coordinator.
//
// Layout (full spec section 6.5):
//
//   runtime/productions/<productionId>/
//     state.json       canonical snapshot + committed command records
//     events.jsonl     append-only journal
//     outbox/          one file per pending side effect, plus durable .ack files
//
// The in-tree summary calls the snapshot `snapshot.json`; the full specification
// (sections 6.5/6.6, which this module is reviewed against) names it
// `state.json`. IP17 follows the full specification.
//
// One commit point: the atomic rename of `state.json`. Everything before that
// rename is staging and may be discarded. In particular:
//
//   * journal lines are visible only when their event id is named by a
//     committed command in `state.json`;
//   * an outbox entry is pending only when a committed command names it;
//   * acknowledgement files are durable, so recovery does not republish an
//     entry whose publish already happened.
//
// Idempotency is per command. A commit record carries commandId,
// idempotencyKey, its events, and its outbox manifest. Replaying the command
// returns the committed record; it never appends a second copy of its events.
//
// Crash order inside commit:
//   1. trim uncommitted journal staging
//   2. write outbox entry files (part of the transaction, before the commit point)
//   3. append event lines
//   4. atomically rename the new state.json (the commit point)
//   5. return; publication is drainOutbox(), separately retryable
//
// Because the outbox files and event lines land before the commit point, a
// crash before the rename leaves no authority behind. Because the commit
// record carries the outbox manifest, a crash after the rename can
// rematerialise any outbox file that was lost. Because publish happens after
// the commit and acks are durable, publication is at least once.

import * as nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { validateEvent, validateProduction } from './contract.mjs';

export const PRODUCTION_STORE_SCHEMA = 'comfyrizz.production-store/v1';

// Production ids become directory names and outbox ids become file names.
// Keep them boring: no separators, no traversal, no leading dot.
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
// Command, idempotency and event ids never become file names; follow the
// contract's identifier shape (no whitespace, path separators or controls).
const GENERAL_ID_RE = /^[^\s/\\\u0000-\u001f]{1,256}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class ProductionStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProductionStoreError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new ProductionStoreError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function insideOrEqual(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function apiFrom(options) {
  const supplied = isPlainObject(options.fs) ? options.fs : {};
  const get = (name, fallback) => (typeof supplied[name] === 'function' ? supplied[name].bind(supplied) : fallback);
  return {
    existsSync: get('existsSync', (target) => nodeFs.existsSync(target)),
    readFileSync: get('readFileSync', (...args) => nodeFs.readFileSync(...args)),
    writeFileSync: get('writeFileSync', (...args) => nodeFs.writeFileSync(...args)),
    appendFileSync: get('appendFileSync', (...args) => nodeFs.appendFileSync(...args)),
    mkdirSync: get('mkdirSync', (...args) => nodeFs.mkdirSync(...args)),
    renameSync: get('renameSync', (...args) => nodeFs.renameSync(...args)),
    chmodSync: get('chmodSync', (...args) => nodeFs.chmodSync(...args)),
    unlinkSync: get('unlinkSync', (...args) => nodeFs.unlinkSync(...args)),
    readdirSync: get('readdirSync', (...args) => nodeFs.readdirSync(...args)),
    statSync: get('statSync', (...args) => nodeFs.statSync(...args)),
    realpathSync: get('realpathSync', (target) => resolve(target)),
    // Kept so tests can inject the same surface as the other stores.
    rmSync: get('rmSync', (...args) => nodeFs.rmSync(...args)),
  };
}

/**
 * Validate a production id and return its canonical paths. The returned
 * directory is always exactly `productionsRoot/<id>`; callers still pass
 * every file through assertContained before touching disk.
 */
export function productionPaths(runtimeDir, productionId) {
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
    fail('INVALID_RUNTIME_DIR', 'runtimeDir must be a non-empty path string');
  }
  if (typeof productionId !== 'string' || !SAFE_ID_RE.test(productionId)) {
    fail('INVALID_PRODUCTION_ID', 'productionId must be a simple identifier', { productionId });
  }
  const root = resolve(runtimeDir);
  const dir = join(root, 'productions', productionId);
  return {
    root,
    productionsRoot: join(root, 'productions'),
    dir,
    state: join(dir, 'state.json'),
    events: join(dir, 'events.jsonl'),
    outbox: join(dir, 'outbox'),
  };
}

/** Resolve a path and prove it stays inside `root` (including symlinks). */
export function assertContained(root, target) {
  const rootPath = resolve(root);
  const resolved = resolve(target);
  if (!insideOrEqual(rootPath, resolved)) {
    throw new ProductionStoreError('PATH_ESCAPE', 'production path escapes the productions directory', { path: resolved });
  }

  // Symlink check. When the root does not exist yet (first write), compare
  // against the nearest existing ancestor of both paths so `/tmp/x/productions`
  // is still recognised as containing `/tmp/x/productions/prod_1`.
  const nearestExisting = (value) => {
    let probe = value;
    while (!nodeFs.existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    return nodeFs.existsSync(probe) ? resolve(nodeFs.realpathSync(probe)) : null;
  };
  const rootReal = nearestExisting(rootPath);
  const probeReal = nearestExisting(resolved);
  if (rootReal && probeReal && !insideOrEqual(rootReal, probeReal)) {
    throw new ProductionStoreError('PATH_ESCAPE', 'production path escapes the productions directory', { path: resolved });
  }
  return resolved;
}

function clockIso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_CLOCK', 'clock must return a valid date');
  return date.toISOString();
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    fail('INVALID_ID', `${label} must be a simple identifier`, { value });
  }
  return value;
}

function assertGeneralId(value, label) {
  if (typeof value !== 'string' || !GENERAL_ID_RE.test(value)) {
    fail('INVALID_ID', `${label} must be a non-empty identifier without whitespace or path separators`, { value });
  }
  return value;
}

function generatedEventId(commandId, index, type) {
  const digest = createHash('sha256')
    .update(`${commandId}\u0000${index}\u0000${type}`)
    .digest('hex')
    .slice(0, 24);
  return `evt_${digest}`;
}

function pendingPath(paths, id) {
  return assertContained(paths.dir, join(paths.outbox, `${assertSafeId(id, 'outbox id')}.json`));
}

function ackPath(paths, id) {
  return assertContained(paths.dir, join(paths.outbox, `${assertSafeId(id, 'outbox id')}.ack`));
}

/**
 * Create the production store. Operations are synchronous except
 * drainOutbox(), which awaits an async publisher when it returns a thenable.
 */
export function createProductionStore(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'createProductionStore options must be an object');
  const runtimeDir = options.runtimeDir ?? options.rootDir;
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
    fail('INVALID_RUNTIME_DIR', 'runtimeDir must be a non-empty path string');
  }

  const api = apiFrom(options);
  const clock = options.clock;
  const resolvedRuntime = resolve(runtimeDir);
  const productionsRoot = join(resolvedRuntime, 'productions');
  let tempSequence = 0;

  function pathsFor(productionId) {
    const paths = productionPaths(resolvedRuntime, productionId);
    for (const target of [paths.dir, paths.state, paths.events, paths.outbox]) {
      assertContained(productionsRoot, target);
    }
    return paths;
  }

  function writeAtomic(target, bytes) {
    assertContained(productionsRoot, target);
    api.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    tempSequence += 1;
    const temp = `${target}.${process.pid}.${tempSequence}.tmp`;
    assertContained(productionsRoot, temp);
    try {
      api.writeFileSync(temp, bytes, { mode: 0o600 });
      api.chmodSync(temp, 0o600);
      api.renameSync(temp, target);
      api.chmodSync(target, 0o600);
    } catch (error) {
      try { api.unlinkSync(temp); } catch { void error; }
      throw error;
    }
  }

  function readStateAt(paths) {
    let raw;
    try {
      raw = api.readFileSync(paths.state, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      fail('CORRUPT_STATE', 'state.json is not valid JSON', { productionId: basename(paths.dir) });
    }
    if (!isPlainObject(state) || state.schema !== PRODUCTION_STORE_SCHEMA || !isPlainObject(state.production)) {
      fail('CORRUPT_STATE', 'state.json is not a production store record', { productionId: basename(paths.dir) });
    }
    if (!isPlainObject(state.commits)) state.commits = {};
    if (!isPlainObject(state.commit)) state.commit = null;
    return state;
  }

  function writeStateAt(paths, state) {
    writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`);
  }

  function readJournalAt(paths) {
    let raw;
    try {
      raw = api.readFileSync(paths.events, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { raw: '', entries: [], malformed: false };
      throw error;
    }
    const lines = raw.split('\n');
    const entries = [];
    let malformed = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === '' && index === lines.length - 1) continue;
      if (line.trim() === '') {
        malformed = true;
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        malformed = true;
        continue;
      }
      if (!isPlainObject(entry)
        || typeof entry.id !== 'string'
        || !Number.isSafeInteger(entry.sequence)
        || entry.sequence < 1) {
        malformed = true;
        continue;
      }
      entries.push(entry);
    }
    return { raw, entries, malformed };
  }

  function committedEventIds(state) {
    const ids = new Set();
    for (const commit of Object.values(state.commits)) {
      if (!isPlainObject(commit) || !Array.isArray(commit.eventIds)) continue;
      for (const id of commit.eventIds) if (typeof id === 'string') ids.add(id);
    }
    return ids;
  }

  function committedOutboxManifest(state) {
    const manifest = new Map();
    const commits = Object.values(state.commits)
      .filter((commit) => isPlainObject(commit))
      .sort((left, right) => (left.revision ?? 0) - (right.revision ?? 0));
    for (const commit of commits) {
      if (!Array.isArray(commit.outbox)) continue;
      for (const entry of commit.outbox) {
        if (!isPlainObject(entry) || typeof entry.id !== 'string') continue;
        manifest.set(entry.id, clone(entry));
      }
    }
    return manifest;
  }

  /**
   * Drop journal lines that are not named by a committed command. This is the
   * only journal rewrite: it removes uncommitted staging and torn tails. Every
   * surviving line is byte-identical apart from being normalised to one line
   * of JSON, so committed data is preserved exactly.
   */
  function trimJournalAt(state, paths) {
    const { raw, entries, malformed } = readJournalAt(paths);
    const ids = committedEventIds(state);
    const lastSequence = state.production.lastSequence;
    const seen = new Set();
    const kept = [];
    for (const entry of entries) {
      if (!ids.has(entry.id)) continue;
      if (entry.sequence > lastSequence) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      kept.push(entry);
    }
    kept.sort((left, right) => left.sequence - right.sequence);
    const canonical = kept.length === 0 ? '' : `${kept.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    if (malformed || canonical !== raw) {
      writeAtomic(paths.events, canonical);
    }
    return kept;
  }

  function appendJournalAt(paths, events) {
    if (events.length === 0) return;
    api.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const bytes = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
    api.appendFileSync(paths.events, bytes, { mode: 0o600 });
  }

  function normalizeOutboxEntry(raw, index, now) {
    if (!isPlainObject(raw)) fail('INVALID_OUTBOX', `outbox entry ${index} must be an object`);
    const id = assertSafeId(raw.id, 'outbox id');
    if (typeof raw.type !== 'string' || raw.type.trim() === '') {
      fail('INVALID_OUTBOX', `outbox entry ${id} requires a non-empty type`);
    }
    const payload = raw.payload === undefined ? {} : raw.payload;
    if (!isPlainObject(payload)) fail('INVALID_OUTBOX', `outbox entry ${id} payload must be an object`);
    const at = raw.at ?? now;
    if (typeof at !== 'string' || !ISO_RE.test(at) || !Number.isFinite(Date.parse(at))) {
      fail('INVALID_OUTBOX', `outbox entry ${id} at must be an ISO-8601 timestamp`);
    }
    const attempts = raw.attempts ?? 0;
    if (!Number.isSafeInteger(attempts) || attempts < 0) {
      fail('INVALID_OUTBOX', `outbox entry ${id} attempts must be a non-negative integer`);
    }
    return clone({ id, type: raw.type, payload, at, attempts });
  }

  function writeOutboxEntry(paths, entry) {
    api.mkdirSync(paths.outbox, { recursive: true, mode: 0o700 });
    const target = pendingPath(paths, entry.id);
    const temp = `${target}.${process.pid}.${++tempSequence}.tmp`;
    assertContained(paths.dir, temp);
    try {
      api.writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
      api.chmodSync(temp, 0o600);
      api.renameSync(temp, target);
      api.chmodSync(target, 0o600);
    } catch (error) {
      try { api.unlinkSync(temp); } catch { void error; }
      throw error;
    }
  }

  function readPendingEntry(paths, id) {
    try {
      const parsed = JSON.parse(api.readFileSync(pendingPath(paths, id), 'utf8'));
      return isPlainObject(parsed) ? parsed : null;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return null;
    }
  }

  function cleanupOutboxAt(paths, manifest) {
    // Orphan pending files appear when a crash happens after the outbox write
    // but before the state rename; they must never be published.
    let names = [];
    try {
      names = api.readdirSync(paths.outbox, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const dirent of names) {
      const name = typeof dirent === 'string' ? dirent : dirent.name;
      if (!name) continue;
      const target = assertContained(paths.dir, join(paths.outbox, name));
      if (name.includes('.tmp')) {
        try { api.unlinkSync(target); } catch { /* best effort */ }
        continue;
      }
      if (name.endsWith('.json')) {
        const id = name.slice(0, -'.json'.length);
        if (!manifest.has(id)) {
          try { api.unlinkSync(target); } catch { /* best effort */ }
        }
        continue;
      }
      if (name.endsWith('.ack')) {
        const id = name.slice(0, -'.ack'.length);
        if (!manifest.has(id)) {
          try { api.unlinkSync(target); } catch { /* best effort */ }
        }
      }
    }
  }

  function materializeOutboxAt(paths, manifest) {
    let materialized = 0;
    for (const [id, entry] of manifest) {
      const ack = ackPath(paths, id);
      const pending = pendingPath(paths, id);
      if (api.existsSync(ack)) {
        try { api.unlinkSync(pending); } catch { /* already gone */ }
        continue;
      }
      if (api.existsSync(pending)) continue;
      writeOutboxEntry(paths, normalizeOutboxEntry(entry, 0, entry.at ?? clockIso(clock)));
      materialized += 1;
    }
    return materialized;
  }

  function findDuplicateCommit(state, commandId, idempotencyKey) {
    if (idempotencyKey && isPlainObject(state.commits[idempotencyKey])) return state.commits[idempotencyKey];
    for (const commit of Object.values(state.commits)) {
      if (isPlainObject(commit) && commit.commandId === commandId) return commit;
    }
    return null;
  }

  function eventsForCommit(state, paths, commit) {
    const ids = new Set(Array.isArray(commit.eventIds) ? commit.eventIds : []);
    const { entries } = readJournalAt(paths);
    const byId = new Map();
    for (const entry of entries) {
      if (ids.has(entry.id) && !byId.has(entry.id)) byId.set(entry.id, entry);
    }
    return [...byId.values()].sort((left, right) => left.sequence - right.sequence).map(clone);
  }

  function create(production) {
    const validation = validateProduction(production);
    if (!validation.ok) fail('INVALID_PRODUCTION', 'production is invalid', { errors: validation.errors });
    if (production.revision !== 0) {
      fail('INVALID_REVISION', 'a new production must start at revision 0', { revision: production.revision });
    }
    if (production.lastSequence !== 0) {
      fail('INVALID_SEQUENCE', 'a new production must start at sequence 0', { lastSequence: production.lastSequence });
    }
    const paths = pathsFor(production.id);
    if (readStateAt(paths)) fail('ALREADY_EXISTS', 'production already exists', { productionId: production.id });

    const state = {
      schema: PRODUCTION_STORE_SCHEMA,
      production: clone(production),
      commits: {},
      commit: null,
    };
    writeStateAt(paths, state);
    return clone(state.production);
  }

  function read(productionId) {
    const paths = pathsFor(productionId);
    const state = readStateAt(paths);
    return state ? clone(state.production) : null;
  }

  function list() {
    let entries;
    try {
      entries = api.readdirSync(productionsRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const productions = [];
    for (const dirent of entries) {
      const name = typeof dirent === 'string' ? dirent : dirent.name;
      if (!name || name.startsWith('.')) continue;
      if (typeof dirent !== 'string' && typeof dirent.isDirectory === 'function' && !dirent.isDirectory()) continue;
      if (!SAFE_ID_RE.test(name)) continue;
      let state;
      try {
        state = readStateAt(pathsFor(name));
      } catch {
        continue;
      }
      if (state) productions.push(clone(state.production));
    }
    productions.sort((left, right) => left.id.localeCompare(right.id));
    return productions;
  }

  /**
   * The committed command record for this command id or idempotency key, or
   * null when the command has not committed. This is a read-only lookup so the
   * command handler can compare request hashes before any approval gate.
   */
  function findCommit(productionId, input = {}) {
    const paths = pathsFor(productionId);
    const state = readStateAt(paths);
    if (!state) return null;
    if (!isPlainObject(input)) fail('INVALID_COMMIT', 'findCommit input must be an object');
    const commandId = input.commandId === undefined ? undefined : assertGeneralId(input.commandId, 'commandId');
    const idempotencyKey = input.idempotencyKey === undefined ? undefined : assertGeneralId(input.idempotencyKey, 'idempotencyKey');
    const commit = findDuplicateCommit(state, commandId, idempotencyKey);
    return commit ? clone(commit) : null;
  }

  /**
   * Commit one command atomically. `production` is the next full production
   * document (revision and lastSequence are assigned by the store). `events`
   * are event inputs; `outbox` entries become committed, pending side effects.
   */
  function commit(productionId, input = {}) {
    const paths = pathsFor(productionId);
    const state = readStateAt(paths);
    if (!state) fail('NOT_FOUND', 'production does not exist', { productionId });
    if (!isPlainObject(input)) fail('INVALID_COMMIT', 'commit input must be an object');

    const commandId = assertGeneralId(input.commandId, 'commandId');
    const idempotencyKey = input.idempotencyKey === undefined
      ? commandId
      : assertGeneralId(input.idempotencyKey, 'idempotencyKey');

    const requestHash = input.requestHash === undefined
      ? undefined
      : assertGeneralId(input.requestHash, 'requestHash');

    const prior = findDuplicateCommit(state, commandId, idempotencyKey);
    if (prior) {
      // Spec 7.1: the same command id (or key) with a different canonical
      // payload is a conflict, never a silent first-write-wins replay. Records
      // written before request hashes existed keep their old duplicate shape.
      if (prior.requestHash !== undefined && requestHash !== undefined && prior.requestHash !== requestHash) {
        fail('IDEMPOTENCY_CONFLICT', 'command id or idempotency key was reused with a different request', {
          commandId,
          idempotencyKey,
        });
      }
      // The commit record, not the journal, is the proof. A duplicate returns
      // every event and outbox id the command committed, exactly once.
      return {
        duplicate: true,
        committed: true,
        revision: state.production.revision,
        lastSequence: state.production.lastSequence,
        production: clone(state.production),
        commit: clone(prior),
        events: eventsForCommit(state, paths, prior),
        outboxIds: Array.isArray(prior.outbox) ? prior.outbox.map((entry) => entry.id) : [],
      };
    }

    if (input.baseRevision !== undefined) {
      if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
        fail('INVALID_REVISION', 'baseRevision must be a non-negative integer');
      }
      if (input.baseRevision !== state.production.revision) {
        fail('REVISION_CONFLICT', 'baseRevision does not match the committed revision', {
          currentRevision: state.production.revision,
          baseRevision: input.baseRevision,
        });
      }
    }

    // Staging is not authority: drop it before assigning new sequence numbers.
    const kept = trimJournalAt(state, paths);
    const journalMax = kept.reduce((max, event) => Math.max(max, event.sequence), 0);
    const commitMax = Object.values(state.commits)
      .reduce((max, record) => Math.max(max, isPlainObject(record) ? record.lastSequence ?? 0 : 0), 0);
    let nextSequence = Math.max(state.production.lastSequence, journalMax, commitMax) + 1;

    const now = clockIso(clock);
    const rawEvents = input.events === undefined ? [] : input.events;
    if (!Array.isArray(rawEvents)) fail('INVALID_EVENT', 'events must be an array');
    const events = rawEvents.map((raw, index) => {
      if (!isPlainObject(raw)) fail('INVALID_EVENT', `event ${index} must be an object`);
      const type = raw.type;
      const event = {
        id: raw.id === undefined
          ? generatedEventId(commandId, index, type)
          : assertGeneralId(raw.id, `event ${index} id`),
        productionId,
        sequence: nextSequence,
        type,
        at: raw.at ?? now,
        data: raw.data === undefined ? {} : raw.data,
      };
      if (raw.commandId !== undefined) event.commandId = raw.commandId;
      else event.commandId = commandId;
      if (raw.userEventId !== undefined) event.userEventId = raw.userEventId;
      const validation = validateEvent(event);
      if (!validation.ok) fail('INVALID_EVENT', `event ${index} is invalid`, { errors: validation.errors });
      nextSequence += 1;
      return event;
    });

    const eventIds = new Set();
    for (const event of events) {
      if (eventIds.has(event.id)) fail('DUPLICATE_EVENT', `event id ${event.id} is duplicated in this command`);
      eventIds.add(event.id);
    }
    const alreadyCommitted = committedEventIds(state);
    for (const event of events) {
      if (alreadyCommitted.has(event.id)) fail('DUPLICATE_EVENT', `event id ${event.id} is already committed`);
    }

    const rawOutbox = input.outbox === undefined ? [] : input.outbox;
    if (!Array.isArray(rawOutbox)) fail('INVALID_OUTBOX', 'outbox must be an array');
    const existingOutbox = committedOutboxManifest(state);
    const outboxIds = new Set();
    const outbox = rawOutbox.map((raw, index) => {
      const entry = normalizeOutboxEntry(raw, index, now);
      if (outboxIds.has(entry.id)) fail('DUPLICATE_OUTBOX', `outbox id ${entry.id} is duplicated in this command`);
      if (existingOutbox.has(entry.id)) fail('DUPLICATE_OUTBOX', `outbox id ${entry.id} is already committed`);
      outboxIds.add(entry.id);
      return entry;
    });

    let production;
    if (input.production === undefined) {
      production = clone(state.production);
    } else {
      const validation = validateProduction(input.production);
      if (!validation.ok) fail('INVALID_PRODUCTION', 'production is invalid', { errors: validation.errors });
      if (input.production.id !== productionId) {
        fail('PRODUCTION_ID_MISMATCH', 'production.id must equal the committed production id');
      }
      production = clone(input.production);
    }
    production.revision = state.production.revision + 1;
    production.lastSequence = nextSequence - 1;
    const productionValidation = validateProduction(production);
    if (!productionValidation.ok) {
      fail('INVALID_PRODUCTION', 'next production is invalid', { errors: productionValidation.errors });
    }

    const record = {
      commandId,
      idempotencyKey,
      ...(requestHash === undefined ? {} : { requestHash }),
      revision: production.revision,
      firstSequence: events.length > 0 ? events[0].sequence : production.lastSequence,
      lastSequence: production.lastSequence,
      eventIds: events.map((event) => event.id),
      outbox,
      at: now,
    };

    // 1. Outbox files are part of the transaction, so they land before the
    //    commit point. Recovery rematerialises them from `record` if lost.
    for (const entry of outbox) writeOutboxEntry(paths, entry);

    // 2. Journal lines are staging until the state rename names them.
    appendJournalAt(paths, events);

    // 3. The single commit point.
    const nextState = {
      schema: PRODUCTION_STORE_SCHEMA,
      production,
      commits: { ...state.commits, [idempotencyKey]: record },
      commit: record,
    };
    writeStateAt(paths, nextState);

    return {
      duplicate: false,
      committed: true,
      revision: production.revision,
      lastSequence: production.lastSequence,
      production: clone(production),
      commit: clone(record),
      events: clone(events),
      outboxIds: outbox.map((entry) => entry.id),
    };
  }

  /**
   * Append event lines as staging. They are invisible to readEvents() until a
   * commit record names their ids. commit() calls this internally after
   * trimming; exported so recovery and adapters share one primitive.
   */
  function appendEvents(productionId, rawEvents, options = {}) {
    const paths = pathsFor(productionId);
    const state = readStateAt(paths);
    if (!state) fail('NOT_FOUND', 'production does not exist', { productionId });
    if (!Array.isArray(rawEvents)) fail('INVALID_EVENT', 'events must be an array');
    const commandId = options.commandId === undefined ? 'staged' : assertGeneralId(options.commandId, 'commandId');
    const now = clockIso(clock);
    const { entries } = readJournalAt(paths);
    const journalMax = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0);
    let nextSequence = Math.max(state.production.lastSequence, journalMax) + 1;
    const events = rawEvents.map((raw, index) => {
      if (!isPlainObject(raw)) fail('INVALID_EVENT', `event ${index} must be an object`);
      const event = {
        id: raw.id === undefined
          ? generatedEventId(commandId, index, raw.type)
          : assertGeneralId(raw.id, `event ${index} id`),
        productionId,
        sequence: raw.sequence !== undefined ? raw.sequence : nextSequence,
        type: raw.type,
        at: raw.at ?? now,
        data: raw.data === undefined ? {} : raw.data,
      };
      if (raw.commandId !== undefined) event.commandId = raw.commandId;
      else event.commandId = commandId;
      if (raw.userEventId !== undefined) event.userEventId = raw.userEventId;
      const validation = validateEvent(event);
      if (!validation.ok) fail('INVALID_EVENT', `event ${index} is invalid`, { errors: validation.errors });
      nextSequence = Math.max(nextSequence + 1, event.sequence + 1);
      return event;
    });
    appendJournalAt(paths, events);
    return clone(events);
  }

  function enqueueOutbox(productionId, rawEntries) {
    const paths = pathsFor(productionId);
    const state = readStateAt(paths);
    if (!state) fail('NOT_FOUND', 'production does not exist', { productionId });
    if (!Array.isArray(rawEntries)) fail('INVALID_OUTBOX', 'outbox must be an array');
    const now = clockIso(clock);
    const entries = rawEntries.map((raw, index) => normalizeOutboxEntry(raw, index, now));
    for (const entry of entries) writeOutboxEntry(paths, entry);
    return clone(entries);
  }

  /** Committed but unacknowledged outbox entries, in commit order. */
  function pending(productionId) {
    const paths = pathsFor(productionId);
    const state = readStateAt(paths);
    if (!state) return [];
    const manifest = committedOutboxManifest(state);
    const result = [];
    for (const [id, entry] of manifest) {
      if (api.existsSync(ackPath(paths, id))) continue;
      const stored = readPendingEntry(paths, id);
      result.push(clone({
        ...entry,
        attempts: stored && Number.isSafeInteger(stored.attempts) ? stored.attempts : (entry.attempts ?? 0),
      }));
    }
    return result;
  }

  /**
   * Publish committed outbox entries at least once. The attempts counter and
   * ack are durable files; the pending file is removed only after the ack.
   * A publisher may be synchronous or return a promise.
   */
  async function drainOutbox(productionId, publish) {
    if (typeof publish !== 'function') fail('INVALID_PUBLISHER', 'drainOutbox requires a publish function');
    const paths = pathsFor(productionId);
    const entries = pending(productionId);
    let published = 0;
    for (const entry of entries) {
      const attempts = (entry.attempts ?? 0) + 1;
      const pendingEntry = { ...entry, attempts, at: clockIso(clock) };
      writeOutboxEntry(paths, pendingEntry);

      const outcome = publish(clone(pendingEntry));
      if (outcome && typeof outcome.then === 'function') await outcome;

      const ack = { id: entry.id, attempts, at: clockIso(clock) };
      writeAtomic(ackPath(paths, entry.id), `${JSON.stringify(ack, null, 2)}\n`);
      try {
        api.unlinkSync(pendingPath(paths, entry.id));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      published += 1;
    }
    return { published };
  }

  /**
   * Acknowledge exactly one committed outbox entry. The durable ack lands
   * before the pending file is removed, so recovery never republishes it and
   * drainOutbox() skips it. Every other entry is untouched.
   */
  function acknowledgeOutboxEntry(input) {
    if (!isPlainObject(input)) {
      fail('INVALID_INPUT', 'acknowledgeOutboxEntry requires one object argument');
    }
    const paths = pathsFor(input.productionId);
    const state = readStateAt(paths);
    if (!state) {
      fail('NOT_FOUND', 'production does not exist', { productionId: input.productionId });
    }
    const outboxId = assertSafeId(input.outboxId, 'outbox id');
    const manifest = committedOutboxManifest(state);
    const entry = manifest.get(outboxId);
    if (!entry) {
      fail('OUTBOX_NOT_FOUND', `outbox entry ${outboxId} is not committed`, {
        productionId: input.productionId,
        outboxId,
      });
    }
    const ack = ackPath(paths, outboxId);
    if (api.existsSync(ack)) {
      return { id: outboxId, acknowledged: false, reason: 'ALREADY_ACKNOWLEDGED' };
    }
    const stored = readPendingEntry(paths, outboxId);
    const attempts = stored && Number.isSafeInteger(stored.attempts)
      ? stored.attempts
      : Number.isSafeInteger(entry.attempts) ? entry.attempts : 0;
    const record = { id: outboxId, attempts, at: clockIso(clock) };
    writeAtomic(ack, `${JSON.stringify(record, null, 2)}\n`);
    try {
      api.unlinkSync(pendingPath(paths, outboxId));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { id: outboxId, acknowledged: true };
  }

  /**
   * Repair a production directory: discard uncommitted staging, remove orphan
   * outbox files, rematerialise committed outbox files that were lost, and
   * return the recovered view.
   */
  function recover(productionId) {
    const paths = pathsFor(productionId);
    const state = readStateAt(paths);
    if (!state) return null;

    const before = readJournalAt(paths);
    const kept = trimJournalAt(state, paths);
    const manifest = committedOutboxManifest(state);
    cleanupOutboxAt(paths, manifest);
    const materialized = materializeOutboxAt(paths, manifest);

    return {
      production: clone(state.production),
      revision: state.production.revision,
      lastSequence: state.production.lastSequence,
      events: clone(kept),
      pending: pending(productionId),
      trimmedEvents: Math.max(0, before.entries.length - kept.length),
      materialized,
    };
  }

  /**
   * Committed events only. Journal lines whose ids are not named by a commit
   * record (or whose sequence is beyond the committed lastSequence) are
   * staging and never leave the store.
   */
  function readEvents(productionId, options = {}) {
    const paths = pathsFor(productionId);
    const state = readStateAt(paths);
    if (!state) return [];
    const ids = committedEventIds(state);
    const lastSequence = state.production.lastSequence;
    const after = Number.isSafeInteger(options.after) && options.after > 0 ? options.after : 0;
    const limit = Number.isSafeInteger(options.limit) && options.limit >= 0 ? options.limit : Infinity;
    const { entries } = readJournalAt(paths);
    const byId = new Map();
    for (const entry of entries) {
      if (!ids.has(entry.id)) continue;
      if (entry.sequence > lastSequence) continue;
      if (entry.sequence <= after) continue;
      if (byId.has(entry.id)) continue;
      byId.set(entry.id, entry);
    }
    const events = [...byId.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
      .map(clone);
    return events;
  }

  return {
    create,
    read,
    list,
    commit,
    findCommit,
    appendEvents,
    readEvents,
    enqueueOutbox,
    pending,
    drainOutbox,
    acknowledgeOutboxEntry,
    recover,
  };
}
