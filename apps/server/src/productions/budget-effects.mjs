// UX02: executor-facing budget effects on top of the durable production ledger.
//
// The ledger is the only accounting authority. This module adds the identity
// and recovery layer an executor needs after a crash:
//
//   * an effect id is stored on the reservation, settlement and release
//     entries, so a restarted process can find the hold it already created;
//   * settlement and release use deterministic effect keys, so retrying a
//     failed write is idempotent and never charges the same hold twice;
//   * open holds whose effect is no longer known are discoverable (including
//     legacy holds with no effect id) and can be released explicitly;
//   * a cap command is journaled first and applied to the ledger second. If the
//     process dies between the two, reconciling the journal repairs the cap
//     without appending the same authorization twice.
//
// The module never starts work, calls a backend or invents usage. Unknown
// provider liability stays bounded by the reserved hold; a caller that can
// attribute measured usage or an allocation duration supplies it explicitly.

import { createHash } from 'node:crypto';

import { ProductionLedgerError } from './ledger.mjs';

export const BUDGET_EFFECTS_SCHEMA = 'comfyrizz.budget-effects/v1';

const ID_RE = /^[^\s/\\\u0000-\u001f]{1,256}$/u;

export class BudgetEffectError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BudgetEffectError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message, details) {
  throw new BudgetEffectError(code, message, details);
}

function requireLedger(ledger) {
  if (!isPlainObject(ledger)
    || typeof ledger.reserve !== 'function'
    || typeof ledger.settle !== 'function'
    || typeof ledger.release !== 'function'
    || typeof ledger.status !== 'function'
    || typeof ledger.entries !== 'function'
    || typeof ledger.setCeiling !== 'function') {
    throw new TypeError('a budget ledger with reserve, settle, release, status, entries and setCeiling is required');
  }
  return ledger;
}

function requireEffectId(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail('INVALID_EFFECT_ID', 'effectId must be a non-empty identifier', { effectId: value });
  }
  return value;
}

function optionalId(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail('INVALID_EFFECT_IDENTITY', `${label} must be a non-empty identifier`, { [label]: value });
  }
  return value;
}

