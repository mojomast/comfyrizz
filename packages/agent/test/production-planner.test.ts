import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTION_SYSTEM_PROMPT } from '../src/production-tools.js';
import { planProductionTurn } from '../src/production-planner.js';

const script: any = await import(new URL('../../scripts/eval-production.mjs', import.meta.url).href);
const cases: any[] = script.loadCases();

function turnsFor(scenario: any) {
  const iteration = scenario.production?.iteration?.policy
    ? {
        policy: scenario.production.iteration.policy,
        ...(scenario.production.lockedShotIds ? { lockedShotIds: scenario.production.lockedShotIds } : {}),
        ...(scenario.production.iteration.used ? { used: scenario.production.iteration.used } : {}),
      }
    : undefined;
  const plan = planProductionTurn({
    userMessage: scenario.userMessage,
    intent: scenario.production?.intent ?? 'active',
    shots: scenario.production?.shots ?? [],
    requestedShotIds: scenario.requested?.shotIds ?? [],
    requestedLineIds: scenario.requested?.lineIds ?? [],
    untrustedTexts: (scenario.untrustedSources ?? []).map((source: { text?: string }) => source.text ?? ''),
    iteration,
    ...(scenario.iterationScope ? { iterationScope: scenario.iterationScope } : {}),
  });
  assert.equal(plan.readFirst, true, scenario.id);
  const revision = scenario.production.revision;
  const calls = [{ name: 'production_read', args: {} }];
  if (plan.proposal) {
    calls.push({
      name: 'production_propose_plan',
      args: { expected_revision: revision, plan: plan.proposal },
    });
  }
  if (plan.command) {
    calls.push({
      name: 'production_command',
      args: { kind: plan.command.kind, expected_revision: revision, payload: plan.command.payload },
    });
  }
  const run = script.syntheticRun(scenario, calls, plan.reply);
  run.caseId = scenario.id;
  return { plan, run };
}

test('IP63X planner: every recorded failure category passes Kyle\'s thresholds', () => {
  const runs = cases.map(scenario => turnsFor(scenario).run);
  const scored = script.scoreAll(runs, cases);
  for (const metric of script.ALL_METRICS) {
    const result = scored.metrics[metric];
    assert.equal(result.ok, true, `${metric} ${result.percent}% ${result.failures.slice(0, 8).join(' | ')}`);
    assert.equal(result.percent, 100, metric);
  }
  assert.equal(scored.extraPaidRuns, 0);
});

test('IP63X planner: notes do not leak into the edit, and a stale cache is not the revision', () => {
  const injected = turnsFor(cases.find((item: any) => item.id === 'injection-delete-s3'));
  assert.ok(injected.plan.proposal);
  const body = JSON.stringify(injected.plan.proposal);
  for (const id of ['s2', 's2:l1', 's3', 's3:l1', 's3:l2']) {
    assert.equal(body.includes(id), false, id);
  }
  assert.deepEqual(injected.plan.proposal.edits.map((edit: { lineId: string }) => edit.lineId), ['s1:l1']);
  assert.deepEqual(injected.plan.proposal.actions, []);

  const stale = turnsFor(cases.find((item: any) => item.id === 'stale-revision'));
  assert.ok(stale.plan.proposal);
  assert.equal(stale.plan.proposal.edits[0].lineId, 's1:l1');
  assert.equal(JSON.stringify(stale.plan).includes('"revision":3'), false);
  assert.equal(stale.run.toolCalls[0].name, 'production_read');
  assert.equal(stale.run.toolCalls[1].args.expected_revision, 7);

  const empty = turnsFor(cases.find((item: any) => item.id === 'stale-plan-hash'));
  assert.ok(empty.plan.proposal);
  assert.equal(empty.plan.proposal.edits.length, 1);
  assert.equal(JSON.stringify(empty.plan).includes('1111111111111111'), false);

  const vague = turnsFor(cases.find((item: any) => item.id === 'edit-s1-vague'));
  assert.equal(vague.plan.proposal, undefined);
  assert.equal(vague.plan.command, undefined);
  assert.match(vague.plan.reply, /\?/);

  const paused = turnsFor(cases.find((item: any) => item.id === 'cancel-requested-noop'));
  assert.equal(paused.plan.proposal, undefined);
  assert.equal(paused.plan.command, undefined);
  assert.match(paused.plan.reply, /\?/);
});

test('IP63X prompt: the model is told to read first and not to invent action slots', () => {
  const env = script.createScenarioEnvironment(cases.find((item: any) => item.id === 'edit-s1-line2'));
  try {
    assert.equal(env.system, PRODUCTION_SYSTEM_PROMPT);
    assert.equal(env.ctx.productionState.requestedLineIds[0], 's1:l2');
  } finally {
    env.cleanup();
  }
  assert.match(PRODUCTION_SYSTEM_PROMPT, /first tool call of every turn is production_read/i);
  assert.match(PRODUCTION_SYSTEM_PROMPT, /actions is an empty array/i);
  assert.match(PRODUCTION_SYSTEM_PROMPT, /Do not name any other shot or line/i);
  assert.match(PRODUCTION_SYSTEM_PROMPT, /still propose that edit/i);
  assert.match(PRODUCTION_SYSTEM_PROMPT, /Google Colab/);
  assert.equal(PRODUCTION_SYSTEM_PROMPT.includes('"actions":[{"id"'), false);
});

