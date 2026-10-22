// IP07: persistent, per-production budget ledger.
//
// One ledger per production, addressed by `production.budgetLedgerId`. Storage
// follows the specification's section 7 layout:
//
//   runtime/
//     budgets/<ledgerId>.json    append-only entries + header
//     budgets/<ledgerId>.lock    short-lived single-writer lock
//
// `entries` is the only authority. `revision`, `spent`, `committed`, `ceiling`
// and `available` are derived on every read, so a restart, a reopen or a retried
// command can never reset the balance or double-count a reservation.
//
// The spend cap is a *user* decision. There is no default ceiling: a new ledger
// is uncapped (`ceiling: null`) until a `setCeiling` authorization entry exists,
// and the agent may never write one. When the cap is disabled the ledger still
// records every reservation and settlement.
//
// Settlement is explicit (IP06 policy): `actual`/`estimated` carries the units
// actually used, `reservation_unverified` charges the full hold (upper bound
// plus collect-and-stop reserve), and `no_allocation` charges zero.
//
// Idempotency follows spec 7.1. A deterministic per-reservation key is used
// when the caller omits one, and every entry stores a request hash: replaying
// the same key with the same request returns `duplicate: true`, while a
// different request under the same key is `IDEMPOTENCY_CONFLICT`.
//
// Writes take the lock, read the latest record, and commit with an atomic temp
// rename, so a crash leaves either the old whole record or the new one.

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join, resolve } from 'node:path';

export const BUDGET_LEDGER_SCHEMA = 'comfyrizz.budget-ledger/v1';

const DEFAULT_UNIT = 'colab_compute_units';
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const GENERAL_ID_RE = /^[^\s/\\\u0000-\u001f]{1,256}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const HASH_RE = /^[0-9a-f]{64}$/;

const ENTRY_KINDS = new Set(['reserve', 'settle', 'release', 'authorization']);
const SETTLEMENT_KINDS = new Set(['actual', 'estimated', 'reservation_unverified', 'no_allocation']);
const RESERVE_BY_KIND = new Set(['actual', 'estimated']);

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 30_000;

export class ProductionLedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProductionLedgerError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new ProductionLedgerError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeNumber(value) {
  if (Object.is(value, -0)) return 0;
  return Number.isInteger(value) ? value : Number(value.toPrecision(12));
}

function nonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('INVALID_AMOUNT', `${label} must be a finite non-negative number`, { field: label, value });
  }
  return normalizeNumber(value);
}

function ceilingValue(value) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('INVALID_CEILING', 'ceiling must be null (cap disabled) or a finite non-negative number', { value });
  }
  return normalizeNumber(value);
}

function unitValue(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    fail('INVALID_UNIT', 'unit must be a non-empty string', { value });
  }
  return value;
}

function reservationIdValue(value) {
  if (typeof value !== 'string' || !GENERAL_ID_RE.test(value)) {
    fail('INVALID_RESERVATION_ID', 'reservationId must be a non-empty identifier', { value });
  }
  return value;
}

function idempotencyKeyValue(value) {
  if (typeof value !== 'string' || !GENERAL_ID_RE.test(value)) {
    fail('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must be a non-empty identifier', { value });
  }
  return value;
}

function userEventIdValue(value) {
  if (typeof value !== 'string' || !GENERAL_ID_RE.test(value)) {
    fail('USER_EVENT_REQUIRED', 'userEventId must name the originating user event', { value });
  }
  return value;
}

function optionalId(value, code, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !GENERAL_ID_RE.test(value)) fail(code, `${label} must be an identifier`, { value });
  return value;
}

function optionalText(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 2000) {
    fail('INVALID_TEXT', `${label} must be a string of at most 2000 characters`, { field: label });
  }
  return value;
}

function evidenceValue(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    fail('INVALID_EVIDENCE', 'evidence must be JSON-serialisable');
  }
  return undefined;
}

