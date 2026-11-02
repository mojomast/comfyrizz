// Goat live check 2026-11-02: one-pass still mode regen budget, pass-through, judge prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { REF_VERDICT_SCHEMA } from '../../../../packages/schema/src/ref-review.mjs';
import { TEXT_GUARD } from '../../../../packages/jobs/src/defaults.mjs';
import { createRefWatchController } from '../../src/ref-watch/controller.mjs';
import { judgePrompt } from '../../src/ref-watch/judge-prompt.mjs';

const PROMPT = `A wide shot of Nana on a ride-on mower in a sunflower field, ${TEXT_GUARD}`;
const DIMS = ['technical', 'identity', 'anatomy', 'framing', 'prompt', 'text_artifact'];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const still = (id) => ({ id, kind: 'still', batch: 'stills', outputKind: 'image', output: `assets/${id}.png`, shotId: id, scene: 's1', seed: 7, prompt: PROMPT, params: { prompt: PROMPT, seed: 7 }, dims: { width: 1024, height: 576 } });
const video = (id, dep, index) => ({ id, kind: 'plate', batch: 'plates', outputKind: 'video', output: `assets/${id}.mp4`, generator: 'ltx25', workflow: 'workflows/ltx25_i2v_2stage.api.json', params: { seed: 11 }, fileInputs: [{ param: 'image', from: 'job', job: dep, path: `assets/${dep}.png` }], shot: { sceneId: `x${index}`, index, cut: true } });
const preview = (id, text = id) => ({ type: 'preview_ready', manifest: { jobs: [{ job: id, status: 'succeeded', outputs: [{ relative: `assets/${id}.png`, sha256: sha(text), bytes: 64 }] }] } });
const verdict = (request, failing = null) => ({ schema: REF_VERDICT_SCHEMA, jobId: request.jobId, keyframeSha256: request.keyframeSha256, reviewer: 'fake', overall: failing ? 'fail' : 'pass', checks: DIMS.map((dimension) => ({ dimension, pass: dimension !== failing, severity: 'hard', evidence: `${dimension} evidence` })), fixHints: failing ? [`fix ${failing}`] : [] });

const N = 7;
function setup({ onePass, failing, refWatchPolicy, budget = 5 }) {
  const jobs = [];
  for (let i = 0; i < N; i += 1) jobs.push(still(`still_${i}`));
  for (let i = 0; i < N; i += 1) jobs.push(video(`video_${i}`, `still_${i}`, i));
  const submitted = []; const events = []; const requests = [];
  const controller = createRefWatchController({
    jobsDoc: { productionId: 'p', runId: 'r', jobs, ...(refWatchPolicy ? { refWatchPolicy } : {}) },
    submitJobs: async (payload) => { submitted.push(payload); }, onEvent: (event) => { events.push(event); },
    now: () => '2026-11-02T00:00:00.000Z', liveSession: true, regenBudgetUnits: budget, targetedEdits: false, onePass,
    reviewer: async ({ request }) => { requests.push(request); return verdict(request, failing(request.jobId)); },
  });
  return { controller, submitted, events, requests };
}
const regens = (submitted) => submitted.filter((entry) => entry.batch === 'regen').flatMap((entry) => entry.jobs.map((job) => job.id));
const videos = (submitted) => new Set(submitted.filter((entry) => entry.batch !== 'regen').flatMap((entry) => entry.jobs).filter((job) => job.kind === 'plate').map((job) => job.id));

async function runAll(ctx, rounds = 2) {
  await ctx.controller.start();
  for (let r = 0; r < rounds; r += 1) for (let i = 0; i < N; i += 1) await ctx.controller.handle(preview(`still_${i}`, `still_${i}-v${r}`));
}

