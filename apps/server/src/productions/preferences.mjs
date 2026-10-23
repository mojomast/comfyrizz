// IP38: scoped production preferences.
//
// Spec 6.3 gives preferences four scopes: user, project, character and
// language (BCP-47, covering language and accent). The closed vocabulary is
// deliberate: there is no global scope and no implicit scope. A preference
// saved for Basil's voice must never be applied to every character.
//
// Durability mirrors the production store without becoming a second system:
// one owner-only JSON snapshot at runtime/preferences/preferences.json, a
// monotonically increasing revision, and a per-command idempotency record.
// Mutations are synchronous read-modify-write operations on that snapshot.
//
// Every mutation cites the server-assigned actor and the originating user
// event. An agent may recommend a value but may not save it; a system actor is
// allowed only for a migration, and only with a reason. Corrections keep the
// stable preference id and append history. Revocation keeps the record for
// audit while removing it from exposure.
//
// expose() resolves character > language > project > user for the requested
// targets. It returns plain data, a plain prompt string (never HTML) and a
// fingerprint over the resolved records, so callers can detect staleness.

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { validateIterationPolicy } from './iteration.mjs';

export const PREFERENCES_SCHEMA = 'comfyrizz.preferences/v1';

// IL09: some preference keys carry a structured value with its own contract.
// The hook is keyed by the preference key only; a key without a validator keeps
// the existing JSON-value behaviour. A validator either returns the normalized
// value that is stored or throws its own contract error, so an invalid policy is
// never persisted.
const VALUE_VALIDATORS = Object.freeze({
  'iteration.policy': validateIterationPolicy,
});

const SCOPES = new Set(['user', 'project', 'character', 'language']);
const SCOPES_BY_RANK = Object.freeze({ user: 1, project: 2, language: 3, character: 4 });
const ACTORS = new Set(['user', 'agent', 'system']);

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// BCP-47 language, optional script and optional region. Extensions are not
// part of the language/accent scope this store resolves.
const LANGUAGE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|\d{3}))?$/;
// A value that is itself a local filesystem path must never be persisted and
// later pasted into a prompt or a renderer.
const LOCAL_PATH_RE = /^(?:\/|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\|file:)/i;

const SET_FIELDS = Object.freeze([
  'scope', 'scopeId', 'key', 'value', 'actor', 'userEventId', 'reason',
  'commandId', 'idempotencyKey',
]);
const CORRECT_FIELDS = Object.freeze([
  'id', 'value', 'actor', 'userEventId', 'reason', 'commandId', 'idempotencyKey',
]);
const REVOKE_FIELDS = Object.freeze([
  'id', 'actor', 'userEventId', 'reason', 'commandId', 'idempotencyKey',
]);

export class PreferencesError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'PreferencesError';
    this.code = code;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
      Object.assign(this, details);
    }
  }
}

function fail(code, message, status = 400, details) {
  throw new PreferencesError(code, message, status, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function owns(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasValue(input, key) {
  return owns(input, key) && input[key] !== undefined;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? 'null' : canonicalJson(entry))).join(',')}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function clockIso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail('INVALID_CLOCK', 'the preference clock returned an invalid date', 500);
  }
  return date.toISOString();
}

function assertOnlyFields(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      fail('INVALID_INPUT', `unknown preference field: ${key}`, 400, { field: key });
    }
  }
}

function normalizeCommand(input) {
  const rawCommandId = input.commandId;
  const rawKey = input.idempotencyKey;
  const clean = (value, label) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
      fail('INVALID_INPUT', `${label} must be a simple identifier`, 400, { field: label });
    }
    return value;
  };
  const commandId = clean(rawCommandId, 'commandId');
  const idempotencyKey = clean(rawKey, 'idempotencyKey');
  if (commandId === undefined && idempotencyKey === undefined) {
    fail('MISSING_COMMAND_ID', 'set, correct and revoke require commandId or idempotencyKey');
  }
  // Normalise so a retry with either member of the caller's pair finds the
  // same durable command record.
  return {
    commandId: commandId ?? idempotencyKey,
    idempotencyKey: idempotencyKey ?? commandId,
  };
}

