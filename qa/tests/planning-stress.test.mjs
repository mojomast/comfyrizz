import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyProductionIntent } from '../../packages/agent/dist/src/index.js';
import { durationAcceptance } from '../../apps/server/src/duration-policy.mjs';
import { CATEGORIES, FIXTURES, PLANNING_MODEL, PLANNING_PROVIDER, fixtureById } from '../planning-stress/fixtures.mjs';
import { evaluateFixture, judge, observePackage } from '../planning-stress/oracles.mjs';
import {
  assertSanitized,
  percentile,
  renderMarkdown,
  resanitizeEvents,
  summarize,
  toAttemptRecord,
  varietyCoverage,
  writeReports,
} from '../planning-stress/report.mjs';
import {
  LIMITS,
  PORTS,
  SMOKE_IDS,
  admission,
  assertAllowedRequest,
  assertLoopback,
  assertStressPath,
  batchHealth,
  complexity,
  createBreaker,
  decideRerun,
  fixtureHash,
  noteCanaryFinished,
  noteTransport,
  orderMain,
  orderSmoke,
  providerKeyPresent,
  publicWorkerConfig,
  stopWorkers,
  updateConcurrency,
  workerEnv,
} from '../planning-stress/run.mjs';

function liveObservation(extra = {}) {
  return {
    httpStatus: 200,
    live: true,
    fallback: false,
    provider: PLANNING_PROVIDER,
    model: PLANNING_MODEL,
    intentKind: 'motion-graphics',
    sceneCount: 1,
    durationSeconds: 6,
    format: { width: 1920, height: 1080, fps: 30 },
    scenes: [{ headline: 'Harbor Light', narration: '', narrationAsset: '', cuePhrases: [], hasCopy: true, hasLowerThird: false, generators: [], items: [], datasetId: null, frames: 180 }],
    datasets: [],
    generators: [],
    svgCount: 0,
    pendingStillCount: 1,
    schemaProblems: [],
    completionProblems: [],
    voiceEnabled: false,
    sharedCast: false,
    ...extra,
  };
}

test('fixture matrix covers 30 plans, 6 refusals, and every requested variety', () => {
  assert.equal(FIXTURES.length, 36);
  assert.equal(new Set(FIXTURES.map(fixture => fixture.id)).size, 36);
  assert.equal(FIXTURES.filter(fixture => fixture.expect === 'plan').length, 30);
  assert.equal(FIXTURES.filter(fixture => fixture.expect === 'refusal').length, 6);
  assert.deepEqual(Object.values(CATEGORIES).flat().sort(), FIXTURES.map(fixture => fixture.id).sort());
  for (const fixture of FIXTURES) {
    assert.equal(fixture.provider, PLANNING_PROVIDER);
    assert.equal(fixture.model, PLANNING_MODEL);
    assert.ok(fixture.brief.trim().length > 40);
    assert.equal(classifyProductionIntent(fixture.brief).kind, fixture.oracle.kind, fixture.id);
  }
  const contradictory = classifyProductionIntent(fixtureById('X33').brief);
  assert.equal(contradictory.requiresNarrationCues, true);
  assert.equal(contradictory.wordless, true);
  assert.equal(classifyProductionIntent(fixtureById('S01').brief).requestedSeconds, 6);
  assert.equal(classifyProductionIntent(fixtureById('A05').brief).requestedSeconds, null);
  assert.equal(classifyProductionIntent(fixtureById('W17').brief).wordless, true);
  assert.equal(classifyProductionIntent(fixtureById('W17').brief).noCaptions, true);
  assert.equal(classifyProductionIntent(fixtureById('H21').brief).requiresNarrationCues, true);
  assert.equal(classifyProductionIntent(fixtureById('H21').brief).wordless, false);
  const tags = new Set(FIXTURES.flatMap(fixture => fixture.tags));
  for (const tag of ['simple', 'short', 'multi-shot', 'character', 'music', 'explainer', 'route:klein', 'route:h3', 'route:ltx', 'route:auto', 'edge', 'failure']) {
    assert.ok(tags.has(tag), tag);
  }
});

