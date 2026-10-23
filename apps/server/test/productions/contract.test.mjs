// IP04: contract types for the iterative production coordinator.
//
// The vocabulary here is closed and hand-written (spec section 4, "Closed
// vocabulary"). These tests pin the exact lists from the specification before
// the implementation exists, so an invented alias cannot slip into the shared
// contract that IP07/IP17/IP18/IP19 build on.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTION_STATES,
  ACTION_TRANSITIONS,
  ARTIFACT_KINDS,
  COMMANDS,
  DECISION_KINDS,
  DECISION_STATUSES,
  EVENTS,
  PRODUCTION_INTENTS,
  PRODUCTION_SCHEMA,
  REVIEW_OBSERVATION_KINDS,
  canTransition,
  validateAction,
  validateActionPlan,
  validateArtifactVersion,
  validateCommandEnvelope,
  validateCreativeVerdict,
  validateDecision,
  validateEvent,
  validateProduction,
  validateRecordedCommand,
  validateReviewObservation,
} from '../../src/productions/contract.mjs';

const AT = '2026-10-22T12:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertValid(result, label) {
  assert.deepEqual(result, { ok: true, errors: [] }, `${label} should be valid`);
}

function assertError(result, label, code, pathPart) {
  assert.equal(result.ok, false, `${label} should be invalid`);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, `${label} should report errors`);
  for (const error of result.errors) {
    assert.equal(typeof error.path, 'string');
    assert.equal(typeof error.code, 'string');
    assert.equal(typeof error.message, 'string');
    assert.ok(error.path.startsWith('/'), `error path should be a JSON pointer, got ${error.path}`);
  }
  if (code) {
    assert.ok(
      result.errors.some((error) => error.code === code),
      `${label} should include code ${code}; got ${JSON.stringify(result.errors)}`,
    );
  }
  if (pathPart) {
    assert.ok(
      result.errors.some((error) => error.path.includes(pathPart)),
      `${label} should include a path containing ${pathPart}; got ${JSON.stringify(result.errors)}`,
    );
  }
}

function validProduction(overrides = {}) {
  return {
    schema: PRODUCTION_SCHEMA,
    id: 'prod_1',
    revision: 4,
    conversationId: 'conv_1',
    packageId: null,
    intent: 'active',
    briefVersionId: 'av_brief_1',
    scriptVersionId: null,
    shotIds: ['shot_1', 'shot_2'],
    characterBindings: [{ characterId: 'char_1', voiceId: 'voice_1' }],
    reviewPolicy: { requireUserVerdict: true },
    budgetLedgerId: 'ledger_1',
    pendingDecisionIds: ['dec_1'],
    actionIds: ['act_1'],
    latestDeliveryId: null,
    lastSequence: 12,
    ...overrides,
  };
}

function validArtifact(overrides = {}) {
  return {
    id: 'av_1',
    logicalId: 'lg_take_shot_1',
    version: 1,
    productionId: 'prod_1',
    kind: 'native_take',
    contentHash: HASH_A,
    mediaId: 'med_1',
    metadata: { prompt: 'slow pan', seed: 42 },
    derivedFrom: [{ artifactId: 'av_0', hash: HASH_B, role: 'conditioning' }],
    createdBy: { actionId: 'act_1', actor: 'agent' },
    provenance: { backend: 'google-colab', modelRevision: 'ltx-2.5' },
    access: { private: true, conditionAllowed: true, redistributeAllowed: false },
    ...overrides,
  };
}

function validDecision(overrides = {}) {
  return {
    id: 'dec_1',
    productionId: 'prod_1',
    kind: 'voice_selection',
    status: 'pending',
    targetIds: ['shot_1'],
    inputFingerprint: HASH_A,
    proposalVersion: 0,
    options: [
      { id: 'opt_a', label: 'Voice A', artifactIds: ['av_voice_a'] },
      { id: 'opt_b', label: 'Voice B', artifactIds: ['av_voice_b'] },
    ],
    ...overrides,
  };
}

