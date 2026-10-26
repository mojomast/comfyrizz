// UX04: hydrated production snapshots.
//
// A reconnect or server restart must recover the current plan, actions,
// decisions and errors together with the committed journal cursor. The plain
// production document does not carry those derived views, and an empty event
// replay is not evidence that work finished. This module is a pure projection
// over the production store's committed journal: it never reads a run status
// from a spinner, never calls a backend and never invents a completion.
//
// The route/store owner mounts `readProductionSnapshot`; the browser client
// consumes the extra fields when present and keeps working with older
// snapshots that only carry production/revision/lastSequence.

import { REJECTING_OPTION_IDS, isTrustedPlan } from './actions.mjs';

export const SNAPSHOT_CONTRACT = 'comfyrizz.production-snapshot/v1';

export const EXECUTION_STATUSES = Object.freeze([
  'unknown',
  'active',
  'reconcile',
  'attention',
  'terminal',
]);

export const RECOVERY_ACTION_IDS = Object.freeze([
  'reconnect',
  'retry_download',
  'reconcile_shutdown',
  'new_generation',
]);

const IN_FLIGHT_ACTIONS = new Set([
  'planned',
  'awaiting_decision',
  'queued',
  'dispatching',
  'running',
  'collecting',
  'verifying',
  'cancel_requested',
]);