function normalizeActor(input) {
  if (!hasValue(input, 'actor') || input.actor === null
    || (typeof input.actor === 'string' && input.actor.trim() === '')) {
    fail('MISSING_ACTOR', 'the originating actor must be supplied explicitly');
  }
  if (typeof input.actor !== 'string' || !ACTORS.has(input.actor)) {
    fail('INVALID_ACTOR', 'actor must be user, agent or system');
  }
  if (input.actor === 'agent') {
    fail('AGENT_CANNOT_SET_PREFERENCE', 'an agent may recommend a preference but only a user may save it', 403);
  }
  return input.actor;
}

function normalizeReason(input, actor) {
  if (!hasValue(input, 'reason') || input.reason === null) {
    if (actor === 'system') {
      fail('MISSING_REASON', 'a system preference change is allowed only for a migration with a reason');
    }
    return undefined;
  }
  if (typeof input.reason !== 'string' || input.reason.trim() === '') {
    if (actor === 'system') fail('MISSING_REASON', 'a system preference change requires a reason');
    fail('INVALID_INPUT', 'reason must be a non-empty string', 400, { field: 'reason' });
  }
  assertNoLocalPath(input.reason);
  return input.reason.trim();
}

function normalizeUserEvent(input) {
  if (!hasValue(input, 'userEventId') || input.userEventId === null
    || (typeof input.userEventId === 'string' && input.userEventId.trim() === '')) {
    fail('MISSING_USER_EVENT', 'every preference change must cite the originating user event');
  }
  if (typeof input.userEventId !== 'string' || !SAFE_ID_RE.test(input.userEventId)) {
    fail('INVALID_INPUT', 'userEventId must be a simple identifier', 400, { field: 'userEventId' });
  }
  return input.userEventId;
}

function canonicalLanguage(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value) {
    fail('INVALID_SCOPE', 'language scope requires a BCP-47 language id');
  }
  let canonical;
  try {
    [canonical] = Intl.getCanonicalLocales(value);
  } catch {
    fail('INVALID_SCOPE', 'language scope requires a valid BCP-47 language id', 400, { scopeId: value });
  }
  if (typeof canonical !== 'string' || !LANGUAGE_RE.test(canonical)) {
    fail('INVALID_SCOPE', 'language scope requires a language id such as en-US or en-GB', 400, { scopeId: value });
  }
  return canonical;
}

function normalizeScope(input) {
  const scope = input.scope;
  if (typeof scope !== 'string' || !SCOPES.has(scope)) {
    fail('INVALID_SCOPE', 'scope must be exactly user, project, character or language');
  }
  const rawId = input.scopeId;
  if (scope === 'user') {
    if (rawId !== undefined && rawId !== null) {
      fail('INVALID_SCOPE', 'user scope does not take a scopeId');
    }
    return { scope, scopeId: null };
  }
  if (rawId === undefined || rawId === null) {
    fail('INVALID_SCOPE', `${scope} scope requires a scopeId`);
  }
  if (typeof rawId !== 'string') {
    fail('INVALID_SCOPE', `${scope} scopeId must be a string`);
  }
  if (scope === 'language') return { scope, scopeId: canonicalLanguage(rawId) };
  if (!SAFE_ID_RE.test(rawId)) {
    fail('INVALID_SCOPE', `${scope} scopeId must be a simple identifier`, 400, { scopeId: rawId });
  }
  return { scope, scopeId: rawId };
}

function normalizeKey(input) {
  if (!hasValue(input, 'key') || input.key === null) {
    fail('INVALID_KEY', 'a preference key is required');
  }
  if (typeof input.key !== 'string' || !KEY_RE.test(input.key)) {
    fail('INVALID_KEY', 'a preference key must be a simple identifier', 400, { key: input.key });
  }
  return input.key;
}

function looksLikeLocalPath(value) {
  if (typeof value !== 'string') return false;
  return LOCAL_PATH_RE.test(value.trim());
}