function validPlan(overrides = {}) {
  return {
    id: 'plan_1',
    productionId: 'prod_1',
    planHash: HASH_C,
    revision: 0,
    requiredDecisions: [
      { kind: 'action_spend', targetIds: ['shot_1'] },
      { kind: 'voice_selection', targetIds: ['shot_1'] },
    ],
    reservationCeiling: 5,
    ...overrides,
  };
}

function validAction(overrides = {}) {
  return {
    id: 'act_1',
    productionId: 'prod_1',
    planId: 'plan_1',
    planHash: HASH_C,
    commandId: 'cmd_1',
    idempotencyKey: 'idem_1',
    expected: { productionRevision: 4, packageRevision: 2 },
    state: 'planned',
    reservationId: 'res_1',
    attemptId: null,
    jobId: null,
    runId: null,
    ...overrides,
  };
}

function validObservation(overrides = {}) {
  return {
    id: 'obs_1',
    productionId: 'prod_1',
    takeId: 'take_1',
    kind: 'technical',
    at: AT,
    summary: 'duration 4.0s, audio present',
    checks: [
      { name: 'duration', ok: true },
      { name: 'audio', ok: true },
    ],
    ...overrides,
  };
}

function validCreativeVerdict(overrides = {}) {
  return {
    id: 'cv_1',
    productionId: 'prod_1',
    takeId: 'take_1',
    verdict: 'approved',
    userEventId: 'ue_1',
    at: AT,
    actor: 'user',
    note: 'matches the brief',
    ...overrides,
  };
}

function validEvent(overrides = {}) {
  return {
    id: 'evt_1',
    productionId: 'prod_1',
    sequence: 13,
    type: 'production.created',
    at: AT,
    data: { conversationId: 'conv_1' },
    ...overrides,
  };
}

function validCommand(overrides = {}) {
  return {
    commandId: 'cmd_1',
    productionId: 'prod_1',
    expected: { productionRevision: 4, packageRevision: 2 },
    kind: 'decision.resolve',
    payload: { decisionId: 'dec_1', optionId: 'opt_a' },
    ...overrides,
  };
}

function validRecordedCommand(overrides = {}) {
  return {
    ...validCommand(),
    actor: 'user',
    userEventId: 'ue_1',
    at: AT,
    ...overrides,
  };
}

// --- Closed vocabulary -----------------------------------------------------

