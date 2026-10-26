// IP04: closed contract types for the iterative production coordinator.
//
// The coordinator is a production-domain module, not a workflow engine
// (architecture D1). Its vocabulary is fixed and hand-written: stages,
// commands, events, decision kinds and action states are specification, not
// configuration. This file is the pure validation layer every other production
// module (store, ledger, commands, routes) shares.
//
// Purity: no filesystem, clock, network or randomness. Validators never throw;
// they return `{ ok, errors: [{ path, code, message }] }` where `path` is a
// JSON pointer into the input, so the HTTP facade can name the exact field.
//
// Authority: actor and user-event attribution are server-owned. A client
// request may not claim `actor: "user"` (or supply its own `userEventId`) to
// authorize a decision; `validateCommandEnvelope` rejects those fields and
// `validateRecordedCommand` validates the attribution the server added.

import { validateIterationPolicy } from './iteration.mjs';

export const PRODUCTION_SCHEMA = 'comfyrizz.production/v1';

// IL02: iteration failures are a closed set of codes. `iteration.set` is the
// only way to establish a level; a paid plan without one is
// ITERATION_LEVEL_REQUIRED, a policy beyond the D4 limits is
// ITERATION_EXCEEDED, and a mid-production change cannot touch a shot that is
// rendered or in flight (ITERATION_SHOT_LOCKED).
export const ITERATION_LEVEL_REQUIRED = 'ITERATION_LEVEL_REQUIRED';
export const ITERATION_EXCEEDED = 'ITERATION_EXCEEDED';
export const ITERATION_SHOT_LOCKED = 'ITERATION_SHOT_LOCKED';

// Spec 4.1: a production's phase is derived from its artifacts and events, so
// it is never stored. `intent` is the only durable production-level status.
export const PRODUCTION_INTENTS = Object.freeze([
  'active',
  'paused',
  'cancel_requested',
  'archived',
]);

// Spec 6.2: exactly these fifteen artifact kinds.
export const ARTIFACT_KINDS = Object.freeze([
  'source',
  'brief',
  'script',
  'identity',
  'composition',
  'motion_reference',
  'audition',
  'voice_reference',
  'conditioning',
  'native_take',
  'transcript',
  'review',
  'edit',
  'mix',
  'delivery',
]);

// Spec 6.3: exactly these eight decision kinds and five statuses.
export const DECISION_KINDS = Object.freeze([
  'direction',
  'voice_selection',
  'native_transfer',
  'reference',
  'take_selection',
  'creative_verdict',
  'action_spend',
  'final_delivery',
]);

export const DECISION_STATUSES = Object.freeze([
  'pending',
  'resolved',
  'rejected',
  'superseded',
  'revoked',
]);

// Spec 6.4: exactly these fifteen action states. `submission_unknown` is a
// first-class state, never an error string; it is reconciled, never silently
// resubmitted.
export const ACTION_STATES = Object.freeze([
  'planned',
  'awaiting_decision',
  'queued',
  'dispatching',
  'running',
  'collecting',
  'verifying',
  'completed',
  'blocked',
  'failed',
  'submission_unknown',
  'cancel_requested',
  'cancelled',
  'interrupted',
  'reconciling',
]);

// Spec 6.4: the only allowed action state transitions. Terminal states have no
// outgoing edges; `completed` may not be re-run, a failed or interrupted
// action is reconciled from its durable attempt record, and human review
// cannot move a completed action backwards.
export const ACTION_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['awaiting_decision', 'queued', 'blocked', 'failed', 'cancelled']),
  awaiting_decision: Object.freeze(['planned', 'queued', 'blocked', 'failed', 'cancelled']),
  queued: Object.freeze(['dispatching', 'blocked', 'failed', 'cancel_requested', 'cancelled']),
  dispatching: Object.freeze(['running', 'submission_unknown', 'blocked', 'failed', 'cancel_requested']),
  running: Object.freeze(['collecting', 'blocked', 'failed', 'submission_unknown', 'cancel_requested', 'interrupted']),
  collecting: Object.freeze(['verifying', 'failed', 'interrupted', 'blocked']),
  verifying: Object.freeze(['completed', 'failed', 'blocked']),
  completed: Object.freeze([]),
  blocked: Object.freeze(['queued', 'failed', 'cancelled']),
  failed: Object.freeze(['reconciling']),
  submission_unknown: Object.freeze(['reconciling', 'cancelled', 'failed']),
  cancel_requested: Object.freeze(['cancelled', 'completed', 'failed']),
  cancelled: Object.freeze([]),
  interrupted: Object.freeze(['reconciling', 'queued', 'failed', 'cancelled']),
  reconciling: Object.freeze(['completed', 'failed', 'queued', 'submission_unknown', 'cancelled']),
});

// Spec 6.4: a review observation is technical by default. Only a
// CreativeVerdict (a user decision) can carry approval.
export const REVIEW_OBSERVATION_KINDS = Object.freeze(['technical', 'creative']);

export const VERDICTS = Object.freeze(['approved', 'rejected']);

export const RECORDED_ACTORS = Object.freeze(['user', 'agent', 'system']);

// Spec 4.3/6.5: append-only event journal vocabulary. The sixteen events from
// the closed vocabulary are kept verbatim; the remaining entries generalize
// decisions, action attempts and deliveries so those records never need an
// out-of-band event name.
export const EVENTS = Object.freeze([
  'production.created',
  'production.intent_changed',
  'production.failed',
  'production.cancelled',
  'plan.proposed',
  'plan.approved',
  'plan.rejected',
  'iteration.set',
  'voice_mode.set',
  'decision.requested',
  'decision.resolved',
  'stage.entered',
  'stage.completed',
  'artifact.attached',
  'cast.decided',
  'take.requested',
  'take.landed',
  'take.selected',
  'clip.reviewed',
  'review.observed',
  'verdict.recorded',
  'action.planned',
  'action.state_changed',
  'budget.ceiling_set',
  'budget.reserved',
  'budget.settled',
  'render.gate.blocked',
  'delivery.updated',
]);

// Spec 4.2/7.1: the only mutation commands. `production.create` is the one
// envelope without a productionId; `decision.resolve` is the same command for
// an explicit UI click and for a chat decision (architecture D5).
export const COMMANDS = Object.freeze([
  'production.create',
  'production.pause',
  'production.resume',
  'production.archive',
  'production.cancel',
  'plan.propose',
  'plan.approve',
  'plan.reject',
  'iteration.set',
  'voice_mode.set',
  'decision.resolve',
  'stage.advance',
  'artifact.attach',
  'cast.decide',
  'take.request',
  'take.select',
  'clip.approve',
  'clip.reject',
  'render.request',
  'gate.override',
  'budget.set_ceiling',
  'budget.reserve',
  'budget.settle',
  'action.dispatch',
  'action.retry',
  'action.cancel',
  'delivery.accept',
]);

/**
 * @typedef {{ path: string, code: string, message: string }} ValidationError
 * @typedef {{ ok: boolean, errors: ValidationError[] }} ValidationResult
 * @typedef {{ artifactId: string, hash: string, role: string }} DerivedFrom
 * @typedef {{ actionId?: string, commandId?: string, actor: string }} CreatedBy
 * @typedef {{ private: boolean, conditionAllowed: boolean, redistributeAllowed: boolean, licenseId?: string|null }} ArtifactAccess
 * @typedef {{ id: string, label: string, artifactIds: string[] }} DecisionOption
 * @typedef {{ userEventId: string, at: string, actor: 'user', optionId?: string, reason?: string }} DecisionResolution
 * @typedef {{ kind: string, targetIds?: string[], id?: string, decisionId?: string }} RequiredDecision
 * @typedef {{ productionRevision: number, packageRevision?: number }} ExpectedRevisions
 * @typedef {{ code: string, message: string }} ActionError
 * @typedef {{ name: string, ok: boolean, detail?: string }} ReviewCheck
 * @typedef {{ id: string, productionId: string, commandId?: string, userEventId?: string }} EventRecord
 * @typedef {{ commandId: string, productionId?: string, expected: ExpectedRevisions, kind: string, payload: object, idempotencyKey?: string }} CommandEnvelope
 * @typedef {CommandEnvelope & { productionId: string, actor: string, userEventId: string, at?: string }} RecordedCommand
 */

