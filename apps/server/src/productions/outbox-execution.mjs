// UX03: server-owned execution of the production outbox.
//
// A dispatched action is committed with an `action.dispatch` outbox entry. This
// module is the only drain that turns those effects into pipeline work:
//
//   * each entry is claimed by one drain at a time, and the pipeline adapter's
//     journaled attempt is the cross-process fence;
//   * the action's attributed run is adopted before anything is dispatched, so
//     a dropped acknowledgement repairs itself without a second paid run;
//   * paused and archived productions leave their entries pending; they are not
//     acknowledged just because a drain looked at them;
//   * an uncertain submission is closed as `submission_unknown` and the effect
//     is acknowledged, because resubmitting it could double-charge;
//   * cancellation fans out to every durable action, aborts an attributed run
//     and reports requested, stopped or unconfirmed separately.
//
// The module never calls a backend directly, never reserves budget and never
// contacts Google Colab. A pipeline controller and the IP22 adapter supply all
// execution facts.

import { createHash, randomUUID } from 'node:crypto';

import { ACTION_STATES } from './contract.mjs';

export const OUTBOX_EXECUTION_SCHEMA = 'comfyrizz.outbox-execution/v1';

export const EXECUTION_OUTCOMES = Object.freeze([
  'started',
  'adopted',
  'completed',
  'cancelled',
  'requested',
  'stopped',
  'unconfirmed',
  'uncertain',
  'paused',
  'refused',
  'missing_package',
  'ignored',
  'failed',
]);

const ID_RE = /^[^\s/\\\u0000-\u001f]{1,256}$/u;
const DISPATCH_TYPE = 'action.dispatch';
const CANCEL_TYPE = 'action.cancel';
const TERMINAL_ACTION_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_PIPELINE_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'shutdown_unconfirmed',
]);
const ACTIVE_ACTION_STATES = new Set([
  'queued',
  'dispatching',
  'running',
  'collecting',
  'verifying',
  'cancel_requested',
  'reconciling',
  'interrupted',
  'submission_unknown',
]);

export class OutboxExecutionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OutboxExecutionError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new OutboxExecutionError('INVALID_INPUT', `${label} must be a non-empty identifier`, { [label]: value });
  }
  return value;
}

