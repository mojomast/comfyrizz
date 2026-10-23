// IP20: action plans and dispatch.
//
// Plans and actions live in the production journal (IP17). Propose goes through
// the IP18 command handler and does not touch the budget ledger. Dispatch
// re-reads the latest plan, the approval and the snapshot, then reserves
// through the IP07/IP08 ledger and commits the admission with store.commit({ outbox }).
//
// Spend authority is consumable. An approval binds one server-computed planHash
// and the slots listed on that plan. Each (planHash, actionId) slot is admitted
// at most once. The plan's reservationCeiling is a scoped bound checked at
// propose time. The user spend cap is the ledger ceiling: there is no default
// cap, and a disabled cap still records every reservation. A failed Google Colab
// run with unknown usage settles its full reservation (ledger kind
// reservation_unverified); this module only reserves.

import { createHash } from 'node:crypto';

import { canonicalJson, requestHashFor } from './commands.mjs';
import { CommandError } from './commands.mjs';
import { ITERATION_LEVEL_REQUIRED, RECORDED_ACTORS, validateAction } from './contract.mjs';
import { ProductionLedgerError } from './ledger.mjs';
import { ProductionStoreError } from './store.mjs';
import { effectivePolicyForShot } from './iteration.mjs';
import { IterationScopeError, validateIterationScope } from './iteration-scope.mjs';

const ID_RE = /^[^\s/\\\u0000-\u001f]+$/u;

// Derived or client-supplied names that are not part of the plan content.
const HASH_EXCLUDED = new Set(['planHash', 'contentHash', 'allocation', 'executionId']);

// Synonyms that must not be read and must not change plan identity.
const PLAN_IGNORED = new Set([
  'planId',
  'plan_id',
  'plan',
  'action',
  'contentHash',
  'proposalRevision',
  'planRevision',
]);

const SLOT_IGNORED = new Set([
  'slotId',
  'actionId',
  'action_id',
  'maximumChargeExposure',
]);

/**
 * Choices that never satisfy a required decision unless the requirement
 * explicitly names the same option. Lower case and exact: option spellings are
 * a closed vocabulary, not aliases.
 */
export const REJECTING_OPTION_IDS = Object.freeze([
  'reject',
  'rejected',
  'cancel',
  'cancelled',
  'decline',
  'declined',
  'deny',
  'denied',
  'no',
]);

export class ActionError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'ActionError';
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

function normalizeNumber(value) {
  if (Object.is(value, -0)) return 0;
  return Number.isInteger(value) ? value : Number(value.toPrecision(12));
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && ID_RE.test(value);
}

function isFiniteAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPaidSlot(slot) {
  if (!isPlainObject(slot)) return false;
  if (!(typeof slot.upperBound === 'number' && slot.upperBound > 0)) return false;
  if (slot.kind === 'audition' && slot.engine === 'kokoro') return false;
  return true;
}

function planHasPaidSlot(plan) {
  if (!isPlainObject(plan) || !Array.isArray(plan.actions)) return false;
  return plan.actions.some(isPaidSlot);
}

/**
 * Server-owned identity of a plan. Client planHash and contentHash are not
 * inputs. Key order does not matter.
 */
