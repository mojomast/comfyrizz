// judge-loop v2: fix verification, scene continuity, clip review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { REF_VERDICT_SCHEMA } from '../../../../packages/schema/src/ref-review.mjs';
import { createRefWatchController } from '../../src/ref-watch/controller.mjs';

const PROMPT = 'A medium shot of the character standing in warm window light, blue coat buttoned, hands relaxed, face three quarters toward the lens.';
const DIMS = ['technical', 'identity', 'anatomy', 'framing', 'prompt', 'text_artifact'];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const still = (id, scene = 's1') => ({ id, kind: 'still', batch: 'stills', outputKind: 'image', output: `assets/${id}.png`, shotId: id, scene, seed: 7, prompt: PROMPT, params: { prompt: PROMPT, seed: 7 }, dims: { width: 1024, height: 576 } });
const video = (id, dep, index) => ({ id, kind: 'plate', batch: 'plates', outputKind: 'video', output: `assets/${id}.mp4`, generator: 'ltx25', workflow: 'workflows/ltx25_i2v_2stage.api.json', params: { seed: 11 }, fileInputs: [{ param: 'image', from: 'job', job: dep, path: `assets/${dep}.png` }], shot: { sceneId: `x${index}`, index } });
const preview = (id, text = id) => ({ type: 'preview_ready', manifest: { jobs: [{ job: id, status: 'succeeded', outputs: [{ relative: `assets/${id}.png`, sha256: sha(text), bytes: 64 }] }] } });
const verdict = (request, failing = null) => ({ schema: REF_VERDICT_SCHEMA, jobId: request.jobId, keyframeSha256: request.keyframeSha256, reviewer: 'fake', overall: failing ? 'fail' : 'pass', checks: DIMS.map((dimension) => ({ dimension, pass: dimension !== failing, severity: 'hard', evidence: `${dimension} evidence` })), fixHints: failing ? [`fix ${failing}`] : [] });

function setup(options) {
  const jobs = [still('still_a'), still('still_b'), video('video_a', 'still_a', 0), video('video_b', 'still_b', 1)];
  const submitted = []; const events = [];
  const controller = createRefWatchController({ jobsDoc: { productionId: 'p', runId: 'r', jobs }, submitJobs: async (payload) => { submitted.push(payload); }, onEvent: (event) => { events.push(event); }, now: () => '2026-11-02T00:00:00.000Z', liveSession: true, regenBudgetUnits: 1, targetedEdits: false, ...options });
  return { controller, submitted, events };
}

test('a fix is re-reviewed with the previous hard failures attached', async () => {
  const requests = [];
  const { controller } = setup({ reviewer: async ({ request }) => { requests.push(request); return verdict(request, requests.length === 1 ? 'anatomy' : null); } });
  await controller.start();
  await controller.handle(preview('still_a'));
  await controller.handle(preview('still_a', 'still_a-v2'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].priorFailures, undefined);
  assert.deepEqual(requests[1].priorFailures, [{ dimension: 'anatomy', evidence: 'anatomy evidence' }]);
});

test('a still that breaks scene continuity gets one regen; the regen is not scene-checked again', async () => {
  const calls = [];
  const { controller, submitted, events } = setup({
    reviewer: async ({ request }) => verdict(request),
    sceneReviewer: async (input) => { calls.push(input); return { consistent: false, checks: [{ dimension: 'wardrobe', pass: false, severity: 'hard', evidence: 'coat is red, anchors show blue' }], fixHints: ['blue coat as in the earlier shots'] }; },
  });
  await controller.start();
  await controller.handle(preview('still_a'));
  assert.equal(calls.length, 0, 'the first accepted still has no anchors');
  await controller.handle(preview('still_b'));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].anchors.map((a) => a.jobId), ['still_a']);
  assert.ok(submitted.some((entry) => entry.batch === 'regen' && entry.jobs[0].id === 'still_b'));
  await controller.handle(preview('still_b', 'still_b-v2'));
  assert.equal(calls.length, 1);
  assert.ok(events.some((event) => event.type === 'ref_gate_open' && event.jobId === 'still_b'));
});

