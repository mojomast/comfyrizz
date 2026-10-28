import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyProductionIntent } from '../../packages/agent/dist/src/index.js';
import {
  BOUNDED_FAILURE_CODES,
  buildCorrectionPrompt,
  correctionInvokedGeneration,
  decideCorrectionAction,
  extractPackageContext,
  hybridPlanningCorrectionEnabled,
  readPlanningCorrection,
} from '../../apps/server/src/hybrid-planning-correction.mjs';
import { ENGINEERING_TARGETS } from '../hybrid-thinking/targets.mjs';
import { MAIN_HARD_TOKEN_BUDGET, MAIN_MAX_REQUESTS, MAIN_REPS, mainBudget } from '../hybrid-thinking/budget.mjs';
import {
  CALIBRATION_FIXTURE,
  CALIBRATION_ID,
  MAIN_COVERAGE,
  MAIN_IDS,
  SMOKE_IDS,
  hybridFixtureById,
  mainFixtures,
  smokeFixtures,
} from '../hybrid-thinking/fixtures.mjs';
import {
  collateralDamage,
  evaluateHybrid,
  mapFailureCode,
  observeHybrid,
  outOfScopeIdChanges,
  remotionFailures,
  triggerFromJudge,
} from '../hybrid-thinking/oracles.mjs';
import { liveCredential, planningProviderEnv, providerKeyPresent, publicProvider } from '../hybrid-thinking/provider.mjs';
import {
  assertSanitized,
  renderHybridMarkdown,
  summarizeHybrid,
  toHybridRecord,
  writeHybridReports,
} from '../hybrid-thinking/report.mjs';
import {
  LIMITS,
  PORTS,
  STRESS_ROOT,
  assertLoopback,
  assertStressPath,
  composeArmC,
  fixtureHash,
  planArmC,
  publicWorkerConfig,
  stopWorkers,
  workerEnv,
} from '../hybrid-thinking/run.mjs';
import { evaluateFixture } from '../planning-stress/oracles.mjs';
import { assertAllowedRequest } from '../planning-stress/run.mjs';
import { PLANNING_MODEL, PLANNING_PROVIDER, fixtureById } from '../planning-stress/fixtures.mjs';

test('smoke and main selections are stratified and include calibration', () => {
  assert.deepEqual(SMOKE_IDS, ['S02', CALIBRATION_ID]);
  assert.equal(MAIN_IDS.length, 12);
  assert.equal(new Set(MAIN_IDS).size, 12);
  assert.ok(MAIN_IDS.includes(CALIBRATION_ID));
  assert.ok(MAIN_IDS.includes('S02'));
  assert.ok(MAIN_IDS.includes('X33'));
  for (const ids of Object.values(MAIN_COVERAGE)) {
    assert.ok(ids.length >= 1, 'every declared class has a fixture');
    for (const id of ids) assert.ok(MAIN_IDS.includes(id), id);
  }
  assert.equal(smokeFixtures().length, 2);
  assert.equal(mainFixtures().length, 12);
  assert.equal(hybridFixtureById('S02').brief, fixtureById('S02').brief);
  assert.equal(CALIBRATION_FIXTURE.experimentOnly, true);
  assert.notEqual(CALIBRATION_FIXTURE.brief, fixtureById('S02').brief);
});

test('calibration brief is a live-action Remotion generated film', () => {
  const intent = classifyProductionIntent(CALIBRATION_FIXTURE.brief);
  assert.equal(intent.kind, 'generated-film');
  assert.equal(intent.liveActionHumans, true);
  assert.equal(intent.bookends, true);
  assert.equal(intent.wordless, true);
  assert.equal(intent.noCaptions, false);
  assert.equal(CALIBRATION_FIXTURE.oracle.remotionBookends, true);
});