function reservationIdFor(effectId) {
  return `resv_${createHash('sha256').update(effectId).digest('hex').slice(0, 32)}`;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function mapLedger(error) {
  if (error instanceof BudgetEffectError) throw error;
  if (error instanceof ProductionLedgerError) {
    if (error.code === 'RESERVATION_NOT_OPEN') {
      fail('EFFECT_NOT_OPEN', 'the effect has no open reservation', {
        reservationId: error.reservationId,
      });
    }
    if (error.code === 'RESERVATION_EXISTS') {
      fail('EFFECT_ALREADY_RESERVED', 'the effect reservation is already open', {
        reservationId: error.reservationId,
      });
    }
  }
  throw error;
}

function effectView(reservation) {
  return {
    effectId: reservation.effectId ?? null,
    reservationId: reservation.reservationId,
    stage: reservation.stage ?? null,
    actionId: reservation.actionId ?? null,
    executionId: reservation.executionId ?? null,
    upperBound: reservation.upperBound,
    collectAndStopReserve: reservation.collectAndStopReserve,
    hold: reservation.hold,
    reservedAt: reservation.reservedAt,
    state: 'reserved',
    ...(reservation.metadata === undefined ? {} : { metadata: reservation.metadata }),
  };
}

/**
 * The one budget projection shared by the spend-cap endpoints, the iteration
 * read and executors. Settled spend, the still-held exposure and the remaining
 * authorization stay separate.
 */
export function budgetSummary(ledger) {
  requireLedger(ledger);
  const status = ledger.status();
  return {
    schema: BUDGET_EFFECTS_SCHEMA,
    ledgerId: status.ledgerId,
    unit: status.unit,
    revision: status.revision,
    ceiling: status.ceiling,
    capped: status.capped,
    spent: status.spent,
    reserved: status.reserved ?? status.committed,
    available: status.available,
    pending: (status.openReservations ?? []).map(effectView),
  };
}

/**
 * Durable effect state: open, settled, released, or missing. The reservation
 * id is recovered from the ledger even after a restart, so an executor does not
 * need a second in-memory map.
 */
export function effectState(ledger, effectId) {
  requireLedger(ledger);
  const wanted = requireEffectId(effectId);
  const entries = ledger.entries();
  const reserve = entries.find((entry) => entry.kind === 'reserve' && entry.effectId === wanted);
  if (!reserve) {
    const later = entries.find((entry) => entry.effectId === wanted
      && (entry.kind === 'settle' || entry.kind === 'release'));
    if (!later) return { effectId: wanted, state: 'missing', reservationId: null };
    return {
      effectId: wanted,
      state: later.kind === 'settle' ? 'settled' : 'released',
      reservationId: later.reservationId,
      ...(later.kind === 'settle'
        ? { charged: later.charged, settlementKind: later.settlementKind }
        : { released: later.released }),
      at: later.at,
    };
  }

  const settlement = entries.find((entry) => entry.kind === 'settle' && entry.reservationId === reserve.reservationId);
  const release = entries.find((entry) => entry.kind === 'release' && entry.reservationId === reserve.reservationId);
  const base = {
    effectId: wanted,
    reservationId: reserve.reservationId,
    stage: reserve.stage ?? null,
    actionId: reserve.actionId ?? null,
    executionId: reserve.executionId ?? null,
    upperBound: reserve.upperBound,
    collectAndStopReserve: reserve.collectAndStopReserve,
    hold: reserve.hold,
    reservedAt: reserve.at,
    ...(reserve.metadata === undefined ? {} : { metadata: reserve.metadata }),
  };
  if (settlement) {
    return {
      ...base,
      state: 'settled',
      charged: settlement.charged,
      settlementKind: settlement.settlementKind,
      at: settlement.at,
    };
  }
  if (release) {
    return {
      ...base,
      state: 'released',
      released: release.released,
      at: release.at,
    };
  }
  return { ...base, state: 'open' };
}

/**
 * Reserve a hold under a durable effect identity. Replaying the same effect is
 * a duplicate; reusing the effect id for a different amount is a conflict from
 * the ledger's request hash.
 */
export function reserveEffect(ledger, input = {}) {
  requireLedger(ledger);
  if (!isPlainObject(input)) fail('INVALID_EFFECT', 'reserveEffect input must be an object');
  const effectId = requireEffectId(input.effectId);
  const reservationId = input.reservationId === undefined
    ? reservationIdFor(effectId)
    : optionalId(input.reservationId, 'reservationId');
  const idempotencyKey = input.idempotencyKey === undefined
    ? `effect:reserve:${effectId}`
    : input.idempotencyKey;

  let result;
  try {
    result = ledger.reserve({
      reservationId,
      upperBound: input.upperBound,
      collectAndStopReserve: input.collectAndStopReserve,
      idempotencyKey,
      expectedRevision: input.expectedRevision,
      unit: input.unit,
      userEventId: input.userEventId,
      actor: input.actor,
      evidence: input.evidence,
      effectId,
      actionId: input.actionId,
      stage: input.stage,
      executionId: input.executionId,
      metadata: input.metadata,
    });
  } catch (error) {
    mapLedger(error);
  }

  return {
    duplicate: result.duplicate,
    created: result.duplicate !== true,
    effect: {
      effectId,
      reservationId: result.entry.reservationId,
      upperBound: result.entry.upperBound,
      collectAndStopReserve: result.entry.collectAndStopReserve,
      hold: result.entry.hold,
      stage: result.entry.stage ?? null,
      actionId: result.entry.actionId ?? null,
      executionId: result.entry.executionId ?? null,
      reservedAt: result.entry.at,
    },
    budget: budgetSummary(ledger),
  };
}

/**
 * Settle one effect. A measured/estimated/unverified settlement is explicit;
 * retries after success, failure or restart use the same effect key and charge
 * the hold once. `kind: 'reservation_unverified'` is the conservative choice
 * when the provider cannot attribute usage.
 */
export function settleEffect(ledger, input = {}) {
  requireLedger(ledger);
  if (!isPlainObject(input)) fail('INVALID_EFFECT', 'settleEffect input must be an object');

  let effectId;
  let reservationId = input.reservationId;
  if (input.effectId !== undefined && input.effectId !== null) {
    effectId = requireEffectId(input.effectId);
    const state = effectState(ledger, effectId);
    if (state.state === 'missing' && reservationId === undefined) {
      fail('EFFECT_NOT_FOUND', 'no reservation carries this effect id', { effectId });
    }
    if (reservationId === undefined) reservationId = state.reservationId;
  }
  if (reservationId === undefined) {
    fail('INVALID_EFFECT_IDENTITY', 'settleEffect requires effectId or reservationId');
  }
  const identity = effectId ?? reservationId;
  const idempotencyKey = input.idempotencyKey === undefined
    ? `effect:settle:${identity}`
    : input.idempotencyKey;

  let result;
  try {
    result = ledger.settle({
      reservationId,
      kind: input.kind,
      actualUnits: input.actualUnits,
      gpuAllocated: input.gpuAllocated,
      idempotencyKey,
      expectedRevision: input.expectedRevision,
      unit: input.unit,
      userEventId: input.userEventId,
      actor: input.actor,
      evidence: input.evidence,
      effectId,
      actionId: input.actionId,
      stage: input.stage,
      executionId: input.executionId,
    });
  } catch (error) {
    mapLedger(error);
  }

  return {
    duplicate: result.duplicate,
    settlement: result.entry,
    budget: budgetSummary(ledger),
  };
}

/**
 * Release one effect's hold. Repeating the release after success, failure or
 * restart is a duplicate, never a second mutation of another reservation.
 */
export function releaseEffect(ledger, input = {}) {
  requireLedger(ledger);
  if (!isPlainObject(input)) fail('INVALID_EFFECT', 'releaseEffect input must be an object');

  let effectId;
  let reservationId = input.reservationId;
  if (input.effectId !== undefined && input.effectId !== null) {
    effectId = requireEffectId(input.effectId);
    const state = effectState(ledger, effectId);
    if (state.state === 'missing' && reservationId === undefined) {
      fail('EFFECT_NOT_FOUND', 'no reservation carries this effect id', { effectId });
    }
    if (reservationId === undefined) reservationId = state.reservationId;
  }
  if (reservationId === undefined) {
    fail('INVALID_EFFECT_IDENTITY', 'releaseEffect requires effectId or reservationId');
  }
  const identity = effectId ?? reservationId;
  const idempotencyKey = input.idempotencyKey === undefined
    ? `effect:release:${identity}`
    : input.idempotencyKey;

  let result;
  try {
    result = ledger.release({
      reservationId,
      idempotencyKey,
      expectedRevision: input.expectedRevision,
      unit: input.unit,
      userEventId: input.userEventId,
      actor: input.actor,
      reason: input.reason,
      effectId,
      actionId: input.actionId,
      stage: input.stage,
      executionId: input.executionId,
    });
  } catch (error) {
    mapLedger(error);
  }

  return {
    duplicate: result.duplicate,
    release: result.entry,
    budget: budgetSummary(ledger),
  };
}

/**
 * Holds whose owning effect is not in `knownEffectIds`. A legacy hold with no
 * effect id is included because it cannot be proven live. The caller decides
 * whether to resume or release; this read never mutates the ledger.
 */
export function orphanEffects(ledger, options = {}) {
  requireLedger(ledger);
  const known = new Set(Array.isArray(options.knownEffectIds) ? options.knownEffectIds : []);
  const pending = ledger.status().openReservations ?? [];
  return pending
    .filter((reservation) => reservation.effectId === undefined || !known.has(reservation.effectId))
    .map(effectView)
    .sort((left, right) => {
      const byTime = String(left.reservedAt).localeCompare(String(right.reservedAt));
      return byTime !== 0 ? byTime : left.reservationId.localeCompare(right.reservationId);
    });
}

/**
 * Release every orphan hold explicitly. A repeated reconciliation over the same
 * ledger finds nothing because the holds are already closed.
 */
export function reclaimOrphanEffects(ledger, options = {}) {
  requireLedger(ledger);
  const reclaimed = [];
  const failed = [];
  for (const orphan of orphanEffects(ledger, options)) {
    try {
      const released = releaseEffect(ledger, {
        ...(orphan.effectId === null ? {} : { effectId: orphan.effectId }),
        reservationId: orphan.reservationId,
        reason: options.reason,
        userEventId: options.userEventId,
        actor: options.actor,
      });
      reclaimed.push({
        ...orphan,
        state: 'released',
        releasedAt: released.release.at,
      });
    } catch (error) {
      failed.push({ ...orphan, error: error?.code ?? 'RELEASE_FAILED' });
    }
  }
  return { reclaimed, failed, budget: budgetSummary(ledger) };
}

function capEvent(event) {
  if (!isPlainObject(event)) fail('CAP_EFFECT_INVALID', 'a cap effect must be an event object');
  if (event.type !== 'budget.ceiling_set') {
    fail('CAP_EFFECT_UNSUPPORTED', 'only budget.ceiling_set is a cap effect', { type: event.type ?? null });
  }
  if (typeof event.id !== 'string' || event.id === '') {
    fail('CAP_EFFECT_INVALID', 'a cap effect requires its journal event id');
  }
  if (!isPlainObject(event.data) || !Object.prototype.hasOwnProperty.call(event.data, 'ceiling')) {
    fail('CAP_EFFECT_INVALID', 'a cap effect requires data.ceiling');
  }
  const ceiling = event.data.ceiling;
  if (ceiling !== null && (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0)) {
    fail('CAP_EFFECT_INVALID', 'data.ceiling must be null or a finite non-negative number', {
      eventId: event.id,
    });
  }
  return ceiling;
}

/**
 * Apply one journaled cap event to the ledger. The journal event is the durable
 * identity, so the ledger write can be retried after a crash without appending
 * the same authorization twice.
 */
export function applyCapEffect(ledger, event) {
  requireLedger(ledger);
  const ceiling = capEvent(event);
  const userEventId = typeof event.userEventId === 'string' && event.userEventId !== ''
    ? event.userEventId
    : event.id;
  let result;
  try {
    result = ledger.setCeiling({
      ceiling,
      actor: 'user',
      userEventId,
      idempotencyKey: `cap:${event.id}`,
    });
  } catch (error) {
    mapLedger(error);
  }
  return {
    applied: result.duplicate !== true,
    duplicate: result.duplicate,
    entry: result.entry,
    budget: budgetSummary(ledger),
  };
}

/**
 * Repair cap journal-before-ledger gaps. Events are applied in journal order;
 * already-applied events are duplicates. Safe to run on every restart.
 */
export function reconcileCapEffects(ledger, events) {
  requireLedger(ledger);
  if (!Array.isArray(events)) fail('CAP_EFFECT_INVALID', 'cap reconciliation needs the production event list');
  let applied = 0;
  let duplicates = 0;
  for (const event of events) {
    if (!isPlainObject(event) || event.type !== 'budget.ceiling_set') continue;
    const result = applyCapEffect(ledger, event);
    if (result.applied) applied += 1;
    else duplicates += 1;
  }
  return { applied, duplicates, budget: budgetSummary(ledger) };
}

/**
 * Bound a settlement when the provider cannot give an attributed charge.
 * Measured usage wins; otherwise recorded allocation seconds at the known rate
 * are used but never exceed the hold; with no evidence the full hold is charged
 * and remains explicitly uncertain.
 */
export function estimateLiability(input = {}) {
  if (!isPlainObject(input)) fail('INVALID_LIABILITY', 'estimateLiability input must be an object');
  const upperBound = input.upperBound;
  const collectAndStopReserve = input.collectAndStopReserve === undefined ? 0 : input.collectAndStopReserve;
  for (const [label, value] of [['upperBound', upperBound], ['collectAndStopReserve', collectAndStopReserve]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail('INVALID_LIABILITY', `${label} must be a finite non-negative number`, { field: label });
    }
  }
  const hold = round3(upperBound + collectAndStopReserve);

  if (input.measuredUnits !== undefined && input.measuredUnits !== null) {
    if (typeof input.measuredUnits !== 'number' || !Number.isFinite(input.measuredUnits) || input.measuredUnits < 0) {
      fail('INVALID_LIABILITY', 'measuredUnits must be a finite non-negative number');
    }
    return { kind: 'actual', units: round3(input.measuredUnits), uncertain: false, basis: 'measured', hold };
  }

  if (input.allocatedSeconds !== undefined && input.allocatedSeconds !== null) {
    if (typeof input.allocatedSeconds !== 'number' || !Number.isFinite(input.allocatedSeconds) || input.allocatedSeconds < 0) {
      fail('INVALID_LIABILITY', 'allocatedSeconds must be a finite non-negative number');
    }
    if (typeof input.ratePerHour !== 'number' || !Number.isFinite(input.ratePerHour) || input.ratePerHour < 0) {
      fail('INVALID_LIABILITY', 'ratePerHour must be a finite non-negative number when allocatedSeconds is supplied');
    }
    const estimated = round3((input.allocatedSeconds / 3600) * input.ratePerHour);
    return { kind: 'estimated', units: round3(Math.min(hold, estimated)), uncertain: true, basis: 'allocation', hold };
  }

  return { kind: 'reservation_unverified', units: hold, uncertain: true, basis: 'hold', hold };
}