/**
 * @typedef {object} Production
 * @property {'comfyrizz.production/v1'} schema
 * @property {string} id Stable identity created before any package.
 * @property {number} revision Non-negative compare-and-swap revision.
 * @property {string} conversationId
 * @property {string|null} packageId Null until a package exists.
 * @property {'active'|'paused'|'cancel_requested'|'archived'} intent Durable intent, not a derived phase.
 * @property {string|null} briefVersionId
 * @property {string|null} scriptVersionId
 * @property {string[]} shotIds
 * @property {Array<{characterId: string, voiceId?: string|null, artifactId?: string|null, role?: string}>} characterBindings
 * @property {object} reviewPolicy
 * @property {string} budgetLedgerId
 * @property {string[]} pendingDecisionIds
 * @property {string[]} actionIds
 * @property {string|null} latestDeliveryId
 * @property {number} lastSequence Non-negative; the sequence of the newest event.
 */

/**
 * @typedef {object} ArtifactVersion
 * @property {string} id
 * @property {string} logicalId
 * @property {number} version Positive; versions of one logical artifact never mutate.
 * @property {string} productionId
 * @property {string} kind One of ARTIFACT_KINDS.
 * @property {string} contentHash
 * @property {string|null} [mediaId]
 * @property {object} metadata Server-owned; may not contain absolute or local paths.
 * @property {DerivedFrom[]} derivedFrom
 * @property {CreatedBy} createdBy
 * @property {object} provenance
 * @property {ArtifactAccess} access
 */

/**
 * @typedef {object} Decision
 * @property {string} id
 * @property {string} productionId
 * @property {string} kind One of DECISION_KINDS.
 * @property {string} status One of DECISION_STATUSES.
 * @property {string[]} targetIds
 * @property {string} inputFingerprint
 * @property {number} proposalVersion Non-negative.
 * @property {DecisionOption[]} options
 * @property {DecisionResolution} [resolution] Required for resolved/rejected; actor must be 'user'.
 */

/**
 * @typedef {object} ActionPlan
 * @property {string} id
 * @property {string} productionId
 * @property {string} planHash Immutable; approved plans are never edited in place.
 * @property {number} revision Non-negative.
 * @property {RequiredDecision[]} requiredDecisions
 * @property {number} reservationCeiling Non-negative upper bound in the ledger's unit.
 */

/**
 * @typedef {object} Action
 * @property {string} id
 * @property {string} productionId
 * @property {string} planId
 * @property {string} planHash
 * @property {string} commandId
 * @property {string} idempotencyKey
 * @property {ExpectedRevisions} expected
 * @property {string} state One of ACTION_STATES.
 * @property {string|null} [reservationId]
 * @property {string|null} [attemptId]
 * @property {string|null} [jobId]
 * @property {string|null} [runId]
 * @property {ActionError|null} [lastError]
 */

/**
 * @typedef {object} ReviewObservation
 * @property {string} id
 * @property {string} productionId
 * @property {string} takeId
 * @property {'technical'|'creative'} kind
 * @property {string} at ISO-8601 timestamp.
 * @property {string} summary
 * @property {ReviewCheck[]} [checks]
 * @property {'approved'|'rejected'|null} [verdict] Forbidden on technical observations.
 */

/**
 * @typedef {object} CreativeVerdict
 * @property {string} id
 * @property {string} productionId
 * @property {string} takeId
 * @property {'approved'|'rejected'} verdict
 * @property {string} userEventId
 * @property {string} at
 * @property {'user'} actor The agent may propose, never approve.
 * @property {string} [note]
 */

const ID_RE = /^[^\s/\\\u0000-\u001f]+$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ABSOLUTE_PATH_RE = /^(?:[/\\]|[A-Za-z]:[/\\]|file:\/\/|~[/\\])/i;
const TRAVERSAL_PATH_RE = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function joinPath(base, key) {
  return base === '' ? `/${key}` : `${base}/${key}`;
}

function push(errors, path, code, message) {
  errors.push({ path: path === '' ? '/' : path, code, message });
}

function requireObject(errors, value, path, label = 'value') {
  if (!isPlainObject(value)) {
    push(errors, path, 'INVALID_OBJECT', `${label} must be an object`);
    return false;
  }
  return true;
}

function requireArray(errors, value, path) {
  if (!Array.isArray(value)) {
    push(errors, path, 'INVALID_ARRAY', `${path || '/'} must be an array`);
    return false;
  }
  return true;
}

function requireText(errors, value, path, { code = 'INVALID_STRING', label, max = 4000 } = {}) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    push(errors, path, code, `${path || '/'} must be ${label || 'a non-empty string'}`);
    return false;
  }
  return true;
}

function requireId(errors, value, path, { code = 'MISSING_ID', label = 'id' } = {}) {
  if (value === undefined || value === null || value === '') {
    push(errors, path, code, `${path || '/'} (${label}) is required`);
    return false;
  }
  if (typeof value !== 'string' || value.length > 256 || !ID_RE.test(value)) {
    push(errors, path, 'INVALID_ID', `${path || '/'} must be a non-empty identifier without whitespace or path separators`);
    return false;
  }
  return true;
}

function optionalId(errors, value, path, label = 'id') {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string' || value.length > 256 || !ID_RE.test(value)) {
    push(errors, path, 'INVALID_ID', `${path || '/'} must be a non-empty identifier without whitespace or path separators`);
    return false;
  }
  return true;
}

function requireIntegerAtLeast(errors, value, minimum, path, code) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    push(errors, path, code, `${path || '/'} must be an integer greater than or equal to ${minimum}`);
    return false;
  }
  return true;
}

function requireNonNegativeAmount(errors, value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    push(errors, path, 'INVALID_AMOUNT', `${path || '/'} must be a non-negative number`);
    return false;
  }
  return true;
}

function requireTimestamp(errors, value, path) {
  if (typeof value !== 'string' || !ISO_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    push(errors, path, 'INVALID_TIMESTAMP', `${path || '/'} must be an ISO-8601 timestamp with a timezone`);
    return false;
  }
  return true;
}

function requireEnum(errors, value, list, path, code) {
  if (!list.includes(value)) {
    push(errors, path, code, `${path || '/'} must be one of: ${list.join(', ')}`);
    return false;
  }
  return true;
}

function requireUniqueIds(errors, value, path) {
  if (!requireArray(errors, value, path)) return;
  const seen = new Set();
  value.forEach((id, index) => {
    if (!requireId(errors, id, joinPath(path, index), { label: 'id' })) return;
    if (seen.has(id)) push(errors, joinPath(path, index), 'DUPLICATE_ID', `${joinPath(path, index)} duplicates ${id}`);
    seen.add(id);
  });
}

function scanForPaths(errors, value, path, seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (ABSOLUTE_PATH_RE.test(value)) {
      push(errors, path, 'ABSOLUTE_PATH', `${path || '/'} must not contain an absolute or local filesystem path; paths are server-owned`);
    } else if (TRAVERSAL_PATH_RE.test(value)) {
      push(errors, path, 'LOCAL_PATH', `${path || '/'} must not contain a traversal path; paths are server-owned`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForPaths(errors, entry, joinPath(path, index), seen));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    scanForPaths(errors, entry, joinPath(path, key), seen);
  }
}

function validateExpectedRevisions(errors, value, path) {
  if (!requireObject(errors, value, path, 'expected')) return;
  requireIntegerAtLeast(errors, value.productionRevision, 0, joinPath(path, 'productionRevision'), 'INVALID_REVISION');
  if (value.packageRevision !== undefined) {
    requireIntegerAtLeast(errors, value.packageRevision, 0, joinPath(path, 'packageRevision'), 'INVALID_REVISION');
  }
}

// --- Production (spec 6.1) -------------------------------------------------

