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

export const PRODUCTION_SCHEMA = 'comfyrizz.production/v1';

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
 * @property {string} briefVersionId
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
  requireId(errors, doc.briefVersionId, joinPath(path, 'briefVersionId'), { label: 'brief version id' });
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

// --- Event (spec 6.5/6.6) --------------------------------------------------

function event(errors, doc, path) {
  if (!requireObject(errors, doc, path, 'event')) return;
  requireId(errors, doc.id, joinPath(path, 'id'), { label: 'event id' });
  requireId(errors, doc.productionId, joinPath(path, 'productionId'), { label: 'production id' });
  requireIntegerAtLeast(errors, doc.sequence, 1, joinPath(path, 'sequence'), 'INVALID_SEQUENCE');
  requireEnum(errors, doc.type, EVENTS, joinPath(path, 'type'), 'UNKNOWN_EVENT_TYPE');
  requireTimestamp(errors, doc.at, joinPath(path, 'at'));
  requireObject(errors, doc.data, joinPath(path, 'data'), 'event data');
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
  requireObject(errors, doc.payload, joinPath(path, 'payload'), 'command payload');
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