test('an unreadable scene review never holds a still', async () => {
  const { controller, events } = setup({ reviewer: async ({ request }) => verdict(request), sceneReviewer: async () => null });
  await controller.start();
  await controller.handle(preview('still_a'));
  await controller.handle(preview('still_b'));
  assert.ok(events.some((event) => event.type === 'ref_gate_open' && event.jobId === 'still_b'));
});

test('a clip with a hard morphing failure is re-rendered once with a new seed and cache key', async () => {
  let clipCalls = 0;
  const { controller, submitted, events } = setup({
    reviewer: async ({ request }) => verdict(request),
    clipReviewer: async ({ request }) => { clipCalls += 1; return verdict({ ...request, keyframeSha256: 'a'.repeat(64) }, 'anatomy'); },
    sampleClipFrames: async () => ({ path: '/tmp/grid.png', sha256: 'b'.repeat(64) }),
  });
  await controller.start();
  await controller.handle(preview('still_a'));
  const first = submitted.flatMap((entry) => entry.jobs).find((job) => job.id === 'video_a');
  await controller.handle({ type: 'video_collected', jobId: 'video_a', path: '/tmp/video_a.mp4' });
  const retry = submitted.filter((entry) => entry.batch === 'video').flatMap((entry) => entry.jobs).filter((job) => job.id === 'video_a').at(-1);
  assert.equal(retry.clipRetry, 1);
  assert.notEqual(retry.params.seed, first.params.seed);
  assert.notEqual(retry.cacheKey, first.cacheKey);
  await controller.handle({ type: 'video_collected', jobId: 'video_a', path: '/tmp/video_a.mp4' });
  assert.equal(clipCalls, 2);
  const verdicts = events.filter((event) => event.type === 'ref_clip_verdict');
  assert.deepEqual(verdicts.map((event) => event.retry), [true, false]);
});

function framingSetup(refWatchPolicy) {
  const jobs = [still('still_a'), video('video_a', 'still_a', 0)];
  const submitted = []; const events = [];
  const controller = createRefWatchController({ jobsDoc: { productionId: 'p', runId: 'r', jobs, ...(refWatchPolicy ? { refWatchPolicy } : {}) }, submitJobs: async (payload) => { submitted.push(payload); }, onEvent: (event) => { events.push(event); }, now: () => '2026-11-02T00:00:00.000Z', liveSession: true, regenBudgetUnits: 5, targetedEdits: false, reviewer: async ({ request }) => verdict(request, 'framing') });
  return { controller, submitted, events };
}

test('framing give-up is off by default: a framing-only still is regenerated, never accepted with a note', async () => {
  const { controller, events } = framingSetup(null);
  await controller.start();
  await controller.handle(preview('still_a'));
  await controller.handle(preview('still_a', 'v2'));
  assert.equal(events.some((event) => event.type === 'ref_framing_drift'), false);
  assert.equal(events.some((event) => event.type === 'ref_gate_open' && event.jobId === 'still_a'), false);
  assert.equal(controller.snapshot().framingGiveUp, false);
  assert.deepEqual(controller.snapshot().framingDrift, []);
});

test('package opt-in: one framing regen, then accepted with a framing-drift note in the run report', async () => {
  const { controller, submitted, events } = framingSetup({ framingGiveUp: true });
  await controller.start();
  await controller.handle(preview('still_a'));
  assert.equal(submitted.filter((entry) => entry.batch === 'regen').length, 1);
  await controller.handle(preview('still_a', 'v2'));
  assert.ok(events.some((event) => event.type === 'ref_framing_drift' && event.jobId === 'still_a'), JSON.stringify(events.map((e) => [e.type, e.decision?.action, e.decision?.reason, e.decision?.attempt])));
  assert.ok(events.some((event) => event.type === 'ref_gate_open' && event.jobId === 'still_a'));
  const snap = controller.snapshot();
  assert.equal(snap.framingGiveUp, true);
  assert.equal(snap.framingDrift.length, 1);
  assert.equal(snap.framingDrift[0].jobId, 'still_a');
});