test('existing planning-stress oracles are not weakened', () => {
  const silent = evaluateFixture(fixtureById('X33'), {
    status: 200,
    body: { live: true, fallback: false, provider: PLANNING_PROVIDER, model: PLANNING_MODEL, package: { scenes: [], assets: {} } },
  });
  assert.equal(silent.outcome, 'missing_actionable_refusal');
  const cues = evaluateFixture(fixtureById('H21'), {
    status: 200,
    body: {
      live: true,
      fallback: false,
      provider: PLANNING_PROVIDER,
      model: PLANNING_MODEL,
      package: {
        format: { width: 1920, height: 1080, fps: 30 },
        scenes: [
          { id: 's1', narration: 'The string reveals an octave.', motion: { cue_phrases: ['Reveals an octave'] }, media: [{ asset: 'a1' }] },
          { id: 's2', narration: 'The next ratio holds.', motion: { cue_phrases: ['ratio holds'] }, media: [{ asset: 'a2' }] },
        ],
        assets: {
          a1: { kind: 'video', gen: { generator: 'flux3-klein' } },
          a2: { kind: 'video', gen: { generator: 'flux3-klein' } },
        },
      },
    },
    voiceEnabled: true,
  });
  assert.equal(cues.outcome, 'fail');
  assert.match(cues.failures.join('\n'), /case-sensitive/);
});

test('trigger oracle maps quality codes and skips refusals and infra', () => {
  assert.equal(mapFailureCode('compiled duration 3.00s is outside 4.00–8.00s'), 'DURATION_OUT_OF_RANGE');
  const observation = observeHybrid({
    id: 'pkg_cal',
    format: { width: 1920, height: 1080, fps: 30 },
    scenes: [
      { id: 's1', layout: 'hero', preferredFrames: 180, media: [{ asset: 'a1' }] },
      { id: 's2', layout: 'hero', preferredFrames: 180, media: [{ asset: 'a2' }] },
    ],
    assets: {
      a1: { kind: 'video', gen: { generator: 'fasth3-omni' } },
      a2: { kind: 'video', gen: { generator: 'fasth3-omni' } },
    },
  }, CALIBRATION_FIXTURE);
  const remotion = remotionFailures(CALIBRATION_FIXTURE, observation);
  assert.deepEqual(remotion.map(item => item.code).sort(), ['REMOTION_OPENER', 'REMOTION_OUTRO']);
  const judged = { outcome: 'pass', failures: [] };
  const trigger = triggerFromJudge(CALIBRATION_FIXTURE, judged, observation);
  assert.equal(trigger.decision.action, 'correct');
  assert.ok(trigger.failures.every(item => BOUNDED_FAILURE_CODES.has(item.code)));

  const refusal = triggerFromJudge(hybridFixtureById('X33'), { outcome: 'expected_refusal_pass', failures: [] }, {});
  assert.equal(refusal.decision.action, 'skip');
  assert.equal(refusal.decision.reason, 'expected_refusal');

  const infra = triggerFromJudge(hybridFixtureById('S02'), { outcome: 'infrastructure', failures: ['transport or provider infrastructure failure'] }, {});
  assert.equal(infra.decision.action, 'skip');
  assert.equal(infra.decision.reason, 'infrastructure');
  assert.equal(decideCorrectionAction({ expect: 'plan', infrastructure: false, failures: [] }).action, 'skip');
});

test('hybrid evaluate adds Remotion failures without changing planning-stress judge strings', () => {
  const hybrid = evaluateHybrid(CALIBRATION_FIXTURE, {
    status: 200,
    body: {
      live: true,
      fallback: false,
      provider: PLANNING_PROVIDER,
      model: PLANNING_MODEL,
      package: {
        id: 'pkg_cal',
        format: { width: 1920, height: 1080, fps: 30 },
        scenes: [
          { id: 's1', layout: 'hero', preferredFrames: 180, media: [{ asset: 'a1' }] },
          { id: 's2', layout: 'hero', preferredFrames: 180, media: [{ asset: 'a2' }] },
        ],
        assets: {
          a1: { kind: 'video', status: 'pending', gen: { generator: 'fasth3-omni' } },
          a2: { kind: 'video', status: 'pending', gen: { generator: 'fasth3-omni' } },
        },
      },
    },
  });
  assert.equal(hybrid.outcome, 'fail');
  assert.ok(hybrid.trigger.failures.some(item => item.code === 'REMOTION_OPENER'));
  assert.doesNotMatch(JSON.stringify(hybrid), /sk-|Bearer /);
});

