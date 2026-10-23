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