test('duration oracle uses the shared tolerance and ignores exact-frame drift inside it', () => {
  const acceptance = durationAcceptance(6);
  assert.equal(acceptance.toleranceSeconds, 2);
  assert.equal(acceptance.minSeconds, 4);
  assert.equal(acceptance.maxSeconds, 8);
  const inside = judge(fixtureById('S01'), liveObservation({ durationSeconds: 7.5 }));
  assert.equal(inside.outcome, 'pass', inside.failures.join('; '));
  assert.deepEqual(inside.durationAcceptance, acceptance);
  const outside = judge(fixtureById('S01'), liveObservation({ durationSeconds: 8.5 }));
  assert.equal(outside.outcome, 'fail');
  assert.match(outside.failures.join('\n'), /4\.00–8\.00/);
});

test('positive oracles reject fallback, bad routes, and inexact cue phrases', () => {
  const fallback = judge(fixtureById('S02'), liveObservation({
    sceneCount: 2,
    durationSeconds: 8,
    svgCount: 4,
    scenes: [
      { headline: 'READY TO RENDER', narration: '', generators: [], items: [], datasetId: null },
      { headline: '', narration: '', generators: [], items: [], datasetId: null },
    ],
    fallback: true,
  }));
  assert.equal(fallback.outcome, 'fail');
  assert.match(fallback.failures.join('\n'), /fallback/);

  const cues = judge(fixtureById('H21'), liveObservation({
    intentKind: 'generated-film',
    sceneCount: 2,
    durationSeconds: 12,
    voiceEnabled: true,
    scenes: [
      { headline: '', narration: 'The string reveals an octave.', cuePhrases: ['reveals an octave'], generators: ['flux3-klein'], hasCopy: true, items: [], datasetId: null },
      { headline: '', narration: 'The next ratio holds.', cuePhrases: ['ratio holds'], generators: ['flux3-klein'], hasCopy: true, items: [], datasetId: null },
    ],
    generators: ['flux3-klein'],
  }));
  assert.equal(cues.outcome, 'pass', cues.failures.join('; '));
  const wrongCase = judge(fixtureById('H21'), liveObservation({
    intentKind: 'generated-film',
    sceneCount: 2,
    durationSeconds: 12,
    voiceEnabled: true,
    scenes: [
      { headline: '', narration: 'The string reveals an octave.', cuePhrases: ['Reveals an octave'], generators: ['flux3-klein'], items: [], datasetId: null },
      { headline: '', narration: 'The next ratio holds.', cuePhrases: ['ratio holds'], generators: ['flux3-klein'], items: [], datasetId: null },
    ],
    generators: ['flux3-klein'],
  }));
  assert.equal(wrongCase.outcome, 'fail');
  assert.match(wrongCase.failures.join('\n'), /case-sensitive/);

  const substituted = judge(fixtureById('W19'), liveObservation({
    intentKind: 'generated-film',
    sceneCount: 4,
    durationSeconds: 16,
    scenes: [0, 1, 2, 3].map(() => ({ narration: '', generators: ['fasth3-omni'], hasCopy: false, hasLowerThird: false, items: [], datasetId: null, cuePhrases: [] })),
    generators: ['fasth3-omni'],
  }));
  assert.equal(substituted.outcome, 'fail');
  assert.match(substituted.failures.join('\n'), /fasth3-omni|media route/);
});