test('correction template contains only the allowed sections', () => {
  const pkg = {
    id: 'pkg_keep',
    format: { width: 1920, height: 1080, fps: 30 },
    scenes: [{ id: 's1', layout: 'hero', variant: null, preferredFrames: 180, media: [{ asset: 'a1' }] }],
    assets: { a1: { kind: 'video', status: 'pending', gen: { generator: 'fasth3-omni' } } },
  };
  const prompt = buildCorrectionPrompt({
    brief: CALIBRATION_FIXTURE.brief,
    failures: [{ code: 'REMOTION_OPENER', detail: 'missing opener', sceneId: 's1' }],
    context: extractPackageContext(pkg),
  });
  assert.match(prompt, /Original brief:/);
  assert.match(prompt, /Objective failure codes/);
  assert.match(prompt, /REMOTION_OPENER/);
  assert.match(prompt, /Immutable IDs/);
  assert.match(prompt, /pkg_keep/);
  assert.match(prompt, /Allowed-edit scope/i);
  assert.doesNotMatch(prompt, /Make this film|\/api\/run|Google Colab|OPENCODE_GO_API_KEY=/);
});

test('C reuses A with zero extra tokens when oracles already pass', () => {
  const aRecord = toHybridRecord({
    fixture: 'S02',
    category: 'simple',
    rep: 1,
    arm: 'A',
    expected: 'plan',
    actual: 'pass',
    thinking: 'disabled',
    usage: { input: 10, output: 5, total: 15, phases: { initial: { input: 8, output: 4, total: 12 }, repair: { input: 2, output: 1, total: 3 }, correction: { input: 0, output: 0, total: 0 } } },
    elapsedMs: 1000,
    e2eMs: 1000,
    firstValidDraftMs: 800,
    repairMs: 200,
  });
  const composed = composeArmC(aRecord, null, { decision: { action: 'skip', reason: 'all_passed' }, hybridEval: { outcome: 'pass' }, generationHit: false, fullReplan: false });
  assert.equal(composed.usage.total.total, 15);
  assert.equal(composed.usage.correction.total, 0);
  assert.equal(composed.correctionMs, 0);
  const plan = planArmC({
    record: { actual: 'pass' },
    judged: { trigger: { infrastructure: false, decision: { action: 'skip', reason: 'all_passed' } } },
  }, hybridFixtureById('S02'));
  assert.equal(plan.action, 'skip');
});

test('C totals add only correction usage onto A', () => {
  const aRecord = toHybridRecord({
    fixture: 'C01',
    category: 'calibration',
    rep: 1,
    arm: 'A',
    expected: 'plan',
    actual: 'fail',
    thinking: 'disabled',
    usage: { input: 100, output: 20, total: 120, phases: { initial: { input: 100, output: 20, total: 120 }, repair: { input: 0, output: 0, total: 0 }, correction: { input: 0, output: 0, total: 0 } } },
    elapsedMs: 2000,
  });
  const composed = composeArmC(aRecord, {
    usage: { input: 40, output: 10, total: 50, phases: { correction: { input: 40, output: 10, total: 50 } } },
    elapsedMs: 900,
  }, { decision: { action: 'correct' }, hybridEval: { outcome: 'pass' }, generationHit: false, fullReplan: false });
  assert.equal(composed.usage.total.total, 170);
  assert.equal(composed.usage.correction.total, 50);
  assert.equal(composed.elapsedMs, 2900);
});

test('collateral and out-of-scope ID changes are detected', () => {
  const before = { failures: [{ code: 'REMOTION_OPENER', detail: 'missing opener' }] };
  const after = { failures: [{ code: 'REMOTION_OPENER', detail: 'missing opener' }, { code: 'DURATION_OUT_OF_RANGE', detail: 'drift' }] };
  const collateral = collateralDamage(before, after);
  assert.deepEqual(collateral.introducedCodes, ['DURATION_OUT_OF_RANGE']);
  const ids = outOfScopeIdChanges(
    { packageId: 'pkg_a', sceneIds: ['s1', 's2'], assetIds: ['a1'] },
    { packageId: 'pkg_b', sceneIds: ['s1', 's9'], assetIds: ['a1', 'a9'] },
    [{ code: 'REMOTION_OPENER', sceneId: 's1' }],
  );
  assert.equal(ids.packageIdChanged, true);
  assert.equal(ids.outOfScope, true);
});

test('generation paths and tools are hard harness failures', () => {
  assert.equal(correctionInvokedGeneration([], '/api/run').hit, true);
  assert.equal(correctionInvokedGeneration([], '/api/pipeline').hit, true);
  assert.equal(correctionInvokedGeneration([{ name: 'clip_propose_correction' }]).hit, true);
  assert.equal(correctionInvokedGeneration([{ name: 'storyboard.edit' }]).hit, false);
  assert.throws(() => assertAllowedRequest('POST', '/api/run'), /refusing/);
});

