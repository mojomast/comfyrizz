// IL13: deterministic covers for the four production-eval misses.
// The scorer is unchanged. A shape that failed the cassette still fails here,
// and the planner plus the tool gate produce a shape that passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planProductionTurn } from '../src/production-planner.js';
import {
  PRODUCTION_SYSTEM_PROMPT,
  PRODUCTION_TOOLS,
  runProductionTool,
  type ProductionToolContext,
} from '../src/production-tools.js';

const script: any = await import(new URL('../../scripts/eval-production.mjs', import.meta.url).href);
const cases: any[] = script.loadCases();

function scenario(id: string): any {
  const found = cases.find((item: any) => item.id === id);
  assert.ok(found, id);
  return found;
}

function planTurn(item: any) {
  const iteration = item.production?.iteration?.policy
    ? {
        policy: item.production.iteration.policy,
        ...(item.production.lockedShotIds ? { lockedShotIds: item.production.lockedShotIds } : {}),
        ...(item.production.iteration.used ? { used: item.production.iteration.used } : {}),
      }
    : undefined;
  const plan = planProductionTurn({
    userMessage: item.userMessage,
    intent: item.production?.intent ?? 'active',
    shots: item.production?.shots ?? [],
    requestedShotIds: item.requested?.shotIds ?? [],
    requestedLineIds: item.requested?.lineIds ?? [],
    untrustedTexts: (item.untrustedSources ?? []).map((source: { text?: string }) => source.text ?? ''),
    iteration,
    ...(item.iterationScope ? { iterationScope: item.iterationScope } : {}),
  });
  const calls: any[] = [{ name: 'production_read', args: {} }];
  if (plan.proposal) {
    calls.push({
      name: 'production_propose_plan',
      args: { expected_revision: item.production.revision, plan: plan.proposal },
    });
  }
  if (plan.command) {
    calls.push({
      name: 'production_command',
      args: { kind: plan.command.kind, expected_revision: item.production.revision, payload: plan.command.payload },
    });
  }
  return { plan, calls };
}

async function executePlanned(item: any) {
  const { plan, calls } = planTurn(item);
  const env = script.createScenarioEnvironment(item);
  try {
    const run = await script.executeTurns(env, { toolCalls: calls, finalText: plan.reply });
    run.caseId = item.id;
    run.runIndex = 0;
    return { plan, run, metrics: script.scoreRun(run, item) };
  } finally {
    env.cleanup();
  }
}

test('IL13 stale: production_read hides the policy-set revision and the plan schema omits revision', async () => {
  const item = scenario('iteration-draft-render');
  const env = script.createScenarioEnvironment(item);
  try {
    const result = await runProductionTool({ name: 'production_read', args: {} }, env.ctx);
    assert.equal(result.ok, true, String(result.error));
    assert.equal(result.revision, item.production.revision);
    const production = result.production as { iteration?: { revision?: number } } | undefined;
    const iteration = result.iteration as { revision?: number; level?: string } | undefined;
    assert.equal(production?.iteration?.revision, undefined);
    assert.equal(iteration?.revision, undefined);
    assert.equal(iteration?.level, 'draft');
    const dumped = JSON.stringify(result);
    assert.equal(dumped.includes('"revision":2'), false);
    assert.equal(dumped.includes(`"revision":${item.production.revision}`), true);
  } finally {
    env.cleanup();
  }

  const propose = PRODUCTION_TOOLS.find(tool => tool.name === 'production_propose_plan')!;
  const planSchema = (propose.parameters as { properties: { plan: { properties: Record<string, unknown> } } }).properties.plan;
  assert.equal(Object.prototype.hasOwnProperty.call(planSchema.properties, 'revision'), false);
  assert.match(PRODUCTION_SYSTEM_PROMPT, /top-level revision/i);
  assert.match(PRODUCTION_SYSTEM_PROMPT, /nested under iteration/i);
  assert.match(PRODUCTION_SYSTEM_PROMPT, /Do not put revision/i);
});