function production(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'production')) return;
  if (doc.schema !== PRODUCTION_SCHEMA) {
    push(errors, joinPath(path, 'schema'), 'INVALID_SCHEMA', `schema must be ${PRODUCTION_SCHEMA}`);
  }
  requireId(errors, doc.id, joinPath(path, 'id'), { label: 'production id' });
  requireIntegerAtLeast(errors, doc.revision, 0, joinPath(path, 'revision'), 'INVALID_REVISION');
  requireId(errors, doc.conversationId, joinPath(path, 'conversationId'), { label: 'conversation id' });
  if (doc.packageId !== null) optionalId(errors, doc.packageId, joinPath(path, 'packageId'), 'package id');
  if (doc.packageId === undefined) {
    push(errors, joinPath(path, 'packageId'), 'INVALID_ID', 'packageId must be a string or null');
  }
  requireEnum(errors, doc.intent, PRODUCTION_INTENTS, joinPath(path, 'intent'), 'INVALID_INTENT');
  // Spec 6.1: briefVersionId is string | null (a production can exist before its brief version).
  if (doc.briefVersionId !== null) optionalId(errors, doc.briefVersionId, joinPath(path, 'briefVersionId'), 'brief version id');
  if (doc.briefVersionId === undefined) {
    push(errors, joinPath(path, 'briefVersionId'), 'INVALID_ID', 'briefVersionId must be a string or null');
  }
  if (doc.scriptVersionId !== null) optionalId(errors, doc.scriptVersionId, joinPath(path, 'scriptVersionId'), 'script version id');
  if (doc.scriptVersionId === undefined) {
    push(errors, joinPath(path, 'scriptVersionId'), 'INVALID_ID', 'scriptVersionId must be a string or null');
  }
  requireUniqueIds(errors, doc.shotIds, joinPath(path, 'shotIds'));

  // An invalid array still lets the remaining production fields report their
  // own errors, so the HTTP facade can return every problem at once.
  if (requireArray(errors, doc.characterBindings, joinPath(path, 'characterBindings'))) {
    doc.characterBindings.forEach((binding, index) => {
      const at = joinPath(joinPath(path, 'characterBindings'), index);
      if (!requireObject(errors, binding, at, 'character binding')) return;
      requireId(errors, binding.characterId, joinPath(at, 'characterId'), { label: 'character id' });
      if (binding.voiceId !== undefined && binding.voiceId !== null) optionalId(errors, binding.voiceId, joinPath(at, 'voiceId'), 'voice id');
      if (binding.artifactId !== undefined && binding.artifactId !== null) optionalId(errors, binding.artifactId, joinPath(at, 'artifactId'), 'artifact id');
      if (binding.role !== undefined) requireText(errors, binding.role, joinPath(at, 'role'), { max: 200 });
    });
  }

  requireObject(errors, doc.reviewPolicy, joinPath(path, 'reviewPolicy'), 'reviewPolicy');
  requireId(errors, doc.budgetLedgerId, joinPath(path, 'budgetLedgerId'), { label: 'budget ledger id' });
  requireUniqueIds(errors, doc.pendingDecisionIds, joinPath(path, 'pendingDecisionIds'));
  requireUniqueIds(errors, doc.actionIds, joinPath(path, 'actionIds'));
  if (doc.latestDeliveryId !== null) optionalId(errors, doc.latestDeliveryId, joinPath(path, 'latestDeliveryId'), 'delivery id');
  if (doc.latestDeliveryId === undefined) {
    push(errors, joinPath(path, 'latestDeliveryId'), 'INVALID_ID', 'latestDeliveryId must be a string or null');
  }
  requireIntegerAtLeast(errors, doc.lastSequence, 0, joinPath(path, 'lastSequence'), 'INVALID_SEQUENCE');

  // A phase is computed from artifacts and events; storing one would create a
  // second source of truth that can drift.
  if (Object.prototype.hasOwnProperty.call(doc, 'phase')) {
    push(errors, joinPath(path, 'phase'), 'DERIVED_FIELD', 'phase is derived from artifacts and events and must not be stored');
  }
}

// --- ArtifactVersion (spec 6.2) --------------------------------------------

function artifactVersion(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'artifact version')) return;
  requireId(errors, doc.id, joinPath(path, 'id'), { label: 'artifact version id' });
  requireId(errors, doc.logicalId, joinPath(path, 'logicalId'), { label: 'logical artifact id' });
  requireIntegerAtLeast(errors, doc.version, 1, joinPath(path, 'version'), 'INVALID_VERSION');
  requireId(errors, doc.productionId, joinPath(path, 'productionId'), { label: 'production id' });
  requireEnum(errors, doc.kind, ARTIFACT_KINDS, joinPath(path, 'kind'), 'UNKNOWN_ARTIFACT_KIND');
  requireText(errors, doc.contentHash, joinPath(path, 'contentHash'), { code: 'INVALID_HASH', label: 'a content hash', max: 512 });
  if (doc.mediaId !== undefined && doc.mediaId !== null) {
    optionalId(errors, doc.mediaId, joinPath(path, 'mediaId'), 'media id');
  }

  if (requireObject(errors, doc.metadata, joinPath(path, 'metadata'), 'metadata')) {
    scanForPaths(errors, doc.metadata, joinPath(path, 'metadata'));
  }

  if (requireArray(errors, doc.derivedFrom, joinPath(path, 'derivedFrom'))) {
    doc.derivedFrom.forEach((entry, index) => {
      const at = joinPath(joinPath(path, 'derivedFrom'), index);
      if (!requireObject(errors, entry, at, 'derivedFrom entry')) return;
      requireId(errors, entry.artifactId, joinPath(at, 'artifactId'), { label: 'artifact id' });
      requireText(errors, entry.hash, joinPath(at, 'hash'), { code: 'INVALID_HASH', label: 'a content hash', max: 512 });
      requireText(errors, entry.role, joinPath(at, 'role'), { max: 200 });
    });
  }

  if (requireObject(errors, doc.createdBy, joinPath(path, 'createdBy'), 'createdBy')) {
    const at = joinPath(path, 'createdBy');
    requireText(errors, doc.createdBy.actor, joinPath(at, 'actor'), { code: 'MISSING_ACTOR', label: 'an actor', max: 100 });
    if (doc.createdBy.actionId !== undefined) optionalId(errors, doc.createdBy.actionId, joinPath(at, 'actionId'), 'action id');
    if (doc.createdBy.commandId !== undefined) optionalId(errors, doc.createdBy.commandId, joinPath(at, 'commandId'), 'command id');
  }

  if (requireObject(errors, doc.provenance, joinPath(path, 'provenance'), 'provenance')) {
    scanForPaths(errors, doc.provenance, joinPath(path, 'provenance'));
  }

  if (requireObject(errors, doc.access, joinPath(path, 'access'), 'access')) {
    const at = joinPath(path, 'access');
    for (const key of ['private', 'conditionAllowed', 'redistributeAllowed']) {
      if (typeof doc.access[key] !== 'boolean') {
        push(errors, joinPath(at, key), 'INVALID_BOOLEAN', `${joinPath(at, key)} must be a boolean`);
      }
    }
    if (doc.access.licenseId !== undefined && doc.access.licenseId !== null) {
      requireText(errors, doc.access.licenseId, joinPath(at, 'licenseId'), { max: 200 });
    }
  }
}

// --- Decision (spec 6.3) ---------------------------------------------------