export function computePlanHash(plan) {
  if (!isPlainObject(plan)) {
    throw new ActionError('INVALID_PLAN', 'plan must be an object', 400);
  }
  const content = {};
  for (const key of Object.keys(plan)) {
    if (HASH_EXCLUDED.has(key)) continue;
    content[key] = plan[key];
  }
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/**
 * A plan.proposed event is trusted only when the journaled planHash is the
 * server content hash of the journaled plan. This is the same check the
 * action-plans route applies through buildStoredPlan; shared here so every
 * reader (approval, dispatch, coordinator) agrees on plan provenance.
 */
export function isTrustedPlan(plan) {
  if (!isPlainObject(plan)) return false;
  if (typeof plan.planHash !== 'string' || plan.planHash === '') return false;
  try {
    return plan.planHash === computePlanHash(plan);
  } catch {
    return false;
  }
}

function reservationIdFor(planHash, actionId) {
  const digest = createHash('sha256')
    .update(`${planHash}\0${actionId}`)
    .digest('hex')
    .slice(0, 32);
  return `slot_${digest}`;
}

function outboxIdFor(commandId) {
  const digest = createHash('sha256').update(commandId).digest('hex').slice(0, 32);
  return `dsp_${digest}`;
}

function requireCommand(body) {
  if (!isPlainObject(body) || !isIdentifier(body.commandId)) {
    throw new ActionError('MISSING_COMMAND_ID', 'commandId is required', 400);
  }
  const idempotencyKey = body.idempotencyKey === undefined ? body.commandId : body.idempotencyKey;
  if (!isIdentifier(idempotencyKey)) {
    throw new ActionError('INVALID_COMMAND', 'idempotencyKey must be an identifier', 400);
  }
  return { commandId: body.commandId, idempotencyKey };
}

function requireContext(context) {
  if (!isPlainObject(context) || typeof context.actor !== 'string' || context.actor.trim() === '') {
    throw new ActionError('MISSING_ACTOR', 'the server must supply the command actor', 500);
  }
  if (!RECORDED_ACTORS.includes(context.actor)) {
    throw new ActionError('INVALID_ACTOR', 'the server supplied an unknown command actor', 500);
  }
  if (context.actor === 'user' || context.actor === 'agent') {
    if (!isIdentifier(context.userEventId)) {
      throw new ActionError('MISSING_USER_EVENT', 'the server must cite the originating user event', 500);
    }
  }
}

function conflict(commandId, idempotencyKey) {
  return new ActionError(
    'IDEMPOTENCY_CONFLICT',
    'command id or idempotency key was reused with a different request',
    409,
    { commandId, idempotencyKey },
  );
}

function normalizeScope(raw, field) {
  try {
    return validateIterationScope(raw);
  } catch (error) {
    if (error instanceof IterationScopeError) {
      throw new ActionError('ITERATION_SCOPE_INVALID', `${field} is not a valid iteration scope`, 400, {
        field: error.field,
      });
    }
    throw error;
  }
}

function scopeMismatch(message, details) {
  return new ActionError('ITERATION_SCOPE_MISMATCH', message, 400, details);
}

function slotTargetIds(slot) {
  const ids = new Set();
  if (typeof slot.targetId === 'string' && slot.targetId !== '') {
    ids.add(slot.targetId);
    const separator = slot.targetId.indexOf(':');
    if (separator > 0) ids.add(slot.targetId.slice(0, separator));
    return ids;
  }
  if (typeof slot.shotId === 'string' && slot.shotId !== '') ids.add(slot.shotId);
  if (typeof slot.clipId === 'string' && slot.clipId !== '') ids.add(slot.clipId);
  return ids;
}

function scopeMatchesSlotTarget(scope, slot) {
  const target = scope.target;
  const ids = slotTargetIds(slot);
  if (ids.size === 0) return true;
  if (target.shotId === undefined && target.clipId === undefined) return false;
  if (target.shotId !== undefined && !ids.has(target.shotId)) return false;
  if (target.clipId !== undefined && !ids.has(target.clipId)) return false;
  return true;
}

function normalizeActions(actions, ceiling, collectAndStopReserve) {
  if (!Array.isArray(actions)) {
    throw new ActionError('INVALID_PLAN', 'actions must be an array of slots', 400);
  }
  const seen = new Set();
  let sum = collectAndStopReserve;
  const normalized = actions.map((slot, index) => {
    if (!isPlainObject(slot)) {
      throw new ActionError('INVALID_PLAN', `actions[${index}] must be an object`, 400);
    }
    if (!isIdentifier(slot.id)) {
      throw new ActionError('INVALID_PLAN', `actions[${index}].id is required`, 400);
    }
    if (seen.has(slot.id)) {
      throw new ActionError('INVALID_PLAN', `actions[${index}].id is duplicated`, 400);
    }
    seen.add(slot.id);
    if (!Object.prototype.hasOwnProperty.call(slot, 'upperBound') || !isFiniteAmount(slot.upperBound)) {
      throw new ActionError('INVALID_PLAN', `actions[${index}].upperBound must be a finite non-negative number`, 400);
    }
    if (slot.upperBound > ceiling) {
      throw new ActionError('INVALID_PLAN', `actions[${index}].upperBound exceeds reservationCeiling`, 400);
    }
    if (slot.kind === 'audition') {
      if (!isIdentifier(slot.characterId)) {
        throw new ActionError('INVALID_PLAN', `actions[${index}].characterId is required for an audition`, 400);
      }
      if (typeof slot.voice !== 'string' || slot.voice.trim() === '') {
        throw new ActionError('INVALID_PLAN', `actions[${index}].voice is required for an audition`, 400);
      }
      if (typeof slot.line !== 'string' || slot.line.trim() === '') {
        throw new ActionError('INVALID_PLAN', `actions[${index}].line is required for an audition`, 400);
      }
      if (slot.engine !== 'kokoro' && slot.engine !== 'qwen3-tts') {
        throw new ActionError('INVALID_PLAN', `actions[${index}].engine must be kokoro or qwen3-tts`, 400);
      }
    }
    sum = normalizeNumber(sum + slot.upperBound);
    const next = {};
    for (const [key, value] of Object.entries(slot)) {
      if (SLOT_IGNORED.has(key)) continue;
      next[key] = value;
    }
    next.id = slot.id;
    next.upperBound = slot.upperBound;
    if (Object.hasOwn(slot, 'scope')) {
      const scope = normalizeScope(slot.scope, `actions[${index}].scope`);
      if (!scopeMatchesSlotTarget(scope, next)) {
        throw scopeMismatch(
          `actions[${index}].scope target does not match the slot target`,
          { actionId: slot.id },
        );
      }
      next.scope = scope;
    }
    return next;
  });
  if (sum > ceiling) {
    throw new ActionError(
      'INVALID_PLAN',
      'the sum of slot upperBounds and collectAndStopReserve exceeds reservationCeiling',
      400,
    );
  }
  return normalized;
}

function buildStoredPlan(payload, productionId) {
  if (!isPlainObject(payload)) {
    throw new ActionError('INVALID_PLAN', 'payload must be an object', 400);
  }
  if (!isIdentifier(payload.planId)) {
    throw new ActionError('INVALID_PLAN', 'planId is required', 400);
  }
  if (payload.productionId !== undefined && payload.productionId !== productionId) {
    throw new ActionError('PRODUCTION_ID_MISMATCH', 'productionId in the plan must match the URL production id', 400);
  }
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 0) {
    throw new ActionError('INVALID_PLAN', 'revision must be a non-negative integer', 400);
  }
  if (!isFiniteAmount(payload.reservationCeiling)) {
    throw new ActionError('INVALID_PLAN', 'reservationCeiling must be a finite non-negative number', 400);
  }
  const collectAndStopReserve = payload.collectAndStopReserve === undefined ? 0 : payload.collectAndStopReserve;
  if (!isFiniteAmount(collectAndStopReserve)) {
    throw new ActionError('INVALID_PLAN', 'collectAndStopReserve must be a finite non-negative number', 400);
  }
  if (!Array.isArray(payload.requiredDecisions)) {
    throw new ActionError('INVALID_PLAN', 'requiredDecisions must be an array', 400);
  }
  const ceiling = normalizeNumber(payload.reservationCeiling);
  const turnScope = Object.hasOwn(payload, 'scope') ? normalizeScope(payload.scope, 'scope') : undefined;
  const actions = normalizeActions(payload.actions, ceiling, normalizeNumber(collectAndStopReserve));
  if (turnScope !== undefined) {
    actions.forEach((slot, index) => {
      if (!isPaidSlot(slot)) return;
      if (!Object.hasOwn(slot, 'scope')) {
        throw scopeMismatch(
          `actions[${index}].scope is required in a scoped turn`,
          { actionId: slot.id },
        );
      }
      if (canonicalJson(slot.scope) !== canonicalJson(turnScope)) {
        throw scopeMismatch(
          `actions[${index}].scope must match the turn iteration scope`,
          { actionId: slot.id },
        );
      }
    });
  }

  const content = {};
  for (const [key, value] of Object.entries(payload)) {
    if (HASH_EXCLUDED.has(key) || PLAN_IGNORED.has(key)) continue;
    content[key] = value;
  }
  content.id = payload.planId;
  content.productionId = productionId;
  content.revision = payload.revision;
  content.reservationCeiling = ceiling;
  content.collectAndStopReserve = normalizeNumber(collectAndStopReserve);
  content.requiredDecisions = payload.requiredDecisions;
  content.actions = actions;
  if (turnScope !== undefined) content.scope = turnScope;
  else delete content.scope;

  const planHash = computePlanHash(content);
  const suppliedHash = Object.prototype.hasOwnProperty.call(payload, 'planHash');
  if (suppliedHash && payload.planHash !== planHash) {
    const error = new ActionError('INVALID_PLAN', 'planHash does not match the plan content', 400);
    error.clientHashRejected = true;
    throw error;
  }

  return {
    ...content,
    planHash,
    executionId: `exec_${planHash.slice(0, 24)}`,
    allocation: null,
  };
}