test('dataset, aspect, and refusal oracles stay declarative', () => {
  const shared = judge(fixtureById('D13'), liveObservation({
    sceneCount: 3,
    durationSeconds: 12,
    svgCount: 4,
    scenes: ['chart', 'stat', 'compare'].map(layout => ({
      layout, headline: '', narration: '', generators: [], items: [], datasetId: 'd_regions', cuePhrases: [],
    })),
    datasets: [{
      id: 'd_regions',
      source: 'user',
      values: [
        { label: 'North', value: 12 },
        { label: 'South', value: 19 },
        { label: 'East', value: 7 },
      ],
    }],
  }));
  assert.equal(shared.outcome, 'pass', shared.failures.join('; '));
  const commaSplit = judge(fixtureById('D15'), liveObservation({
    sceneCount: 4,
    durationSeconds: 12,
    svgCount: 4,
    scenes: ['chart', 'stat', 'compare', 'title'].map(layout => ({ layout, narration: '', generators: [], items: [], datasetId: 'd_regions', cuePhrases: [] })),
    datasets: [{
      id: 'd_regions',
      source: 'user',
      values: [
        { label: 'North', value: 1 },
        { label: 'South', value: 900 },
        { label: 'East', value: 12 },
        { label: 'West', value: 7 },
      ],
    }],
  }));
  assert.equal(commaSplit.outcome, 'fail');
  assert.match(commaSplit.failures.join('\n'), /dataset/);

  const portrait = judge(fixtureById('T27'), liveObservation({
    intentKind: 'generated-film',
    sceneCount: 2,
    durationSeconds: 8,
    format: { width: 1920, height: 1080, fps: 30 },
    sourceDimensions: [{ width: 1920, height: 1080 }],
    scenes: [
      { narration: '', generators: ['fasth3-omni'], items: [], datasetId: null, cuePhrases: [] },
      { narration: '', generators: ['fasth3-omni'], items: [], datasetId: null, cuePhrases: [] },
    ],
  }));
  assert.equal(portrait.outcome, 'fail');
  assert.match(portrait.failures.join('\n'), /1080x1920/);

  const refused = judge(fixtureById('X33'), {
    httpStatus: 422,
    details: 'generated-film plan is incomplete: narration contradicts wordless and cue_phrases',
    scenes: [],
  });
  assert.equal(refused.outcome, 'expected_refusal_pass');
  const silent = judge(fixtureById('X36'), { httpStatus: 200, live: true, fallback: false, provider: PLANNING_PROVIDER, model: PLANNING_MODEL, scenes: [], intentKind: 'motion-graphics' });
  assert.equal(silent.outcome, 'missing_actionable_refusal');
  const generic = judge(fixtureById('X31'), { httpStatus: 500, details: 'internal server error', scenes: [] });
  assert.equal(generic.outcome, 'missing_actionable_refusal');
});

test('observePackage measures compiled duration without returning the package', () => {
  const view = observePackage({
    format: { width: 1920, height: 1080, fps: 30 },
    scenes: [{ id: 's1', layout: 'title', preferredFrames: 210, copy: { headline: 'Harbor Light' } }],
    assets: {},
  }, fixtureById('S01'));
  assert.ok(Math.abs(view.durationSeconds - 7) < 0.05);
  assert.equal(view.package, undefined);
  const judged = evaluateFixture(fixtureById('S02'), {
    status: 200,
    body: {
      live: true,
      fallback: true,
      provider: PLANNING_PROVIDER,
      model: PLANNING_MODEL,
      package: { format: { width: 1920, height: 1080, fps: 30 }, scenes: [], assets: {}, voice: { enabled: false } },
      usage: { input: 3, output: 4, total: 7 },
      reasoning: 'do-not-retain',
    },
  });
  assert.equal(judged.package, undefined);
  assert.equal(judged.outcome, 'fail');
  assert.doesNotMatch(JSON.stringify(judged), /do-not-retain/);
});

