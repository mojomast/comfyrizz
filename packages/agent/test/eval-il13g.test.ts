import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planProductionTurn } from '../src/production-planner.js';
import {
  PRODUCTION_SYSTEM_PROMPT,
  PRODUCTION_TOOLS,
  runProductionTool,
  type ProductionCommandEnvelope,
  type ProductionToolContext,
} from '../src/production-tools.js';

const script: any = await import(new URL('../../scripts/eval-production.mjs', import.meta.url).href);
const cases: any[] = script.loadCases();

function scenario(id: string): any {
  const found = cases.find((item: any) => item.id === id);
  assert.ok(found, id);
  return found;
}

function planFor(item: any) {
  const iteration = item.production?.iteration?.policy
    ? {
        policy: item.production.iteration.policy,
        ...(item.production.lockedShotIds ? { lockedShotIds: item.production.lockedShotIds } : {}),
        ...(item.production.iteration.used ? { used: item.production.iteration.used } : {}),
      }
    : undefined;
  return planProductionTurn({
    userMessage: item.userMessage,
    intent: item.production?.intent ?? 'active',
    shots: item.production?.shots ?? [],
    requestedShotIds: item.requested?.shotIds ?? [],
    requestedLineIds: item.requested?.lineIds ?? [],
    untrustedTexts: (item.untrustedSources ?? []).map((source: { text?: string }) => source.text ?? ''),
    iteration,
    ...(item.iterationScope ? { iterationScope: item.iterationScope } : {}),
  });
}

function fakeContext(item: any): ProductionToolContext & { dispatched: ProductionCommandEnvelope[] } {
  const dispatched: ProductionCommandEnvelope[] = [];
  return {
    productionId: 'prod_il13g',
    userEventId: 'ue_il13g',
    turnId: 'turn_il13g',
    productionState: {
      intent: item.production.intent,
      shots: item.production.shots,
      requestedShotIds: item.requested?.shotIds ?? [],
      requestedLineIds: item.requested?.lineIds ?? [],
    },
    read: () => ({
      production: {
        id: 'prod_il13g',
        revision: item.production.revision,
        intent: item.production.intent,
        shotIds: item.production.shots.map((shot: { id: string }) => shot.id),
        ...(item.production.lockedShotIds ? { lockedShotIds: item.production.lockedShotIds } : {}),
        ...(item.production.iteration ? { iteration: item.production.iteration } : {}),
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

async function proposeSlotKind(item: any, kind: string) {
  const ctx = fakeContext(item);
  const read = await runProductionTool({ name: 'production_read', args: {} }, ctx);
  assert.equal(read.ok, true, String(read.error));
  const result = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: item.production.revision,
      plan: {
        edits: [],
        actions: [{ id: 'a1', kind, targetId: 's1', upperBound: 0 }],
        summary: item.userMessage,
      },
    },
  }, ctx);
  return { result, dispatched: ctx.dispatched };
}

test('IL13G scope-voice-line: draft policy and expected voice-line take are consistent', () => {
  const item = scenario('scope-voice-line');
  const voice = item.production.iteration.policy.stages.voice;
  assert.equal(voice.takes, 1);
  assert.equal(voice.rounds, 1);
  assert.equal(voice.auditions, 0);
  assert.equal(item.expect.iteration.takeSlots, 1);
  assert.equal(item.iterationScope.element, 'voice_line');
  assert.deepEqual(item.iterationScope.elementRef, { lineId: 's2:l1' });

  const plan = planFor(item);
  assert.ok(plan.proposal);
  assert.deepEqual(plan.proposal.edits, []);
  assert.deepEqual(plan.proposal.actions, [
    { id: 'a1', kind: 'audition', targetId: 's2:l1', upperBound: 0 },
  ]);
  const run = script.syntheticRun(item, [
    { name: 'production_read', args: {} },
    {
      name: 'production_propose_plan',
      args: { expected_revision: item.production.revision, plan: plan.proposal },
    },
  ], plan.reply);
  const metrics = script.scoreRun(run, item);
  assert.equal(metrics.scopeSafety.ok, true, metrics.scopeSafety.detail);
  assert.equal(metrics.scopeCompliance.ok, true, metrics.scopeCompliance.detail);
  assert.equal(metrics.iterationCompliance.ok, true, metrics.iterationCompliance.detail);
});

test('IL13G guidance: candidate-voice auditions do not ban a voice-line take', () => {
  assert.match(PRODUCTION_SYSTEM_PROMPT, /voice\.auditions`? counts candidate voices, not voice_line re-takes/i);
  assert.match(PRODUCTION_SYSTEM_PROMPT, /voice takes × rounds/i);
  assert.match(PRODUCTION_SYSTEM_PROMPT, /auditions 0 does not ban that re-take/i);
});

test('IL13G iteration-draft-render: the tool gate rejects video and accepts render or take', async () => {
  const item = scenario('iteration-draft-render');
  const video = await proposeSlotKind(item, 'video');
  assert.equal(video.result.ok, false);
  assert.match(String(video.result.error), /render or take/i);
  assert.equal(video.dispatched.length, 0);

  for (const kind of ['render', 'take']) {
    const accepted = await proposeSlotKind(item, kind);
    assert.equal(accepted.result.ok, true, String(accepted.result.error));
    assert.equal(accepted.dispatched.length, 1);
    const actions = accepted.dispatched[0].payload.actions as Array<{ kind: string }>;
    assert.equal(actions[0].kind, kind);
  }

  const planned = planFor(item);
  assert.ok(planned.proposal);
  assert.equal(planned.proposal.actions.length, 1);
  assert.equal(planned.proposal.actions[0].kind, 'render');
  assert.equal(planned.proposal.actions[0].targetId, 's1');
});

test('IL13G tool guidance: video is a stage, not a render or take slot kind', () => {
  const propose = PRODUCTION_TOOLS.find(tool => tool.name === 'production_propose_plan');
  assert.ok(propose);
  const parameters = propose.parameters as any;
  const description = String(parameters.properties.plan.properties.actions.items.properties.kind.description);
  assert.match(description, /render or take/i);
  assert.match(description, /never `?video`?|video`? is never/i);
  assert.match(description, /video.*stage/i);
});