function mapLedger(error) {
  if (error instanceof ActionError || error instanceof CommandError) throw error;
  if (!(error instanceof ProductionLedgerError)) throw error;
  if (error.code === 'RESERVATION_EXISTS') {
    throw new ActionError(
      'RUN_BUSY',
      'the slot reservation is already open; retry the same commandId',
      409,
      { reservationId: error.reservationId },
    );
  }
  if (error.code === 'BUDGET_EXCEEDED') {
    throw new ActionError('BUDGET_EXCEEDED', 'the production spend cap cannot admit this reservation', 409);
  }
  if (error.code === 'IDEMPOTENCY_CONFLICT') {
    throw new ActionError(
      'IDEMPOTENCY_CONFLICT',
      'command id or idempotency key was reused with a different request',
      409,
    );
  }
  throw new ActionError(error.code || 'LEDGER_ERROR', 'the budget ledger rejected the reservation', 400);
}

function mapStore(error) {
  if (error instanceof ActionError || error instanceof CommandError) throw error;
  if (!(error instanceof ProductionStoreError)) {
    throw new ActionError('INTERNAL', 'the production store rejected the command', 500);
  }
  const details = {};
  if (Array.isArray(error.errors)) details.errors = error.errors;
  switch (error.code) {
    case 'NOT_FOUND':
      throw new ActionError('NOT_FOUND', 'production does not exist', 404, details);
    case 'REVISION_CONFLICT':
      details.currentRevision = error.currentRevision;
      details.baseRevision = error.baseRevision;
      throw new ActionError('REVISION_CONFLICT', 'baseRevision does not match the committed revision', 409, details);
    case 'IDEMPOTENCY_CONFLICT':
      if (error.commandId !== undefined) details.commandId = error.commandId;
      if (error.idempotencyKey !== undefined) details.idempotencyKey = error.idempotencyKey;
      throw new ActionError('IDEMPOTENCY_CONFLICT', 'command id or idempotency key was reused with a different request', 409, details);
    default:
      throw new ActionError(error.code || 'STORE_ERROR', 'the production store rejected the command', 400, details);
  }
}