function assertNoLocalPath(value) {
  if (looksLikeLocalPath(value)) {
    fail('LOCAL_PATH_FORBIDDEN', 'preferences may not contain local filesystem paths');
  }
}

function assertJsonValue(value, path = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string') assertNoLocalPath(value);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_VALUE', `${path} must contain finite numbers`);
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail('INVALID_VALUE', `${path} must not be circular`);
    seen.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === undefined) fail('INVALID_VALUE', `${path}[${index}] must not be undefined`);
      assertJsonValue(value[index], `${path}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) fail('INVALID_VALUE', `${path} must not be circular`);
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) fail('INVALID_VALUE', `${path}.${key} must not be undefined`);
      assertJsonValue(entry, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  fail('INVALID_VALUE', `${path} must be a JSON value`);
}

function normalizeValue(input) {
  if (!hasValue(input, 'value')) fail('INVALID_VALUE', 'a preference value is required');
  assertJsonValue(input.value);
  return clone(input.value);
}

function validateKeyedValue(key, value) {
  const validator = VALUE_VALIDATORS[key];
  return validator ? clone(validator(value)) : value;
}

function normalizeId(input) {
  if (!hasValue(input, 'id') || input.id === null || typeof input.id !== 'string'
    || input.id.trim() === '') {
    fail('INVALID_INPUT', 'a preference id is required', 400, { field: 'id' });
  }
  return input.id;
}

function requestHash(kind, payload) {
  return sha256(canonicalJson({ kind, ...payload }));
}

function generatedRecordId(commandId, scope, scopeId, key) {
  const digest = createHash('sha256')
    .update(`preference\u0000${commandId}\u0000${scope}\u0000${scopeId ?? ''}\u0000${key}`)
    .digest('hex')
    .slice(0, 24);
  return `pref_${digest}`;
}

function findCommand(state, commandId, idempotencyKey) {
  const matches = state.commands.filter(
    (entry) => entry.commandId === commandId || entry.idempotencyKey === idempotencyKey,
  );
  if (matches.length === 0) return null;
  const first = matches[0];
  for (const entry of matches) {
    if (entry !== first) {
      fail('IDEMPOTENCY_CONFLICT', 'command id or idempotency key was reused', 409, {
        commandId,
        idempotencyKey,
      });
    }
  }
  return first;
}

function replay(command, hash) {
  if (command.requestHash !== hash) {
    fail(
      'IDEMPOTENCY_CONFLICT',
      'command id or idempotency key was reused with a different preference payload',
      409,
      { commandId: command.commandId, idempotencyKey: command.idempotencyKey },
    );
  }
  return { record: clone(command.result), duplicate: true };
}

function findRecord(state, id) {
  return state.records.find((record) => record.id === id) ?? null;
}

function activeRecord(state, scope, scopeId, key) {
  return state.records.find((record) => record.status === 'active'
    && record.scope === scope
    && record.scopeId === scopeId
    && record.key === key) ?? null;
}

function historyEntry(action, input, at, revision, value) {
  const entry = {
    action,
    actor: input.actor,
    userEventId: input.userEventId,
    at,
    revision,
  };
  if (value !== undefined) entry.value = clone(value);
  if (input.reason !== undefined) entry.reason = input.reason;
  return entry;
}

function promptText(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return raw
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function assertSafeScopeId(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    fail('INVALID_INPUT', `${label} must be a simple identifier`, 400, { field: label });
  }
  return value;
}

function apiFrom(options) {
  const supplied = isPlainObject(options.fs) ? options.fs : {};
  const get = (name, fallback) => (typeof supplied[name] === 'function' ? supplied[name].bind(supplied) : fallback);
  return {
    readFileSync: get('readFileSync', (...args) => nodeFs.readFileSync(...args)),
    writeFileSync: get('writeFileSync', (...args) => nodeFs.writeFileSync(...args)),
    mkdirSync: get('mkdirSync', (...args) => nodeFs.mkdirSync(...args)),
    renameSync: get('renameSync', (...args) => nodeFs.renameSync(...args)),
    chmodSync: get('chmodSync', (...args) => nodeFs.chmodSync(...args)),
    unlinkSync: get('unlinkSync', (...args) => nodeFs.unlinkSync(...args)),
  };
}

/**
 * Create the scoped preference store.
 *
 * Options: runtimeDir (required), clock, fs. There is deliberately no
 * rootDir alias and no default scope.
 */
export function createPreferencesStore(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'createPreferencesStore options must be an object');
  if (owns(options, 'rootDir')) {
    fail('INVALID_OPTIONS', 'createPreferencesStore takes runtimeDir; rootDir is not supported');
  }
  if (typeof options.runtimeDir !== 'string' || options.runtimeDir.trim() === '') {
    fail('INVALID_OPTIONS', 'runtimeDir must be a non-empty path string');
  }
  if (options.fs !== undefined && !isPlainObject(options.fs)) {
    fail('INVALID_OPTIONS', 'fs must be an object of filesystem functions');
  }

  const api = apiFrom(options);
  const clock = options.clock;
  const preferencesDir = join(resolve(options.runtimeDir), 'preferences');
  const statePath = join(preferencesDir, 'preferences.json');
  let tempSequence = 0;

  function emptyState() {
    return { schema: PREFERENCES_SCHEMA, revision: 0, records: [], commands: [] };
  }

  function validateState(state) {
    if (!isPlainObject(state)
      || state.schema !== PREFERENCES_SCHEMA
      || !Number.isSafeInteger(state.revision)
      || state.revision < 0
      || !Array.isArray(state.records)
      || !Array.isArray(state.commands)) {
      fail('CORRUPT_STATE', 'preferences.json is not a preference store snapshot', 500);
    }
    for (const record of state.records) {
      if (!isPlainObject(record) || typeof record.id !== 'string'
        || typeof record.scope !== 'string' || typeof record.key !== 'string'
        || !Array.isArray(record.history)) {
        fail('CORRUPT_STATE', 'preferences.json contains an invalid record', 500);
      }
    }
    for (const command of state.commands) {
      if (!isPlainObject(command) || typeof command.commandId !== 'string'
        || typeof command.requestHash !== 'string' || !isPlainObject(command.result)) {
        fail('CORRUPT_STATE', 'preferences.json contains an invalid command record', 500);
      }
    }
    return state;
  }

  function readState() {
    let raw;
    try {
      raw = api.readFileSync(statePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail('CORRUPT_STATE', 'preferences.json is not valid JSON', 500);
    }
    return validateState(parsed);
  }

  function writeState(state) {
    api.mkdirSync(preferencesDir, { recursive: true, mode: 0o700 });
    api.chmodSync(preferencesDir, 0o700);
    tempSequence += 1;
    const temp = `${statePath}.${process.pid}.${tempSequence}.tmp`;
    try {
      api.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      api.chmodSync(temp, 0o600);
      api.renameSync(temp, statePath);
      api.chmodSync(statePath, 0o600);
    } catch (error) {
      try { api.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }

  function commit(state, next, command, hash, at, record) {
    next.revision = state.revision + 1;
    record.revision = next.revision;
    record.updatedAt = at;
    next.commands.push({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hash,
      kind: record.history[record.history.length - 1].action,
      at,
      revision: next.revision,
      result: clone(record),
    });
    // A compare-and-swap revision check before the atomic rename: a concurrent
    // writer that committed while this command was being prepared is surfaced,
    // never silently overwritten.
    const current = readState();
    if (current.revision !== state.revision) {
      fail('REVISION_CONFLICT', 'the preference revision changed before the command committed', 409, {
        currentRevision: current.revision,
        baseRevision: state.revision,
      });
    }
    writeState(next);
    return { record: clone(record), duplicate: false };
  }

  function set(input) {
    if (!isPlainObject(input)) fail('INVALID_INPUT', 'set input must be an object');
    assertOnlyFields(input, SET_FIELDS);
    const actor = normalizeActor(input);
    const userEventId = normalizeUserEvent(input);
    const command = normalizeCommand(input);
    const reason = normalizeReason(input, actor);
    const { scope, scopeId } = normalizeScope(input);
    const key = normalizeKey(input);
    const value = validateKeyedValue(key, normalizeValue(input));

    const hash = requestHash('set', {
      scope, scopeId, key, value, actor, userEventId, reason,
    });
    const state = readState();
    const prior = findCommand(state, command.commandId, command.idempotencyKey);
    if (prior) return replay(prior, hash);
    if (activeRecord(state, scope, scopeId, key)) {
      fail('PREFERENCE_EXISTS', 'an active preference already exists for this scope and key; correct it instead', 409);
    }

    const at = clockIso(clock);
    const nextRevision = state.revision + 1;
    const record = {
      id: generatedRecordId(command.commandId, scope, scopeId, key),
      scope,
      scopeId,
      key,
      value,
      status: 'active',
      actor,
      userEventId,
      createdAt: at,
      updatedAt: at,
      revision: nextRevision,
      history: [historyEntry('set', { actor, userEventId, reason }, at, nextRevision, value)],
    };
    if (reason !== undefined) record.reason = reason;
    const next = {
      ...state,
      records: [...state.records, record],
      commands: [...state.commands],
    };
    return commit(state, next, command, hash, at, record);
  }

  function correct(input) {
    if (!isPlainObject(input)) fail('INVALID_INPUT', 'correct input must be an object');
    assertOnlyFields(input, CORRECT_FIELDS);
    const actor = normalizeActor(input);
    const userEventId = normalizeUserEvent(input);
    const command = normalizeCommand(input);
    const reason = normalizeReason(input, actor);
    const id = normalizeId(input);
    const rawValue = normalizeValue(input);

    const state = readState();
    const existing = findRecord(state, id);
    if (!existing) fail('NOT_FOUND', 'preference does not exist', 404);
    const value = validateKeyedValue(existing.key, rawValue);

    const hash = requestHash('correct', {
      id, value, actor, userEventId, reason,
    });
    const prior = findCommand(state, command.commandId, command.idempotencyKey);
    if (prior) return replay(prior, hash);
    if (existing.status === 'revoked') {
      fail('PREFERENCE_REVOKED', 'a revoked preference cannot be corrected', 409);
    }

    const at = clockIso(clock);
    const nextRevision = state.revision + 1;
    const record = {
      ...clone(existing),
      value,
      actor,
      userEventId,
      updatedAt: at,
      revision: nextRevision,
      history: [...existing.history, historyEntry('correct', { actor, userEventId, reason }, at, nextRevision, value)],
    };
    if (reason !== undefined) record.reason = reason;
    else delete record.reason;
    const next = {
      ...state,
      records: state.records.map((entry) => (entry.id === id ? record : entry)),
      commands: [...state.commands],
    };
    return commit(state, next, command, hash, at, record);
  }

  function revoke(input) {
    if (!isPlainObject(input)) fail('INVALID_INPUT', 'revoke input must be an object');
    assertOnlyFields(input, REVOKE_FIELDS);
    const actor = normalizeActor(input);
    const userEventId = normalizeUserEvent(input);
    const command = normalizeCommand(input);
    const reason = normalizeReason(input, actor);
    const id = normalizeId(input);

    const hash = requestHash('revoke', { id, actor, userEventId, reason });
    const state = readState();
    const prior = findCommand(state, command.commandId, command.idempotencyKey);
    if (prior) return replay(prior, hash);
    const existing = findRecord(state, id);
    if (!existing) fail('NOT_FOUND', 'preference does not exist', 404);
    if (existing.status === 'revoked') {
      fail('ALREADY_REVOKED', 'preference is already revoked', 409);
    }

    const at = clockIso(clock);
    const nextRevision = state.revision + 1;
    const record = {
      ...clone(existing),
      status: 'revoked',
      actor,
      userEventId,
      revokedAt: at,
      updatedAt: at,
      revision: nextRevision,
      history: [...existing.history, historyEntry('revoke', { actor, userEventId, reason }, at, nextRevision)],
    };
    if (reason !== undefined) record.reason = reason;
    else delete record.reason;
    const next = {
      ...state,
      records: state.records.map((entry) => (entry.id === id ? record : entry)),
      commands: [...state.commands],
    };
    return commit(state, next, command, hash, at, record);
  }

  function read(id) {
    if (typeof id !== 'string' || id.trim() === '') {
      fail('INVALID_INPUT', 'read takes a preference id string');
    }
    const record = findRecord(readState(), id);
    return record ? clone(record) : null;
  }

  function history(id) {
    if (typeof id !== 'string' || id.trim() === '') {
      fail('INVALID_INPUT', 'history takes a preference id string');
    }
    const record = findRecord(readState(), id);
    return record ? clone(record.history) : null;
  }

  function list(filter = {}) {
    if (!isPlainObject(filter)) fail('INVALID_INPUT', 'list filter must be an object');
    assertOnlyFields(filter, ['scope', 'scopeId', 'key', 'status']);

    let wanted = null;
    if (hasValue(filter, 'scope')) {
      wanted = normalizeScope(filter);
    } else if (hasValue(filter, 'scopeId')) {
      fail('INVALID_INPUT', 'list scopeId requires scope');
    }
    const wantedKey = hasValue(filter, 'key') ? normalizeKey(filter) : null;
    const status = hasValue(filter, 'status') ? filter.status : 'active';
    if (status !== 'active' && status !== 'revoked' && status !== 'all') {
      fail('INVALID_INPUT', 'list status must be active, revoked or all');
    }

    return readState().records
      .filter((record) => {
        if (wanted) {
          if (record.scope !== wanted.scope || record.scopeId !== wanted.scopeId) return false;
        }
        if (wantedKey && record.key !== wantedKey) return false;
        if (status !== 'all' && record.status !== status) return false;
        return true;
      })
      .map(clone);
  }

  function expose(target = {}) {
    if (!isPlainObject(target)) fail('INVALID_INPUT', 'expose target must be an object');
    assertOnlyFields(target, ['projectId', 'characterId', 'language']);

    const projectId = assertSafeScopeId(target.projectId, 'projectId');
    const characterId = assertSafeScopeId(target.characterId, 'characterId');
    let language = null;
    if (target.language !== undefined && target.language !== null) {
      language = canonicalLanguage(target.language);
    }

    const applicable = readState().records.filter((record) => {
      if (record.status !== 'active') return false;
      if (record.scope === 'user') return true;
      if (record.scope === 'project') return projectId !== null && record.scopeId === projectId;
      if (record.scope === 'character') return characterId !== null && record.scopeId === characterId;
      if (record.scope === 'language') return language !== null && record.scopeId === language;
      return false;
    });

    const byKey = new Map();
    for (const record of applicable) {
      const bucket = byKey.get(record.key) ?? [];
      bucket.push(record);
      byKey.set(record.key, bucket);
    }

    const data = {};
    const winners = {};
    const overrides = [];
    for (const key of [...byKey.keys()].sort()) {
      const bucket = byKey.get(key);
      bucket.sort((left, right) => {
        const rank = (SCOPES_BY_RANK[right.scope] ?? 0) - (SCOPES_BY_RANK[left.scope] ?? 0);
        if (rank !== 0) return rank;
        if (right.revision !== left.revision) return right.revision - left.revision;
        return left.id.localeCompare(right.id);
      });
      const winner = bucket[0];
      data[key] = clone(winner.value);
      winners[key] = {
        id: winner.id,
        scope: winner.scope,
        scopeId: winner.scopeId,
        revision: winner.revision,
        value: clone(winner.value),
      };
      if (bucket.length > 1) {
        overrides.push({
          key,
          winner: winner.id,
          overridden: bucket.slice(1).map((record) => record.id),
        });
      }
    }

    const prompt = Object.keys(data)
      .sort()
      .map((key) => `${key}: ${promptText(data[key])}`)
      .join('\n');
    const fingerprint = sha256(canonicalJson({ data, winners, overrides }));
    return { data, prompt, fingerprint, overrides };
  }

  function revision() {
    return readState().revision;
  }

  return Object.freeze({
    set,
    correct,
    revoke,
    read,
    list,
    history,
    expose,
    revision,
  });
}
