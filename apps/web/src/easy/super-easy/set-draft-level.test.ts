// SE08: the pure Super Easy Draft level command.
//
// The helper builds the same client `iteration.set` envelope the Easy and IL
// surfaces send. The server owns actor attribution, so this request never
// claims `actor: "user"`; it only records the user's Draft choice.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDraftLevelCommand,
  isDraftLevelCommand,
} from './set-draft-level.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const APPROVAL_KEYS = [
  'actor',
  'userEventId',
  'spend',
  'spendCap',
  'ceiling',
  'budget',
  'budgetUnits',
  'planId',
  'planHash',
  'proposalRevision',
  'approval',
  'approve',
];

function build(overrides: Record<string, unknown> = {}) {
  return buildDraftLevelCommand({
    productionId: PRODUCTION_ID,
    expectedProductionRevision: 7,
    ...overrides,
  });
}

function keys(value: unknown): string[] {
  return value && typeof value === 'object' ? Object.keys(value) : [];
}

test('builds the user iteration.set command with the Draft policy', () => {
  const result = build();
  assert.equal(result.ok, true);
  if (result.ok === false) return;

  const { command } = result;
  assert.equal(command.kind, 'iteration.set');
  assert.equal(command.productionId, PRODUCTION_ID);
  assert.deepEqual(command.expected, { productionRevision: 7 });
  assert.equal(command.payload.policy.level, 'draft');
  assert.equal(command.payload.policy.reviewDepth, 'light');
  assert.deepEqual(command.payload.policy.stages, {
    script: { takes: 1, rounds: 1, auditions: 0, pick: 'auto' },
    voice: { takes: 1, rounds: 1, auditions: 0, pick: 'auto', linesPerVoice: 1 },
    keyframe: { takes: 1, rounds: 1, auditions: 0, pick: 'auto' },
    video: { takes: 1, rounds: 1, auditions: 0, pick: 'auto' },
  });
  assert.deepEqual(command.payload.policy.shotOverrides, {});
  assert.equal(Object.prototype.hasOwnProperty.call(command, 'actor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(command, 'userEventId'), false);
  assert.deepEqual(keys(command.payload), ['policy']);
  assert.equal(typeof command.commandId, 'string');
  assert.ok(command.commandId.length > 0);
  assert.equal(typeof command.idempotencyKey, 'string');
  assert.ok(command.idempotencyKey.length > 0);
});

test('the command never looks like spend, plan or budget approval', () => {
  const result = build();
  assert.equal(result.ok, true);
  if (result.ok === false) return;

  const { command } = result;
  for (const key of APPROVAL_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(command, key), false, key);
    assert.equal(Object.prototype.hasOwnProperty.call(command.payload, key), false, key);
    assert.equal(Object.prototype.hasOwnProperty.call(command.expected, key), false, key);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(command, 'planId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(command, 'planHash'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(command, 'ceiling'), false);
  assert.doesNotMatch(JSON.stringify(command), /plan\.approve|budget\.approve|spend\.approve|budget\.set_ceiling/u);
});

test('is pure and deterministic for the same request', () => {
  const input = { productionId: PRODUCTION_ID, expectedProductionRevision: 7 };
  const first = buildDraftLevelCommand(input);
  const second = buildDraftLevelCommand(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, { productionId: PRODUCTION_ID, expectedProductionRevision: 7 });

  const nextRevision = buildDraftLevelCommand({
    productionId: PRODUCTION_ID,
    expectedProductionRevision: 8,
  });
  assert.equal(nextRevision.ok, true);
  if (first.ok === false || nextRevision.ok === false) return;
  assert.notEqual(first.command.commandId, nextRevision.command.commandId);
  assert.notEqual(first.command.idempotencyKey, nextRevision.command.idempotencyKey);
});

test('keeps caller-supplied command and idempotency keys', () => {
  const result = build({ commandId: 'cmd_custom_1', idempotencyKey: 'idem_custom_1' });
  assert.equal(result.ok, true);
  if (result.ok === false) return;
  assert.equal(result.command.commandId, 'cmd_custom_1');
  assert.equal(result.command.idempotencyKey, 'idem_custom_1');
});

test('refuses a missing or malformed production id', () => {
  for (const productionId of [undefined, null, '', '  ', 'prod/one', 'prod\\one', 42]) {
    const result = build({ productionId });
    assert.equal(result.ok, false);
    if (result.ok === true) continue;
    assert.equal(result.code, 'INVALID_INPUT');
  }
});

test('refuses a revision that is not a non-negative safe integer', () => {
  for (const expectedProductionRevision of [undefined, null, -1, 1.5, '7', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const result = build({ expectedProductionRevision });
    assert.equal(result.ok, false);
    if (result.ok === true) continue;
    assert.equal(result.code, 'INVALID_INPUT');
  }
});

test('refuses an approval command kind instead of building it', () => {
  for (const kind of ['plan.approve', 'budget.approve', 'spend.approve', 'budget.set_ceiling']) {
    const result = build({ kind });
    assert.equal(result.ok, false);
    if (result.ok === true) continue;
    assert.equal(result.code, 'APPROVAL_SHAPE');
  }
});

test('refuses spend and plan approval fields smuggled into the request', () => {
  const smuggle = [
    { ceiling: 12 },
    { spendCap: 12 },
    { budgetUnits: 12 },
    { planId: 'plan_1' },
    { planHash: 'fnv1a64:0000000000000000' },
    { proposalRevision: 3 },
    { approval: { ok: true } },
    { payload: { policy: { level: 'draft' } } },
    { actor: 'user' },
  ];
  for (const extra of smuggle) {
    const result = build(extra);
    assert.equal(result.ok, false, JSON.stringify(extra));
    if (result.ok === true) continue;
    assert.equal(result.code, 'APPROVAL_SHAPE', JSON.stringify(extra));
  }
});

test('refuses unrelated extra fields rather than copying them through', () => {
  const result = build({ note: 'please' });
  assert.equal(result.ok, false);
  if (result.ok === true) return;
  assert.equal(result.code, 'INVALID_INPUT');
});

test('isDraftLevelCommand accepts only the exact built Draft envelope', () => {
  const result = build();
  assert.equal(result.ok, true);
  if (result.ok === false) return;
  assert.equal(isDraftLevelCommand(result.command), true);
  assert.equal(isDraftLevelCommand(structuredClone(result.command)), true);

  assert.equal(isDraftLevelCommand(null), false);
  assert.equal(isDraftLevelCommand(undefined), false);
  assert.equal(isDraftLevelCommand('iteration.set'), false);
  assert.equal(isDraftLevelCommand({ ...result.command, kind: 'plan.approve' }), false);
  assert.equal(isDraftLevelCommand({ ...result.command, kind: 'budget.set_ceiling' }), false);
  assert.equal(isDraftLevelCommand({ ...result.command, actor: 'user' }), false);
  assert.equal(isDraftLevelCommand({ ...result.command, ceiling: 3 }), false);

  const balanced = structuredClone(result.command);
  balanced.payload.policy.level = 'balanced';
  balanced.payload.policy.stages.video.takes = 2;
  balanced.payload.policy.stages.video.pick = 'hero';
  balanced.payload.policy.reviewDepth = 'standard';
  assert.equal(isDraftLevelCommand(balanced), false);

  const scoped = structuredClone(result.command);
  scoped.payload.scope = { shotIds: ['shot_1'] };
  assert.equal(isDraftLevelCommand(scoped), false);
});

test('the built policy is an independent frozen snapshot', () => {
  const first = build();
  const second = build();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok === false || second.ok === false) return;
  assert.notEqual(first.command.payload.policy, second.command.payload.policy);
  assert.equal(Object.isFrozen(first.command.payload.policy), true);
  assert.equal(Object.isFrozen(first.command.payload.policy.stages), true);
  assert.equal(Object.isFrozen(first.command.payload.policy.stages.video), true);
});