function proposedPlans(events) {
  const plans = [];
  for (const event of events) {
    if (event.type !== 'plan.proposed' || !isPlainObject(event.data)) continue;
    if (typeof event.data.id !== 'string' || !isTrustedPlan(event.data)) continue;
    plans.push(event.data);
  }
  return plans;
}

function latestPlan(plans, planId) {
  let latest = null;
  for (const plan of plans) {
    if (plan.id !== planId) continue;
    if (!latest || plan.revision > latest.revision || plan.revision === latest.revision) latest = plan;
  }
  return latest;
}

function planAtRevision(plans, planId, revision) {
  let found = null;
  for (const plan of plans) {
    if (plan.id === planId && plan.revision === revision) found = plan;
  }
  return found;
}

function approvalState(events, plan) {
  let approved = false;
  let rejected = false;
  for (const event of events) {
    if (event.type !== 'plan.approved' && event.type !== 'plan.rejected') continue;
    const data = event.data;
    if (!isPlainObject(data) || typeof data.planHash !== 'string') continue;
    if (data.planHash !== plan.planHash) continue;
    if (Object.prototype.hasOwnProperty.call(data, 'planId') && data.planId !== plan.id) continue;
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

/**
 * A required decision is met only when the latest `decision.resolved` event for
 * its id carries an approving choice. A later rejection supersedes an earlier
 * approval, a resolution without an option is not an approval, and a decision
 * still listed on the production snapshot is open. Requirements may name the
 * exact `optionId`, an `approveOptionIds` allow-list, or rely on the default
 * rule that refuses the closed rejecting vocabulary.
 */
export function decisionApproved(events, production, required) {
  const decisionId = decisionIdOf(required);
  if (!decisionId) return false;
  const pending = new Set(
    Array.isArray(production?.pendingDecisionIds) ? production.pendingDecisionIds : [],
  );
  if (pending.has(decisionId)) return false;
  if (!Array.isArray(events)) return false;
  const event = latestResolution(events, decisionId);
  if (!event) return false;
  const data = event.data;
  if (data.status === 'rejected') return false;
  if (typeof data.optionId !== 'string' || data.optionId.length === 0) return false;
  if (isPlainObject(required)) {
    if (typeof required.optionId === 'string') return data.optionId === required.optionId;
    if (Array.isArray(required.approveOptionIds)) {
      return required.approveOptionIds.includes(data.optionId);
    }
  }
  return !REJECTING_OPTION_IDS.includes(data.optionId);
}

function decisionsSatisfied(events, production, plan) {
  for (const required of plan.requiredDecisions ?? []) {
    if (typeof required === 'string') {
      if (!decisionApproved(events, production, required)) return false;
      continue;
    }
    if (!isPlainObject(required)) return false;
    const decisionId = decisionIdOf(required);
    if (decisionId) {
      if (!decisionApproved(events, production, required)) return false;
      continue;
    }
    if (required.kind === 'action_spend') continue;
    return false;
  }
  return true;
}

function slotAdmission(events, planHash, actionId) {
  for (const event of events) {
    if (event.type !== 'action.state_changed' || !isPlainObject(event.data)) continue;
    if (event.data.planHash === planHash && event.data.id === actionId) return event.data;
  }
  return null;
}

function actionRecord(events, actionId) {
  let action = null;
  for (const event of events) {
    if (event.type !== 'action.state_changed' || !isPlainObject(event.data)) continue;
    if (event.data.id !== actionId) continue;
    if (event.data.commandId && event.data.planHash && event.data.expected) {
      action = event.data;
      continue;
    }
    if (action && typeof event.data.state === 'string') {
      action = { ...action, state: event.data.state };
    }
  }
  return action;
}

function proposeResult(productionId, plan, commit, command) {
  return {
    duplicate: commit.duplicate === true,
    committed: true,
    productionId,
    revision: commit.revision,
    lastSequence: commit.lastSequence,
    planHash: plan.planHash,
    allocation: null,
    plan,
    ...(command ? { command } : {}),
  };
}

function dispatchResult(productionId, action, commit) {
  return {
    duplicate: commit.duplicate === true,
    committed: true,
    productionId,
    revision: commit.revision,
    lastSequence: commit.lastSequence,
    action,
  };
}

/**
 * Create the action coordinator. `ledgerFor(production)` opens the production's
 * existing budget ledger and must not invent a spend cap.
 */
const KIND_TO_STAGE = Object.freeze({
  render: 'video',
  take: 'video',
  video: 'video',
  image: 'keyframe',
  generate: 'keyframe',
});

function roundOf(slot) {
  return Number.isInteger(slot?.round) && slot.round >= 1 ? slot.round : 1;
}

function validatePlanIterationSlots(production, plan) {
  if (!isPlainObject(production)
    || !isPlainObject(production.iteration)
    || !isPlainObject(production.iteration.policy)) {
    return;
  }
  const policy = production.iteration.policy;
  const shotIds = Array.isArray(production.shotIds) ? production.shotIds : [];
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];

  const groups = new Map();
  for (let i = 0; i < actions.length; i += 1) {
    const slot = actions[i];
    if (!isPlainObject(slot)) continue;
    const stage = KIND_TO_STAGE[slot.kind];
    if (stage === undefined) continue;

    let shot = null;
    const targetId = slot.targetId;
    if (typeof targetId === 'string') {
      if (shotIds.includes(targetId)) {
        shot = targetId;
      } else if (targetId.includes(':')) {
        const candidate = targetId.slice(0, targetId.indexOf(':'));
        if (shotIds.includes(candidate)) shot = candidate;
      }
    }
    if (shot === null) {
      throw new ActionError('INVALID_PLAN', `actions[${i}].targetId is not a shot or line of this production`, 400);
    }

    const key = `${shot}\u0000${stage}`;
    if (!groups.has(key)) groups.set(key, { shot, stage, slots: [], rounds: new Map() });
    const group = groups.get(key);
    group.slots.push(slot);
    const round = roundOf(slot);
    const current = group.rounds.get(round) ?? 0;
    group.rounds.set(round, current + 1);
  }

  for (const group of groups.values()) {
    const effective = effectivePolicyForShot(policy, group.shot);
    const stagePolicy = effective.stages[group.stage];
    const allowedTotal = stagePolicy.takes * stagePolicy.rounds;
    const allowedRounds = stagePolicy.rounds;
    const allowedPerRound = stagePolicy.takes;

    const distinctRounds = group.rounds.size;
    if (distinctRounds > allowedRounds) {
      throw new ActionError(
        'ITERATION_EXCEEDED',
        `${group.shot} ${group.stage}: ${distinctRounds} rounds exceed allowed ${allowedRounds}`,
        400,
        { shotId: group.shot, stage: group.stage, allowed: allowedRounds, requested: distinctRounds },
      );
    }

    let maxPerRound = 0;
    for (const count of group.rounds.values()) {
      if (count > maxPerRound) maxPerRound = count;
    }
    if (maxPerRound > allowedPerRound) {
      throw new ActionError(
        'ITERATION_EXCEEDED',
        `${group.shot} ${group.stage}: ${maxPerRound} slots in one round exceed allowed ${allowedPerRound}`,
        400,
        { shotId: group.shot, stage: group.stage, allowed: allowedPerRound, requested: maxPerRound },
      );
    }

    const total = group.slots.length;
    if (total > allowedTotal) {
      throw new ActionError(
        'ITERATION_EXCEEDED',
        `${group.shot} ${group.stage}: ${total} slots exceed allowed ${allowedTotal}`,
        400,
        { shotId: group.shot, stage: group.stage, allowed: allowedTotal, requested: total },
      );
    }
  }

  const auditionCounts = new Map();
  for (let i = 0; i < actions.length; i += 1) {
    const slot = actions[i];
    if (!isPlainObject(slot) || slot.kind !== 'audition') continue;
    const characterId = slot.characterId;
    if (typeof characterId !== 'string') continue;
    const current = auditionCounts.get(characterId) ?? 0;
    auditionCounts.set(characterId, current + 1);
  }

  const voiceStage = policy.stages.voice;
  for (const [characterId, count] of auditionCounts) {
    const allowed = voiceStage.auditions;
    if (count > allowed) {
      throw new ActionError(
        'ITERATION_EXCEEDED',
        `character ${characterId} voice: ${count} auditions exceed allowed ${allowed}`,
        400,
        { characterId, stage: 'voice', allowed, requested: count },
      );
    }
  }
}

export function createActionCoordinator(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('createActionCoordinator options must be an object');
  }
  const { store, handler, ledgerFor } = options;
  if (!store || typeof store.commit !== 'function' || typeof store.read !== 'function'
    || typeof store.findCommit !== 'function' || typeof store.readEvents !== 'function') {
    throw new TypeError('createActionCoordinator requires a production store');
  }
  if (!handler || typeof handler.execute !== 'function') {
    throw new TypeError('createActionCoordinator requires the command handler');
  }
  if (typeof ledgerFor !== 'function') {
    throw new TypeError('createActionCoordinator requires ledgerFor(production)');
  }

  if (!handler.__iterationGateWrapped) {
    const originalExecute = handler.execute.bind(handler);
    handler.execute = function (envelope, context) {
      if (isPlainObject(envelope) && envelope.kind === 'plan.approve') {
        const productionId = envelope.productionId;
        if (typeof productionId === 'string') {
          const production = store.read(productionId);
          if (production) {
            const events = store.readEvents(productionId);
            const plans = proposedPlans(events);
            const targetHash = isPlainObject(envelope.payload) ? envelope.payload.planHash : undefined;
            const targetId = isPlainObject(envelope.payload) ? envelope.payload.planId : undefined;
            let plan = null;
            for (let i = plans.length - 1; i >= 0; i -= 1) {
              const candidate = plans[i];
              if (targetHash && candidate.planHash !== targetHash) continue;
              if (targetId && candidate.id !== targetId) continue;
              plan = candidate;
              break;
            }
            if (plan && planHasPaidSlot(plan)) {
              const policy = production.iteration && isPlainObject(production.iteration)
                ? production.iteration.policy
                : undefined;
              if (!isPlainObject(policy)) {
                throw new ActionError('ITERATION_LEVEL_REQUIRED', 'an iteration level must be set before approving a paid plan', 409);
              }
            }
          }
        }
      }
      return originalExecute(envelope, context);
    };
    handler.__iterationGateWrapped = true;
  }

  function existingCommit(productionId, commandId, idempotencyKey) {
    return store.findCommit(productionId, { commandId, idempotencyKey });
  }

  function propose({ productionId, body, context }) {
    const { commandId, idempotencyKey } = requireCommand(body);
    const prior = existingCommit(productionId, commandId, idempotencyKey);
    if (!isPlainObject(body.expected)) {
      if (prior) throw conflict(commandId, idempotencyKey);
      throw new ActionError('INVALID_COMMAND', 'expected revision is required', 400);
    }

    let stored;
    try {
      stored = buildStoredPlan(body.payload, productionId);
    } catch (error) {
      if (prior) throw conflict(commandId, idempotencyKey);
      throw error;
    }

    const production = store.read(productionId);
    if (production) {
      try {
        validatePlanIterationSlots(production, stored);
      } catch (error) {
        if (prior) throw conflict(commandId, idempotencyKey);
        throw error;
      }
    }

    const envelope = {
      commandId,
      idempotencyKey,
      productionId,
      kind: 'plan.propose',
      expected: body.expected,
      payload: stored,
    };
    const requestHash = requestHashFor(envelope, productionId);
    if (prior) {
      if (prior.requestHash !== undefined && prior.requestHash !== requestHash) {
        throw conflict(commandId, idempotencyKey);
      }
      const events = store.readEvents(productionId);
      const planEvent = events.find((event) => (prior.eventIds ?? []).includes(event.id) && event.type === 'plan.proposed');
      const plan = planEvent?.data ?? stored;
      return proposeResult(productionId, plan, { ...prior, duplicate: true }, null);
    }

    const events = store.readEvents(productionId);
    const plans = proposedPlans(events);
    const sameRevision = planAtRevision(plans, stored.id, stored.revision);
    if (sameRevision && sameRevision.planHash !== stored.planHash) {
      throw new ActionError('INVALID_PLAN', 'plan revision is immutable', 400);
    }

    requireContext(context);
    let result;
    try {
      result = handler.execute(envelope, context);
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw error;
    }
    const planEvent = (result.events ?? []).find((event) => event.type === 'plan.proposed');
    const plan = planEvent?.data ?? stored;
    return proposeResult(productionId, plan, result, result.command);
  }

  function reserveSlot(ledger, { commandId, reservationId, upperBound, planHash, actionId }) {
    const evidence = { source: 'action.dispatch', commandId, planHash, actionId };
    const base = {
      reservationId,
      upperBound,
      collectAndStopReserve: 0,
      evidence,
    };
    let reserved;
    try {
      reserved = ledger.reserve({ ...base, idempotencyKey: `reserve:${commandId}` });
    } catch (error) {
      mapLedger(error);
    }
    if (!reserved.duplicate) return { created: true, reserved };
    const open = (reserved.status?.openReservations ?? []).find((entry) => entry.reservationId === reservationId);
    if (open) {
      if (open.upperBound !== upperBound) {
        throw new ActionError(
          'IDEMPOTENCY_CONFLICT',
          'command id or idempotency key was reused with a different request',
          409,
          { commandId },
        );
      }
      return { created: false, reserved };
    }
    try {
      reserved = ledger.reserve({
        ...base,
        idempotencyKey: `reserve:${commandId}:${reserved.status?.revision ?? 'retry'}`,
      });
    } catch (error) {
      mapLedger(error);
    }
    return { created: reserved.duplicate !== true, reserved };
  }

  function releaseSlot(ledger, reservationId, commandId) {
    try {
      ledger.release({
        reservationId,
        idempotencyKey: `release:${commandId}:${reservationId}`,
        reason: 'dispatch_refused',
      });
    } catch (error) {
      if (error?.code !== 'RESERVATION_NOT_OPEN') {
        // The admission itself failed. Leaving the release error unthrown keeps
        // that refusal as the client-visible result; a still-open hold is
        // recovered by retrying the same commandId.
      }
    }
  }

  function dispatch({ productionId, body, context }) {
    const { commandId, idempotencyKey } = requireCommand(body);
    if (!isPlainObject(body.payload)) {
      throw new ActionError('INVALID_PLAN', 'payload must be an object', 400);
    }
    if (!isPlainObject(body.expected) || !Number.isSafeInteger(body.expected.productionRevision) || body.expected.productionRevision < 0) {
      throw new ActionError('INVALID_COMMAND', 'expected.productionRevision is required', 400);
    }
    if (body.expected.packageRevision !== undefined
      && (!Number.isSafeInteger(body.expected.packageRevision) || body.expected.packageRevision < 0)) {
      throw new ActionError('INVALID_COMMAND', 'packageRevision must be a non-negative integer', 400);
    }

    const envelope = {
      commandId,
      idempotencyKey,
      productionId,
      kind: 'action.dispatch',
      expected: body.expected,
      payload: body.payload,
    };
    const requestHash = requestHashFor(envelope, productionId);
    const prior = existingCommit(productionId, commandId, idempotencyKey);
    if (prior) {
      if (prior.requestHash !== undefined && prior.requestHash !== requestHash) {
        throw conflict(commandId, idempotencyKey);
      }
      const ids = new Set(prior.eventIds ?? []);
      const matched = store.readEvents(productionId).find((event) => ids.has(event.id)
        && event.type === 'action.state_changed'
        && isPlainObject(event.data)
        && event.data.commandId === commandId);
      if (!matched) {
        throw new ActionError('INTERNAL', 'the committed action could not be read', 500);
      }
      return dispatchResult(productionId, matched.data, { ...prior, duplicate: true });
    }

    requireContext(context);
    const production = store.read(productionId);
    if (!production) throw new ActionError('NOT_FOUND', 'production does not exist', 404);
    if (production.revision !== body.expected.productionRevision) {
      throw new ActionError('REVISION_CONFLICT', 'baseRevision does not match the committed revision', 409, {
        currentRevision: production.revision,
        baseRevision: body.expected.productionRevision,
      });
    }

    const intent = production.intent;
    if (intent === 'paused') {
      throw new ActionError('PRODUCTION_PAUSED', 'a paused production cannot admit paid work', 409);
    }
    if (intent !== 'active') {
      throw new ActionError('PRODUCTION_NOT_ACTIVE', 'only an active production can admit paid work', 409);
    }

    const payload = body.payload;
    if (!isIdentifier(payload.planId) || !Number.isSafeInteger(payload.planRevision) || payload.planRevision < 0) {
      throw new ActionError('INVALID_PLAN', 'planId and planRevision are required', 400);
    }

    const events = store.readEvents(productionId);
    const plans = proposedPlans(events);
    const latest = latestPlan(plans, payload.planId);
    if (!latest) throw new ActionError('UNKNOWN_PLAN', 'action plan does not exist', 404);
    const selected = planAtRevision(plans, payload.planId, payload.planRevision);
    if (!selected || selected.planHash !== latest.planHash || selected.revision !== latest.revision) {
      throw new ActionError('PLAN_CHANGED', 'the approved plan is no longer the latest revision', 409, {
        planId: payload.planId,
        planHash: latest.planHash,
      });
    }

    const slots = Array.isArray(selected.actions) ? selected.actions : [];
    if (slots.length === 0) {
      throw new ActionError('NO_DISPATCHABLE_ACTIONS', 'the plan lists no actions to dispatch', 409);
    }
    if (!isIdentifier(payload.actionId)) {
      throw new ActionError('INVALID_PLAN', 'actionId is required', 400);
    }
    const slot = slots.find((entry) => entry.id === payload.actionId);
    if (!slot) throw new ActionError('UNKNOWN_ACTION', 'action is not on the approved plan', 404);
    if (slotAdmission(events, selected.planHash, payload.actionId)) {
      throw new ActionError('SLOT_CONSUMED', 'this plan slot was already admitted', 409, {
        planHash: selected.planHash,
        actionId: payload.actionId,
      });
    }

    const authority = approvalState(events, selected);
    if (authority.rejected) {
      throw new ActionError('PLAN_REJECTED', 'the plan was rejected', 409, { planHash: selected.planHash });
    }
    if (!authority.approved) {
      throw new ActionError('APPROVAL_REQUIRED', 'the plan hash has no user approval', 409, { planHash: selected.planHash });
    }
    if (!decisionsSatisfied(events, production, selected)) {
      throw new ActionError('DECISION_REQUIRED', 'a required decision is still open', 409);
    }

    const ledger = ledgerFor(production);
    if (!ledger || typeof ledger.reserve !== 'function' || typeof ledger.release !== 'function') {
      throw new ActionError('LEDGER_UNAVAILABLE', 'the production budget ledger is not available', 500);
    }
    const reservationId = reservationIdFor(selected.planHash, payload.actionId);
    const { created } = reserveSlot(ledger, {
      commandId,
      reservationId,
      upperBound: slot.upperBound,
      planHash: selected.planHash,
      actionId: payload.actionId,
    });

    const action = {
      id: payload.actionId,
      productionId,
      planId: selected.id,
      planHash: selected.planHash,
      commandId,
      idempotencyKey,
      expected: {
        productionRevision: body.expected.productionRevision,
        ...(body.expected.packageRevision !== undefined ? { packageRevision: body.expected.packageRevision } : {}),
      },
      state: 'queued',
      reservationId,
      attemptId: null,
      jobId: null,
      runId: null,
      lastError: null,
      ...(typeof slot.kind === 'string' && slot.kind !== '' ? { kind: slot.kind } : {}),
      ...(slot.kind === 'audition'
        ? {
            audition: {
              characterId: slot.characterId,
              voice: slot.voice,
              line: slot.line,
              engine: slot.engine,
            },
          }
        : {}),
    };
    const validation = validateAction(action);
    if (!validation.ok) {
      if (created) releaseSlot(ledger, reservationId, commandId);
      throw new ActionError('INVALID_PLAN', 'the action record is invalid', 500, { errors: validation.errors });
    }

    const next = clone(production);
    if (!next.actionIds.includes(action.id)) next.actionIds = [...next.actionIds, action.id];
    const attribution = context.userEventId ? { userEventId: context.userEventId } : {};
    let committed;
    try {
      committed = store.commit(productionId, {
        commandId,
        idempotencyKey,
        baseRevision: body.expected.productionRevision,
        requestHash,
        production: next,
        events: [
          { type: 'action.state_changed', data: action, ...attribution },
          {
            type: 'budget.reserved',
            data: {
              actionId: action.id,
              planId: selected.id,
              planHash: selected.planHash,
              reservationId,
              upperBound: slot.upperBound,
              hold: slot.upperBound,
            },
            ...attribution,
          },
        ],
        outbox: [{
          id: outboxIdFor(commandId),
          type: 'action.dispatch',
          payload: {
            productionId,
            actionId: action.id,
            planId: selected.id,
            planHash: selected.planHash,
            commandId,
            reservationId,
            upperBound: slot.upperBound,
            ...(typeof slot.kind === 'string' && slot.kind !== '' ? { kind: slot.kind } : {}),
            ...(slot.kind === 'audition'
              ? {
                  audition: {
                    characterId: slot.characterId,
                    voice: slot.voice,
                    line: slot.line,
                    engine: slot.engine,
                  },
                }
              : {}),
          },
        }],
      });
    } catch (error) {
      if (created) releaseSlot(ledger, reservationId, commandId);
      mapStore(error);
    }

    const recorded = (committed.events ?? []).find((event) => event.type === 'action.state_changed')?.data ?? action;
    return dispatchResult(productionId, recorded, committed);
  }

  function getAction({ productionId, actionId }) {
    if (!isIdentifier(actionId)) throw new ActionError('UNKNOWN_ACTION', 'action does not exist', 404);
    const production = store.read(productionId);
    if (!production) throw new ActionError('NOT_FOUND', 'production does not exist', 404);
    const action = actionRecord(store.readEvents(productionId), actionId);
    if (!action) throw new ActionError('UNKNOWN_ACTION', 'action does not exist', 404);
    return { action };
  }

  return Object.freeze({ propose, dispatch, getAction });
}