function decision(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'decision')) return;
  requireId(errors, doc.id, joinPath(path, 'id'), { label: 'decision id' });
  requireId(errors, doc.productionId, joinPath(path, 'productionId'), { label: 'production id' });
  requireEnum(errors, doc.kind, DECISION_KINDS, joinPath(path, 'kind'), 'UNKNOWN_DECISION_KIND');
  requireEnum(errors, doc.status, DECISION_STATUSES, joinPath(path, 'status'), 'UNKNOWN_DECISION_STATUS');
  requireUniqueIds(errors, doc.targetIds, joinPath(path, 'targetIds'));
  requireText(errors, doc.inputFingerprint, joinPath(path, 'inputFingerprint'), { code: 'INVALID_HASH', label: 'an input fingerprint', max: 512 });
  requireIntegerAtLeast(errors, doc.proposalVersion, 0, joinPath(path, 'proposalVersion'), 'INVALID_REVISION');

  const optionIds = new Set();
  if (requireArray(errors, doc.options, joinPath(path, 'options'))) {
    doc.options.forEach((option, index) => {
      const at = joinPath(joinPath(path, 'options'), index);
      if (!requireObject(errors, option, at, 'decision option')) return;
      if (requireId(errors, option.id, joinPath(at, 'id'), { label: 'option id' })) {
        if (optionIds.has(option.id)) push(errors, joinPath(at, 'id'), 'DUPLICATE_ID', `${joinPath(at, 'id')} duplicates ${option.id}`);
        optionIds.add(option.id);
      }
      requireText(errors, option.label, joinPath(at, 'label'), { max: 500 });
      requireUniqueIds(errors, option.artifactIds, joinPath(at, 'artifactIds'));
    });
  }

  const mustResolve = doc.status === 'resolved' || doc.status === 'rejected';
  if (doc.resolution === undefined || doc.resolution === null) {
    if (mustResolve) {
      push(errors, joinPath(path, 'resolution'), 'MISSING_RESOLUTION', 'a resolved or rejected decision requires a user resolution');
    }
    return;
  }

  if (!requireObject(errors, doc.resolution, joinPath(path, 'resolution'), 'resolution')) return;
  const at = joinPath(path, 'resolution');
  requireText(errors, doc.resolution.userEventId, joinPath(at, 'userEventId'), { code: 'MISSING_USER_EVENT', label: 'the originating user event id', max: 256 });
  requireTimestamp(errors, doc.resolution.at, joinPath(at, 'at'));

  if (doc.resolution.actor === undefined || doc.resolution.actor === null) {
    push(errors, joinPath(at, 'actor'), 'MISSING_ACTOR', 'a resolution requires an actor');
  } else if (doc.resolution.actor !== 'user') {
    push(errors, joinPath(at, 'actor'), 'AGENT_CANNOT_RESOLVE', 'only a user can resolve a decision; the agent may propose, never approve');
  }

  if (doc.resolution.reason !== undefined) {
    requireText(errors, doc.resolution.reason, joinPath(at, 'reason'), { max: 4000 });
  }

  if (doc.resolution.optionId === undefined || doc.resolution.optionId === null) {
    if (doc.status === 'resolved') {
      push(errors, joinPath(at, 'optionId'), 'MISSING_OPTION', 'a resolved decision must name the chosen option');
    }
  } else if (requireId(errors, doc.resolution.optionId, joinPath(at, 'optionId'), { label: 'option id' })) {
    if (!optionIds.has(doc.resolution.optionId)) {
      push(errors, joinPath(at, 'optionId'), 'UNKNOWN_OPTION', `${doc.resolution.optionId} is not one of this decision's options`);
    }
  }
}

// --- ActionPlan and Action (spec 6.4) --------------------------------------

function actionPlan(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'action plan')) return;
  requireId(errors, doc.id, joinPath(path, 'id'), { label: 'action plan id' });
  requireId(errors, doc.productionId, joinPath(path, 'productionId'), { label: 'production id' });
  requireText(errors, doc.planHash, joinPath(path, 'planHash'), { code: 'MISSING_PLAN_HASH', label: 'an immutable plan hash', max: 512 });
  requireIntegerAtLeast(errors, doc.revision, 0, joinPath(path, 'revision'), 'INVALID_REVISION');

  if (requireArray(errors, doc.requiredDecisions, joinPath(path, 'requiredDecisions'))) {
    doc.requiredDecisions.forEach((required, index) => {
      const at = joinPath(joinPath(path, 'requiredDecisions'), index);
      if (typeof required === 'string') {
        requireId(errors, required, at, { label: 'decision id' });
        return;
      }
      if (!requireObject(errors, required, at, 'required decision')) return;
      requireEnum(errors, required.kind, DECISION_KINDS, joinPath(at, 'kind'), 'UNKNOWN_DECISION_KIND');
      if (required.targetIds !== undefined) requireUniqueIds(errors, required.targetIds, joinPath(at, 'targetIds'));
      if (required.id !== undefined) optionalId(errors, required.id, joinPath(at, 'id'), 'decision id');
      if (required.decisionId !== undefined) optionalId(errors, required.decisionId, joinPath(at, 'decisionId'), 'decision id');
    });
  }

  requireNonNegativeAmount(errors, doc.reservationCeiling, joinPath(path, 'reservationCeiling'));
}

function action(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'action')) return;
  requireId(errors, doc.id, joinPath(path, 'id'), { label: 'action id' });
  requireId(errors, doc.productionId, joinPath(path, 'productionId'), { label: 'production id' });
  requireId(errors, doc.planId, joinPath(path, 'planId'), { label: 'action plan id' });
  requireText(errors, doc.planHash, joinPath(path, 'planHash'), { code: 'MISSING_PLAN_HASH', label: 'an immutable plan hash', max: 512 });
  requireId(errors, doc.commandId, joinPath(path, 'commandId'), { label: 'command id' });
  requireId(errors, doc.idempotencyKey, joinPath(path, 'idempotencyKey'), { label: 'idempotency key' });
  validateExpectedRevisions(errors, doc.expected, joinPath(path, 'expected'));
  requireEnum(errors, doc.state, ACTION_STATES, joinPath(path, 'state'), 'UNKNOWN_ACTION_STATE');

  if (doc.reservationId !== undefined && doc.reservationId !== null) {
    optionalId(errors, doc.reservationId, joinPath(path, 'reservationId'), 'reservation id');
  }
  for (const key of ['attemptId', 'jobId', 'runId']) {
    if (doc[key] !== undefined && doc[key] !== null) requireText(errors, doc[key], joinPath(path, key), { max: 512 });
  }
  if (doc.lastError !== undefined && doc.lastError !== null) {
    const at = joinPath(path, 'lastError');
    if (requireObject(errors, doc.lastError, at, 'lastError')) {
      requireText(errors, doc.lastError.code, joinPath(at, 'code'), { max: 200 });
      requireText(errors, doc.lastError.message, joinPath(at, 'message'), { max: 4000 });
    }
  }
}

// --- Review observations and creative verdicts (spec 6.4) ------------------

function reviewObservation(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'review observation')) return;
  requireId(errors, doc.id, joinPath(path, 'id'), { label: 'observation id' });
  requireId(errors, doc.productionId, joinPath(path, 'productionId'), { label: 'production id' });
  requireId(errors, doc.takeId, joinPath(path, 'takeId'), { label: 'take id' });
  requireEnum(errors, doc.kind, REVIEW_OBSERVATION_KINDS, joinPath(path, 'kind'), 'UNKNOWN_OBSERVATION_KIND');
  requireTimestamp(errors, doc.at, joinPath(path, 'at'));
  requireText(errors, doc.summary, joinPath(path, 'summary'), { max: 4000 });

  if (doc.checks !== undefined) {
    if (requireArray(errors, doc.checks, joinPath(path, 'checks'))) {
      doc.checks.forEach((check, index) => {
        const at = joinPath(joinPath(path, 'checks'), index);
        if (!requireObject(errors, check, at, 'review check')) return;
        requireText(errors, check.name, joinPath(at, 'name'), { max: 200 });
        if (typeof check.ok !== 'boolean') {
          push(errors, joinPath(at, 'ok'), 'INVALID_BOOLEAN', `${joinPath(at, 'ok')} must be a boolean`);
        }
        if (check.detail !== undefined) requireText(errors, check.detail, joinPath(at, 'detail'), { max: 4000 });
      });
    }
  }

  if (doc.verdict !== undefined && doc.verdict !== null) {
    if (doc.kind === 'technical') {
      push(errors, joinPath(path, 'verdict'), 'TECHNICAL_VERDICT_FORBIDDEN', 'a technical observation cannot carry a user verdict');
    } else {
      requireEnum(errors, doc.verdict, VERDICTS, joinPath(path, 'verdict'), 'INVALID_VERDICT');
    }
  }
}

function creativeVerdict(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'creative verdict')) return;
  requireId(errors, doc.id, joinPath(path, 'id'), { label: 'verdict id' });
  requireId(errors, doc.productionId, joinPath(path, 'productionId'), { label: 'production id' });
  requireId(errors, doc.takeId, joinPath(path, 'takeId'), { label: 'take id' });
  requireEnum(errors, doc.verdict, VERDICTS, joinPath(path, 'verdict'), 'INVALID_VERDICT');
  requireText(errors, doc.userEventId, joinPath(path, 'userEventId'), { code: 'MISSING_USER_EVENT', label: 'the originating user event id', max: 256 });
  requireTimestamp(errors, doc.at, joinPath(path, 'at'));

  if (doc.actor === undefined || doc.actor === null) {
    push(errors, joinPath(path, 'actor'), 'MISSING_ACTOR', 'a creative verdict requires an actor');
  } else if (doc.actor !== 'user') {
    push(errors, joinPath(path, 'actor'), 'AGENT_CANNOT_RESOLVE', 'only a user can record a creative verdict');
  }
  if (doc.note !== undefined) requireText(errors, doc.note, joinPath(path, 'note'), { max: 4000 });
}