test('HTTP planningCorrection is rejected unless the env flag is set', () => {
  assert.equal(hybridPlanningCorrectionEnabled({}), false);
  assert.equal(hybridPlanningCorrectionEnabled({ COMFYRIZZ_HYBRID_PLANNING_CORRECTION: '1' }), true);
  const denied = readPlanningCorrection({ planningCorrection: { packageId: 'pkg_1', failures: [{ code: 'X', detail: 'y' }] } }, {});
  assert.equal(denied.code, 'HYBRID_CORRECTION_DISABLED');
  const allowed = readPlanningCorrection({
    planningCorrection: { packageId: 'pkg_1', failures: [{ code: 'REMOTION_OPENER', detail: 'missing opener' }] },
  }, { COMFYRIZZ_HYBRID_PLANNING_CORRECTION: '1' });
  assert.equal(allowed.value.packageId, 'pkg_1');
  assert.equal(readPlanningCorrection({ brief: 'x' }, {}).value, null);
});

test('infrastructure stays infrastructure and is not a model failure', () => {
  const judged = evaluateHybrid(hybridFixtureById('S02'), { status: 429, transport: true, body: {} });
  assert.equal(judged.outcome, 'infrastructure');
  assert.notEqual(judged.outcome, 'fail');
  const plan = planArmC({
    record: { actual: 'infrastructure' },
    judged: { trigger: { infrastructure: true, decision: { action: 'skip', reason: 'infrastructure' } } },
  }, hybridFixtureById('S02'));
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'infrastructure');
});

test('isolation reuses planning-stress patterns on a dedicated workspace', () => {
  assert.deepEqual(PORTS, [4531, 4532, 4533, 4534, 4535, 4536]);
  assert.equal(STRESS_ROOT, '/tmp/opencode/comfyrizz-hybrid-thinking');
  assert.doesNotThrow(() => assertLoopback('http://127.0.0.1:4531'));
  assert.throws(() => assertLoopback('http://127.0.0.1:4521'), /port/);
  assert.throws(() => assertLoopback('http://10.1.1.1:4531'), /loopback/);
  assert.throws(() => assertStressPath('/tmp/opencode/comfyrizz-planning-stress'), /hybrid thinking workspace/);
  const env = workerEnv({
    port: 4531,
    runtimeDir: `${STRESS_ROOT}/runtimes/unit/4531`,
    token: 'local-server-token',
    baseEnv: {
      PATH: '/usr/bin',
      OPENCODE_GO_API_KEY: 'unit-key-value',
      COMFYRIZZ_HF_TOKEN: 'hf-secret',
    },
  });
  assert.equal(env.COMFYRIZZ_HYBRID_PLANNING_CORRECTION, '1');
  assert.equal(env.OPENCODE_GO_API_KEY, 'unit-key-value');
  assert.equal(env.COMFYRIZZ_HF_TOKEN, undefined);
  const published = publicWorkerConfig(env);
  assert.doesNotMatch(JSON.stringify(published), /unit-key-value|local-server-token|hf-secret/);
  const signals = [];
  assert.deepEqual(stopWorkers([5001], (pid, signal) => signals.push([pid, signal])), [5001]);
  assert.throws(() => stopWorkers([-1], () => {}), /unrecorded/);
});

test('provider selection is identical-by-construction and never prints secrets', () => {
  assert.equal(providerKeyPresent({}), false);
  const direct = liveCredential({ COMFYRIZZ_CUSTOM_API_KEY: 'secret-direct' });
  assert.equal(direct.provider, 'custom');
  assert.equal(direct.model, 'deepseek-flash');
  const go = liveCredential({ OPENCODE_GO_API_KEY: 'secret-go' });
  assert.equal(go.provider, 'opencode-go');
  assert.equal(go.model, 'deepseek-v4.1-flash');
  const published = publicProvider(direct);
  assert.equal(published.keyPresent, true);
  assert.doesNotMatch(JSON.stringify(published), /secret-direct/);
  const { extra } = planningProviderEnv({ DEEPSEEK_API_KEY: 'secret-ds' });
  assert.equal(extra.COMFYRIZZ_CUSTOM_API_KEY, 'secret-ds');
  assert.equal(extra.COMFYRIZZ_CUSTOM_BASE_URL, 'https://api.deepseek.com/v1');
});

