// IP21: deterministic next step and bounded continuation.
//
// The coordinator is the scheduling layer between the durable journal (IP17)
// and the action coordinator (IP20). It is deliberately small and closed:
//
//   * `deriveNextStep` is a pure function of the production snapshot and its
//     committed events. The same state always yields the same step, so a
//     restart, a retry or a second process computes the same work.
//   * `onEvent` schedules a continuation for a terminal action or stage event.
//     Scheduling is process-local but idempotent per event id: delivering the
//     same event twice never queues to work twice.
//   * `continue` re-reads the snapshot on every step, executes at most
//     `maxSteps` admissions, and stops at the first step it cannot execute.
//     A bounded drain keeps the continuation so a later drain resumes exactly
//     where this one stopped.
//
// This module never calls a backend and never settles budget. Dispatch goes
// through the IP20 action coordinator, which reserves one approved slot and
// writes the side effect to the IP17 outbox. Paused, archived, cancelling or
// superseded productions are suppressed before any step is admitted.

import { createHash } from 'node:crypto';

const ID_RE = /^[^\s/\\\u0000-\u001f]+$/u;

const DEFAULT_MAX_STEPS = 8;
const MAX_MAX_STEPS = 64;
const SEEN_EVENT_LIMIT = 1024;

// Events that can reveal new work. An action is the important one: only a
// terminal action state continues the production. Plan, decision, take and
// stage events are included so adapters can wake the same path without a
// second scheduler.
const CONTINUATION_EVENT_TYPES = new Set([
  'plan.approved',
  'stage.completed',
  'take.landed',
  'decision.resolved',
  'delivery.updated',
]);

const TERMINAL_ACTION_STATES = new Set([
  'completed',
  'failed',
  'interrupted',
  'submission_unknown',
  'cancelled',
]);

const PROBLEM_ACTION_STATES = new Set([
  'failed',
  'blocked',
  'submission_unknown',
  'interrupted',
  'cancelled',
]);

const IN_FLIGHT_ACTION_STATES = new Set([
  'queued',
  'dispatching',
  'running',
  'collecting',
  'verifying',
  'cancel_requested',
  'reconciling',
]);

// Intent-changing events create a barrier: a completion that happened before
// the user changed their mind may not resume the old work after a resume.
const INTENT_BARRIER_TYPES = new Set([
  'production.intent_changed',
  'production.cancelled',
]);

export class CoordinatorError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
      Object.assign(this, details);
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && ID_RE.test(value);
}

function clockIso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CoordinatorError('INVALID_CLOCK', 'the coordinator clock returned an invalid date', 500);
  }
  return date.toISOString();
}

function stableDigest(...parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function commandIdFor(productionId, planHash, actionId) {
  return `coord_${stableDigest('coordinator', productionId, planHash, actionId).slice(0, 24)}`;
}

function continuationIdFor(productionId, eventId) {
  return `cont_${stableDigest('continuation', productionId, eventId).slice(0, 24)}`;
}

function orderedEvents(events) {
  if (!Array.isArray(events)) return [];
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => isPlainObject(event))
    .sort((left, right) => {
      const leftSequence = Number.isSafeInteger(left.event.sequence) ? left.event.sequence : 0;
      const rightSequence = Number.isSafeInteger(right.event.sequence) ? right.event.sequence : 0;
      return leftSequence - rightSequence || left.index - right.index;
    })
    .map(({ event }) => event);
}

function latestProposedPlan(events) {
  let latest = null;
  for (const event of events) {
    if (event.type !== 'plan.proposed' || !isPlainObject(event.data)) continue;
    const plan = event.data;
    if (!isIdentifier(plan.id) || typeof plan.planHash !== 'string' || plan.planHash === '') continue;
    latest = plan;
  }
  return latest;
}

function approvalState(events, plan) {
  let approved = false;
  let rejected = false;
  for (const event of events) {
    if (event.type !== 'plan.approved' && event.type !== 'plan.rejected') continue;
    const data = event.data;
    if (!isPlainObject(data) || data.planHash !== plan.planHash) continue;
    if (data.planId !== undefined && data.planId !== plan.id) continue;
    if (event.type === 'plan.approved') {
      approved = true;
      rejected = false;
    } else {
      rejected = true;
      approved = false;
    }
  }
  return { approved, rejected };
}

