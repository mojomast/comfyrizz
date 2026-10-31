// Google Colab e2e 2026-10-30: a held still skips its shot; regens fit a small live-session allowance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { REF_VERDICT_SCHEMA } from '../../../../packages/schema/src/ref-review.mjs';
import { createRefWatchController } from '../../src/ref-watch/controller.mjs';

const PROMPT = 'A medium shot of the character standing in warm window light, blue coat buttoned, hands relaxed, face three quarters toward the lens.';
const LOCK = 'Mara has a narrow face, dark cropped hair, and a small scar on her left brow.';
const SCENE = 'scene_01';
const PASS_CHECKS = ['technical', 'identity', 'anatomy', 'framing', 'prompt', 'text_artifact'].map((dimension) => ({
  dimension, pass: true, severity: 'hard', evidence: `${dimension} matches the still`,
}));

function shaOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

function still(id) {
  return {
    id,
    kind: 'still',
    batch: 'stills',
    outputKind: 'image',
    output: `assets/${id}.png`,
    shotId: id,
    seed: 1000,
    prompt: PROMPT,
    params: { prompt: PROMPT, seed: 1000 },
    fileInputs: [{ param: 'reference', from: 'package', path: 'assets/ref.png' }],
    dims: { width: 1024, height: 576 },
    characters: [{ characterId: 'hero', identityLock: LOCK }],
  };
}

function video(id, deps, shot) {
  return {
    id,
    kind: 'plate',
    batch: 'plates',
    outputKind: 'video',
    output: `assets/${id}.mp4`,
    generator: 'ltx25',
    workflow: 'workflows/ltx25_i2v_2stage.api.json',
    fileInputs: deps.map((dep, index) => ({
      param: index === 0 ? 'image' : `image_${index + 1}`,
      from: 'job',
      job: dep,
      path: `assets/${dep}.png`,
    })),
    characters: [{ characterId: 'hero', identityLock: LOCK }],
    shot,
  };
}

function preview(jobId, text) {
  return {
    type: 'preview_ready',
    manifest: {
      jobs: [{
        job: jobId,
        status: 'succeeded',
        outputs: [{ relative: `assets/${jobId}.png`, sha256: shaOf(text), bytes: 128 }],
      }],
    },
  };
}

function passVerdict(request) {
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: request.jobId,
    keyframeSha256: request.keyframeSha256,
    reviewer: 'fake',
    overall: 'pass',
    checks: PASS_CHECKS,
    fixHints: [],
  };
}

function failVerdict(request) {
  return {
    ...passVerdict(request),
    overall: 'fail',
    checks: PASS_CHECKS.map((check) => check.dimension === 'text_artifact'
      ? { ...check, pass: false, evidence: 'a plaque on the wall shows illegible lettering' }
      : check),
    fixHints: ['remove the lettering on the wall plaque'],
  };
}

function setup({ failing, ...options }) {
  const jobs = [
    still('still_a'), still('still_b'), still('still_c'),
    video('video_a', ['still_a'], { sceneId: SCENE, index: 0 }),
    video('video_b', ['still_b'], { sceneId: SCENE, index: 1 }),
    video('video_c', ['still_c'], { sceneId: SCENE, index: 2 }),
  ];
  const submitted = [];
  const events = [];
  const controller = createRefWatchController({
    jobsDoc: { productionId: 'prod_skip', runId: 'run_skip', jobs },
    reviewer: async ({ request }) => (request.jobId === failing ? failVerdict(request) : passVerdict(request)),
    submitJobs: async (payload) => { submitted.push(payload); },
    onEvent: (event) => { events.push(event); },
    now: () => '2026-10-30T00:00:00.000Z',
    extractLastFrame: async (clip) => `assets/${clip.id}-last.png`,
    reviewKeyframe: async () => ({ overall: 'pass', checks: [{ dimension: 'identity', pass: true, severity: 'hard', evidence: 'same person' }] }),
    ...options,
  });
  return { controller, submitted, events };
}

test('a held still skips its own shot and the next chained shot renders from its keyframe', async () => {
  const { controller, submitted, events } = setup({ failing: 'still_b', liveSession: true, regenBudgetUnits: 0 });
  await controller.start();
  for (const id of ['still_a', 'still_b', 'still_c']) await controller.handle(preview(id, id));
  assert.ok(events.some((event) => event.type === 'ref_gate_held' && event.jobId === 'video_b' && event.state === 'skipped'));
  await controller.handle({ type: 'video_collected', jobId: 'video_a', path: 'assets/video_a.mp4' });
  const videos = submitted.filter((entry) => entry.batch === 'video').flatMap((entry) => entry.jobs);
  assert.deepEqual(videos.map((job) => job.id), ['video_a', 'video_c']);
  const shotC = videos.find((job) => job.id === 'video_c');
  assert.equal(shotC.chainFallback, 'keyframe');
  assert.equal(shotC.chainFallbackReason, 'the previous shot was skipped');
  assert.equal(controller.beforeRender().ok, true, 'nothing waits on the skipped shot');
});

test('a flagged still regenerates inside a small live-session allowance instead of escalating', async () => {
  const { controller, submitted, events } = setup({ failing: 'still_b', liveSession: true, regenBudgetUnits: 0.6 });
  await controller.start();
  await controller.handle(preview('still_b', 'still_b'));
  const estimate = events.find((event) => event.type === 'ref_regen_estimate');
  assert.ok(estimate.estimate.units.high < 0.6, JSON.stringify(estimate.estimate.units));
  assert.equal(estimate.estimate.blocked, false);
  assert.equal(events.some((event) => event.type === 'ref_review_verdict' && event.decision?.action === 'escalate'), false);
  assert.ok(events.some((event) => event.type === 'ref_regen_queued' && event.jobId === 'still_b'));
  const regen = submitted.find((entry) => entry.batch === 'regen');
  assert.equal(regen.jobs[0].generator, 'qwen-edit-2511', 'the text artifact is fixed with a targeted edit');
});