// --- Iteration.set payload (IL02) ------------------------------------------

const ITERATION_SET_KEYS = new Set(['policy', 'scope']);
const ITERATION_SCOPE_KEYS = new Set(['shotIds']);

// The policy validator names dotted fields (`policy.stages.video.takes`).
// Keep that name intact as one JSON-pointer token so a shot id containing a
// dot is never split into a different path.
function iterationPolicyPath(base, field) {
  if (typeof field !== 'string' || field === '' || field === 'policy') return base;
  const token = field.startsWith('policy.') ? field.slice('policy.'.length) : field;
  return joinPath(base, token);
}

function iterationSetPayload(errors, value, path) {
  for (const key of Object.keys(value)) {
    if (!ITERATION_SET_KEYS.has(key)) {
      push(errors, joinPath(path, key), 'UNKNOWN_FIELD', `${joinPath(path, key)} is not a recognized field`);
    }
  }

  const policyPath = joinPath(path, 'policy');
  if (!Object.hasOwn(value, 'policy')) {
    push(errors, policyPath, 'INVALID_OBJECT', `${policyPath} is required`);
  } else if (!isPlainObject(value.policy)) {
    push(errors, policyPath, 'INVALID_OBJECT', `${policyPath} must be an object`);
  } else {
    try {
      validateIterationPolicy(value.policy);
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : 'ITERATION_POLICY_INVALID';
      const field = error && typeof error.field === 'string' ? error.field : '';
      const message = error && typeof error.message === 'string' ? error.message : 'policy is invalid';
      push(errors, iterationPolicyPath(policyPath, field), code, message);
    }
  }

  if (!Object.hasOwn(value, 'scope')) return;
  const scopePath = joinPath(path, 'scope');
  if (!requireObject(errors, value.scope, scopePath, 'scope')) return;
  for (const key of Object.keys(value.scope)) {
    if (!ITERATION_SCOPE_KEYS.has(key)) {
      push(errors, joinPath(scopePath, key), 'UNKNOWN_FIELD', `${joinPath(scopePath, key)} is not a recognized field`);
    }
  }
  const shotIdsPath = joinPath(scopePath, 'shotIds');
  if (!Object.hasOwn(value.scope, 'shotIds')) {
    push(errors, shotIdsPath, 'INVALID_ARRAY', `${shotIdsPath} must be an array`);
    return;
  }
  // An empty list would be a second spelling of "no scope" (the whole
  // production); a scoped change names at least one shot, otherwise omit scope.
  if (Array.isArray(value.scope.shotIds) && value.scope.shotIds.length === 0) {
    push(errors, shotIdsPath, 'INVALID_ARRAY', `${shotIdsPath} must name at least one shot; omit scope for the whole production`);
    return;
  }
  requireUniqueIds(errors, value.scope.shotIds, shotIdsPath);
}

const VOICE_MODE_SET_KEYS = new Set(['h3VoiceMode']);

const CEILING_KEYS = new Set(['ceiling']);

function ceilingPayload(errors, value, path) {
  for (const key of Object.keys(value)) {
    if (!CEILING_KEYS.has(key)) {
      push(errors, joinPath(path, key), 'UNKNOWN_FIELD', `${joinPath(path, key)} is not a recognized field`);
    }
  }
  const ceilingPath = joinPath(path, 'ceiling');
  if (!Object.hasOwn(value, 'ceiling')) {
    push(errors, ceilingPath, 'INVALID_CEILING', `${ceilingPath} is required`);
    return;
  }
  const ceiling = value.ceiling;
  if (ceiling !== null && (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0)) {
    push(errors, ceilingPath, 'INVALID_CEILING', `${ceilingPath} must be null or a finite non-negative number`);
  }
}

function voiceModeSetPayload(errors, value, path) {
  for (const key of Object.keys(value)) {
    if (!VOICE_MODE_SET_KEYS.has(key)) {
      push(errors, joinPath(path, key), 'UNKNOWN_FIELD', `${joinPath(path, key)} is not a recognized field`);
    }
  }
  const modePath = joinPath(path, 'h3VoiceMode');
  if (!Object.hasOwn(value, 'h3VoiceMode')) {
    push(errors, modePath, 'INVALID_H3_VOICE_MODE', `${modePath} is required`);
    return;
  }
  const mode = value.h3VoiceMode;
  if (mode !== null && mode !== 'clip' && mode !== 'prompt') {
    push(errors, modePath, 'INVALID_H3_VOICE_MODE', `${modePath} must be one of: clip, prompt, null`);
  }
}

// --- Event (spec 6.5/6.6) --------------------------------------------------

function event(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'event')) return;
  requireId(errors, doc.id, joinPath(path, 'id'), { label: 'event id' });
  requireId(errors, doc.productionId, joinPath(path, 'productionId'), { label: 'production id' });
  requireIntegerAtLeast(errors, doc.sequence, 1, joinPath(path, 'sequence'), 'INVALID_SEQUENCE');
  requireEnum(errors, doc.type, EVENTS, joinPath(path, 'type'), 'UNKNOWN_EVENT_TYPE');
  requireTimestamp(errors, doc.at, joinPath(path, 'at'));
  if (requireObject(errors, doc.data, joinPath(path, 'data'), 'event data')) {
    if (doc.type === 'iteration.set') {
      iterationSetPayload(errors, doc.data, joinPath(path, 'data'));
    } else if (doc.type === 'voice_mode.set') {
      voiceModeSetPayload(errors, doc.data, joinPath(path, 'data'));
    } else if (doc.type === 'budget.ceiling_set') {
      ceilingPayload(errors, doc.data, joinPath(path, 'data'));
    }
  }
  if (doc.commandId !== undefined) optionalId(errors, doc.commandId, joinPath(path, 'commandId'), 'command id');
  if (doc.userEventId !== undefined) optionalId(errors, doc.userEventId, joinPath(path, 'userEventId'), 'user event id');
}

// --- Command envelope and recorded command (spec 7.1) ----------------------

function commandFields(errors, doc, path, { allowProductionIdForCreate }) {
  requireId(errors, doc.commandId, joinPath(path, 'commandId'), { label: 'command id' });
  const kindOk = requireEnum(errors, doc.kind, COMMANDS, joinPath(path, 'kind'), 'UNKNOWN_COMMAND_KIND');
  if (kindOk && doc.kind === 'production.create') {
    if (!allowProductionIdForCreate && doc.productionId !== undefined) {
      push(errors, joinPath(path, 'productionId'), 'PRODUCTION_ID_NOT_ALLOWED', 'production.create omits productionId; the server assigns it');
    }
  } else if (kindOk) {
    if (doc.productionId === undefined || doc.productionId === null) {
      push(errors, joinPath(path, 'productionId'), 'MISSING_ID', 'every command except production.create requires a productionId');
    } else {
      requireId(errors, doc.productionId, joinPath(path, 'productionId'), { label: 'production id' });
    }
  }
  validateExpectedRevisions(errors, doc.expected, joinPath(path, 'expected'));
  if (requireObject(errors, doc.payload, joinPath(path, 'payload'), 'command payload')
    && kindOk) {
    if (doc.kind === 'iteration.set') {
      iterationSetPayload(errors, doc.payload, joinPath(path, 'payload'));
    } else if (doc.kind === 'voice_mode.set') {
      voiceModeSetPayload(errors, doc.payload, joinPath(path, 'payload'));
    } else if (doc.kind === 'budget.set_ceiling') {
      ceilingPayload(errors, doc.payload, joinPath(path, 'payload'));
    }
  }
  if (doc.idempotencyKey !== undefined) {
    requireId(errors, doc.idempotencyKey, joinPath(path, 'idempotencyKey'), { label: 'idempotency key' });
  }
}