const TERMINAL_ACTIONS = new Set(['completed', 'failed', 'cancelled']);
const RECONCILE_ACTIONS = new Set(['submission_unknown', 'reconciling']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sequenceOf(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function eventSequence(event) {
  return isPlainObject(event) ? sequenceOf(event.sequence) : 0;
}

function bySequence(left, right) {
  return eventSequence(left) - eventSequence(right);
}

function committedEventsFor(production, events) {
  if (!Array.isArray(events)) return [];
  const productionId = typeof production?.id === 'string' ? production.id : null;
  const lastSequence = sequenceOf(production?.lastSequence);
  return events
    .filter((event) => isPlainObject(event))
    .filter((event) => productionId === null || event.productionId === undefined
      || event.productionId === productionId)
    .filter((event) => eventSequence(event) <= lastSequence)
    .sort(bySequence)
    .map(clone);
}

function planProjection(events) {
  let plan = null;
  for (const event of events) {
    if (event.type !== 'plan.proposed' || !isTrustedPlan(event.data)) continue;
    plan = event.data;
  }
  if (!plan) return null;

  let status = 'pending';
  for (const event of events) {
    if (event.type !== 'plan.approved' && event.type !== 'plan.rejected') continue;
    const data = event.data;
    if (!isPlainObject(data) || data.planHash !== plan.planHash) continue;
    if (data.planId !== undefined && data.planId !== plan.id) continue;
    status = event.type === 'plan.approved' ? 'approved' : 'rejected';
  }

  return {
    ...clone(plan),
    approval: {
      status,
      planId: plan.id,
      planHash: plan.planHash,
    },
  };
}

function actionProjections(events) {
  const actions = new Map();
  for (const event of events) {
    if (event.type !== 'action.state_changed' || !isPlainObject(event.data)) continue;
    const data = event.data;
    if (typeof data.id !== 'string' || data.id === '') continue;
    const prior = actions.get(data.id);
    const next = prior === undefined
      ? { ...clone(data) }
      : { ...prior, ...clone(data) };
    next.lastSequence = eventSequence(event);
    actions.set(data.id, next);
  }
  return [...actions.values()];
}

function decisionStatus(decisionId, request, resolution, pendingIds) {
  if (pendingIds.has(decisionId)) return 'pending';
  if (resolution) {
    if (resolution.status === 'rejected') return 'rejected';
    if (typeof resolution.status === 'string' && resolution.status !== '') return resolution.status;
    if (typeof resolution.optionId === 'string'
      && REJECTING_OPTION_IDS.includes(resolution.optionId)) {
      return 'rejected';
    }
    if (typeof resolution.optionId === 'string' && resolution.optionId !== '') return 'resolved';
  }
  if (request && typeof request.status === 'string' && request.status !== '') return request.status;
  return 'unknown';
}

function decisionProjections(events, production) {
  const requests = new Map();
  const resolutions = new Map();
  for (const event of events) {
    if (!isPlainObject(event.data)) continue;
    const data = event.data;
    const decisionId = typeof data.decisionId === 'string'
      ? data.decisionId
      : (typeof data.id === 'string' ? data.id : null);
    if (decisionId === null || decisionId === '') continue;
    if (event.type === 'decision.requested') requests.set(decisionId, clone(data));
    if (event.type === 'decision.resolved') resolutions.set(decisionId, clone(data));
  }

  const pendingIds = new Set(
    Array.isArray(production?.pendingDecisionIds) ? production.pendingDecisionIds : [],
  );
  const ids = new Set([...requests.keys(), ...resolutions.keys(), ...pendingIds]);
  const decisions = [];
  for (const decisionId of ids) {
    const request = requests.get(decisionId) ?? null;
    const resolution = resolutions.get(decisionId) ?? null;
    const status = decisionStatus(decisionId, request, resolution, pendingIds);
    decisions.push({
      ...(request ?? { id: decisionId, options: [] }),
      id: decisionId,
      status,
      ...(resolution === null ? {} : { resolution }),
    });
  }
  decisions.sort((left, right) => left.id.localeCompare(right.id));
  return decisions;
}

function errorProjections(events) {
  const errors = [];
  for (const event of events) {
    if (!isPlainObject(event.data)) continue;
    if (event.type === 'production.failed') {
      const data = event.data;
      errors.push({
        source: 'production',
        code: typeof data.code === 'string' ? data.code : null,
        message: typeof data.message === 'string' ? data.message : null,
        at: event.at ?? null,
        sequence: eventSequence(event),
      });
      continue;
    }
    if (event.type !== 'action.state_changed') continue;
    const data = event.data;
    if (data.state !== 'failed' && data.lastError === null) continue;
    if (data.state !== 'failed' && data.lastError === undefined) continue;
    const lastError = isPlainObject(data.lastError) ? data.lastError : {};
    errors.push({
      source: 'action',
      actionId: typeof data.id === 'string' ? data.id : null,
      code: typeof lastError.code === 'string' ? lastError.code : null,
      message: typeof lastError.message === 'string' ? lastError.message : null,
      at: event.at ?? null,
      sequence: eventSequence(event),
    });
  }
  return errors;
}

function actionNeedsReconciliation(action) {
  if (!isPlainObject(action) || typeof action.state !== 'string') return false;
  if (RECONCILE_ACTIONS.has(action.state)) return true;
  if (action.state === 'interrupted') return typeof action.runId === 'string' && action.runId !== '';
  if (action.state === 'failed') return typeof action.runId === 'string' && action.runId !== '';
  if (action.state === 'cancel_requested') {
    return typeof action.runId === 'string' && action.runId !== '';
  }
  return false;
}

function executionProjection(actions, lastSequence) {
  const activeActionIds = [];
  const reconcileActionIds = [];
  const failedActionIds = [];
  const terminalActionIds = [];

  for (const action of actions) {
    const id = typeof action.id === 'string' ? action.id : null;
    if (id === null) continue;
    const state = typeof action.state === 'string' ? action.state : 'unknown';
    if (IN_FLIGHT_ACTIONS.has(state)) activeActionIds.push(id);
    if (actionNeedsReconciliation(action)) reconcileActionIds.push(id);
    if (state === 'failed') failedActionIds.push(id);
    if (TERMINAL_ACTIONS.has(state)) terminalActionIds.push(id);
  }

  let status = 'unknown';
  if (reconcileActionIds.length > 0) status = 'reconcile';
  else if (activeActionIds.length > 0) status = 'active';
  else if (actions.length > 0 && terminalActionIds.length === actions.length) status = 'terminal';
  else if (actions.length > 0) status = 'attention';

  return {
    status,
    evidence: 'journal',
    lastSequence,
    activeActionIds,
    reconcileActionIds,
    failedActionIds,
    terminalActionIds,
    reconcileRequired: reconcileActionIds.length > 0,
  };
}

function hasDownloadableDelivery(production, events) {
  if (typeof production?.latestDeliveryId === 'string' && production.latestDeliveryId !== '') {
    return true;
  }
  for (const event of events) {
    if (event.type !== 'delivery.updated' || !isPlainObject(event.data)) continue;
    if (typeof event.data.artifactId === 'string' && event.data.artifactId !== '') return true;
    if (typeof event.data.mediaId === 'string' && event.data.mediaId !== '') return true;
  }
  return false;
}

function recoveryProjection(production, events, execution) {
  const actions = [];
  if (hasDownloadableDelivery(production, events)) {
    actions.push({
      id: 'retry_download',
      reason: 'a previous delivery artifact can be fetched again without rendering',
    });
  }
  if (execution.reconcileRequired) {
    actions.push({
      id: 'reconcile_shutdown',
      reason: 'an attributed execution is uncertain; confirm shutdown before dispatching again',
    });
  }
  if (!execution.reconcileRequired && execution.activeActionIds.length === 0) {
    actions.push({
      id: 'new_generation',
      reason: 'no server-owned execution is active in the committed journal',
    });
  }
  return { actions };
}

/**
 * Build the complete actionable snapshot for one production.
 *
 * `events` are committed journal entries; entries that belong to another
 * production or lie beyond `production.lastSequence` are ignored. `epoch`
 * identifies the journal generation, so a client can tell a restart from a
 * quiet journal. An empty journal yields `execution.status === 'unknown'`,
 * never a terminal or paid-work claim.
 */
export function buildProductionSnapshot({ production, events = [], epoch = null } = {}) {
  if (!isPlainObject(production) || typeof production.id !== 'string' || production.id === '') {
    throw new TypeError('buildProductionSnapshot requires a production with an id');
  }

  const committed = committedEventsFor(production, events);
  const lastSequence = sequenceOf(production.lastSequence);
  const revision = sequenceOf(production.revision);
  const plan = planProjection(committed);
  const actions = actionProjections(committed);
  const decisions = decisionProjections(committed, production);
  const pendingDecisions = decisions.filter((decision) => decision.status === 'pending');
  const pendingActions = actions.filter((action) => !TERMINAL_ACTIONS.has(action.state));
  const errors = errorProjections(committed);
  const execution = executionProjection(actions, lastSequence);
  const recovery = recoveryProjection(production, committed, execution);

  return {
    contract: SNAPSHOT_CONTRACT,
    production: clone(production),
    revision,
    lastSequence,
    epoch: typeof epoch === 'string' && epoch !== '' ? epoch : null,
    plan,
    actions,
    pendingActions,
    decisions,
    pendingDecisions,
    errors,
    execution,
    recovery,
  };
}

/**
 * Read one production and project its committed journal. This is the adapter
 * the coordinator mounts for `GET /api/productions/:id`.
 */
export function readProductionSnapshot(store, productionId, options = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.readEvents !== 'function') {
    throw new TypeError('readProductionSnapshot requires a production store');
  }
  if (typeof productionId !== 'string' || productionId === '') {
    throw new TypeError('readProductionSnapshot requires a productionId');
  }
  const production = store.read(productionId);
  if (!production) return null;
  return buildProductionSnapshot({
    production,
    events: store.readEvents(productionId),
    epoch: options?.epoch,
  });
}
