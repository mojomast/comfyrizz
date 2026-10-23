import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_COMMAND_KINDS,
  PRODUCTION_RULES,
  PRODUCTION_TOOLS,
  runProductionTool,
  type IterationScope,
  type ProductionToolContext,
} from '../src/production-tools.js';

const SHOTS = [
  { id: 's1', lines: ['s1:l1', 's1:l2'] },
  { id: 's2', lines: ['s2:l1', 's2:l2'] },
  { id: 's3', lines: ['s3:l1', 's3:l2'] },
  { id: 's4', lines: ['s4:l1', 's4:l2'] },
];

function makeScope(overrides: Partial<IterationScope> = {}): IterationScope {
  return {
    target: { packageId: 'pkg_1', shotId: 's4' },
    element: 'background',
    note: 'warmer sunset light',
    preserve: ['character', 'voice'],
    ...overrides,
  } as IterationScope;
}

function context(opts: {
  iterationScope?: IterationScope;
  decoy?: boolean;
} = {}) {
  const dispatched: unknown[] = [];
  const scope = opts.iterationScope;
  const ctx: ProductionToolContext & { dispatched: unknown[] } = {
    productionId: 'prod_1',
    userEventId: 'ue_1',
    turnId: 'turn_1',
    iterationScope: scope,
    productionState: {
      intent: 'active',
      shots: SHOTS,
      requestedShotIds: ['s4'],
      requestedLineIds: ['s4:l1'],
    } as ProductionToolContext['productionState'],
    read: () => ({
      production: { id: 'prod_1', revision: 4, intent: 'active', shotIds: SHOTS.map(shot => shot.id) },
      revision: 4,
      lastSequence: 4,
    }),
    command: (envelope) => {
      dispatched.push(envelope);
      return { ok: true };
    },
    dispatched,
  };
  if (opts.decoy) {
    (ctx as any).scope = { target: { packageId: 'decoy', shotId: 's9' }, element: 'other', note: 'decoy', preserve: [] };
    (ctx.productionState as any).scope = { target: { packageId: 'decoy', shotId: 's9' }, element: 'other', note: 'decoy', preserve: [] };
  }
  return ctx;
}

async function read(ctx: ProductionToolContext) {
  const result = await runProductionTool({ name: 'production_read', args: {} }, ctx);
  assert.equal(result.ok, true, String(result.error));
  return result;
}

test('AV15: rule 12 text is present', () => {
  assert.match(
    PRODUCTION_RULES,
    /12\. Scoped iteration: when the turn carries an iteration scope, propose exactly one plan limited to that target and element within the iteration level; state what is preserved; never approve, never touch other shots; if the level allows no further take, ask whether to change the level and propose nothing\./,
  );
});

test('AV15: AGENT_COMMAND_KINDS unchanged', () => {
  assert.deepEqual([...AGENT_COMMAND_KINDS], [
    'plan.propose',
    'stage.advance',
    'artifact.attach',
    'take.request',
    'render.request',
    'production.pause',
  ]);
});

test('AV15: production_read surfaces ctx.iterationScope and ignores decoys', async () => {
  const scope = makeScope();
  const ctx = context({ iterationScope: scope, decoy: true });
  const result = await read(ctx);
  assert.deepEqual(result.iterationScope, scope);
  assert.notDeepEqual(result.iterationScope, (ctx as any).scope);
});

test('AV15: production_read omits iterationScope when unset', async () => {
  const ctx = context({});
  const result = await read(ctx);
  assert.equal(result.iterationScope, undefined);
});

test('AV15: scoped turn, plan without scope dispatched with payload.scope deep-equal to turn scope', async () => {
  const scope = makeScope();
  const ctx = context({ iterationScope: scope });
  await read(ctx);
  const result = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: 4,
      plan: {
        edits: [{ shotId: 's4', lineId: 's4:l1', instruction: 'Warm up s4:l1.' }],
        actions: [],
        summary: 'Warm up s4:l1.',
      },
    },
  }, ctx);
  assert.equal(result.ok, true, String(result.error));
  assert.equal(ctx.dispatched.length, 1);
  assert.deepEqual((ctx.dispatched[0] as any).payload.scope, scope);
});

test('AV15: equal plan.scope is accepted', async () => {
  const scope = makeScope();
  const ctx = context({ iterationScope: scope });
  await read(ctx);
  const result = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: 4,
      plan: {
        scope,
        edits: [{ shotId: 's4', lineId: 's4:l1', instruction: 'Warm up s4:l1.' }],
        actions: [],
        summary: 'Warm up s4:l1.',
      },
    },
  }, ctx);
  assert.equal(result.ok, true, String(result.error));
  assert.equal(ctx.dispatched.length, 1);
  assert.deepEqual((ctx.dispatched[0] as any).payload.scope, scope);
});

test('AV15: different plan.scope (other shotId) is refused, nothing dispatched', async () => {
  const scope = makeScope();
  const otherScope = makeScope({ target: { packageId: 'pkg_1', shotId: 's2' } });
  const ctx = context({ iterationScope: scope });
  await read(ctx);
  const result = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: 4,
      plan: {
        scope: otherScope,
        edits: [{ shotId: 's4', lineId: 's4:l1', instruction: 'Warm up s4:l1.' }],
        actions: [],
        summary: 'Warm up s4:l1.',
      },
    },
  }, ctx);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /mismatch/i);
  assert.equal(ctx.dispatched.length, 0);
});

test('AV15: plan.scope in an unscoped turn is refused', async () => {
  const scope = makeScope();
  const ctx = context({});
  await read(ctx);
  const result = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: 4,
      plan: {
        scope,
        edits: [{ shotId: 's4', lineId: 's4:l1', instruction: 'Warm up s4:l1.' }],
        actions: [],
        summary: 'Warm up s4:l1.',
      },
    },
  }, ctx);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /scope/i);
  assert.equal(ctx.dispatched.length, 0);
});

test('AV15: edit on another shot in a scoped turn is refused', async () => {
  const scope = makeScope();
  const ctx = context({ iterationScope: scope });
  await read(ctx);
  const result = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: 4,
      plan: {
        edits: [{ shotId: 's2', lineId: 's2:l1', instruction: 'Edit s2:l1.' }],
        actions: [],
        summary: 'Edit s2:l1.',
      },
    },
  }, ctx);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /never touch other shots/);
  assert.equal(ctx.dispatched.length, 0);
});

test('AV15: tool schema has plan.scope, no top-level scope, no slot scope', () => {
  const propose = PRODUCTION_TOOLS.find(t => t.name === 'production_propose_plan')!;
  const planSchema = (propose.parameters as any).properties.plan;
  assert.ok(planSchema.properties.scope, 'plan.scope must exist');
  assert.equal(planSchema.properties.scope.type, 'object');
  assert.match(String(planSchema.properties.scope.description), /tool fills it from the turn/i);
  assert.equal(Object.prototype.hasOwnProperty.call((propose.parameters as any).properties, 'scope'), false);
  const actionSchema = planSchema.properties.actions.items;
  assert.equal(Object.prototype.hasOwnProperty.call(actionSchema.properties, 'scope'), false);
});
