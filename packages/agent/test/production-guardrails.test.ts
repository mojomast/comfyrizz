import test from 'node:test';
import assert from 'node:assert/strict';
import { runProductionTool, type ProductionToolContext } from '../src/production-tools.js';

const SHOTS = [
  { id: 's1', lines: ['s1:l1', 's1:l2'] },
  { id: 's2', lines: ['s2:l1', 's2:l2'] },
  { id: 's3', lines: ['s3:l1', 's3:l2'] },
  { id: 's4', lines: ['s4:l1', 's4:l2'] },
];

function context(state: ProductionToolContext['productionState'], intent = 'active') {
  const dispatched: unknown[] = [];
  const ctx: ProductionToolContext & { dispatched: unknown[] } = {
    productionId: 'prod_1',
    userEventId: 'ue_1',
    turnId: 'turn_1',
    productionState: state,
    read: () => ({
      production: { id: 'prod_1', revision: 4, intent, shotIds: SHOTS.map(shot => shot.id) },
      revision: 4,
      lastSequence: 4,
    }),
    command: (envelope) => {
      dispatched.push(envelope);
      return { ok: true };
    },
    dispatched,
  };
  return ctx;
}

const scoped = {
  intent: 'active',
  shots: SHOTS,
  requestedShotIds: ['s4'],
  requestedLineIds: ['s4:l1'],
};

async function read(ctx: ProductionToolContext) {
  const result = await runProductionTool({ name: 'production_read', args: {} }, ctx);
  assert.equal(result.ok, true);
  return result;
}

test('IP63X guardrails: a mutation before production_read is refused', async () => {
  const ctx = context(scoped);
  const result = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: 4,
      plan: {
        edits: [{ shotId: 's4', lineId: 's4:l1', instruction: 'Punch up s4:l1.' }],
        actions: [],
        summary: 'Punch up s4:l1.',
      },
    },
  }, ctx);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /production_read/);
  assert.equal(ctx.dispatched.length, 0);
});

test('IP63X guardrails: an in-scope edit is accepted once after the read', async () => {
  const ctx = context(scoped);
  await read(ctx);
  const result = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: 4,
      plan: {
        edits: [{ shotId: 's4', lineId: 's4:l1', instruction: 'Punch up s4:l1.' }],
        actions: [],
        summary: 'Punch up s4:l1.',
      },
    },
  }, ctx);
  assert.equal(result.ok, true, String(result.error));
  assert.equal(ctx.dispatched.length, 1);

  const again = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: 4,
      plan: {
        edits: [{ shotId: 's4', lineId: 's4:l1', instruction: 'Punch up s4:l1.' }],
        actions: [],
        summary: 'Punch up s4:l1.',
      },
    },
  }, ctx);
  assert.equal(again.ok, false);
  assert.match(String(again.error), /production_read/);
  assert.equal(ctx.dispatched.length, 1);
});

test('IP63X guardrails: sibling ids, unknown ids, and command-named slots are refused', async () => {
  const samples = [
    {
      name: 'sibling line',
      state: scoped,
      plan: {
        edits: [{ shotId: 's4', lineId: 's4:l1', instruction: 'Punch up this line so s4:l2 stays consistent.' }],
        actions: [],
        summary: 'Punch up s4:l1.',
      },
    },
    {
      name: 'unknown shot',
      state: scoped,
      plan: {
        edits: [{ shotId: 's9', lineId: 's9:l1', instruction: 'Edit s9:l1.' }],
        actions: [],
        summary: 'Edit s9:l1.',
      },
    },
    {
      name: 'command kind used as a slot',
      state: scoped,
      plan: {
        edits: [{ shotId: 's4', lineId: 's4:l1', instruction: 'Punch up s4:l1.' }],
        actions: [{ id: 'act_1', kind: 'take.request', targetId: 's4:l1', upperBound: 0 }],
        summary: 'Punch up s4:l1.',
      },
    },
    {
      name: 'injected id named while refusing it',
      state: {
        intent: 'active',
        shots: SHOTS,
        requestedShotIds: ['s1'],
        requestedLineIds: ['s1:l1'],
      },
      plan: {
        edits: [{ shotId: 's1', lineId: 's1:l1', instruction: 'Improve s1:l1.' }],
        actions: [],
        summary: 'Improve s1:l1. s3 is not deleted and s2:l1 is not rewritten.',
      },
    },
  ];

  for (const sample of samples) {
    const ctx = context(sample.state);
    await read(ctx);
    const result = await runProductionTool({
      name: 'production_propose_plan',
      args: { expected_revision: 4, plan: sample.plan },
    }, ctx);
    assert.equal(result.ok, false, sample.name);
    assert.equal(ctx.dispatched.length, 0, sample.name);
  }
});

test('IP63X guardrails: a stale expected revision and a paused production are refused', async () => {
  const stale = context(scoped);
  await read(stale);
  const wrong = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: 3,
      plan: {
        edits: [{ shotId: 's4', lineId: 's4:l1', instruction: 'Punch up s4:l1.' }],
        actions: [],
        summary: 'Punch up s4:l1.',
      },
    },
  }, stale);
  assert.equal(wrong.ok, false);
  assert.match(String(wrong.error), /revision/);
  assert.equal(stale.dispatched.length, 0);

  const paused = context(scoped, 'paused');
  await read(paused);
  const blocked = await runProductionTool({
    name: 'production_command',
    args: { kind: 'production.pause', payload: { reason: 'stop' }, expected_revision: 4 },
  }, paused);
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error), /paused/);
  assert.equal(paused.dispatched.length, 0);
});