function decisionFacts(events, production) {
  const resolved = new Set();
  for (const event of events) {
    if (event.type !== 'decision.resolved' || !isPlainObject(event.data)) continue;
    const decisionId = event.data.decisionId ?? event.data.id;
    if (typeof decisionId === 'string') resolved.add(decisionId);
  }
  const pending = new Set(
    Array.isArray(production.pendingDecisionIds) ? production.pendingDecisionIds : [],
  );
  return { resolved, pending };
}

function unmetDecisions(plan, facts) {
  const unmet = [];
  for (const required of Array.isArray(plan.requiredDecisions) ? plan.requiredDecisions : []) {
    if (typeof required === 'string') {
      if (!facts.resolved.has(required) || facts.pending.has(required)) unmet.push(required);
      continue;
    }
    if (!isPlainObject(required)) continue;
    const decisionId = typeof required.decisionId === 'string'
      ? required.decisionId
      : (typeof required.id === 'string' ? required.id : null);
    if (decisionId) {
      if (!facts.resolved.has(decisionId) || facts.pending.has(decisionId)) unmet.push(decisionId);
      continue;
    }
    if (required.kind === 'action_spend') continue;
    if (typeof required.kind === 'string') unmet.push(`kind:${required.kind}`);
  }
  return unmet;
}

function slotFacts(events, production, plan) {
  const slots = Array.isArray(plan.actions) ? plan.actions : [];
  const ids = new Set(slots.map((slot) => slot?.id).filter(isIdentifier));
  const actionIds = new Set(Array.isArray(production.actionIds) ? production.actionIds : []);
  const facts = new Map();
  for (const slot of slots) {
    if (!isPlainObject(slot) || !isIdentifier(slot.id)) continue;
    facts.set(slot.id, {
      slot,
      admitted: actionIds.has(slot.id),
      state: actionIds.has(slot.id) ? 'queued' : null,
      record: null,
    });
  }

  for (const event of events) {
    if (event.type !== 'action.state_changed' || !isPlainObject(event.data)) continue;
    const data = event.data;
    if (!isIdentifier(data.id) || !ids.has(data.id)) continue;
    if (data.planHash !== undefined && data.planHash !== plan.planHash) continue;
    if (data.planId !== undefined && data.planId !== plan.id) continue;
    const fact = facts.get(data.id);
    if (!fact) continue;
    fact.admitted = true;
    if (typeof data.state === 'string') fact.state = data.state;
    fact.record = data;
  }

  return slots
    .filter((slot) => isPlainObject(slot) && isIdentifier(slot.id))
    .map((slot) => facts.get(slot.id));
}

function step(kind, reason, extra = {}) {
  return { kind, reason, deterministic: true, ...extra };
}

/**
 * Compute the next deterministic step.
 *
 * Called as `deriveNextStep({ production, events })`. The result is plain data:
 *
 *   await_plan | awaiting_approval | await_decision | dispatch | wait |
 *   review | complete | blocked
 *
 * `dispatch` carries `planId`, `planHash`, `planRevision`, `actionId`,
 * `slotIndex`, `slot` and the deterministic `commandId` the coordinator uses.
 */