test('scheduling keeps smoke order, complex plans first, and bounded retries', () => {
  assert.deepEqual(orderSmoke(FIXTURES).map(fixture => fixture.id), SMOKE_IDS);
  const main = orderMain(FIXTURES);
  assert.equal(main.length, 32);
  assert.equal(main[0].id, 'H21');
  assert.ok(complexity(fixtureById('H21')) > complexity(fixtureById('S01')));
  const firstRefusal = main.findIndex(fixture => fixture.expect === 'refusal');
  assert.ok(main.slice(firstRefusal).every(fixture => fixture.expect === 'refusal'));
  assert.deepEqual(decideRerun({ expected: 'plan', transport: true, reruns: 0 }), { rerun: true, reason: 'transient' });
  assert.deepEqual(decideRerun({ expected: 'plan', incomplete: true, reruns: 0 }), { rerun: true, reason: 'transient' });
  assert.equal(decideRerun({ expected: 'refusal', transport: true, reruns: 0 }).rerun, false);
  assert.equal(decideRerun({ expected: 'plan', semantic: true, transport: true, reruns: 0 }).rerun, false);
  assert.equal(decideRerun({ expected: 'plan', fallback: true, reruns: 0 }).rerun, false);
  assert.equal(decideRerun({ expected: 'plan', usageTotal: 100_001, transport: true, reruns: 0 }).rerun, false);
  assert.equal(decideRerun({ expected: 'plan', transport: true, reruns: 1 }).rerun, false);
  let state = { concurrency: LIMITS.initialConcurrency, healthyBatches: 0 };
  state = updateConcurrency(state, { rateLimited: false, networkErrors: false, p95Ms: 100_000 });
  assert.equal(state.concurrency, 4);
  state = updateConcurrency(state, { rateLimited: false, networkErrors: false, p95Ms: 90_000 });
  assert.equal(state.concurrency, 5);
  state = updateConcurrency(state, { rateLimited: false, networkErrors: false, p95Ms: 90_000 });
  state = updateConcurrency(state, { rateLimited: false, networkErrors: false, p95Ms: 90_000 });
  assert.equal(state.concurrency, 6);
  state = updateConcurrency(state, { rateLimited: true, networkErrors: false, p95Ms: 10_000 });
  assert.equal(state.concurrency, 5);
  const slow = batchHealth([{ timings: { elapsedMs: 250_000 }, httpStatus: 200 }, { timings: { elapsedMs: 10 }, httpStatus: 200 }]);
  assert.ok(slow.p95Ms > LIMITS.reduceP95Ms);
  const breaker = createBreaker();
  noteTransport(breaker, 0);
  noteTransport(breaker, 1_000);
  assert.equal(admission(breaker, 2_000, 4).allow, true);
  noteTransport(breaker, 2_000);
  assert.equal(admission(breaker, 3_000, 4).allow, false);
  assert.equal(admission(breaker, 62_000, 4).canary, true);
  assert.equal(admission(breaker, 62_000, 4).concurrency, 1);
  noteCanaryFinished(breaker);
  assert.equal(admission(breaker, 62_000, 4).concurrency, 4);
});

test('reports redact secrets, packages, reasoning, and tool arguments', () => {
  const record = toAttemptRecord({
    fixture: 'S02',
    category: 'simple',
    expected: 'plan',
    actual: 'fail',
    validation: ['model leaked sk-supersecretvalue'],
    failures: ['Bearer abcdefghijklmnop'],
    package: { id: 'pkg_secret' },
    args: { prompt: 'hidden prompt' },
    reasoning: 'chain of thought',
    usage: { input: 5, output: 6 },
    elapsedMs: 1500,
  });
  assertSanitized(record);
  assert.equal(record.usage.total, 11);
  assert.match(record.validation[0], /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(record), /supersecret|abcdefghijklmnop|hidden prompt|pkg_secret|chain of thought/);
  const events = resanitizeEvents([{
    type: 'tool_call',
    name: 'assets.generate_video',
    args: { secret: 'do-not-retain' },
    reasoning: 'hidden',
    durationMs: 20,
    usage: { input: 1, output: 2, total: 3 },
  }]);
  assert.deepEqual(events[0].args, undefined);
  assert.equal(events[0].name, 'assets.generate_video');
  assert.doesNotMatch(JSON.stringify(events), /do-not-retain|hidden/);
  const summary = summarize([record], {
    provider: PLANNING_PROVIDER,
    model: PLANNING_MODEL,
    variety: varietyCoverage(FIXTURES),
    concurrency: [{ concurrency: 2 }, { concurrency: 4 }],
  });
  assert.equal(summary.latencyMs.p50, 1500);
  assert.deepEqual(percentile([10, 20, 30, 40], 95), 40);
  const markdown = renderMarkdown(summary);
  assert.match(markdown, /simple/);
  assert.match(markdown, /opencode-go/);
  assert.match(markdown, /deepseek-v4.1-flash/);
  assert.doesNotMatch(markdown, /supersecret|hidden prompt/);
});