test('IL13 stale: a nested or cached revision still fails the metric, and a bound plan.revision is refused', async () => {
  const item = scenario('iteration-draft-render');
  const slot = { id: 'a1', kind: 'render', targetId: 's1', upperBound: 0 };
  const nested = script.syntheticRun(item, [
    { name: 'production_read', args: {} },
    {
      name: 'production_propose_plan',
      args: {
        expected_revision: 2,
        plan: { edits: [], actions: [slot], summary: 'Render a take for s1.' },
      },
    },
  ], 'Proposed one take.');
  const nestedScore = script.scoreRun(nested, item);
  assert.equal(nestedScore.stalePlanRevision.ok, false);
  assert.match(nestedScore.stalePlanRevision.detail, /revision 2/);

  const cached = script.syntheticRun(scenario('stale-revision'), [
    { name: 'production_read', args: {} },
    {
      name: 'production_propose_plan',
      args: {
        expected_revision: 3,
        plan: {
          edits: [{ shotId: 's1', lineId: 's1:l1', instruction: 'Fix s1:l1.' }],
          actions: [],
          summary: 'Fix s1:l1.',
        },
      },
    },
  ], 'Proposed.');
  assert.equal(script.scoreRun(cached, scenario('stale-revision')).stalePlanRevision.ok, false);

  const planRevision = script.syntheticRun(item, [
    { name: 'production_read', args: {} },
    {
      name: 'production_propose_plan',
      args: {
        expected_revision: item.production.revision,
        plan: { revision: item.production.revision, edits: [], actions: [slot], summary: 'Render a take for s1.' },
      },
    },
  ], 'Proposed one take.');
  const planRevisionScore = script.scoreRun(planRevision, item);
  assert.equal(planRevisionScore.stalePlanRevision.ok, false);
  assert.match(planRevisionScore.stalePlanRevision.detail, /stale plan revision/);

  const dispatched: unknown[] = [];
  const ctx: ProductionToolContext & { dispatched: unknown[] } = {
    productionId: 'prod_1',
    userEventId: 'ue_1',
    turnId: 'turn_1',
    productionState: {
      intent: 'active',
      shots: item.production.shots,
      requestedShotIds: ['s1'],
      requestedLineIds: [],
    },
    read: () => ({
      production: { id: 'prod_1', revision: 7, intent: 'active', shotIds: ['s1', 's2', 's3', 's4'] },
      revision: 7,
    }),
    command: (envelope) => {
      dispatched.push(envelope);
      return { ok: true };
    },
    dispatched,
  };
  await runProductionTool({ name: 'production_read', args: {} }, ctx);
  const refused = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: 7,
      plan: { revision: 7, edits: [], actions: [slot], summary: 'Render a take for s1.' },
    },
  }, ctx);
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /plan\.revision/);
  assert.equal(dispatched.length, 0);
});

test('IL13 stale: the planner cites the read revision and a real turn stays fresh', async () => {
  const stale = scenario('stale-revision');
  const planned = planTurn(stale);
  assert.equal(planned.calls[0].name, 'production_read');
  assert.equal(planned.calls[1].args.expected_revision, stale.production.revision);
  assert.equal(JSON.stringify(planned.plan).includes('"revision"'), false);

  const executed = await executePlanned(stale);
  assert.equal(executed.metrics.stalePlanRevision.ok, true, executed.metrics.stalePlanRevision.detail);
  assert.equal(executed.run.attempts.length, 1);
  assert.equal(executed.run.attempts[0].expectedRevision, stale.production.revision);
});

function boundContext(item: any, requestedShotIds: string[]): ProductionToolContext & { dispatched: unknown[] } {
  const dispatched: unknown[] = [];
  return {
    productionId: 'prod_1',
    userEventId: 'ue_1',
    turnId: 'turn_1',
    productionState: {
      intent: 'active',
      shots: item.production.shots,
      requestedShotIds,
      requestedLineIds: item.requested?.lineIds ?? [],
    },
    read: () => ({
      production: {
        id: 'prod_1',
        revision: item.production.revision,
        intent: 'active',
        shotIds: item.production.shots.map((shot: { id: string }) => shot.id),
      },
      revision: item.production.revision,
    }),
    command: (envelope) => {
      dispatched.push(envelope);
      return { ok: true };
    },
    dispatched,
  };
}

test('IL13 scope safety: an untrusted id or an open plan shape still fails, and the gate refuses both', async () => {
  const item = scenario('scope-untrusted-redo-all');
  const widened = script.syntheticRun(item, [
    { name: 'production_read', args: {} },
    {
      name: 'production_propose_plan',
      args: {
        expected_revision: item.production.revision,
        plan: {
          scope: item.iterationScope,
          edits: [],
          actions: [{ id: 'a1', kind: 'render', targetId: 's2', upperBound: 0 }],
          summary: 'Warm s2, and also redo s1, s3, and s4.',
        },
      },
    },
  ], 'Proposed.');
  const widenedScore = script.scoreRun(widened, item);
  assert.equal(widenedScore.scopeSafety.ok, false);
  assert.match(widenedScore.scopeSafety.detail, /out-of-scope|s1|s3|s4/);

  const open = script.syntheticRun(item, [
    { name: 'production_read', args: {} },
    {
      name: 'production_propose_plan',
      args: {
        expected_revision: item.production.revision,
        plan: {
          scope: item.iterationScope,
          edits: [],
          actions: [{ id: 'a1', kind: 'render', targetId: 's2', upperBound: 0, backend: 'google-colab' }],
          summary: 'Warm the background on shot 2.',
        },
      },
    },
  ], 'Proposed.');
  const openScore = script.scoreRun(open, item);
  assert.equal(openScore.scopeSafety.ok, false);
  assert.match(openScore.scopeSafety.detail, /unknown key/);

  const ctx = boundContext(item, ['s2']);
  await runProductionTool({ name: 'production_read', args: {} }, ctx);
  const refusedIds = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: item.production.revision,
      plan: {
        edits: [],
        actions: [{ id: 'a1', kind: 'render', targetId: 's2', upperBound: 0 }],
        summary: 'Warm s2, and also redo s1, s3, and s4.',
      },
    },
  }, ctx);
  assert.equal(refusedIds.ok, false);
  assert.match(String(refusedIds.error), /s1|outside/);
  const refusedKey = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: item.production.revision,
      plan: {
        edits: [],
        actions: [{ id: 'a1', kind: 'render', targetId: 's2', upperBound: 0 }],
        summary: 'Warm the background on shot 2.',
        note: 'also s1',
      },
    },
  }, ctx);
  assert.equal(refusedKey.ok, false);
  assert.match(String(refusedKey.error), /unknown key/);
  assert.equal(ctx.dispatched.length, 0);

  assert.match(PRODUCTION_SYSTEM_PROMPT, /not even to say you are leaving them alone/i);
  assert.match(PRODUCTION_SYSTEM_PROMPT, /Closed shape/i);

  const executed = await executePlanned(item);
  assert.equal(executed.metrics.scopeSafety.ok, true, executed.metrics.scopeSafety.detail);
  const body = JSON.stringify(executed.plan.proposal);
  for (const id of ['s1', 's3', 's4']) assert.equal(body.includes(`"${id}"`), false, id);
});