function claimIdFor(productionId, outboxId) {
  return `claim_${createHash('sha256')
    .update(`outbox.claim\u0000${productionId}\u0000${outboxId}\u0000${randomUUID()}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function latestActions(events) {
  const actions = new Map();
  for (const event of events) {
    if (event?.type !== 'action.state_changed' || !isPlainObject(event.data)) continue;
    const data = event.data;
    if (typeof data.id !== 'string') continue;
    const previous = actions.get(data.id);
    actions.set(data.id, previous ? { ...previous, ...data } : { ...data });
  }
  return actions;
}

function shutdownOf(run) {
  if (!isPlainObject(run)) return 'stopped';
  const runtimes = isPlainObject(run.runtimes) ? Object.values(run.runtimes) : [];
  if (runtimes.some((runtime) => isPlainObject(runtime)
    && runtime.ownership !== 'external'
    && runtime.state === 'stop_unconfirmed')) {
    return 'unconfirmed';
  }
  if (run.teardown?.state === 'stop_unconfirmed') return 'unconfirmed';
  if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return 'stopped';
  return 'requested';
}

function cancellationPhase(result, run) {
  const status = typeof result?.status === 'string' ? result.status : '';
  if (status === 'shutdown_unconfirmed' || status === 'submission_unknown') return 'unconfirmed';
  if (TERMINAL_PIPELINE_STATUSES.has(status)) {
    return shutdownOf(run) === 'unconfirmed' ? 'unconfirmed' : 'stopped';
  }
  if (TERMINAL_ACTION_STATES.has(result?.actionState)) {
    return result.actionState === 'failed' ? 'unconfirmed' : 'stopped';
  }
  if (status === 'cancelled') return run ? (shutdownOf(run) === 'unconfirmed' ? 'unconfirmed' : 'stopped') : 'stopped';
  if (status === 'cancel_requested') return 'requested';
  const shutdown = shutdownOf(run);
  if (shutdown === 'stopped') return 'stopped';
  if (shutdown === 'unconfirmed') return 'unconfirmed';
  return 'requested';
}

function executionStatus(result) {
  const candidates = [result?.status, result?.actionState];
  for (const value of candidates) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * Create the outbox executor.
 *
 * `store` is the production journal, `adapter` is the IP22 pipeline adapter and
 * `packageFor` resolves the package document for a production. `ledgerFor`
 * optionally supplies the production ledger so a queued cancel can release a
 * never-used hold; settlements are the run controller's responsibility.
 */
export function createOutboxExecutor(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('createOutboxExecutor options must be an object');
  }
  const { store, adapter, packageFor = null, ledgerFor = null } = options;
  if (!store
    || typeof store.read !== 'function'
    || typeof store.list !== 'function'
    || typeof store.readEvents !== 'function'
    || typeof store.pending !== 'function'
    || typeof store.acknowledgeOutboxEntry !== 'function') {
    throw new TypeError('createOutboxExecutor requires a production store with pending and acknowledgeOutboxEntry');
  }
  if (!adapter
    || typeof adapter.admit !== 'function'
    || typeof adapter.cancel !== 'function'
    || typeof adapter.observe !== 'function') {
    throw new TypeError('createOutboxExecutor requires a pipeline adapter');
  }
  if (packageFor !== null && typeof packageFor !== 'function') {
    throw new TypeError('packageFor must be a function when supplied');
  }
  if (ledgerFor !== null && typeof ledgerFor !== 'function') {
    throw new TypeError('ledgerFor must be a function when supplied');
  }

  // Entries may be delivered twice by the durable store. This process holds one
  // claim per production/entry; cross-process safety comes from the adapter's
  // journaled attempt and attributed run.
  const claims = new Map();

  function serialized(key, fn) {
    const previous = claims.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.then(() => {}, () => {});
    claims.set(key, tail);
    tail.then(() => { if (claims.get(key) === tail) claims.delete(key); });
    return result;
  }

  function acknowledge(productionId, outboxId) {
    try {
      const result = store.acknowledgeOutboxEntry({ productionId, outboxId });
      return result?.acknowledged !== false;
    } catch {
      return false;
    }
  }

  function ledgerForProduction(production) {
    if (!ledgerFor || !production) return null;
    try {
      return ledgerFor(production);
    } catch {
      return null;
    }
  }

  function releaseQueuedHold(production, action) {
    const ledger = ledgerForProduction(production);
    const reservationId = typeof action?.reservationId === 'string' ? action.reservationId : null;
    if (!ledger || !reservationId || typeof ledger.release !== 'function') return false;
    try {
      ledger.release({
        reservationId,
        idempotencyKey: `cancel-release:${production.id}:${action.id}:${reservationId}`,
        reason: 'action_cancelled_before_start',
      });
      return true;
    } catch (error) {
      return error?.code === 'RESERVATION_NOT_OPEN';
    }
  }

  async function dispatchEntry(entry, context) {
    const payload = isPlainObject(entry.payload) ? entry.payload : {};
    const productionId = requireIdentifier(payload.productionId, 'productionId');
    const actionId = requireIdentifier(payload.actionId, 'actionId');
    const production = store.read(productionId);
    if (!production) {
      return { outcome: 'failed', acknowledged: false, reason: 'production_missing', productionId, actionId };
    }
    if (production.intent === 'paused' || production.intent === 'archived') {
      return {
        outcome: 'paused',
        acknowledged: false,
        reason: production.intent === 'paused' ? 'production_paused' : 'production_archived',
        productionId,
        actionId,
      };
    }
    const pkg = context.pkg
      ?? (packageFor ? packageFor(production) : null)
      ?? (production.packageId && typeof store.readPackage === 'function' ? store.readPackage(production.packageId) : null);
    if (!pkg) {
      return { outcome: 'missing_package', acknowledged: false, reason: 'package_unavailable', productionId, actionId };
    }

    let result;
    try {
      result = await adapter.admit({
        productionId,
        actionId,
        pkg,
        input: context.input,
        sourceDir: context.sourceDir,
        claimId: context.claimId,
      });
    } catch (error) {
      return {
        outcome: 'failed',
        acknowledged: false,
        reason: error?.code ?? 'DISPATCH_FAILED',
        message: error?.message ?? 'the dispatch failed',
        productionId,
        actionId,
      };
    }

    if (result?.reason === 'production_paused' || result?.reason === 'production_archived') {
      return {
        outcome: 'paused',
        acknowledged: false,
        reason: result.reason,
        productionId,
        actionId,
        action: result.action ?? null,
      };
    }
    if (result?.claimLost) {
      return {
        outcome: 'ignored',
        acknowledged: false,
        reason: 'claim_lost',
        productionId,
        actionId,
        action: result.action ?? null,
      };
    }

    const status = executionStatus(result);
    let outcome = 'failed';
    if (result?.reconcileRequired) outcome = 'uncertain';
    else if (result?.started) outcome = 'started';
    else if (result?.adopted) outcome = 'adopted';
    else if (status === 'cancelled' || result?.actionState === 'cancelled') outcome = 'cancelled';
    else if (status === 'cancel_requested' || result?.actionState === 'cancel_requested') outcome = 'requested';
    else if (status === 'completed') outcome = 'completed';
    else if (status === 'failed' || status === 'blocked') outcome = 'refused';
    else if (status === 'interrupted' || status === 'submission_unknown') outcome = 'uncertain';
    else if (result?.admitted) outcome = 'started';

    // A durable terminal, blocked or uncertain action is never dispatched by a
    // later drain, so acknowledging the effect is safe. A transient exception
    // (failed outcome) leaves it pending for a bounded retry.
    const acknowledged = outcome === 'failed' || outcome === 'missing_package'
      ? false
      : acknowledge(productionId, entry.id);
    return {
      outcome,
      acknowledged,
      productionId,
      actionId,
      actionState: result?.actionState ?? null,
      runId: result?.run?.runId ?? null,
      status,
      reconcileRequired: result?.reconcileRequired === true,
      action: result?.action ?? null,
      run: result?.run ?? null,
    };
  }

  async function cancelEntry(entry, context) {
    const payload = isPlainObject(entry.payload) ? entry.payload : {};
    const productionId = requireIdentifier(payload.productionId, 'productionId');
    const actionId = requireIdentifier(payload.actionId, 'actionId');
    const production = store.read(productionId);
    if (!production) {
      return { outcome: 'failed', acknowledged: false, reason: 'production_missing', productionId, actionId };
    }

    let result;
    try {
      result = await adapter.cancel({ productionId, actionId });
    } catch (error) {
      return {
        outcome: 'failed',
        acknowledged: false,
        reason: error?.code ?? 'CANCEL_FAILED',
        message: error?.message ?? 'the cancel failed',
        productionId,
        actionId,
      };
    }

    const phase = cancellationPhase(result, result?.run);
    let released = false;
    if (phase === 'stopped' && !result?.run) {
      const action = result?.action ?? latestActions(store.readEvents(productionId)).get(actionId) ?? null;
      released = releaseQueuedHold(production, action);
    }
    const acknowledged = acknowledge(productionId, entry.id);
    return {
      outcome: phase === 'requested' ? 'requested' : phase === 'unconfirmed' ? 'unconfirmed' : 'cancelled',
      acknowledged,
      productionId,
      actionId,
      phase,
      released,
      actionState: result?.actionState ?? null,
      runId: result?.run?.runId ?? payload.runId ?? null,
      status: result?.status ?? null,
      action: result?.action ?? null,
      run: result?.run ?? null,
    };
  }

  async function executeEntry(entry, context) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || typeof entry.type !== 'string') {
      return { outcome: 'ignored', acknowledged: false, reason: 'invalid_outbox_entry' };
    }
    if (entry.type === DISPATCH_TYPE) return dispatchEntry(entry, context);
    if (entry.type === CANCEL_TYPE) return cancelEntry(entry, context);
    return { outcome: 'ignored', acknowledged: false, reason: 'unsupported_outbox_type', entryId: entry.id };
  }

  function normalizeContext(context = {}) {
    if (!isPlainObject(context)) {
      throw new OutboxExecutionError('INVALID_CONTEXT', 'drain options must be an object');
    }
    const maxEntries = context.maxEntries === undefined ? 32 : context.maxEntries;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 256) {
      throw new OutboxExecutionError('INVALID_CONTEXT', 'maxEntries must be an integer between 1 and 256');
    }
    return { ...context, maxEntries };
  }

  async function drainProduction(productionId, options = {}) {
    requireIdentifier(productionId, 'productionId');
    const context = normalizeContext(options);
    const production = store.read(productionId);
    if (!production) {
      throw new OutboxExecutionError('NOT_FOUND', 'production does not exist', { productionId });
    }
    const pending = store.pending(productionId);
    const supported = pending
      .filter((entry) => entry.type === DISPATCH_TYPE || entry.type === CANCEL_TYPE)
      .slice(0, context.maxEntries);
    const entries = [];
    for (const entry of supported) {
      const key = `${productionId}\u0000${entry.id}`;
      const result = await serialized(key, () => executeEntry(entry, {
        ...context,
        claimId: context.claimId ?? claimIdFor(productionId, entry.id),
      }));
      entries.push({ entryId: entry.id, type: entry.type, ...result });
    }
    return {
      schema: OUTBOX_EXECUTION_SCHEMA,
      productionId,
      entries,
      pending: store.pending(productionId).length,
      started: entries.filter((entry) => entry.outcome === 'started').length,
      adopted: entries.filter((entry) => entry.outcome === 'adopted').length,
      paused: entries.filter((entry) => entry.outcome === 'paused').length,
      uncertain: entries.filter((entry) => entry.outcome === 'uncertain').length,
      cancelled: entries.filter((entry) => entry.outcome === 'cancelled' || entry.outcome === 'requested').length,
      failed: entries.filter((entry) => entry.outcome === 'failed').length,
    };
  }

  async function drainAll(options = {}) {
    const context = normalizeContext(options);
    const productions = typeof store.list === 'function' ? store.list() : [];
    const results = [];
    for (const production of productions) {
      results.push(await drainProduction(production.id, context));
    }
    return {
      schema: OUTBOX_EXECUTION_SCHEMA,
      productions: results,
      drained: results.reduce((sum, result) => sum + result.entries.length, 0),
      started: results.reduce((sum, result) => sum + result.started, 0),
      adopted: results.reduce((sum, result) => sum + result.adopted, 0),
      uncertain: results.reduce((sum, result) => sum + result.uncertain, 0),
    };
  }

  /**
   * Durable cancel fan-out. Every non-terminal action is journaled through the
   * adapter; an attributed run is aborted by the adapter's retained controller
   * handle. The result separates the request from confirmed shutdown.
   */
  function cancelProduction({ productionId } = {}) {
    requireIdentifier(productionId, 'productionId');
    const production = store.read(productionId);
    if (!production) {
      throw new OutboxExecutionError('NOT_FOUND', 'production does not exist', { productionId });
    }
    const actions = latestActions(store.readEvents(productionId));
    const requested = [];
    const stopped = [];
    const unconfirmed = [];
    const ignored = [];
    for (const action of actions.values()) {
      if (!ACTION_STATES.includes(action.state)) {
        ignored.push({ actionId: action.id, state: action.state ?? null, reason: 'unknown_action_state' });
        continue;
      }
      if (action.state === 'cancelled' || action.state === 'completed') {
        stopped.push({
          actionId: action.id,
          state: action.state,
          runId: action.runId ?? null,
          phase: 'stopped',
          status: action.state,
        });
        continue;
      }
      let result;
      try {
        result = adapter.cancel({ productionId, actionId: action.id });
      } catch (error) {
        ignored.push({
          actionId: action.id,
          state: action.state,
          reason: error?.code ?? 'CANCEL_FAILED',
          message: error?.message ?? 'the cancel failed',
        });
        continue;
      }
      const phase = cancellationPhase(result, result?.run);
      const record = {
        actionId: action.id,
        state: result?.actionState ?? action.state,
        runId: result?.run?.runId ?? action.runId ?? null,
        phase,
        status: result?.status ?? null,
      };
      if (phase === 'requested') requested.push(record);
      else if (phase === 'unconfirmed') unconfirmed.push(record);
      else stopped.push(record);

      if (phase === 'stopped' && !result?.run && ACTIVE_ACTION_STATES.has(action.state)) {
        releaseQueuedHold(production, result?.action ?? action);
      }
    }
    return {
      schema: OUTBOX_EXECUTION_SCHEMA,
      productionId,
      requested,
      stopped,
      unconfirmed,
      ignored,
      actions: [...requested, ...stopped, ...unconfirmed],
    };
  }

  /**
   * Observe every active action against the pipeline controller. This repairs a
   * journal that lags the run after a crash and never admits new work.
   */
  async function reconcileProduction({ productionId } = {}) {
    requireIdentifier(productionId, 'productionId');
    const production = store.read(productionId);
    if (!production) {
      throw new OutboxExecutionError('NOT_FOUND', 'production does not exist', { productionId });
    }
    const actions = latestActions(store.readEvents(productionId));
    const observations = [];
    for (const action of actions.values()) {
      if (!ACTIVE_ACTION_STATES.has(action.state)) continue;
      const observed = await adapter.observe({ productionId, actionId: action.id });
      observations.push({
        actionId: action.id,
        state: observed?.actionState ?? action.state,
        status: observed?.status ?? null,
        changed: observed?.changed === true,
        reconcileRequired: observed?.reconcileRequired === true,
        runId: observed?.run?.runId ?? action.runId ?? null,
      });
    }
    return {
      schema: OUTBOX_EXECUTION_SCHEMA,
      productionId,
      observations,
      changed: observations.filter((entry) => entry.changed).length,
      reconcileRequired: observations.filter((entry) => entry.reconcileRequired).length,
    };
  }

  /**
   * Startup/event hook for the coordinator. A cancel intent fans out to active
   * actions; a terminal action wakes the next outbox drain only when requested.
   */
  async function onEvent(event) {
    if (!isPlainObject(event)) return { handled: false, reason: 'invalid_event' };
    if (event.type === 'production.cancelled'
      || (event.type === 'production.intent_changed' && event.data?.intent === 'cancel_requested')) {
      const productionId = event.productionId;
      if (typeof productionId !== 'string' || productionId === '') {
        return { handled: false, reason: 'missing_production' };
      }
      return { handled: true, cancel: cancelProduction({ productionId }) };
    }
    if (event.type === 'action.state_changed'
      && TERMINAL_ACTION_STATES.has(event.data?.state)
      && typeof event.productionId === 'string') {
      return { handled: true, drain: await drainProduction(event.productionId) };
    }
    return { handled: false, reason: 'not_an_execution_event' };
  }

  return Object.freeze({
    drainProduction,
    drainAll,
    cancelProduction,
    reconcileProduction,
    onEvent,
  });
}