test('predeclared targets and main budget exist before any live results', () => {
  assert.equal(ENGINEERING_TARGETS.maxPassRateDropPpVsOn, 5);
  assert.equal(ENGINEERING_TARGETS.minMedianTokenSavingsVsOn, 0.25);
  assert.equal(ENGINEERING_TARGETS.minMedianLatencySavingsVsOn, 0.20);
  const budget = mainBudget();
  assert.equal(budget.fixtures, 12);
  assert.equal(budget.reps, MAIN_REPS);
  assert.equal(budget.maxRequests, MAIN_MAX_REQUESTS);
  assert.equal(budget.maxRequests, 108);
  assert.equal(budget.hardTokenBudget, MAIN_HARD_TOKEN_BUDGET);
  assert.equal(MAIN_HARD_TOKEN_BUDGET, 20_000_000);
  assert.equal(budget.approved, false);
  assert.equal(budget.started, false);
  assert.ok(budget.hardTokenBudget >= budget.estimatedTokens);
});

test('reports stay sanitized and include recommendation slots', () => {
  const records = ['A', 'B', 'C'].map(arm => toHybridRecord({
    fixture: 'S02',
    category: 'simple',
    expected: 'plan',
    actual: 'not_run',
    arm,
    provider: 'custom',
    model: 'deepseek-flash',
    thinking: arm === 'A' ? 'disabled' : 'enabled',
    reason: 'provider key missing',
    package: { id: 'pkg_secret' },
    brief: 'hidden brief',
    reasoning: 'chain of thought',
  }));
  for (const record of records) assertSanitized(record);
  const dir = mkdtempSync(join(tmpdir(), 'hybrid-thinking-'));
  try {
    writeHybridReports(dir, records, {
      runId: 'unit',
      status: 'blocked',
      provider: 'custom',
      model: 'deepseek-flash',
      mode: 'direct-deepseek',
      fixtures: SMOKE_IDS,
      reps: 1,
      blocked: 'keys unset',
      config: { provider: 'custom', model: 'deepseek-flash', ports: PORTS, keyPresent: false },
      events: { 'A-S02-r1.json': [{ type: 'tool_call', name: 'storyboard.propose', args: { brief: 'secret brief' } }] },
    });
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    const markdown = readFileSync(join(dir, 'summary.md'), 'utf8');
    const event = readFileSync(join(dir, 'events', 'A-S02-r1.json'), 'utf8');
    assert.equal(summary.status, 'blocked');
    assert.equal(summary.recommendations.viableOverall, null);
    assert.match(markdown, /Viable overall/);
    assert.match(markdown, /custom/);
    assert.match(markdown, /deepseek-flash/);
    assert.doesNotMatch(`${markdown}\n${event}`, /secret brief|chain of thought|pkg_secret|hidden brief/);
    assertSanitized(summary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary records hybrid-more-expensive trials instead of hiding them', () => {
  const records = [
    toHybridRecord({ fixture: 'S02', category: 'simple', rep: 1, arm: 'B', expected: 'plan', actual: 'pass', usage: { input: 10, output: 10, total: 20 }, e2eMs: 1000, elapsedMs: 1000 }),
    toHybridRecord({ fixture: 'S02', category: 'simple', rep: 1, arm: 'C', expected: 'plan', actual: 'pass', usage: { input: 30, output: 10, total: 40 }, e2eMs: 3000, elapsedMs: 3000 }),
    toHybridRecord({ fixture: 'S02', category: 'simple', rep: 1, arm: 'A', expected: 'plan', actual: 'pass', usage: { input: 8, output: 2, total: 10 }, e2eMs: 500, elapsedMs: 500 }),
  ];
  const summary = summarizeHybrid(records, { status: 'complete', provider: 'custom', model: 'deepseek-flash' });
  assert.ok(summary.comparisons.hybridMoreExpensiveThanOn.length >= 2);
  const markdown = renderHybridMarkdown(summary);
  assert.match(markdown, /hybrid cost more/);
  assert.match(markdown, /S02:1/);
});

test('fixture hash is stable and limits stay above the attempt timeout', () => {
  assert.equal(fixtureHash(mainFixtures()).length, 64);
  assert.ok(LIMITS.serverRequestTimeoutMs >= LIMITS.attemptTimeoutMs);
});