export function deriveNextStep({ production, events: rawEvents } = {}) {

  if (!isPlainObject(production)) {
    throw new CoordinatorError('INVALID_PRODUCTION', 'deriveNextStep requires a production snapshot', 400);
  }
  const events = orderedEvents(rawEvents);

  if (production.intent !== 'active') {
    return step('suppressed', `intent_${production.intent}`, {
      productionId: production.id,
      intent: production.intent,
    });
  }

  const plan = latestProposedPlan(events);
  if (!plan) {
    const pending = Array.isArray(production.pendingDecisionIds) ? production.pendingDecisionIds : [];
    if (pending.length > 0) {
      return step('await_decision', 'decisions_pending', {
        productionId: production.id,
        decisionIds: [...pending],
      });
    }
    return step('await_plan', 'no_plan', { productionId: production.id });
  }

  const base = {
    productionId: production.id,
    planId: plan.id,
    planHash: plan.planHash,
    planRevision: plan.revision ?? 0,
  };

  const authority = approvalState(events, plan);
  if (authority.rejected) return step('blocked', 'plan_rejected', base);
  if (!authority.approved) return step('awaiting_approval', 'plan_not_approved', base);

  const facts = decisionFacts(events, production);
  const unmet = unmetDecisions(plan, facts);
  if (unmet.length > 0) {
    return step('await_decision', 'decisions_pending', { ...base, decisionIds: unmet });
  }

  const slots = slotFacts(events, production, plan);

  const failed = slots.filter((fact) => PROBLEM_ACTION_STATES.has(fact.state));
  if (failed.length > 0) {
    return step('blocked', 'action_failed', {
      ...base,
      actionIds: failed.map((fact) => fact.slot.id),
      action: clone(failed[0].record ?? { id: failed[0].slot.id, state: failed[0].state }),
    });
  }

  const next = slots.find((fact) => !fact.admitted);
  if (next) {
    return step('dispatch', 'slot_pending', {
      ...base,
      actionId: next.slot.id,
      slotIndex: slots.indexOf(next),
      slot: clone(next.slot),
      expected: { productionRevision: production.revision },
      commandId: commandIdFor(production.id, plan.planHash, next.slot.id),
    });
  }

  const inFlight = slots.filter((fact) => IN_FLIGHT_ACTION_STATES.has(fact.state));
  if (inFlight.length > 0) {
    return step('wait', 'action_in_flight', {
      ...base,
      actionIds: inFlight.map((fact) => fact.slot.id),
    });
  }

  const completed = slots.filter((fact) => fact.state === 'completed');
  if (slots.length > 0 && completed.length === slots.length) {
    if (production.latestDeliveryId !== null && production.latestDeliveryId !== undefined) {
      return step('complete', 'delivery_accepted', {
        ...base,
        deliveryId: production.latestDeliveryId,
      });
    }
    return step('review', 'all_actions_completed', {
      ...base,
      actionIds: completed.map((fact) => fact.slot.id),
    });
  }

  return step('complete', 'no_dispatchable_actions', base);
}

function isContinuationEvent(event) {
  if (!isPlainObject(event) || typeof event.type !== 'string') return false;
  if (event.type === 'action.state_changed') {
    return isPlainObject(event.data) && TERMINAL_ACTION_STATES.has(event.data.state);
  }
  return CONTINUATION_EVENT_TYPES.has(event.type);
}

function normalizeMaxSteps(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MAX_STEPS) {
    throw new CoordinatorError(
      'INVALID_MAX_STEPS',
      `maxSteps must be an integer between 1 and ${MAX_MAX_STEPS}`,
      400,
    );
  }
  return value;
}

function validateEventShape(event) {
  if (!isPlainObject(event)) {
    throw new CoordinatorError('INVALID_EVENT', 'continuation event must be an object', 400);
  }
  if (!isIdentifier(event.id)) {
    throw new CoordinatorError('INVALID_EVENT', 'continuation event requires an id', 400);
  }
  if (typeof event.type !== 'string' || event.type === '') {
    throw new CoordinatorError('INVALID_EVENT', 'continuation event requires a type', 400);
  }
}

/**
 * Create the production coordinator.
 *
 * `store` is required. `actions` is an IP20 action coordinator
 * (`{ dispatch }`); `dispatch` may be supplied directly for adapters or tests.
 * `clock` only stamps continuation tokens; it never changes the next step.
 */