function commandEnvelope(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'command envelope')) return;
  commandFields(errors, doc, path, { allowProductionIdForCreate: false });
  // Attribution is server-side. A request must not be able to assert its own
  // authority by supplying these fields.
  if (Object.prototype.hasOwnProperty.call(doc, 'actor')) {
    push(errors, joinPath(path, 'actor'), 'CLIENT_ATTRIBUTION_FORBIDDEN', 'actor is assigned by the server and must not be supplied by the client');
  }
  if (Object.prototype.hasOwnProperty.call(doc, 'userEventId')) {
    push(errors, joinPath(path, 'userEventId'), 'CLIENT_ATTRIBUTION_FORBIDDEN', 'userEventId is assigned by the server and must not be supplied by the client');
  }
}

function recordedCommand(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'recorded command')) return;
  commandFields(errors, doc, path, { allowProductionIdForCreate: true });
  if (doc.productionId === undefined || doc.productionId === null) {
    push(errors, joinPath(path, 'productionId'), 'MISSING_ID', 'a recorded command always carries the server-assigned productionId');
  } else {
    requireId(errors, doc.productionId, joinPath(path, 'productionId'), { label: 'production id' });
  }

  if (doc.actor === undefined || doc.actor === null || doc.actor === '') {
    push(errors, joinPath(path, 'actor'), 'MISSING_ACTOR', 'a recorded command requires the server-assigned actor');
  } else if (!RECORDED_ACTORS.includes(doc.actor)) {
    push(errors, joinPath(path, 'actor'), 'INVALID_ACTOR', `actor must be one of: ${RECORDED_ACTORS.join(', ')}`);
  }

  // Both user clicks and chat-driven agent commands cite the user message that
  // authorized them (architecture D5). A system command may omit it.
  if (doc.actor === 'user' || doc.actor === 'agent') {
    requireText(errors, doc.userEventId, joinPath(path, 'userEventId'), { code: 'MISSING_USER_EVENT', label: 'the originating user event id', max: 256 });
  } else if (doc.userEventId !== undefined) {
    optionalId(errors, doc.userEventId, joinPath(path, 'userEventId'), 'user event id');
  }

  if (doc.at !== undefined) requireTimestamp(errors, doc.at, joinPath(path, 'at'));
}

// --- Pure transition query -------------------------------------------------

/**
 * True only when `from` and `to` are known states and the transition table
 * contains the edge. Same-state and unknown-state calls are always false.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  const allowed = ACTION_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function makeValidator(fn) {
  return function validate(value) {
    const errors = [];
    try {
      fn(errors, value, '');
    } catch {
      return {
        ok: false,
        errors: [{ path: '/', code: 'INVALID_INPUT', message: 'input could not be read as a production record' }],
      };
    }
    return { ok: errors.length === 0, errors };
  };
}

/** @param {unknown} value @returns {ValidationResult} */
export const validateProduction = makeValidator(production);
/** @param {unknown} value @returns {ValidationResult} */
export const validateArtifactVersion = makeValidator(artifactVersion);
/** @param {unknown} value @returns {ValidationResult} */
export const validateDecision = makeValidator(decision);
/** @param {unknown} value @returns {ValidationResult} */
export const validateActionPlan = makeValidator(actionPlan);
/** @param {unknown} value @returns {ValidationResult} */
export const validateAction = makeValidator(action);
/** @param {unknown} value @returns {ValidationResult} */
export const validateReviewObservation = makeValidator(reviewObservation);
/** @param {unknown} value @returns {ValidationResult} */
export const validateCreativeVerdict = makeValidator(creativeVerdict);
/** @param {unknown} value @returns {ValidationResult} */
export const validateEvent = makeValidator(event);
/** @param {unknown} value @returns {ValidationResult} */
export const validateCommandEnvelope = makeValidator(commandEnvelope);
/** @param {unknown} value @returns {ValidationResult} */
export const validateRecordedCommand = makeValidator(recordedCommand);

// --- UX00: generation admission (comfyrizz.admission/v1) -------------------
//
// One admission rule for every entry point that can allocate generation work.
// The field names are the live IP24 `/api/run` shape (`authority` +
// `expected`); this is not a second envelope. Binding is resolved by the
// server from the production store, never from a caller boolean.

export const ADMISSION_CONTRACT = 'comfyrizz.admission/v1';

// Every start path that can reach a backend. A bound package must be admitted
// (or refused with a code below) at each of these; an entry point that cannot
// verify authority refuses with BOUND_ENTRY_UNSUPPORTED instead of running
// unguarded. Unbound packages keep their legacy behaviour.
export const ADMISSION_ENTRY_POINTS = Object.freeze([
  'run.start',
  'pipeline.start',
  'take.regenerate',
  'take.regenerate_batch',
  'take.queue_drain',
  'chat.correction',
  'audition.synthesize',
  'action.outbox',
]);

// Pause stops future admissions; cancel_requested and archived never admit.
// Intent does not unbind a package: a paused production still owns it.
export const ADMITTING_INTENTS = Object.freeze(['active']);

// Typed refusal code -> HTTP status. Codes already returned by run.mjs keep
// their status; PRODUCTION_NOT_ACTIVE and BOUND_ENTRY_UNSUPPORTED are new.
export const ADMISSION_REFUSALS = Object.freeze({
  BOUND_AUTHORITY_REQUIRED: 400,
  CALLER_AUTHORITY_FORBIDDEN: 400,
  PRODUCTION_MISMATCH: 403,
  PRODUCTION_NOT_FOUND: 404,
  UNKNOWN_PLAN: 404,
  UNKNOWN_ACTION: 404,
  REVISION_CONFLICT: 409,
  PRODUCTION_NOT_ACTIVE: 409,
  PLAN_REJECTED: 409,
  APPROVAL_REQUIRED: 409,
  ACTION_CONSUMED: 409,
  ACTION_NOT_ADMITTED: 409,
  SLOT_BOUND_EXCEEDED: 409,
  BUDGET_EXCEEDED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  DUPLICATE_START: 409,
  RUN_BUSY: 409,
  BOUND_ENTRY_UNSUPPORTED: 409,
  BOUND_AUTHORITY_UNAVAILABLE: 500,
  LEDGER_UNAVAILABLE: 500,
});

// Safe detail keys on a refusal body. `budget` stays an opaque object until the
// UX02 amendment versions its spent/reserved/available fields.
export const ADMISSION_REFUSAL_DETAIL_KEYS = Object.freeze([
  'entryPoint',
  'productionId',
  'planId',
  'planHash',
  'actionId',
  'reservationId',
  'commandId',
  'idempotencyKey',
  'intent',
  'currentRevision',
  'baseRevision',
  'activeRunId',
  'slot',
  'budget',
  'errors',
]);

// A refusal must not look like started or queued work.
const REFUSAL_START_KEYS = Object.freeze(['runId', 'started', 'queued', 'approved', 'jobId', 'attemptId']);
const REFUSAL_BASE_KEYS = new Set(['error', 'code', 'status']);
const AUTHORITY_KEYS = new Set(['productionId', 'planId', 'planHash', 'actionId']);
const CALLER_AUTHORITY_KEYS = new Set(['approved', 'actor', 'userEventId', 'reservationId', 'state']);
const BOUND_ADMISSION_KEYS = new Set(['authority', 'expected']);

/**
 * @typedef {{ productionId: string, planId: string, planHash: string, actionId: string }} BoundAuthority
 * @typedef {{ authority: BoundAuthority, expected: ExpectedRevisions }} BoundAdmission
 * @typedef {{ state: 'unbound' }
 *   | { state: 'bound', productionId: string, source: 'store'|'package', intent: string|null, revision: number|null }
 *   | { state: 'conflict', productionId: string, packageProductionId: string }} ProductionBinding
 * @typedef {{ error: string, code: string, status: number } & Record<string, unknown>} AdmissionRefusal
 */