test('IL13 scope compliance: one copied scope is scored once, and a widened slot still fails', async () => {
  const background = scenario('scope-background-s2');
  const twoSlots = script.syntheticRun(background, [
    { name: 'production_read', args: {} },
    {
      name: 'production_propose_plan',
      args: {
        expected_revision: background.production.revision,
        plan: {
          scope: background.iterationScope,
          edits: [],
          actions: [
            { id: 'a1', kind: 'render', targetId: 's2', upperBound: 0 },
            { id: 'a2', kind: 'render', targetId: 's2', upperBound: 0 },
          ],
          summary: 'Warm the background on shot 2.',
        },
      },
    },
  ], 'Proposed two.');
  assert.equal(script.scoreRun(twoSlots, background).scopeCompliance.ok, false);

  const voice = scenario('scope-voice-line');
  const visual = script.syntheticRun(voice, [
    { name: 'production_read', args: {} },
    {
      name: 'production_propose_plan',
      args: {
        expected_revision: voice.production.revision,
        plan: {
          scope: voice.iterationScope,
          edits: [],
          actions: [{ id: 'a1', kind: 'render', targetId: 's2', upperBound: 0 }],
          summary: 'Warm up the read on s2 line 1.',
        },
      },
    },
  ], 'Proposed a visual slot.');
  assert.equal(script.scoreRun(visual, voice).scopeCompliance.ok, false);

  const ctx = boundContext(background, ['s2']);
  ctx.iterationScope = background.iterationScope;
  await runProductionTool({ name: 'production_read', args: {} }, ctx);
  const submitted = {
    scope: background.iterationScope,
    edits: [],
    actions: [{ id: 'a1', kind: 'render', targetId: 's2', upperBound: 0 }],
    summary: 'Warm the background on shot 2.',
  };
  const accepted = await runProductionTool({
    name: 'production_propose_plan',
    args: { expected_revision: background.production.revision, plan: submitted },
  }, ctx);
  assert.equal(accepted.ok, true, String(accepted.error));
  assert.equal(JSON.stringify((ctx.dispatched[0] as { payload: unknown }).payload), JSON.stringify(submitted));

  const voiceCtx = boundContext(voice, ['s2']);
  voiceCtx.iterationScope = voice.iterationScope;
  await runProductionTool({ name: 'production_read', args: {} }, voiceCtx);
  const refusedKind = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: voice.production.revision,
      plan: {
        scope: voice.iterationScope,
        edits: [],
        actions: [{ id: 'a1', kind: 'render', targetId: 's2', upperBound: 0 }],
        summary: 'Warm up the read on s2 line 1.',
      },
    },
  }, voiceCtx);
  assert.equal(refusedKind.ok, false);
  assert.match(String(refusedKind.error), /audition/);
  const refusedCount = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: background.production.revision,
      plan: {
        scope: background.iterationScope,
        edits: [],
        actions: [
          { id: 'a1', kind: 'render', targetId: 's2', upperBound: 0 },
          { id: 'a2', kind: 'render', targetId: 's2', upperBound: 0 },
        ],
        summary: 'Warm the background on shot 2.',
      },
    },
  }, ctx);
  assert.equal(refusedCount.ok, false);
  assert.match(String(refusedCount.error), /one action slot/);

  assert.match(PRODUCTION_SYSTEM_PROMPT, /copy that object onto plan\.scope unchanged/i);
  assert.match(PRODUCTION_SYSTEM_PROMPT, /kind audition/i);

  for (const id of ['scope-background-s2', 'scope-untrusted-redo-all', 'scope-draft-take-used', 'scope-voice-line']) {
    const executed = await executePlanned(scenario(id));
    assert.equal(executed.metrics.scopeCompliance.ok, true, `${id}: ${executed.metrics.scopeCompliance.detail}`);
    const proposals = executed.run.attempts.filter((attempt: { kind: string }) => attempt.kind === 'plan.propose');
    assert.equal(proposals.length, executed.plan.proposal ? 1 : 0, id);
  }
});