test('runner isolation refuses foreign hosts, production routes, and unrecorded signals', () => {
  assert.deepEqual(PORTS, [4521, 4522, 4523, 4524, 4525, 4526]);
  assert.doesNotThrow(() => assertLoopback('http://127.0.0.1:4521'));
  assert.throws(() => assertLoopback('http://127.0.0.1:4404'), /port/);
  assert.throws(() => assertLoopback('http://10.1.1.1:4521'), /loopback/);
  assert.doesNotThrow(() => assertAllowedRequest('POST', '/api/agent'));
  assert.doesNotThrow(() => assertAllowedRequest('PATCH', '/api/package/pkg_123'));
  assert.throws(() => assertAllowedRequest('POST', '/api/run'), /refusing/);
  assert.throws(() => assertAllowedRequest('POST', '/api/pipeline'), /refusing/);
  assert.throws(() => assertAllowedRequest('POST', '/api/brief'), /refusing/);
  assert.throws(() => assertStressPath('/tmp/opencode/other'), /stress workspace/);
  assert.equal(assertStressPath('/tmp/opencode/comfyrizz-planning-stress/results/run'), '/tmp/opencode/comfyrizz-planning-stress/results/run');
  const env = workerEnv({
    port: 4521,
    runtimeDir: '/tmp/opencode/comfyrizz-planning-stress/runtimes/unit/4521',
    token: 'local-server-token',
    baseEnv: {
      PATH: '/usr/bin',
      OPENCODE_GO_API_KEY: 'unit-key-value',
      OPENAI_API_KEY: 'other-provider',
      COMFYRIZZ_HF_TOKEN: 'hf-secret',
      COMFYRIZZ_TOKEN: 'stale-token',
    },
  });
  assert.equal(env.OPENCODE_GO_API_KEY, 'unit-key-value');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.COMFYRIZZ_HF_TOKEN, undefined);
  assert.equal(env.COMFYRIZZ_TOKEN, 'local-server-token');
  const published = publicWorkerConfig(env);
  assert.equal(published.providerKey, true);
  assert.doesNotMatch(JSON.stringify(published), /unit-key-value|local-server-token|hf-secret/);
  assert.equal(providerKeyPresent({}), false);
  assert.equal(providerKeyPresent({ OPENCODE_API_KEY: 'present' }), true);
  const signals = [];
  assert.deepEqual(stopWorkers([4321, 4322], (pid, signal) => signals.push([pid, signal])), [4321, 4322]);
  assert.deepEqual(signals, [[4321, 'SIGTERM'], [4322, 'SIGTERM']]);
  assert.throws(() => stopWorkers([-1], () => {}), /unrecorded/);
  assert.equal(fixtureHash(FIXTURES).length, 64);
});

test('report files stay sanitized and show blocked variety coverage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planning-stress-'));
  try {
    const records = FIXTURES.map(fixture => toAttemptRecord({
      fixture: fixture.id,
      category: fixture.category,
      expected: fixture.expect,
      actual: 'not_run',
      provider: PLANNING_PROVIDER,
      model: PLANNING_MODEL,
      motionModel: fixture.motionModel,
      reason: 'provider key missing',
    }));
    writeReports(dir, records, {
      runId: 'unit',
      status: 'blocked',
      provider: PLANNING_PROVIDER,
      model: PLANNING_MODEL,
      blocked: 'OPENCODE_GO_API_KEY and OPENCODE_API_KEY are unset',
      variety: varietyCoverage(FIXTURES),
      concurrency: [],
      invalidTools: 0,
      config: { provider: PLANNING_PROVIDER, model: PLANNING_MODEL, ports: PORTS, keyPresent: false },
      events: { 'S02-a1.json': [{ type: 'tool_call', name: 'storyboard.propose', args: { brief: 'secret brief' } }] },
    });
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    const markdown = readFileSync(join(dir, 'summary.md'), 'utf8');
    const jsonl = readFileSync(join(dir, 'results.jsonl'), 'utf8');
    const event = readFileSync(join(dir, 'events', 'S02-a1.json'), 'utf8');
    assert.equal(summary.status, 'blocked');
    assert.equal(summary.categories.simple.not_run, 4);
    assert.equal(summary.categories.failure.not_run, 6);
    assert.equal(summary.categories.narrated.fixtures, 4);
    assert.match(markdown, /route:auto/);
    assert.match(markdown, /music/);
    assert.doesNotMatch(`${jsonl}\n${event}\n${markdown}`, /secret brief|sk-/);
    assert.equal(jsonl.trim().split('\n').length, 36);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