test('artifact kinds are exactly the fifteen kinds in spec 6.2', () => {
  // docs/specs/ITERATIVE_PRODUCTION_AGENT.md 6.2 ArtifactVersion
  assert.deepEqual([...ARTIFACT_KINDS], [
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
});

test('decision kinds and statuses are exactly the values in spec 6.3', () => {
  // 6.3 Decision
  assert.deepEqual([...DECISION_KINDS], [
    'direction',
    'voice_selection',
    'native_transfer',
    'reference',
    'take_selection',
    'creative_verdict',
    'action_spend',
    'final_delivery',
  ]);
  assert.deepEqual([...DECISION_STATUSES], [
    'pending',
    'resolved',
    'rejected',
    'superseded',
    'revoked',
  ]);
});

test('action states are exactly the values in spec 6.4 and the transition table covers them', () => {
  // 6.4 Action
  assert.deepEqual([...ACTION_STATES], [
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
  assert.deepEqual(Object.keys(ACTION_TRANSITIONS).sort(), [...ACTION_STATES].sort());
  for (const from of ACTION_STATES) {
    for (const to of ACTION_TRANSITIONS[from]) {
      assert.ok(ACTION_STATES.includes(to), `${from} -> ${to} must stay inside the closed state list`);
    }
  }
});

test('canTransition allows forward progress and refuses invented or backward states', () => {
  assert.equal(canTransition('planned', 'queued'), true);
  assert.equal(canTransition('queued', 'dispatching'), true);
  assert.equal(canTransition('dispatching', 'submission_unknown'), true);
  assert.equal(canTransition('running', 'collecting'), true);
  assert.equal(canTransition('collecting', 'verifying'), true);
  assert.equal(canTransition('verifying', 'completed'), true);
  assert.equal(canTransition('failed', 'reconciling'), true);
  assert.equal(canTransition('submission_unknown', 'reconciling'), true);
  assert.equal(canTransition('completed', 'running'), false);
  assert.equal(canTransition('cancelled', 'queued'), false);
  assert.equal(canTransition('planned', 'executed'), false);
  assert.equal(canTransition('proposed', 'queued'), false);
});

test('events include every event named in spec 4.3 and reject unknown types', () => {
  // docs/specs/ITERATIVE_PRODUCTION_AGENT.md 4.3 Events
  const specEvents = [
    'production.created',
    'plan.proposed',
    'plan.approved',
    'stage.entered',
    'stage.completed',
    'artifact.attached',
    'cast.decided',
    'take.requested',
    'take.landed',
    'take.selected',
    'clip.reviewed',
    'budget.reserved',
    'budget.settled',
    'render.gate.blocked',
    'production.failed',
    'production.cancelled',
  ];
  for (const type of specEvents) assert.ok(EVENTS.includes(type), `EVENTS is missing ${type}`);
});

test('commands include spec 4.2 and the decision.resolve command from 7.1', () => {
  const specCommands = [
    'production.create',
    'plan.propose',
    'plan.approve',
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
    'production.cancel',
  ];
  for (const kind of specCommands) assert.ok(COMMANDS.includes(kind), `COMMANDS is missing ${kind}`);
  assert.ok(COMMANDS.includes('decision.resolve'));
});

test('vocabulary lists are frozen', () => {
  for (const list of [ARTIFACT_KINDS, DECISION_KINDS, DECISION_STATUSES, ACTION_STATES, EVENTS, COMMANDS, PRODUCTION_INTENTS, REVIEW_OBSERVATION_KINDS]) {
    assert.equal(Object.isFrozen(list), true);
  }
});

// --- Valid fixtures --------------------------------------------------------

test('one valid fixture per record type validates', () => {
  assertValid(validateProduction(validProduction()), 'production');
  assertValid(validateArtifactVersion(validArtifact()), 'artifact version');
  assertValid(validateDecision(validDecision()), 'pending decision');
  assertValid(validateDecision(validDecision({
    status: 'resolved',
    resolution: { userEventId: 'ue_1', at: AT, actor: 'user', optionId: 'opt_a' },
  })), 'resolved decision');
  assertValid(validateActionPlan(validPlan()), 'action plan');
  assertValid(validateAction(validAction()), 'action');
  assertValid(validateReviewObservation(validObservation()), 'review observation');
  assertValid(validateCreativeVerdict(validCreativeVerdict()), 'creative verdict');
  assertValid(validateEvent(validEvent()), 'event');
  assertValid(validateCommandEnvelope(validCommand()), 'command envelope');
  assertValid(validateRecordedCommand(validRecordedCommand()), 'recorded command');
});

test('production exists before a package and before a script (invariant I1)', () => {
  // 6.1 Production: packageId and scriptVersionId are nullable.
  assertValid(validateProduction(validProduction({ packageId: null, scriptVersionId: null })), 'pre-package production');
  assertValid(validateProduction(validProduction({ briefVersionId: null })), 'spec 6.1: briefVersionId may be null');
  assert.equal(validateProduction(validProduction({ briefVersionId: undefined })).ok, false, 'briefVersionId must be present (string or null)');
  assertValid(validateProduction(validProduction({ packageId: 'pkg_1', scriptVersionId: 'av_script_1' })), 'packaged production');
});

// --- Required identity and revisions --------------------------------------

test('every record type rejects a missing id', () => {
  for (const [label, validate, fixture] of [
    ['production', validateProduction, validProduction()],
    ['artifact version', validateArtifactVersion, validArtifact()],
    ['decision', validateDecision, validDecision()],
    ['action plan', validateActionPlan, validPlan()],
    ['action', validateAction, validAction()],
    ['review observation', validateReviewObservation, validObservation()],
    ['creative verdict', validateCreativeVerdict, validCreativeVerdict()],
    ['event', validateEvent, validEvent()],
  ]) {
    const doc = clone(fixture);
    delete doc.id;
    assertError(validate(doc), `${label} without id`, 'MISSING_ID', '/id');
  }
});

test('revisions, versions and sequences reject missing or negative values', () => {
  assertError(validateProduction(validProduction({ revision: undefined })), 'production without revision', 'INVALID_REVISION', '/revision');
  assertError(validateProduction(validProduction({ revision: -1 })), 'production negative revision', 'INVALID_REVISION', '/revision');
  assertError(validateProduction(validProduction({ lastSequence: -1 })), 'production negative lastSequence', 'INVALID_SEQUENCE', '/lastSequence');

  assertError(validateArtifactVersion(validArtifact({ version: undefined })), 'artifact without version', 'INVALID_VERSION', '/version');
  assertError(validateArtifactVersion(validArtifact({ version: 0 })), 'artifact zero version', 'INVALID_VERSION', '/version');
  assertError(validateArtifactVersion(validArtifact({ version: -1 })), 'artifact negative version', 'INVALID_VERSION', '/version');

  assertError(validateDecision(validDecision({ proposalVersion: undefined })), 'decision without proposalVersion', 'INVALID_REVISION', '/proposalVersion');
  assertError(validateDecision(validDecision({ proposalVersion: -1 })), 'decision negative proposalVersion', 'INVALID_REVISION', '/proposalVersion');

  assertError(validateActionPlan(validPlan({ revision: undefined })), 'plan without revision', 'INVALID_REVISION', '/revision');
  assertError(validateActionPlan(validPlan({ revision: -1 })), 'plan negative revision', 'INVALID_REVISION', '/revision');

  assertError(validateAction(validAction({ expected: {} })), 'action without expected revision', 'INVALID_REVISION', '/expected/productionRevision');
  assertError(validateAction(validAction({ expected: { productionRevision: -1 } })), 'action negative expected revision', 'INVALID_REVISION', '/expected/productionRevision');

  assertError(validateEvent(validEvent({ sequence: undefined })), 'event without sequence', 'INVALID_SEQUENCE', '/sequence');
  assertError(validateEvent(validEvent({ sequence: 0 })), 'event zero sequence', 'INVALID_SEQUENCE', '/sequence');
  assertError(validateEvent(validEvent({ sequence: -1 })), 'event negative sequence', 'INVALID_SEQUENCE', '/sequence');
});

test('unknown enums are rejected', () => {
  assertError(validateProduction(validProduction({ intent: 'done' })), 'invented production status', 'INVALID_INTENT', '/intent');
  assertError(validateProduction(validProduction({ schema: 'comfyrizz.production/v2' })), 'wrong schema', 'INVALID_SCHEMA', '/schema');
  assertError(validateArtifactVersion(validArtifact({ kind: 'take' })), 'invented artifact kind', 'UNKNOWN_ARTIFACT_KIND', '/kind');
  assertError(validateDecision(validDecision({ kind: 'plan.approved' })), 'invented decision kind', 'UNKNOWN_DECISION_KIND', '/kind');
  assertError(validateDecision(validDecision({ status: 'active' })), 'invented decision status', 'UNKNOWN_DECISION_STATUS', '/status');
  assertError(validateAction(validAction({ state: 'proposed' })), 'invented action state', 'UNKNOWN_ACTION_STATE', '/state');
  assertError(validateEvent(validEvent({ type: 'card.rendered' })), 'invented event type', 'UNKNOWN_EVENT_TYPE', '/type');
  assertError(validateCommandEnvelope(validCommand({ kind: 'clip.approved' })), 'invented command kind', 'UNKNOWN_COMMAND_KIND', '/kind');
});

test('production phase is derived, never stored (spec 6.1)', () => {
  const doc = validProduction({ phase: 'media' });
  assertError(validateProduction(doc), 'stored phase', 'DERIVED_FIELD', '/phase');
});

// --- ArtifactVersion (6.2) -------------------------------------------------

test('artifact metadata and provenance reject absolute or local paths', () => {
  assertValid(validateArtifactVersion(validArtifact({ metadata: { relative: 'media/av_1.mp4' } })), 'relative media reference');
  assertError(
    validateArtifactVersion(validArtifact({ metadata: { output: '/srv/renders/take.mp4' } })),
    'unix absolute path',
    'ABSOLUTE_PATH',
    '/metadata/output',
  );
  assertError(
    validateArtifactVersion(validArtifact({ metadata: { nested: [{ output: 'D:\\\\media\\\\take.mp4' }] } })),
    'windows absolute path',
    'ABSOLUTE_PATH',
    '/metadata/nested/0/output',
  );
  assertError(
    validateArtifactVersion(validArtifact({ metadata: { output: 'file:///tmp/take.mp4' } })),
    'file URL',
    'ABSOLUTE_PATH',
    '/metadata/output',
  );
  assertError(
    validateArtifactVersion(validArtifact({ provenance: { scratchDir: '/tmp/colab-run' } })),
    'absolute path in provenance',
    'ABSOLUTE_PATH',
    '/provenance/scratchDir',
  );
  assertError(
    validateArtifactVersion(validArtifact({ metadata: { relative: '../../secrets/take.mp4' } })),
    'traversal path',
    'LOCAL_PATH',
    '/metadata/relative',
  );
});

test('artifact versions validate derivedFrom, createdBy and access', () => {
  assertValid(validateArtifactVersion(validArtifact({ mediaId: undefined })), 'artifact without media yet');
  assertValid(validateArtifactVersion(validArtifact({ mediaId: null })), 'artifact with null media');
  assertError(validateArtifactVersion(validArtifact({ derivedFrom: {} })), 'bad derivedFrom', 'INVALID_ARRAY', '/derivedFrom');
  assertError(
    validateArtifactVersion(validArtifact({ derivedFrom: [{ artifactId: 'av_0', hash: HASH_B }] })),
    'derivedFrom without role',
    'INVALID_STRING',
    '/derivedFrom/0/role',
  );
  assertError(validateArtifactVersion(validArtifact({ createdBy: {} })), 'createdBy without actor', 'MISSING_ACTOR', '/createdBy/actor');
  assertError(
    validateArtifactVersion(validArtifact({ access: { private: true, conditionAllowed: 'yes', redistributeAllowed: false } })),
    'non-boolean access',
    'INVALID_BOOLEAN',
    '/access/conditionAllowed',
  );
});

// --- Decision (6.3) --------------------------------------------------------

test('resolved and rejected decisions require a user resolution', () => {
  assertError(
    validateDecision(validDecision({ status: 'resolved' })),
    'resolved without resolution',
    'MISSING_RESOLUTION',
    '/resolution',
  );
  assertError(
    validateDecision(validDecision({
      status: 'rejected',
      resolution: { at: AT, actor: 'user' },
    })),
    'resolution without userEventId',
    'MISSING_USER_EVENT',
    '/resolution/userEventId',
  );
  const resolved = validDecision({
    status: 'resolved',
    resolution: { userEventId: 'ue_1', at: AT, actor: 'user', optionId: 'opt_a' },
  });
  assertValid(validateDecision(resolved), 'resolved decision');
  assertError(
    validateDecision({ ...resolved, resolution: { ...resolved.resolution, optionId: 'opt_z' } }),
    'resolution option outside options',
    'UNKNOWN_OPTION',
    '/resolution/optionId',
  );
});

test('an agent can never resolve a decision (invariant I6)', () => {
  const agent = validDecision({
    status: 'resolved',
    resolution: { userEventId: 'ue_1', at: AT, actor: 'agent', optionId: 'opt_a' },
  });
  const result = validateDecision(agent);
  assertError(result, 'agent resolution', 'AGENT_CANNOT_RESOLVE', '/resolution/actor');

  const system = validDecision({
    status: 'resolved',
    resolution: { userEventId: 'ue_1', at: AT, actor: 'system', optionId: 'opt_a' },
  });
  assertError(validateDecision(system), 'system resolution', 'AGENT_CANNOT_RESOLVE', '/resolution/actor');
});

test('decision options must be well formed and uniquely identified', () => {
  assertError(
    validateDecision(validDecision({ options: [{ id: 'opt_a' }] })),
    'option without label',
    'INVALID_STRING',
    '/options/0/label',
  );
  assertError(
    validateDecision(validDecision({
      options: [
        { id: 'opt_a', label: 'A', artifactIds: [] },
        { id: 'opt_a', label: 'B', artifactIds: [] },
      ],
    })),
    'duplicate option id',
    'DUPLICATE_ID',
    '/options/1/id',
  );
});

// --- ActionPlan and Action (6.4) -------------------------------------------

test('action plans keep an immutable hash, required decisions and a reservation ceiling', () => {
  assertValid(validateActionPlan(validPlan({ requiredDecisions: [] })), 'plan with no extra decisions');
  assertError(validateActionPlan(validPlan({ planHash: undefined })), 'plan without planHash', 'MISSING_PLAN_HASH', '/planHash');
  assertError(validateActionPlan(validPlan({ requiredDecisions: undefined })), 'plan without requiredDecisions', 'INVALID_ARRAY', '/requiredDecisions');
  assertError(
    validateActionPlan(validPlan({ requiredDecisions: [{ kind: 'plan.approved' }] })),
    'plan required decision with invented kind',
    'UNKNOWN_DECISION_KIND',
    '/requiredDecisions/0/kind',
  );
  assertError(validateActionPlan(validPlan({ reservationCeiling: -1 })), 'negative ceiling', 'INVALID_AMOUNT', '/reservationCeiling');
  assertError(validateActionPlan(validPlan({ reservationCeiling: undefined })), 'missing ceiling', 'INVALID_AMOUNT', '/reservationCeiling');
});

test('actions link their command, idempotency key, expected revisions and job identifiers', () => {
  assertError(validateAction(validAction({ commandId: undefined })), 'action without commandId', 'MISSING_ID', '/commandId');
  assertError(validateAction(validAction({ idempotencyKey: undefined })), 'action without idempotencyKey', 'MISSING_ID', '/idempotencyKey');
  assertError(validateAction(validAction({ planId: undefined })), 'action without planId', 'MISSING_ID', '/planId');
  assertError(validateAction(validAction({ planHash: undefined })), 'action without planHash', 'MISSING_PLAN_HASH', '/planHash');
  assertValid(validateAction(validAction({
    state: 'submission_unknown',
    attemptId: 'att_1',
    jobId: null,
  })), 'submission_unknown action');
  assertValid(validateAction(validAction({
    state: 'running',
    attemptId: 'att_1',
    jobId: 'job_1',
    runId: 'run_1',
  })), 'running action with durable ids');
});

// --- Review observations and verdicts (6.4) --------------------------------

test('technical observations cannot carry a user verdict', () => {
  assertValid(validateReviewObservation(validObservation({ kind: 'technical' })), 'technical observation');
  assertError(
    validateReviewObservation(validObservation({ kind: 'technical', verdict: 'approved' })),
    'technical observation with verdict',
    'TECHNICAL_VERDICT_FORBIDDEN',
    '/verdict',
  );
  assertError(
    validateReviewObservation(validObservation({ kind: 'opinion' })),
    'unknown observation kind',
    'UNKNOWN_OBSERVATION_KIND',
    '/kind',
  );
});

test('a creative verdict must be the user decision', () => {
  assertValid(validateCreativeVerdict(validCreativeVerdict()), 'user verdict');
  assertError(
    validateCreativeVerdict(validCreativeVerdict({ actor: 'agent' })),
    'agent verdict',
    'AGENT_CANNOT_RESOLVE',
    '/actor',
  );
  assertError(
    validateCreativeVerdict(validCreativeVerdict({ userEventId: undefined })),
    'verdict without user event',
    'MISSING_USER_EVENT',
    '/userEventId',
  );
  assertError(
    validateCreativeVerdict(validCreativeVerdict({ verdict: 'maybe' })),
    'invented verdict',
    'INVALID_VERDICT',
    '/verdict',
  );
});

// --- Event log (6.5/6.6) ---------------------------------------------------

test('events need a production, a positive sequence, a closed type and object data', () => {
  assertError(validateEvent(validEvent({ productionId: undefined })), 'event without production', 'MISSING_ID', '/productionId');
  assertError(validateEvent(validEvent({ type: 'not.an.event' })), 'event unknown type', 'UNKNOWN_EVENT_TYPE', '/type');
  assertError(validateEvent(validEvent({ data: undefined })), 'event without data', 'INVALID_OBJECT', '/data');
  assertError(validateEvent(validEvent({ data: [] })), 'event array data', 'INVALID_OBJECT', '/data');
  assertError(validateEvent(validEvent({ at: 'yesterday' })), 'event bad timestamp', 'INVALID_TIMESTAMP', '/at');
});

// --- Command envelope (7.1) ------------------------------------------------

test('command envelopes carry a command id, kind, expected revision and payload', () => {
  assertError(validateCommandEnvelope(validCommand({ commandId: undefined })), 'command without id', 'MISSING_ID', '/commandId');
  assertError(validateCommandEnvelope(validCommand({ payload: undefined })), 'command without payload', 'INVALID_OBJECT', '/payload');
  assertError(validateCommandEnvelope(validCommand({ expected: {} })), 'command without expected revision', 'INVALID_REVISION', '/expected/productionRevision');
  assertError(validateCommandEnvelope(validCommand({ kind: 'decision.accept' })), 'command unknown kind', 'UNKNOWN_COMMAND_KIND', '/kind');
});

test('production.create omits productionId; every other command requires it', () => {
  const create = {
    commandId: 'cmd_create',
    expected: { productionRevision: 0 },
    kind: 'production.create',
    payload: { conversationId: 'conv_1', brief: 'launch video' },
  };
  assertValid(validateCommandEnvelope(create), 'create command');
  assertError(
    validateCommandEnvelope({ ...create, productionId: 'prod_1' }),
    'create with productionId',
    'PRODUCTION_ID_NOT_ALLOWED',
    '/productionId',
  );
  assertError(
    validateCommandEnvelope({ ...validCommand(), productionId: undefined }),
    'update without productionId',
    'MISSING_ID',
    '/productionId',
  );
});

test('the request envelope never grants actor authority to the client', () => {
  assertError(
    validateCommandEnvelope({ ...validCommand(), actor: 'user' }),
    'client-supplied user actor',
    'CLIENT_ATTRIBUTION_FORBIDDEN',
    '/actor',
  );
  assertError(
    validateCommandEnvelope({ ...validCommand(), userEventId: 'ue_forged' }),
    'client-supplied user event',
    'CLIENT_ATTRIBUTION_FORBIDDEN',
    '/userEventId',
  );
});

test('the recorded command requires server attribution', () => {
  assertValid(validateRecordedCommand(validRecordedCommand()), 'user-attributed record');
  assertValid(validateRecordedCommand(validRecordedCommand({ actor: 'agent', userEventId: 'ue_1' })), 'agent-attributed record');
  assertError(
    validateRecordedCommand((() => {
      const doc = validRecordedCommand();
      delete doc.actor;
      return doc;
    })()),
    'record without attribution',
    'MISSING_ACTOR',
    '/actor',
  );
  assertError(
    validateRecordedCommand(validRecordedCommand({ actor: 'user', userEventId: undefined })),
    'user record without user event',
    'MISSING_USER_EVENT',
    '/userEventId',
  );
  assertError(
    validateRecordedCommand(validRecordedCommand({ actor: 'agent', userEventId: undefined })),
    'agent record without citing user message',
    'MISSING_USER_EVENT',
    '/userEventId',
  );
  assertError(
    validateRecordedCommand(validRecordedCommand({ actor: 'assistant' })),
    'invented actor',
    'INVALID_ACTOR',
    '/actor',
  );
  const createRecord = {
    ...validRecordedCommand({
      productionId: 'prod_1',
      expected: { productionRevision: 0 },
      kind: 'production.create',
      payload: { conversationId: 'conv_1' },
    }),
  };
  assertValid(validateRecordedCommand(createRecord), 'recorded create carries the server-assigned id');
});

// --- Purity ----------------------------------------------------------------

test('validators never throw and always return the error shape', () => {
  const validators = [
    validateProduction,
    validateArtifactVersion,
    validateDecision,
    validateActionPlan,
    validateAction,
    validateReviewObservation,
    validateCreativeVerdict,
    validateEvent,
    validateCommandEnvelope,
    validateRecordedCommand,
  ];
  for (const validate of validators) {
    for (const garbage of [null, undefined, 1, 'x', [], true]) {
      const result = validate(garbage);
      assert.equal(result.ok, false);
      assert.ok(Array.isArray(result.errors));
      assert.ok(result.errors.length > 0);
    }
  }
});