function expectedRevisionValue(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_REVISION', 'expectedRevision must be a non-negative integer', { value });
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHashOf(payload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function clockIso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_CLOCK', 'clock must return a valid date');
  return date.toISOString();
}

function sleep(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/**
 * Canonical paths for one ledger. The file is always
 * `<runtimeDir>/budgets/<ledgerId>.json`; the lock sits beside it.
 */
export function ledgerPaths(runtimeDir, ledgerId) {
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
    fail('INVALID_RUNTIME_DIR', 'runtimeDir must be a non-empty path string');
  }
  if (typeof ledgerId !== 'string' || !SAFE_ID_RE.test(ledgerId)) {
    fail('INVALID_LEDGER_ID', 'ledgerId must be a simple identifier', { ledgerId });
  }
  const root = resolve(runtimeDir);
  const budgetsRoot = join(root, 'budgets');
  return {
    root,
    budgetsRoot,
    file: join(budgetsRoot, `${ledgerId}.json`),
    lock: join(budgetsRoot, `${ledgerId}.lock`),
  };
}

/**
 * Open (or create) the ledger for `ledgerId` under `runtimeDir`.
 *
 * The ceiling is always derived from the latest `authorization` entry. A
 * `ceiling` option may seed a brand-new ledger (it becomes the initial user
 * authorization), but it is optional and never rewrites an existing ledger's
 * authorization, so reopening with no ceiling argument works.
 */
export function createBudgetLedger(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'createBudgetLedger options must be an object');
  const { runtimeDir, ledgerId } = options;
  const paths = ledgerPaths(runtimeDir, ledgerId);
  const constructionUnit = options.unit === undefined || options.unit === null ? null : unitValue(options.unit);
  // A ceiling argument only seeds a brand-new ledger (as an explicit user
  // authorization entry). It is never required and never rewrites an existing
  // ledger's latest authorization.
  const initialCeiling = options.ceiling === undefined ? null : ceilingValue(options.ceiling);
  // A seeded ceiling is a user authorization like setCeiling, so it must cite
  // the originating user event (review fix-up: no unattributed authorization).
  const initialUserEventId = options.userEventId === undefined && initialCeiling === null
    ? undefined
    : userEventIdValue(options.userEventId);
  const clock = options.clock;
  const lockTimeoutMs = options.lockTimeoutMs === undefined
    ? DEFAULT_LOCK_TIMEOUT_MS
    : nonNegativeNumber(options.lockTimeoutMs, 'lockTimeoutMs');
  const lockStaleMs = options.lockStaleMs === undefined
    ? DEFAULT_LOCK_STALE_MS
    : nonNegativeNumber(options.lockStaleMs, 'lockStaleMs');

  let tempSequence = 0;

  function readRecord() {
    let raw;
    try {
      raw = nodeFs.readFileSync(paths.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') fail('LEDGER_NOT_FOUND', 'budget ledger does not exist', { ledgerId });
      throw error;
    }

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      fail('CORRUPT_LEDGER', 'budget ledger is not valid JSON', { ledgerId });
    }
    if (!isPlainObject(record)
      || record.schema !== BUDGET_LEDGER_SCHEMA
      || record.ledgerId !== ledgerId
      || typeof record.unit !== 'string'
      || record.unit.length === 0
      || !Array.isArray(record.entries)
      || !Number.isSafeInteger(record.revision)
      || record.revision < 0
      || record.revision !== record.entries.length) {
      fail('CORRUPT_LEDGER', 'budget ledger header is invalid', { ledgerId });
    }
    record.entries.forEach((entry, index) => {
      if (!isPlainObject(entry)
        || typeof entry.id !== 'string'
        || !ENTRY_KINDS.has(entry.kind)
        || entry.revision !== index + 1
        || typeof entry.idempotencyKey !== 'string'
        || typeof entry.requestHash !== 'string'
        || !HASH_RE.test(entry.requestHash)
        || entry.ledgerId !== ledgerId
        || entry.unit !== record.unit
        || typeof entry.at !== 'string'
        || !ISO_RE.test(entry.at)) {
        fail('CORRUPT_LEDGER', 'budget ledger entry is invalid', { ledgerId, index });
      }
    });
    return record;
  }

  function readRecordOrNull() {
    try {
      return readRecord();
    } catch (error) {
      if (error?.code === 'LEDGER_NOT_FOUND') return null;
      throw error;
    }
  }

  function writeRecord(record) {
    nodeFs.mkdirSync(paths.budgetsRoot, { recursive: true, mode: 0o700 });
    tempSequence += 1;
    const temp = `${paths.file}.${process.pid}.${tempSequence}.tmp`;
    try {
      nodeFs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      nodeFs.chmodSync(temp, 0o600);
      nodeFs.renameSync(temp, paths.file);
      nodeFs.chmodSync(paths.file, 0o600);
    } catch (error) {
      try { nodeFs.unlinkSync(temp); } catch { void error; }
      throw error;
    }
  }

  function withLock(fn) {
    nodeFs.mkdirSync(paths.budgetsRoot, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + lockTimeoutMs;
    let fd;
    for (;;) {
      try {
        fd = nodeFs.openSync(paths.lock, 'wx', 0o600);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const stat = nodeFs.statSync(paths.lock);
          if (Date.now() - stat.mtimeMs > lockStaleMs) {
            nodeFs.unlinkSync(paths.lock);
            continue;
          }
        } catch (probeError) {
          if (probeError?.code === 'ENOENT') continue;
        }
        if (Date.now() > deadline) {
          fail('LOCK_TIMEOUT', 'timed out waiting for the budget ledger lock', { ledgerId });
        }
        sleep(2);
      }
    }

    try {
      try { nodeFs.writeFileSync(fd, `${process.pid}\n${clockIso(clock)}\n`); } catch { /* diagnostic only */ }
      return fn();
    } finally {
      try { nodeFs.closeSync(fd); } catch { /* already closed */ }
      try { nodeFs.unlinkSync(paths.lock); } catch { /* lock was reclaimed */ }
    }
  }

  function derive(record) {
    let ceiling = null;
    let spent = 0;
    let committed = 0;
    const open = new Map();

    for (const entry of record.entries) {
      if (entry.kind === 'authorization') {
        const value = entry.ceiling;
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
          fail('CORRUPT_LEDGER', 'authorization entry has an invalid ceiling', { ledgerId });
        }
        ceiling = value === null ? null : normalizeNumber(value);
        continue;
      }
      if (entry.kind === 'reserve') {
        if (open.has(entry.reservationId)) {
          fail('CORRUPT_LEDGER', 'reservation was opened twice', { reservationId: entry.reservationId });
        }
        const hold = nonNegativeNumber(entry.hold, 'hold');
        committed = normalizeNumber(committed + hold);
        open.set(entry.reservationId, {
          reservationId: entry.reservationId,
          upperBound: nonNegativeNumber(entry.upperBound, 'upperBound'),
          collectAndStopReserve: nonNegativeNumber(entry.collectAndStopReserve ?? 0, 'collectAndStopReserve'),
          hold,
          reservedAt: entry.at,
        });
        continue;
      }
      if (entry.kind === 'settle') {
        const reserved = open.get(entry.reservationId);
        if (!reserved) {
          fail('CORRUPT_LEDGER', 'settlement references a closed reservation', { reservationId: entry.reservationId });
        }
        committed = normalizeNumber(committed - reserved.hold);
        spent = normalizeNumber(spent + nonNegativeNumber(entry.charged, 'charged'));
        open.delete(entry.reservationId);
        continue;
      }
      if (entry.kind === 'release') {
        const reserved = open.get(entry.reservationId);
        if (!reserved) {
          fail('CORRUPT_LEDGER', 'release references a closed reservation', { reservationId: entry.reservationId });
        }
        committed = normalizeNumber(committed - reserved.hold);
        open.delete(entry.reservationId);
      }
    }

    return {
      ceiling,
      spent: normalizeNumber(spent),
      committed: normalizeNumber(committed),
      open,
    };
  }

  function statusOf(record) {
    const derived = derive(record);
    return {
      schema: BUDGET_LEDGER_SCHEMA,
      ledgerId: record.ledgerId,
      unit: record.unit,
      revision: record.revision,
      entryCount: record.entries.length,
      ceiling: derived.ceiling,
      capped: derived.ceiling !== null,
      spent: derived.spent,
      committed: derived.committed,
      available: derived.ceiling === null
        ? null
        : normalizeNumber(derived.ceiling - derived.spent - derived.committed),
      openReservations: [...derived.open.values()].map((reservation) => clone(reservation)),
    };
  }

  function commit({ idempotencyKey, expectedRevision, payload, build }) {
    return withLock(() => {
      const record = readRecord();
      const requestHash = requestHashOf(payload(record));

      const prior = record.entries.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          fail('IDEMPOTENCY_CONFLICT', 'idempotency key was reused with a different request', {
            idempotencyKey,
            entryId: prior.id,
          });
        }
        return {
          duplicate: true,
          revision: record.revision,
          entry: clone(prior),
          status: statusOf(record),
        };
      }

      if (expectedRevision !== undefined && expectedRevision !== record.revision) {
        fail('REVISION_CONFLICT', 'expectedRevision does not match the ledger revision', {
          currentRevision: record.revision,
          expectedRevision,
        });
      }

      const fields = build(record);
      const revision = record.revision + 1;
      const entry = {
        id: `lede_${revision}`,
        revision,
        ledgerId,
        at: clockIso(clock),
        idempotencyKey,
        requestHash,
        unit: record.unit,
        ...fields,
      };

      record.entries.push(entry);
      record.revision = revision;
      record.updatedAt = entry.at;
      writeRecord(record);

      return {
        duplicate: false,
        revision,
        entry: clone(entry),
        status: statusOf(record),
      };
    });
  }

  function resolveUnit(record, supplied) {
    if (supplied !== undefined) {
      const unit = unitValue(supplied);
      if (unit !== record.unit) {
        fail('UNIT_MISMATCH', 'entry unit does not match the ledger unit', {
          unit,
          ledgerUnit: record.unit,
        });
      }
      return unit;
    }
    return record.unit;
  }

  function reserve(input = {}) {
    if (!isPlainObject(input)) fail('INVALID_RESERVE', 'reserve input must be an object');
    const reservationId = reservationIdValue(input.reservationId);
    const upperBound = nonNegativeNumber(input.upperBound, 'upperBound');
    const collectAndStopReserve = input.collectAndStopReserve === undefined
      ? 0
      : nonNegativeNumber(input.collectAndStopReserve, 'collectAndStopReserve');
    const hold = normalizeNumber(upperBound + collectAndStopReserve);
    const idempotencyKey = input.idempotencyKey === undefined
      ? `reserve:${reservationId}`
      : idempotencyKeyValue(input.idempotencyKey);
    const expectedRevision = expectedRevisionValue(input.expectedRevision);
    const userEventId = optionalId(input.userEventId, 'INVALID_USER_EVENT', 'userEventId');
    const actor = optionalId(input.actor, 'INVALID_ACTOR', 'actor');
    const evidence = evidenceValue(input.evidence);

    return commit({
      idempotencyKey,
      expectedRevision,
      payload: (record) => ({
        op: 'reserve',
        reservationId,
        upperBound,
        collectAndStopReserve,
        unit: resolveUnit(record, input.unit),
        userEventId,
        actor,
        evidence,
      }),
      build: (record) => {
        const derived = derive(record);
        if (derived.open.has(reservationId)) {
          fail('RESERVATION_EXISTS', 'reservation is already open', { reservationId });
        }
        if (derived.ceiling !== null) {
          const available = normalizeNumber(derived.ceiling - derived.spent - derived.committed);
          if (normalizeNumber(derived.spent + derived.committed + hold) > derived.ceiling) {
            fail('BUDGET_EXCEEDED', 'reservation would exceed the user-set spend ceiling', {
              ceiling: derived.ceiling,
              spent: derived.spent,
              committed: derived.committed,
              upperBound,
              collectAndStopReserve,
              requested: hold,
              available,
            });
          }
        }
        return {
          kind: 'reserve',
          reservationId,
          upperBound,
          collectAndStopReserve,
          hold,
          ...(userEventId === undefined ? {} : { userEventId }),
          ...(actor === undefined ? {} : { actor }),
          ...(evidence === undefined ? {} : { evidence }),
        };
      },
    });
  }

  function settle(input = {}) {
    if (!isPlainObject(input)) fail('INVALID_SETTLEMENT', 'settle input must be an object');
    const reservationId = reservationIdValue(input.reservationId);
    const kind = input.kind;
    if (typeof kind !== 'string' || !SETTLEMENT_KINDS.has(kind)) {
      fail('INVALID_SETTLEMENT', 'settlement kind must be actual, estimated, reservation_unverified or no_allocation', { kind });
    }

    let actualUnits;
    if (RESERVE_BY_KIND.has(kind)) {
      if (input.actualUnits === undefined) {
        fail('INVALID_SETTLEMENT', `${kind} settlement requires actualUnits`);
      }
      actualUnits = nonNegativeNumber(input.actualUnits, 'actualUnits');
    } else if (input.actualUnits !== undefined) {
      fail('INVALID_SETTLEMENT', `${kind} settlement must not carry actualUnits`);
    }
    if (input.gpuAllocated !== undefined && typeof input.gpuAllocated !== 'boolean') {
      fail('INVALID_SETTLEMENT', 'gpuAllocated must be a boolean when supplied', { field: 'gpuAllocated' });
    }
    if (kind === 'no_allocation' && input.gpuAllocated === true) {
      fail('INVALID_SETTLEMENT', 'no_allocation is only valid when no GPU was allocated', { gpuAllocated: true });
    }

    const idempotencyKey = input.idempotencyKey === undefined
      ? `settle:${reservationId}`
      : idempotencyKeyValue(input.idempotencyKey);
    const expectedRevision = expectedRevisionValue(input.expectedRevision);
    const userEventId = optionalId(input.userEventId, 'INVALID_USER_EVENT', 'userEventId');
    const actor = optionalId(input.actor, 'INVALID_ACTOR', 'actor');
    const evidence = evidenceValue(input.evidence);

    return commit({
      idempotencyKey,
      expectedRevision,
      payload: (record) => ({
        op: 'settle',
        reservationId,
        kind,
        actualUnits: RESERVE_BY_KIND.has(kind) ? actualUnits : null,
        gpuAllocated: kind === 'no_allocation' ? input.gpuAllocated === false ? false : null : null,
        unit: resolveUnit(record, input.unit),
        userEventId,
        actor,
        evidence,
      }),
      build: (record) => {
        const derived = derive(record);
        const reserved = derived.open.get(reservationId);
        if (!reserved) {
          fail('RESERVATION_NOT_OPEN', 'reservation is not open for settlement', { reservationId });
        }
        let charged;
        if (kind === 'reservation_unverified') charged = reserved.hold;
        else if (kind === 'no_allocation') charged = 0;
        else charged = actualUnits;
        return {
          kind: 'settle',
          reservationId,
          settlementKind: kind,
          actualUnits: RESERVE_BY_KIND.has(kind) ? actualUnits : null,
          hold: reserved.hold,
          charged,
          ...(userEventId === undefined ? {} : { userEventId }),
          ...(actor === undefined ? {} : { actor }),
          ...(evidence === undefined ? {} : { evidence }),
        };
      },
    });
  }

  function release(input = {}) {
    if (!isPlainObject(input)) fail('INVALID_RELEASE', 'release input must be an object');
    const reservationId = reservationIdValue(input.reservationId);
    const idempotencyKey = input.idempotencyKey === undefined
      ? `release:${reservationId}`
      : idempotencyKeyValue(input.idempotencyKey);
    const expectedRevision = expectedRevisionValue(input.expectedRevision);
    const userEventId = optionalId(input.userEventId, 'INVALID_USER_EVENT', 'userEventId');
    const actor = optionalId(input.actor, 'INVALID_ACTOR', 'actor');
    const reason = optionalText(input.reason, 'reason');

    return commit({
      idempotencyKey,
      expectedRevision,
      payload: (record) => ({
        op: 'release',
        reservationId,
        unit: resolveUnit(record, input.unit),
        reason,
        userEventId,
        actor,
      }),
      build: (record) => {
        const derived = derive(record);
        const reserved = derived.open.get(reservationId);
        if (!reserved) {
          fail('RESERVATION_NOT_OPEN', 'reservation is not open for release', { reservationId });
        }
        return {
          kind: 'release',
          reservationId,
          released: reserved.hold,
          hold: reserved.hold,
          ...(reason === undefined ? {} : { reason }),
          ...(userEventId === undefined ? {} : { userEventId }),
          ...(actor === undefined ? {} : { actor }),
        };
      },
    });
  }

  function setCeiling(input = {}) {
    if (!isPlainObject(input)) fail('INVALID_CEILING', 'setCeiling input must be an object');
    if (input.actor !== 'user') {
      fail('AGENT_CANNOT_SET_CEILING', 'only the user may set or amend the spend ceiling', { actor: input.actor });
    }
    const userEventId = userEventIdValue(input.userEventId);
    const ceiling = ceilingValue(input.ceiling);
    // Commands normally supply their own key. A missing key falls back to a
    // deterministic per-user-event/per-ceiling key so a retried amendment is
    // still idempotent rather than appending twice.
    const idempotencyKey = input.idempotencyKey === undefined
      ? idempotencyKeyValue(`authorization:${userEventId}:${ceiling === null ? 'none' : String(ceiling)}`)
      : idempotencyKeyValue(input.idempotencyKey);
    const expectedRevision = expectedRevisionValue(input.expectedRevision);
    const note = optionalText(input.note, 'note');

    return commit({
      idempotencyKey,
      expectedRevision,
      payload: (record) => ({
        op: 'setCeiling',
        ceiling,
        userEventId,
        actor: 'user',
        unit: resolveUnit(record, input.unit),
        note,
      }),
      build: () => ({
        kind: 'authorization',
        ceiling,
        userEventId,
        actor: 'user',
        ...(note === undefined ? {} : { note }),
      }),
    });
  }

  function status() {
    return statusOf(readRecord());
  }

  function snapshot() {
    const record = readRecord();
    return { ...clone(record), status: statusOf(record) };
  }

  function entries() {
    return clone(readRecord().entries);
  }

  // Initialise the file exactly once. This runs under the lock so two processes
  // opening a brand-new ledger cannot clobber each other; an existing header is
  // never overwritten, and its unit is authoritative.
  withLock(() => {
    const existing = readRecordOrNull();
    if (existing) {
      if (constructionUnit !== null && constructionUnit !== existing.unit) {
        fail('UNIT_MISMATCH', 'ledger unit does not match the requested unit', {
          unit: constructionUnit,
          ledgerUnit: existing.unit,
        });
      }
      return;
    }
    const at = clockIso(clock);
    const unit = constructionUnit ?? DEFAULT_UNIT;
    const record = {
      schema: BUDGET_LEDGER_SCHEMA,
      ledgerId,
      unit,
      revision: 0,
      createdAt: at,
      updatedAt: at,
      entries: [],
    };
    if (initialCeiling !== null) {
      const authorization = {
        kind: 'authorization',
        ceiling: initialCeiling,
        actor: 'user',
        userEventId: initialUserEventId,
      };
      record.entries.push({
        id: 'lede_1',
        revision: 1,
        ledgerId,
        at,
        idempotencyKey: 'authorization:creation',
        requestHash: requestHashOf({
          op: 'setCeiling',
          ceiling: initialCeiling,
          actor: 'user',
          userEventId: initialUserEventId,
          unit,
        }),
        unit,
        ...authorization,
      });
      record.revision = 1;
    }
    writeRecord(record);
  });

  return {
    ledgerId,
    paths: { ...paths },
    reserve,
    settle,
    release,
    setCeiling,
    status,
    snapshot,
    entries,
  };
}