function boundAdmission(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'bound admission')) return;
  for (const key of Object.keys(doc)) {
    if (BOUND_ADMISSION_KEYS.has(key)) continue;
    const at = joinPath(path, key);
    if (CALLER_AUTHORITY_KEYS.has(key)) {
      push(errors, at, 'CALLER_AUTHORITY_FORBIDDEN', `${at} cannot authorize a bound start; only the dispatched action authority does`);
    } else {
      push(errors, at, 'UNKNOWN_FIELD', `${at} is not a recognized field`);
    }
  }
  const authorityPath = joinPath(path, 'authority');
  if (doc.authority === undefined || doc.authority === null) {
    push(errors, authorityPath, 'BOUND_AUTHORITY_REQUIRED', 'a production-bound start requires its dispatched action authority');
  } else if (requireObject(errors, doc.authority, authorityPath, 'authority')) {
    for (const key of Object.keys(doc.authority)) {
      if (AUTHORITY_KEYS.has(key)) continue;
      const at = joinPath(authorityPath, key);
      if (CALLER_AUTHORITY_KEYS.has(key)) {
        push(errors, at, 'CALLER_AUTHORITY_FORBIDDEN', `${at} is server-owned and cannot be supplied as authority`);
      } else {
        push(errors, at, 'UNKNOWN_FIELD', `${at} is not a recognized field`);
      }
    }
    requireId(errors, doc.authority.productionId, joinPath(authorityPath, 'productionId'), { code: 'BOUND_AUTHORITY_REQUIRED', label: 'production id' });
    requireId(errors, doc.authority.planId, joinPath(authorityPath, 'planId'), { code: 'BOUND_AUTHORITY_REQUIRED', label: 'action plan id' });
    requireText(errors, doc.authority.planHash, joinPath(authorityPath, 'planHash'), { code: 'BOUND_AUTHORITY_REQUIRED', label: 'an immutable plan hash', max: 512 });
    requireId(errors, doc.authority.actionId, joinPath(authorityPath, 'actionId'), { code: 'BOUND_AUTHORITY_REQUIRED', label: 'action id' });
  }
  const expectedPath = joinPath(path, 'expected');
  if (doc.expected === undefined || doc.expected === null) {
    push(errors, expectedPath, 'BOUND_AUTHORITY_REQUIRED', 'expected.productionRevision is required for a production-bound start');
  } else {
    validateExpectedRevisions(errors, doc.expected, expectedPath);
  }
}

function admissionRefusalRecord(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'admission refusal')) return;
  const codeOk = requireEnum(errors, doc.code, Object.keys(ADMISSION_REFUSALS), joinPath(path, 'code'), 'UNKNOWN_REFUSAL_CODE');
  if (codeOk && doc.status !== ADMISSION_REFUSALS[doc.code]) {
    push(errors, joinPath(path, 'status'), 'REFUSAL_STATUS_MISMATCH', `${doc.code} is refused with HTTP ${ADMISSION_REFUSALS[doc.code]}`);
  }
  requireText(errors, doc.error, joinPath(path, 'error'), { max: 4000 });
  for (const key of Object.keys(doc)) {
    if (REFUSAL_BASE_KEYS.has(key) || ADMISSION_REFUSAL_DETAIL_KEYS.includes(key)) continue;
    const at = joinPath(path, key);
    if (REFUSAL_START_KEYS.includes(key)) {
      push(errors, at, 'REFUSAL_CLAIMS_START', `${at} must not appear on a refusal; refused work was never started or queued`);
    } else {
      push(errors, at, 'UNKNOWN_FIELD', `${at} is not a recognized refusal detail`);
    }
  }
  if (doc.code === 'PRODUCTION_NOT_ACTIVE') {
    const nonAdmitting = PRODUCTION_INTENTS.filter((intent) => !ADMITTING_INTENTS.includes(intent));
    requireEnum(errors, doc.intent, nonAdmitting, joinPath(path, 'intent'), 'INVALID_INTENT');
  }
  if (doc.entryPoint !== undefined) {
    requireEnum(errors, doc.entryPoint, ADMISSION_ENTRY_POINTS, joinPath(path, 'entryPoint'), 'UNKNOWN_ENTRY_POINT');
  }
  scanForPaths(errors, doc, path);
}

/** @param {unknown} value @returns {ValidationResult} */
export const validateBoundAdmission = makeValidator(boundAdmission);
/** @param {unknown} value @returns {ValidationResult} */
export const validateAdmissionRefusal = makeValidator(admissionRefusalRecord);

/**
 * The legacy unbound `/api/run` budget refusal: HTTP 200 with `refused: true`
 * and no `status`. Accepted only for unbound packages; a bound refusal uses
 * BUDGET_EXCEEDED with HTTP 409.
 */
export function isLegacyBudgetRefusal(value) {
  return isPlainObject(value)
    && value.code === 'BUDGET_EXCEEDED'
    && value.refused === true
    && value.status === undefined
    && REFUSAL_START_KEYS.every((key) => value[key] === undefined || value[key] === null || value[key] === false);
}

/**
 * Build a typed refusal body. Unlike the validators this throws, because an
 * unknown code or detail key is a programming error in the caller.
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {AdmissionRefusal}
 */
export function admissionRefusal(code, message, details = {}) {
  if (!Object.hasOwn(ADMISSION_REFUSALS, code)) throw new TypeError(`unknown admission refusal code: ${code}`);
  if (typeof message !== 'string' || message.trim() === '') throw new TypeError('an admission refusal needs a message');
  if (!isPlainObject(details)) throw new TypeError('refusal details must be an object');
  for (const key of Object.keys(details)) {
    if (!ADMISSION_REFUSAL_DETAIL_KEYS.includes(key)) throw new TypeError(`unknown admission refusal detail: ${key}`);
  }
  return { ...details, error: message, code, status: ADMISSION_REFUSALS[code] };
}

/**
 * The durable command identity for consuming one dispatched action. It is the
 * id run.mjs already commits (`run-start:<planHash>:<actionId>`) and is shared
 * by every entry point, so one action can start at most one execution.
 * @param {BoundAuthority} authority
 */
export function admissionCommandId(authority) {
  return `run-start:${authority.planHash}:${authority.actionId}`;
}

/**
 * Server-side production binding for a package.
 *
 * A package is bound to the lowest-id production whose `packageId` equals the
 * package id (the store lists productions in id order). A caller-supplied
 * `pkg.productionId` is not a package-schema field and can only make a start
 * stricter: it binds an otherwise unbound package, and disagreeing with the
 * store binding is a conflict (PRODUCTION_MISMATCH). Intent never unbinds.
 *
 * @param {{ id?: string, productionId?: string } | null | undefined} pkg
 * @param {Array<{ id: string, packageId: string|null, intent?: string, revision?: number }>} productions
 * @returns {ProductionBinding}
 */
export function resolveProductionBinding(pkg, productions) {
  const list = Array.isArray(productions) ? productions : [];
  const packageId = isPlainObject(pkg) && typeof pkg.id === 'string' && pkg.id !== '' ? pkg.id : null;
  const claimed = isPlainObject(pkg) && typeof pkg.productionId === 'string' && pkg.productionId.trim() !== ''
    ? pkg.productionId.trim()
    : null;
  const owners = packageId === null
    ? []
    : list.filter((production) => isPlainObject(production) && production.packageId === packageId)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const owner = owners[0] ?? null;
  if (owner && claimed && claimed !== owner.id) {
    return { state: 'conflict', productionId: owner.id, packageProductionId: claimed };
  }
  const chosen = owner ?? (claimed ? list.find((production) => isPlainObject(production) && production.id === claimed) ?? null : null);
  if (!owner && !claimed) return { state: 'unbound' };
  return {
    state: 'bound',
    productionId: owner ? owner.id : claimed,
    source: owner ? 'store' : 'package',
    intent: typeof chosen?.intent === 'string' ? chosen.intent : null,
    revision: Number.isSafeInteger(chosen?.revision) ? chosen.revision : null,
  };
}

/**
 * The refusal for a binding that cannot admit new work, or null when it can.
 * Authority (plan approval, queued action, reservation) is checked after this.
 * @param {ProductionBinding} binding
 * @param {string} [entryPoint]
 * @returns {AdmissionRefusal|null}
 */
export function bindingRefusal(binding, entryPoint) {
  const where = entryPoint === undefined ? {} : { entryPoint };
  if (!isPlainObject(binding) || binding.state === 'unbound') return null;
  if (binding.state === 'conflict') {
    return admissionRefusal('PRODUCTION_MISMATCH', 'the package names a different production than the one that owns it', {
      ...where,
      productionId: binding.productionId,
    });
  }
  if (binding.intent === null) {
    return admissionRefusal('PRODUCTION_NOT_FOUND', 'production not found', { ...where, productionId: binding.productionId });
  }
  if (!ADMITTING_INTENTS.includes(binding.intent)) {
    return admissionRefusal('PRODUCTION_NOT_ACTIVE', `the production is ${binding.intent}; no new work is admitted`, {
      ...where,
      productionId: binding.productionId,
      intent: binding.intent,
    });
  }
  return null;
}

