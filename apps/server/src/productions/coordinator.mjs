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
//
// IL10: when a take round lands, a stage whose effective pick is `auto`
// selects exactly one take through the existing take.select command (actor
// `system`). A pick of `ask` opens a durable take_selection decision for the
// user instead. Both decisions are derived from the journal, so a restart
// repeats neither; the coordinator never resolves a spend or delivery
// decision, approves a plan or reserves budget.

import { createHash } from 'node:crypto';

import {
  decisionApproved,
  isTrustedPlan,
  REJECTING_OPTION_IDS,
} from './actions.mjs';
import {
  effectivePolicyForShot,
  ITERATION_STAGES,
  pickForShot,
} from './iteration.mjs';
import { promptVoiceGate, sceneAssetIds } from './voice-gate.mjs';

const ID_RE = /^[^\s/\\\u0000-\u001f]+$/u;

const DEFAULT_MAX_STEPS = 8;
const MAX_MAX_STEPS = 64;
const SEEN_EVENT_LIMIT = 1024;

// IL10 / D5: the one reason an automatic take selection is recorded with. It
// is also how a replay recognises that a selection was the coordinator's, not
// the user's.
export const AUTO_PICK_REASON = 'iteration:auto-pick';

const STAGE_ORDER = new Map(ITERATION_STAGES.map((name, index) => [name, index]));

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