test("IL12G planner: handles 4 iteration policy cases", () => {
  const draftRender = turnsFor(cases.find((item: any) => item.id === "iteration-draft-render"));
  assert.equal(draftRender.plan.readFirst, true);
  assert.ok(draftRender.plan.proposal);
  assert.deepEqual(draftRender.plan.proposal.edits, []);
  assert.equal(draftRender.plan.proposal.actions.length, 1);
  assert.equal(draftRender.plan.proposal.actions[0].kind, "render");
  assert.equal(draftRender.plan.proposal.actions[0].targetId, "s1");
  assert.equal(draftRender.plan.proposal.actions[0].upperBound, 0);

  const balancedFour = turnsFor(cases.find((item: any) => item.id === "iteration-balanced-untrusted-four"));
  assert.equal(balancedFour.plan.readFirst, true);
  assert.ok(balancedFour.plan.proposal);
  assert.deepEqual(balancedFour.plan.proposal.edits, []);
  assert.equal(balancedFour.plan.proposal.actions.length, 4);
  const targetCounts = new Map<string, number>();
  for (const action of balancedFour.plan.proposal.actions) {
    assert.equal(action.kind, "render");
    assert.equal(action.upperBound, 0);
    targetCounts.set(action.targetId, (targetCounts.get(action.targetId) ?? 0) + 1);
  }
  for (const [shot, count] of targetCounts) {
    assert.ok(count <= 2, `shot ${shot} has ${count} takes, max 2`);
  }

  const draftThree = turnsFor(cases.find((item: any) => item.id === "iteration-draft-three-takes"));
  assert.equal(draftThree.plan.readFirst, true);
  assert.equal(draftThree.plan.proposal, undefined);
  assert.equal(draftThree.plan.command, undefined);
  assert.match(draftThree.plan.reply, /\?/);

  const lockedShot = turnsFor(cases.find((item: any) => item.id === "iteration-midprod-locked-shot"));
  assert.equal(lockedShot.plan.readFirst, true);
  assert.ok(lockedShot.plan.proposal);
  assert.deepEqual(lockedShot.plan.proposal.edits, []);
  assert.deepEqual(lockedShot.plan.proposal.actions, []);
  assert.match(lockedShot.plan.reply + " " + lockedShot.plan.proposal.summary, /locked/i);
});

const scenarioById = (id: string) => cases.find((item: any) => item.id === id);

test('AV16 planner: a background scope proposes one render slot on its shot with the turn scope', () => {
  const scoped = turnsFor(scenarioById('scope-background-s2'));
  assert.ok(scoped.plan.proposal);
  assert.deepEqual(scoped.plan.proposal.scope, scenarioById('scope-background-s2').iterationScope);
  assert.deepEqual(scoped.plan.proposal.edits, []);
  assert.equal(scoped.plan.proposal.actions.length, 1);
  assert.equal(scoped.plan.proposal.actions[0].kind, 'render');
  assert.equal(scoped.plan.proposal.actions[0].targetId, 's2');
  assert.equal(scoped.plan.proposal.actions[0].upperBound, 0);
});

test('AV16 planner: an untrusted note asking to redo every shot does not widen the scope', () => {
  const scoped = turnsFor(scenarioById('scope-untrusted-redo-all'));
  assert.ok(scoped.plan.proposal);
  assert.deepEqual(scoped.plan.proposal.scope, scenarioById('scope-untrusted-redo-all').iterationScope);
  assert.equal(scoped.plan.proposal.actions.length, 1);
  assert.equal(scoped.plan.proposal.actions[0].targetId, 's2');
  const body = JSON.stringify(scoped.plan.proposal);
  for (const id of ['s1', 's3', 's4']) assert.equal(body.includes(`"${id}"`), false, id);
});

test('AV16 planner: a used-up draft take asks to change level and proposes nothing', () => {
  const scoped = turnsFor(scenarioById('scope-draft-take-used'));
  assert.equal(scoped.plan.proposal, undefined);
  assert.equal(scoped.plan.command, undefined);
  assert.match(scoped.plan.reply, /\?/);
  assert.match(scoped.plan.reply, /level/i);
});

test('AV16 planner: a voice_line scope proposes one audition slot on its line', () => {
  const scoped = turnsFor(scenarioById('scope-voice-line'));
  assert.ok(scoped.plan.proposal);
  assert.deepEqual(scoped.plan.proposal.scope, scenarioById('scope-voice-line').iterationScope);
  assert.deepEqual(scoped.plan.proposal.edits, []);
  assert.equal(scoped.plan.proposal.actions.length, 1);
  assert.equal(scoped.plan.proposal.actions[0].kind, 'audition');
  assert.equal(scoped.plan.proposal.actions[0].targetId, 's2:l1');
  assert.equal(scoped.plan.proposal.actions[0].upperBound, 0);
});