// --- UX00: media source identity and tickets (comfyrizz.media-ticket/v1) ---
//
// A ticket is a short-lived bearer URL; the durable identity is the media
// source. Persist the source (or mediaId/artifactId), never `url`/`ticket`.

export const MEDIA_TICKET_CONTRACT = 'comfyrizz.media-ticket/v1';
export const MEDIA_ID_PATTERN = /^med_[a-f0-9]{32}$/;
export const MEDIA_TICKET_PATTERN = /^[a-f0-9]{32}$/;
export const MEDIA_SOURCE_KINDS = Object.freeze(['take', 'artifact', 'package_media', 'thumb']);
// Renew this long before `expiresAt` so a seek does not race expiry.
export const MEDIA_RENEW_BEFORE_MS = 30_000;
// Consecutive renewals without a successful load before a source is shown as
// unavailable instead of retried again.
export const MEDIA_RENEWAL_LIMIT = 2;

const MEDIA_SOURCE_FIELDS = Object.freeze({
  take: Object.freeze(['packageId', 'clipId', 'takeId']),
  artifact: Object.freeze(['artifactId', 'mediaId']),
  package_media: Object.freeze(['packageId', 'path']),
  thumb: Object.freeze(['key']),
});
const MEDIA_TICKET_KEYS = new Set(['ticket', 'url', 'expiresAt', 'mediaId', 'artifactId', 'kind', 'takeId']);
const EXPIRING_IDENTITY_KEYS = new Set(['url', 'ticket', 'ticketUrl', 'expiresAt']);

/**
 * @typedef {{ kind: 'take', packageId: string, clipId: string, takeId: string }
 *   | { kind: 'artifact', artifactId?: string, mediaId?: string }
 *   | { kind: 'package_media', packageId: string, path: string }
 *   | { kind: 'thumb', key: string }} MediaSource
 * @typedef {{ ticket: string, url: string, expiresAt: string, mediaId?: string, artifactId?: string|null, kind?: 'ticket', takeId?: string }} MediaTicket
 * @typedef {'fresh'|'renew'|'expired'|'unknown'} TicketExpiryState
 *
 * UX11 implements this; consumers depend only on the interface.
 * `resolve` deduplicates concurrent calls by `mediaSourceKey`, renews a
 * cached ticket whose expiry state is not `fresh`, rejects with an AbortError
 * when `signal` aborts, and stops after MEDIA_RENEWAL_LIMIT failed renewals.
 * `invalidate` drops a cached ticket after a media error so the next resolve
 * renews it.
 * @typedef {object} MediaResolver
 * @property {(source: MediaSource, options?: { signal?: AbortSignal }) => Promise<MediaTicket>} resolve
 * @property {(source: MediaSource) => void} invalidate
 * @property {() => void} dispose
 */

function mediaSource(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'media source')) return;
  if (!requireEnum(errors, doc.kind, MEDIA_SOURCE_KINDS, joinPath(path, 'kind'), 'UNKNOWN_MEDIA_SOURCE')) return;
  const fields = MEDIA_SOURCE_FIELDS[doc.kind];
  for (const key of Object.keys(doc)) {
    if (key === 'kind' || fields.includes(key)) continue;
    const at = joinPath(path, key);
    if (EXPIRING_IDENTITY_KEYS.has(key)) {
      push(errors, at, 'EXPIRING_URL_AS_IDENTITY', `${at} expires; identify media by its source, mediaId or artifactId`);
    } else {
      push(errors, at, 'UNKNOWN_FIELD', `${at} is not a recognized field`);
    }
  }
  if (doc.kind === 'take') {
    for (const key of fields) requireId(errors, doc[key], joinPath(path, key), { label: key });
  } else if (doc.kind === 'artifact') {
    if (doc.artifactId === undefined && doc.mediaId === undefined) {
      push(errors, path, 'MISSING_ID', 'an artifact media source names artifactId or mediaId');
    }
    if (doc.artifactId !== undefined) requireId(errors, doc.artifactId, joinPath(path, 'artifactId'), { label: 'artifact id' });
    if (doc.mediaId !== undefined && (typeof doc.mediaId !== 'string' || !MEDIA_ID_PATTERN.test(doc.mediaId))) {
      push(errors, joinPath(path, 'mediaId'), 'INVALID_MEDIA_ID', 'mediaId must match med_<32 hex>');
    }
  } else if (doc.kind === 'package_media') {
    requireId(errors, doc.packageId, joinPath(path, 'packageId'), { label: 'package id' });
    if (requireText(errors, doc.path, joinPath(path, 'path'), { max: 1024 })) {
      scanForPaths(errors, doc.path, joinPath(path, 'path'));
    }
  } else {
    requireText(errors, doc.key, joinPath(path, 'key'), { max: 512 });
  }
}

function mediaTicket(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'media ticket')) return;
  for (const key of Object.keys(doc)) {
    if (!MEDIA_TICKET_KEYS.has(key)) push(errors, joinPath(path, key), 'UNKNOWN_FIELD', `${joinPath(path, key)} is not a recognized field`);
  }
  const ticketOk = typeof doc.ticket === 'string' && MEDIA_TICKET_PATTERN.test(doc.ticket);
  if (!ticketOk) push(errors, joinPath(path, 'ticket'), 'INVALID_TICKET', 'ticket must be 32 lowercase hex characters');
  if (typeof doc.url !== 'string' || (ticketOk && doc.url !== `/api/media/${doc.ticket}`)) {
    push(errors, joinPath(path, 'url'), 'INVALID_TICKET_URL', 'url must be /api/media/<ticket>');
  }
  requireTimestamp(errors, doc.expiresAt, joinPath(path, 'expiresAt'));
  if (doc.mediaId !== undefined && (typeof doc.mediaId !== 'string' || !MEDIA_ID_PATTERN.test(doc.mediaId))) {
    push(errors, joinPath(path, 'mediaId'), 'INVALID_MEDIA_ID', 'mediaId must match med_<32 hex>');
  }
  if (doc.artifactId !== undefined && doc.artifactId !== null) optionalId(errors, doc.artifactId, joinPath(path, 'artifactId'), 'artifact id');
  if (doc.kind !== undefined && doc.kind !== 'ticket') push(errors, joinPath(path, 'kind'), 'INVALID_KIND', 'kind must be ticket');
  if (doc.takeId !== undefined) optionalId(errors, doc.takeId, joinPath(path, 'takeId'), 'take id');
}

/** @param {unknown} value @returns {ValidationResult} */
export const validateMediaSource = makeValidator(mediaSource);
/** @param {unknown} value @returns {ValidationResult} */
export const validateMediaTicket = makeValidator(mediaTicket);

/**
 * Deduplication/cache key for a valid media source: the same source always
 * maps to the same key regardless of property order.
 * @param {MediaSource} source
 */
export function mediaSourceKey(source) {
  const fields = MEDIA_SOURCE_FIELDS[source.kind] ?? [];
  return JSON.stringify([source.kind, ...fields.map((key) => source[key] ?? null)]);
}

/**
 * Expiry state of a ticket at `nowMs`. A ticket without `expiresAt` (the
 * legacy thumbs `ticketUrl`) is `unknown`: use it once, renew on the first
 * media error, never persist it.
 * @param {{ expiresAt?: string|null } | null | undefined} ticket
 * @param {number} nowMs
 * @param {number} [renewBeforeMs]
 * @returns {TicketExpiryState}
 */
export function ticketExpiryState(ticket, nowMs, renewBeforeMs = MEDIA_RENEW_BEFORE_MS) {
  const expiresAt = isPlainObject(ticket) ? ticket.expiresAt : undefined;
  if (typeof expiresAt !== 'string' || !ISO_RE.test(expiresAt)) return 'unknown';
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return 'unknown';
  if (expires <= nowMs) return 'expired';
  if (expires - nowMs <= renewBeforeMs) return 'renew';
  return 'fresh';
}