// Every identifier an action can use to name the plate it works on. A scene id
// is expanded through the package so `targetId: shot_1` also names that shot's
// plate; an action with no asset identity is never matched by guesswork.
function actionAssetIds(slot, pkg) {
  const ids = new Set();
  if (!isPlainObject(slot)) return ids;
  const add = (value) => {
    if (typeof value !== 'string' || value === '') return;
    ids.add(value);
    const separator = value.indexOf(':');
    if (separator > 0) ids.add(value.slice(0, separator));
  };
  for (const key of ['assetId', 'targetId', 'shotId', 'clipId']) add(slot[key]);
  if (Array.isArray(slot.assetIds)) {
    for (const value of slot.assetIds) add(value);
  }
  if (Array.isArray(slot.assets)) {
    for (const value of slot.assets) add(value);
  }
  if (isPlainObject(slot.scope) && isPlainObject(slot.scope.target)) {
    for (const key of ['assetId', 'shotId', 'clipId']) add(slot.scope.target[key]);
  }

  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  for (const scene of scenes) {
    if (!isPlainObject(scene) || typeof scene.id !== 'string' || !ids.has(scene.id)) continue;
    for (const assetId of sceneAssetIds(scene)) ids.add(assetId);
  }
  return ids;
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
    if (!isIdentifier(plan.id) || !isTrustedPlan(plan)) continue;
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

function decisionIdOf(required) {
  if (typeof required === 'string') return required;
  if (!isPlainObject(required)) return null;
  if (typeof required.decisionId === 'string') return required.decisionId;
  if (typeof required.id === 'string') return required.id;
  return null;
}

function latestResolution(events, decisionId) {
  let latest = null;
  for (const event of events) {
    if (event.type !== 'decision.resolved' || !isPlainObject(event.data)) continue;
    const eventDecisionId = event.data.decisionId ?? event.data.id;
    if (eventDecisionId !== decisionId) continue;
    latest = event;
  }
  return latest;
}

// True only when the latest resolution is an explicit refusal. A resolution
// that merely names the wrong option, or no option at all, remains a decision
// the user still has to make.
function decisionRejected(events, production, required) {
  const decisionId = decisionIdOf(required);
  if (!decisionId) return false;
  const pending = new Set(
    Array.isArray(production.pendingDecisionIds) ? production.pendingDecisionIds : [],
  );
  if (pending.has(decisionId)) return false;
  const event = latestResolution(events, decisionId);
  if (!event) return false;
  if (event.data.status === 'rejected') return true;
  const optionId = event.data.optionId;
  return typeof optionId === 'string' && REJECTING_OPTION_IDS.includes(optionId);
}

function takeRoundOf(data) {
  return Number.isSafeInteger(data?.round) && data.round >= 1 ? data.round : 1;
}

function takeSelectionDecisionIdFor(productionId, shotId, stage, round) {
  return `dec_take_${stableDigest('take-selection', productionId, shotId, stage, String(round)).slice(0, 24)}`;
}

function takeSelectionCommandIdFor(productionId, shotId, stage, round) {
  return `cmd_auto_${stableDigest('auto-pick', productionId, shotId, stage, String(round)).slice(0, 24)}`;
}

function takeDecisionCommandIdFor(productionId, shotId, stage, round) {
  return `cmd_take_decision_${stableDigest('take-selection-request', productionId, shotId, stage, String(round)).slice(0, 24)}`;
}

function takeScore(record) {
  const data = record.data;
  if (typeof data.technicalScore === 'number' && Number.isFinite(data.technicalScore)) {
    return data.technicalScore;
  }
  if (typeof data.score === 'number' && Number.isFinite(data.score)) return data.score;
  if (Array.isArray(data.checks)) {
    const checks = data.checks.filter((check) => isPlainObject(check) && typeof check.ok === 'boolean');
    if (checks.length > 0) {
      return checks.filter((check) => check.ok).length / checks.length;
    }
  }
  return 0;
}

function isRecommended(record) {
  const value = record.data.recommendation;
  if (value === true) return true;
  if (typeof value === 'string' && value === record.takeId) return true;
  if (record.data.recommended === true) return true;
  return false;
}

function selectedInGroup(selections, group) {
  return selections.some((selection) => {
    const data = selection.data;
    if (typeof data.takeId !== 'string') return false;
    if (!group.records.some((record) => record.takeId === data.takeId)) return false;
    if (typeof data.shotId === 'string' && data.shotId !== group.shotId) return false;
    if (typeof data.stage === 'string' && data.stage !== group.stage) return false;
    if (data.round !== undefined && takeRoundOf(data) !== group.round) return false;
    return true;
  });
}

function decisionRequestedInGroup(requests, group) {
  return requests.some((request) => {
    const data = request.data;
    const id = typeof data.decisionId === 'string' ? data.decisionId : data.id;
    if (id === group.decisionId) return true;
    if (data.kind !== undefined && data.kind !== 'take_selection') return false;
    if (data.shotId !== undefined && data.shotId !== group.shotId) return false;
    if (data.stage !== undefined && data.stage !== group.stage) return false;
    if (data.round !== undefined && takeRoundOf(data) !== group.round) return false;
    return data.shotId === group.shotId && data.stage === group.stage;
  });
}

function chooseTake(records, reviewDepth) {
  if (reviewDepth === 'standard' || reviewDepth === 'deep') {
    const recommended = records.filter(isRecommended);
    if (recommended.length > 0) return recommended[0];
  }

  let best = records[0];
  let bestScore = takeScore(best);
  for (const record of records.slice(1)) {
    const score = takeScore(record);
    if (score > bestScore) {
      best = record;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Compute the next take selection, or null when every landed round is settled.
 *
 * A round is the take count from the effective iteration policy for one shot
 * and stage. `pickForShot` resolves `hero` (video only) into `ask` or `auto`.
 * At standard/deep review the agent's one recorded recommendation wins;
 * otherwise the best technical score wins and a tie keeps the first landed
 * take. The result is derived only from the journal, so a restart computes the
 * same decision or the same command id.
 */
export function deriveTakeSelection({ production, events: rawEvents, shots } = {}) {
  if (!isPlainObject(production)) {
    throw new CoordinatorError('INVALID_PRODUCTION', 'deriveTakeSelection requires a production snapshot', 400);
  }
  if (production.intent !== 'active') return null;

  const policy = isPlainObject(production.iteration) && isPlainObject(production.iteration.policy)
    ? production.iteration.policy
    : null;
  if (!policy) return null;

  const shotList = Array.isArray(shots)
    ? shots
    : (Array.isArray(production.shotIds) ? production.shotIds.map((id) => ({ id })) : []);
  const shotOrder = new Map(
    shotList
      .filter((shot) => isPlainObject(shot) && typeof shot.id === 'string')
      .map((shot, index) => [shot.id, index]),
  );
  if (shotOrder.size === 0) return null;

  const events = orderedEvents(rawEvents);
  const groups = new Map();
  const selections = [];
  const requests = [];

  for (const event of events) {
    if (!isPlainObject(event.data)) continue;
    if (event.type === 'take.selected') {
      selections.push({ data: event.data, sequence: event.sequence });
      continue;
    }
    if (event.type === 'decision.requested') {
      requests.push({ data: event.data, sequence: event.sequence });
      continue;
    }
    if (event.type !== 'take.landed') continue;

    const data = event.data;
    const shotId = data.shotId;
    const stage = data.stage;
    const takeId = data.takeId;
    if (!isIdentifier(shotId) || !shotOrder.has(shotId)) continue;
    if (typeof stage !== 'string' || !STAGE_ORDER.has(stage)) continue;
    if (!isIdentifier(takeId)) continue;

    const round = takeRoundOf(data);
    const key = `${shotId}\u0000${stage}\u0000${round}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        shotId,
        stage,
        round,
        records: [],
        decisionId: takeSelectionDecisionIdFor(production.id, shotId, stage, round),
      };
      groups.set(key, group);
    }
    if (group.records.some((record) => record.takeId === takeId)) continue;
    group.records.push({
      takeId,
      index: Number.isSafeInteger(data.index) ? data.index : group.records.length,
      sequence: Number.isSafeInteger(event.sequence) ? event.sequence : 0,
      data,
    });
  }

  const orderedGroups = [...groups.values()].sort((left, right) => {
    const shotDelta = (shotOrder.get(left.shotId) ?? Number.MAX_SAFE_INTEGER)
      - (shotOrder.get(right.shotId) ?? Number.MAX_SAFE_INTEGER);
    if (shotDelta !== 0) return shotDelta;
    const stageDelta = (STAGE_ORDER.get(left.stage) ?? Number.MAX_SAFE_INTEGER)
      - (STAGE_ORDER.get(right.stage) ?? Number.MAX_SAFE_INTEGER);
    if (stageDelta !== 0) return stageDelta;
    return left.round - right.round;
  });

  for (const group of orderedGroups) {
    const effective = effectivePolicyForShot(policy, group.shotId);
    const stagePolicy = effective.stages[group.stage];
    if (!stagePolicy) continue;
    if (group.records.length < stagePolicy.takes) continue;
    if (selectedInGroup(selections, group)) continue;
    if (decisionRequestedInGroup(requests, group)) continue;

    const pick = pickForShot(policy, group.stage, group.shotId, shotList);
    const base = {
      productionId: production.id,
      shotId: group.shotId,
      stage: group.stage,
      round: group.round,
      decisionId: group.decisionId,
      takes: group.records.map((record) => record.takeId),
    };

    if (pick === 'ask') {
      return {
        kind: 'ask_take_selection',
        reason: 'take_selection_required',
        ...base,
        decisionCommandId: takeDecisionCommandIdFor(
          production.id,
          group.shotId,
          group.stage,
          group.round,
        ),
      };
    }

    const chosen = chooseTake(group.records, effective.reviewDepth);
    return {
      kind: 'select_take',
      reason: 'take_round_landed',
      ...base,
      takeId: chosen.takeId,
      commandId: takeSelectionCommandIdFor(
        production.id,
        group.shotId,
        group.stage,
        group.round,
      ),
    };
  }

  return null;
}

function pendingTakeSelection(events, production) {
  const pending = new Set(
    Array.isArray(production.pendingDecisionIds) ? production.pendingDecisionIds : [],
  );
  if (pending.size === 0) return null;
  for (const event of orderedEvents(events)) {
    if (event.type !== 'decision.requested' || !isPlainObject(event.data)) continue;
    if (event.data.kind !== 'take_selection') continue;
    const decisionId = event.data.decisionId ?? event.data.id;
    if (typeof decisionId === 'string' && pending.has(decisionId)) return decisionId;
  }
  return null;
}

function unmetDecisions(events, production, plan) {
  const unmet = [];
  let rejected = false;
  for (const required of Array.isArray(plan.requiredDecisions) ? plan.requiredDecisions : []) {
    if (typeof required === 'string') {
      if (!decisionApproved(events, production, required)) {
        unmet.push(required);
        if (decisionRejected(events, production, required)) rejected = true;
      }
      continue;
    }
    if (!isPlainObject(required)) continue;
    const decisionId = decisionIdOf(required);
    if (decisionId) {
      if (!decisionApproved(events, production, required)) {
        unmet.push(decisionId);
        if (decisionRejected(events, production, required)) rejected = true;
      }
      continue;
    }
    if (required.kind === 'action_spend') continue;
    if (typeof required.kind === 'string') unmet.push(`kind:${required.kind}`);
  }
  return { unmet, rejected };
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

  // IL10: an open take_selection decision is a user decision. No later slot
  // (render included) is admitted around it, and resolving it is the user's
  // action; the coordinator never resolves it itself.
  const pendingTakeDecisionId = pendingTakeSelection(events, production);
  if (pendingTakeDecisionId) {
    return step('await_decision', 'take_selection_pending', {
      productionId: production.id,
      decisionIds: [pendingTakeDecisionId],
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

  const decisions = unmetDecisions(events, production, plan);
  if (decisions.unmet.length > 0) {
    if (decisions.rejected) {
      return step('blocked', 'decision_rejected', { ...base, decisionIds: decisions.unmet });
    }
    return step('await_decision', 'decisions_pending', { ...base, decisionIds: decisions.unmet });
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
 * `handler` is the IP18 command handler used only for the automatic
 * take.select (actor `system`). `shots` is the ordered package scene list
 * (or a function returning it) so `pickForShot` can resolve hero shots.
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
  const handler = options.handler;
  if (handler !== undefined
    && (!isPlainObject(handler) || typeof handler.execute !== 'function')) {
    throw new TypeError('createProductionCoordinator handler must expose execute');
  }
  const shots = options.shots;
  if (shots !== undefined && !Array.isArray(shots) && typeof shots !== 'function') {
    throw new TypeError('createProductionCoordinator shots must be an array or a function');
  }
  const pkg = options.pkg;
  if (pkg !== undefined && typeof pkg !== 'function' && !isPlainObject(pkg)) {
    throw new TypeError('createProductionCoordinator pkg must be an object or a function');
  }
  const characters = options.characters;
  if (characters !== undefined
    && typeof characters !== 'function'
    && !(characters instanceof Map)
    && !isPlainObject(characters)) {
    throw new TypeError('createProductionCoordinator characters must be a Map, object or function');
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

  // The package scene list carries the hero flags. A caller without a package
  // may pass only the ordered shot ids; isHeroShot then uses its first/last
  // fallback, and the coordinator never keeps a second hero implementation.
  function shotsFor(production) {
    if (typeof shots === 'function') return shots(production);
    if (Array.isArray(shots)) return shots;
    return Array.isArray(production.shotIds)
      ? production.shotIds.map((shotId) => ({ id: shotId }))
      : [];
  }

  function packageFor(production) {
    return typeof pkg === 'function' ? pkg(production) : pkg;
  }

  function charactersFor(production) {
    return typeof characters === 'function' ? characters(production) : characters;
  }

  // VX15: a prompt-mode plate may be dispatched only when its character's
  // audition still pins the exact current seed+description. The check runs
  // before the action executor, so a refusal never reserves or holds budget.
  function blockedAction(production, next) {
    const currentPackage = packageFor(production);
    if (!isPlainObject(currentPackage)) return null;
    const gate = promptVoiceGate({
      pkg: currentPackage,
      characters: charactersFor(production),
    });
    if (gate.ok || gate.blocked.length === 0) return null;
    const ids = actionAssetIds(next?.slot, currentPackage);
    if (ids.size === 0) return null;
    return gate.blocked.find((entry) => ids.has(entry.assetId)) ?? null;
  }

  function nextTakeSelection(productionId) {
    const production = readProduction(productionId);
    return deriveTakeSelection({
      production,
      events: store.readEvents(productionId),
      shots: shotsFor(production),
    });
  }

  function executeTakeSelection(productionId, selection) {
    const production = readProduction(productionId);

    if (selection.kind === 'select_take') {
      if (!handler) {
        return {
          status: 'blocked',
          reason: 'NO_COMMAND_HANDLER',
          error: {
            code: 'NO_COMMAND_HANDLER',
            message: 'auto-pick requires the production command handler',
          },
        };
      }
      try {
        const result = handler.execute({
          commandId: selection.commandId,
          idempotencyKey: selection.commandId,
          kind: 'take.select',
          productionId,
          expected: { productionRevision: production.revision },
          payload: {
            shotId: selection.shotId,
            stage: selection.stage,
            round: selection.round,
            takeId: selection.takeId,
            actor: 'system',
            reason: AUTO_PICK_REASON,
          },
        }, { actor: 'system' });
        return {
          status: 'selected',
          selection,
          result: {
            kind: 'take.selected',
            shotId: selection.shotId,
            stage: selection.stage,
            round: selection.round,
            takeId: selection.takeId,
            commandId: selection.commandId,
            duplicate: result?.duplicate === true,
          },
        };
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'TAKE_SELECT_FAILED';
        return {
          status: 'blocked',
          reason: code,
          error: {
            code,
            message: typeof error?.message === 'string'
              ? error.message
              : 'the take selection was refused',
          },
        };
      }
    }

    // pick === 'ask': open one durable take_selection decision. It stays
    // pending until the user resolves it; the coordinator never resolves it,
    // approves a plan or reserves budget here.
    const decisionId = selection.decisionId;
    const pending = Array.isArray(production.pendingDecisionIds)
      ? production.pendingDecisionIds
      : [];
    const nextProduction = {
      ...clone(production),
      pendingDecisionIds: pending.includes(decisionId) ? [...pending] : [...pending, decisionId],
    };
    const data = {
      decisionId,
      productionId,
      kind: 'take_selection',
      status: 'pending',
      shotId: selection.shotId,
      stage: selection.stage,
      round: selection.round,
      targetIds: [selection.shotId],
      proposalVersion: 0,
      inputFingerprint: stableDigest(
        'take-selection',
        productionId,
        selection.shotId,
        selection.stage,
        String(selection.round),
        ...selection.takes,
      ),
      options: selection.takes.map((takeId, index) => ({
        id: takeId,
        label: `Take ${index + 1}`,
        artifactIds: [],
      })),
    };

    try {
      const committed = store.commit(productionId, {
        commandId: selection.decisionCommandId,
        idempotencyKey: selection.decisionCommandId,
        baseRevision: production.revision,
        production: nextProduction,
        events: [{ type: 'decision.requested', data }],
      });
      return {
        status: 'await_decision',
        selection,
        result: {
          kind: 'take_selection.requested',
          decisionId,
          shotId: selection.shotId,
          stage: selection.stage,
          round: selection.round,
          commandId: selection.decisionCommandId,
          duplicate: committed?.duplicate === true,
        },
      };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'TAKE_DECISION_FAILED';
      return {
        status: 'blocked',
        reason: code,
        error: {
          code,
          message: typeof error?.message === 'string'
            ? error.message
            : 'the take selection decision could not be opened',
        },
      };
    }
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

    const events = store.readEvents(productionId);
    const selection = deriveTakeSelection({
      production,
      events,
      shots: shotsFor(production),
    });
    return {
      scheduled: true,
      duplicate: false,
      productionId,
      continuation: clone(continuation),
      next: selection ?? deriveNextStep({ production, events }),
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
    const events = store.readEvents(productionId);
    const selection = deriveTakeSelection({
      production,
      events,
      shots: shotsFor(production),
    });
    if (selection) return selection;
    return deriveNextStep({ production, events });
  }

  function voiceRefusal(voiceBlock) {
    return {
      status: 'blocked',
      reason: voiceBlock.code,
      admitted: false,
      code: voiceBlock.code,
      blocked: voiceBlock,
      error: {
        code: voiceBlock.code,
        message: voiceBlock.code === 'VOICE_AUDITION_STALE'
          ? 'the approved prompt voice audition is stale; approve it again before dispatch'
          : 'the character prompt voice audition must be approved before this shot can dispatch',
      },
    };
  }

  // The dispatch route names one plan revision and action slot; resolve that
  // same slot so the gate sees the plate the caller is about to admit.
  function planSlotForAction(events, payload) {
    if (!isPlainObject(payload)) return null;
    if (!isIdentifier(payload.planId)) return null;
    if (!Number.isSafeInteger(payload.planRevision) || payload.planRevision < 0) return null;
    if (!isIdentifier(payload.actionId)) return null;
    let plan = null;
    for (const event of events) {
      if (event.type !== 'plan.proposed' || !isPlainObject(event.data)) continue;
      if (event.data.id !== payload.planId || event.data.revision !== payload.planRevision) continue;
      plan = event.data;
    }
    if (!plan || !Array.isArray(plan.actions)) return null;
    return plan.actions.find((entry) => isPlainObject(entry) && entry.id === payload.actionId) ?? null;
  }

  function dispatchAction({ productionId, body, context } = {}) {
    if (actions === undefined || typeof actions.dispatch !== 'function') {
      return {
        status: 'blocked',
        reason: 'no_executor',
        error: { code: 'NO_EXECUTOR', message: 'the coordinator has no action executor' },
      };
    }

    const slot = planSlotForAction(store.readEvents(productionId), body?.payload);
    if (slot) {
      const production = readProduction(productionId);
      const voiceBlock = blockedAction(production, { slot });
      if (voiceBlock) return voiceRefusal(voiceBlock);
    }

    return actions.dispatch({ productionId, body, context });
  }

  function executeDispatch(productionId, next, production) {
    if (actions === undefined && typeof options.dispatch !== 'function') {
      return {
        status: 'blocked',
        reason: 'no_executor',
        error: { code: 'NO_EXECUTOR', message: 'the coordinator has no action executor' },
      };
    }

    const voiceBlock = blockedAction(production, next);
    if (voiceBlock) return voiceRefusal(voiceBlock);

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

    // IL10: a landed take round is settled before any later plan slot runs.
    // Selection is derived from the journal, so a fresh coordinator with no
    // queued token still performs the one deterministic auto-pick or opens the
    // one take_selection decision.
    const takeSelections = [];
    let lastSelection = null;
    for (let index = 0; index < maxSteps; index += 1) {
      const selection = nextTakeSelection(productionId);
      if (!selection) break;
      const outcome = executeTakeSelection(productionId, selection);
      lastSelection = selection;
      if (outcome.status === 'blocked') {
        const blockedToken = firstToken(session);
        if (blockedToken) session.tokens.delete(blockedToken.id);
        return {
          productionId,
          status: 'blocked',
          reason: outcome.reason,
          error: outcome.error,
          executed: takeSelections.length,
          bounded: false,
          actions: [],
          takeSelections,
          next: selection,
        };
      }
      takeSelections.push(outcome.result);
    }

    let token = firstToken(session);
    if (!token && !force && takeSelections.length > 0) {
      production = readProduction(productionId);
      const events = store.readEvents(productionId);
      const awaiting = pendingTakeSelection(events, production);
      return {
        productionId,
        status: awaiting ? 'await_decision' : 'selected',
        reason: lastSelection?.reason,
        executed: takeSelections.length,
        bounded: false,
        actions: [],
        takeSelections,
        next: deriveNextStep({ production, events }),
      };
    }

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
    const planBudget = Math.max(0, maxSteps - takeSelections.length);
    for (let index = 0; index < planBudget; index += 1) {
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
          takeSelections,
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
        ...(outcome.admitted !== undefined ? { admitted: outcome.admitted } : {}),
        ...(outcome.code !== undefined ? { code: outcome.code } : {}),
        ...(outcome.blocked !== undefined ? { blocked: outcome.blocked } : {}),
        error: outcome.error,
        executed: executed.length,
        bounded: false,
        actions: executed,
        takeSelections,
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
      takeSelections,
      next: after,
    };
  }

  function status(productionId) {
    const production = readProduction(productionId);
    const events = store.readEvents(productionId);
    const selection = deriveTakeSelection({
      production,
      events,
      shots: shotsFor(production),
    });
    const session = sessions.get(productionId);
    return {
      productionId,
      revision: production.revision,
      intent: production.intent,
      pending: pending(productionId),
      barrier: session?.barrier ?? 0,
      next: selection ?? deriveNextStep({ production, events }),
    };
  }

  return Object.freeze({
    nextStep,
    nextTakeSelection,
    onEvent: scheduleEvent,
    continue: continueProduction,
    dispatch: dispatchAction,
    pending,
    status,
  });
}