test('the shared production cap (2 for 7 stills) is what held stills on the goat run; one-pass gives every still one regen', async () => {
  const failingIds = new Set(['still_0', 'still_1', 'still_2', 'still_3', 'still_4']);
  const legacy = setup({ onePass: false, failing: (id) => (failingIds.has(id) ? 'framing' : null) });
  await runAll(legacy);
  assert.equal(regens(legacy.submitted).length, 2);
  assert.ok(legacy.events.some((e) => e.decision?.reason === 'production regen cap exhausted'));

  const one = setup({ onePass: true, failing: (id) => (failingIds.has(id) ? 'framing' : null), refWatchPolicy: { passThroughHeld: false } });
  await runAll(one, 1);
  assert.deepEqual(regens(one.submitted).sort(), [...failingIds].sort(), 'each failing still gets exactly one regen');
  assert.equal(one.events.some((e) => e.decision?.reason === 'production regen cap exhausted'), false);
});

test('one-pass: a still that fails again after its regen goes to video with a warning, so every shot gets a clip', async () => {
  const ctx = setup({ onePass: true, failing: (id) => (id === 'still_2' ? 'text_artifact' : null) });
  await runAll(ctx);
  assert.deepEqual(regens(ctx.submitted), ['still_2']);
  const warn = ctx.events.filter((e) => e.type === 'ref_pass_through');
  assert.equal(warn.length, 1);
  assert.equal(warn[0].jobId, 'still_2');
  assert.equal(warn[0].warning, true);
  assert.deepEqual(warn[0].failed, ['text_artifact']);
  assert.equal(videos(ctx.submitted).size, N);
  assert.deepEqual(ctx.controller.snapshot().passThroughs.map((p) => p.jobId), ['still_2']);
});

for (const dim of ['identity', 'anatomy', 'technical']) {
  test(`one-pass: a hard ${dim} failure still blocks its clip unless the package opts in`, async () => {
    const ctx = setup({ onePass: true, failing: (id) => (id === 'still_2' ? dim : null) });
    await runAll(ctx);
    assert.equal(ctx.events.some((e) => e.type === 'ref_pass_through'), false);
    assert.equal(videos(ctx.submitted).has('video_2'), false);
    assert.equal(videos(ctx.submitted).size, N - 1);
    const optIn = setup({ onePass: true, failing: (id) => (id === 'still_2' ? dim : null), refWatchPolicy: { passThroughHardFailures: true } });
    await runAll(optIn);
    assert.equal(videos(optIn.submitted).size, N);
  });
}

test('pass-through is a per-package switch and is off outside one-pass mode', async () => {
  const off = setup({ onePass: true, failing: (id) => (id === 'still_2' ? 'text_artifact' : null), refWatchPolicy: { passThroughHeld: false } });
  await runAll(off);
  assert.equal(videos(off.submitted).has('video_2'), false);
  const legacy = setup({ onePass: false, failing: (id) => (id === 'still_2' ? 'text_artifact' : null) });
  await runAll(legacy, 3);
  assert.equal(legacy.events.some((e) => e.type === 'ref_pass_through'), false);
});

test('a regen the CU allowance cannot afford is not run; the still passes through instead of dropping its clip', async () => {
  const ctx = setup({ onePass: true, budget: 0, failing: (id) => (id === 'still_2' ? 'text_artifact' : null) });
  await runAll(ctx, 1);
  assert.deepEqual(regens(ctx.submitted), []);
  assert.equal(videos(ctx.submitted).size, N);
});

test('the judge reads the shot prompt without the text guard or the start-frame instruction', async () => {
  const ctx = setup({ onePass: true, failing: () => null });
  await runAll(ctx, 1);
  assert.ok(ctx.requests.length > 0);
  for (const r of ctx.requests) assert.equal(r.prompt, 'A wide shot of Nana on a ride-on mower in a sunflower field');
  assert.equal(judgePrompt(`Use the provided start image as the first frame. The mower splashes into the pond. Tracking shot, no cuts., ${TEXT_GUARD}`), 'The mower splashes into the pond. Tracking shot, no cuts.');
  assert.equal(judgePrompt('A plain grey studio background, a red cube.'), 'A plain grey studio background, a red cube.', 'a real background request is kept');
});