export function createProductionCoordinator(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('createProductionCoordinator options must be an object');
  }
  const { store } = options;
  if (!store || typeof store.read !== 'function' || typeof store.readEvents !== 'function') {
    throw new TypeError('createProductionCoordinator requires a production store');
  }
  const actions = options.actions;
  if (actions !== undefined
    && (!isPlainObject(actions) || typeof actions.dispatch !== 'function')) {
    throw new TypeError('createProductionCoordinator actions must expose dispatch');
  }
  if (options.dispatch !== undefined && typeof options.dispatch !== 'function') {
    throw new TypeError('createProductionCoordinator dispatch must be a function');
  }
  const clock = options.clock;
  const defaultMaxSteps = normalizeMaxSteps(options.maxSteps, DEFAULT_MAX_STEPS);

  // Process-local continuation scheduling. The deterministic next step is
  // always recoverable from the journal; only the wake-up token is in memory.
  const sessions = new Map();

  function sessionFor(productionId) {
    let session = sessions.get(productionId);
    if (!session) {
      session = {
        tokens: new Map(),
        seen: new Map(),
        barrier: 0,
        generation: 0,
      };
      sessions.set(productionId, session);
    }
    return session;
  }

  function readProduction(productionId) {
    const production = store.read(productionId);
    if (!production) {
      throw new CoordinatorError('NOT_FOUND', 'production does not exist', 404, { productionId });
    }
    return production;
  }

  function latestIntentSequence(productionId) {
    let latest = 0;
    for (const event of store.readEvents(productionId)) {
      if (!INTENT_BARRIER_TYPES.has(event.type)) continue;
      if (Number.isSafeInteger(event.sequence) && event.sequence > latest) latest = event.sequence;
    }
    return latest;
  }

  function refreshBarrier(productionId, session) {
    const latest = latestIntentSequence(productionId);
    if (latest <= session.barrier) return false;
    session.barrier = latest;
    session.generation += 1;
    session.tokens.clear();
    return true;
  }

  function markSeen(session, eventId) {
    session.seen.set(eventId, true);
    while (session.seen.size > SEEN_EVENT_LIMIT) {
      const oldest = session.seen.keys().next().value;
      session.seen.delete(oldest);
    }
  }

  function scheduleEvent(event) {
    validateEventShape(event);
    const productionId = event.productionId;
    if (!isIdentifier(productionId)) {
      throw new CoordinatorError('INVALID_EVENT', 'continuation event requires a productionId', 400);
    }
    if (event.productionId !== undefined && event.productionId !== productionId) {
      throw new CoordinatorError('INVALID_EVENT', 'event productionId does not match the target production', 400);
    }

    const production = readProduction(productionId);
    const session = sessionFor(productionId);
    if (refreshBarrier(productionId, session)) {
      // An intent change landed since the last call. Anything already queued
      // addressed the previous intent and is dropped below.
    }

    const sequence = Number.isSafeInteger(event.sequence)
      ? event.sequence
      : production.lastSequence;

    if (INTENT_BARRIER_TYPES.has(event.type)) {
      session.barrier = Math.max(session.barrier, sequence);
      session.generation += 1;
      const cancelled = session.tokens.size;
      session.tokens.clear();
      markSeen(session, event.id);
      return {
        scheduled: false,
        duplicate: false,
        reason: event.type === 'production.cancelled' ? 'cancelled' : 'intent_changed',
        cancelled,
        productionId,
      };
    }

    if (!isContinuationEvent(event)) {
      return { scheduled: false, duplicate: false, reason: 'not_a_continuation_event', productionId };
    }

    if (session.seen.has(event.id)) {
      return {
        scheduled: false,
        duplicate: true,
        reason: 'already_scheduled',
        productionId,
        eventId: event.id,
      };
    }

    if (production.intent !== 'active') {
      // Remember the suppressed delivery: if the production resumes, the same
      // event must not be replayed into a new continuation.
      markSeen(session, event.id);
      session.tokens.clear();
      return {
        scheduled: false,
        duplicate: false,
        reason: `intent_${production.intent}`,
        productionId,
        intent: production.intent,
      };
    }

    if (sequence <= session.barrier) {
      markSeen(session, event.id);
      return { scheduled: false, duplicate: false, reason: 'superseded', productionId };
    }

    const continuationId = continuationIdFor(productionId, event.id);
    if (session.tokens.has(continuationId)) {
      return {
        scheduled: false,
        duplicate: true,
        reason: 'already_scheduled',
        productionId,
        eventId: event.id,
      };
    }

    const continuation = {
      id: continuationId,
      productionId,
      eventId: event.id,
      eventType: event.type,
      eventSequence: sequence,
      generation: session.generation,
      scheduledAt: clockIso(clock),
    };
    session.tokens.set(continuationId, continuation);
    markSeen(session, event.id);

    return {
      scheduled: true,
      duplicate: false,
      productionId,
      continuation: clone(continuation),
      next: deriveNextStep({ production, events: store.readEvents(productionId) }),
    };
  }

  function firstToken(session) {
    for (const token of session.tokens.values()) return token;
    return null;
  }

  function pending(productionId) {
    const session = sessions.get(productionId);
    if (!session) return [];
    return [...session.tokens.values()].map(clone);
  }

  function nextStep(productionId) {
    const production = readProduction(productionId);
    return deriveNextStep({ production, events: store.readEvents(productionId) });
  }

  function executeDispatch(productionId, next, production) {
    if (actions === undefined && typeof options.dispatch !== 'function') {
      return {
        status: 'blocked',
        reason: 'no_executor',
        error: { code: 'NO_EXECUTOR', message: 'the coordinator has no action executor' },
      };
    }

    const commandId = next.commandId ?? commandIdFor(productionId, next.planHash, next.actionId);
    const body = {
      commandId,
      idempotencyKey: commandId,
      expected: { productionRevision: production.revision },
      payload: {
        planId: next.planId,
        planRevision: next.planRevision,
        actionId: next.actionId,
      },
    };

    try {
      const result = typeof options.dispatch === 'function'
        ? options.dispatch({
          productionId,
          step: clone(next),
          production,
          commandId,
          body,
        })
        : actions.dispatch({
          productionId,
          body,
          context: { actor: 'system' },
        });
      return { status: 'dispatched', result };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'DISPATCH_FAILED';
      if (code === 'SLOT_CONSUMED') return { status: 'duplicate', error };
      return {
        status: 'blocked',
        reason: code,
        error: {
          code,
          message: typeof error?.message === 'string' ? error.message : 'the dispatch was refused',
        },
      };
    }
  }

  function continueProduction(productionId, continueOptions = {}) {
    const maxSteps = normalizeMaxSteps(continueOptions.maxSteps, defaultMaxSteps);
    const force = continueOptions.force === true;

    let production = readProduction(productionId);
    const session = sessionFor(productionId);
    const intentChanged = refreshBarrier(productionId, session);

    // A pause, archive or cancellation may have landed since the token was
    // queued (and refreshBarrier may already have dropped it). Report the
    // suppression explicitly rather than as an empty idle drain.
    if (production.intent !== 'active') {
      session.tokens.clear();
      return {
        productionId,
        status: 'suppressed',
        reason: `intent_${production.intent}`,
        executed: 0,
        bounded: false,
        actions: [],
      };
    }

    let token = firstToken(session);
    if (!token && !force) {
      if (intentChanged) {
        return { productionId, status: 'superseded', executed: 0, bounded: false, actions: [] };
      }
      return {
        productionId,
        status: 'idle',
        executed: 0,
        bounded: false,
        actions: [],
        next: deriveNextStep({ production, events: store.readEvents(productionId) }),
      };
    }

    if (token && token.generation !== session.generation) {
      session.tokens.delete(token.id);
      return { productionId, status: 'superseded', executed: 0, bounded: false, actions: [] };
    }
    if (token && token.eventSequence <= session.barrier) {
      session.tokens.delete(token.id);
      return { productionId, status: 'superseded', executed: 0, bounded: false, actions: [] };
    }

    const executed = [];
    for (let index = 0; index < maxSteps; index += 1) {
      production = readProduction(productionId);
      const events = store.readEvents(productionId);
      const next = deriveNextStep({ production, events });

      if (next.kind !== 'dispatch') {
        if (token) session.tokens.delete(token.id);
        return {
          productionId,
          status: next.kind === 'suppressed' ? 'suppressed' : next.kind,
          reason: next.reason,
          executed: executed.length,
          bounded: false,
          actions: executed,
          next,
        };
      }

      const outcome = executeDispatch(productionId, next, production);
      if (outcome.status === 'dispatched' || outcome.status === 'duplicate') {
        if (outcome.status === 'dispatched') executed.push(outcome.result);
        continue;
      }

      if (token) session.tokens.delete(token.id);
      return {
        productionId,
        status: 'blocked',
        reason: outcome.reason,
        error: outcome.error,
        executed: executed.length,
        bounded: false,
        actions: executed,
        next,
      };
    }

    production = readProduction(productionId);
    const after = deriveNextStep({ production, events: store.readEvents(productionId) });
    const bounded = after.kind === 'dispatch';

    if (!bounded && token) session.tokens.delete(token.id);
    if (bounded && !token) {
      // `force` started work without a queued event. Keep a synthetic token so
      // the remainder is not lost between drains.
      const synthetic = {
        id: continuationIdFor(productionId, `force_${production.revision}_${after.actionId}`),
        productionId,
        eventId: null,
        eventType: 'coordinator.force',
        eventSequence: production.lastSequence,
        generation: session.generation,
        scheduledAt: clockIso(clock),
      };
      session.tokens.set(synthetic.id, synthetic);
    }

    return {
      productionId,
      status: bounded ? 'bounded' : after.kind,
      reason: after.reason,
      executed: executed.length,
      bounded,
      actions: executed,
      next: after,
    };
  }

  function status(productionId) {
    const production = readProduction(productionId);
    const session = sessions.get(productionId);
    return {
      productionId,
      revision: production.revision,
      intent: production.intent,
      pending: pending(productionId),
      barrier: session?.barrier ?? 0,
      next: deriveNextStep({ production, events: store.readEvents(productionId) }),
    };
  }

  return Object.freeze({
    nextStep,
    onEvent: scheduleEvent,
    continue: continueProduction,
    pending,
    status,
  });
}
