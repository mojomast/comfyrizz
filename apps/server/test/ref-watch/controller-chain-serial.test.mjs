// SPW03: chained videos are serialized. A same-scene chained shot waits until the
// previous LTX clip has been collected, then is submitted alone so chain.mjs sees
// an accepted previousClip. Scripted fakes only: no network, no Comfy, no Google Colab.
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

test('SPW03: chained same-scene shots wait for video_collected and submit one at a time', async () => {
  const jobs = [
    still('still_a'),
    still('still_b'),
    still('still_c'),
    still('still_cross'),
    video('video_a', ['still_a'], { sceneId: SCENE, index: 0 }),
    video('video_b', ['still_b'], { sceneId: SCENE, index: 1 }),
    video('video_c', ['still_c'], { sceneId: SCENE, index: 2 }),
    video('video_cross', ['still_a', 'still_cross'], { sceneId: 'scene_02', index: 3 }),
  ];
  const submitted = [];
  const events = [];
  const extracted = [];
  const reviewed = [];

  const controller = createRefWatchController({
    jobsDoc: { productionId: 'prod_chain_serial', runId: 'run_chain_serial', jobs },
    reviewer: async ({ request }) => passVerdict(request),
    submitJobs: async (payload) => { submitted.push(payload); },
    onEvent: (event) => { events.push(event); },
    now: () => '2026-10-30T00:00:00.000Z',
    extractLastFrame: async (clip) => {
      extracted.push(structuredClone(clip));
      return `assets/${clip.id}-last.png`;
    },
    reviewKeyframe: async (input) => {
      reviewed.push(input);
      return { overall: 'pass', checks: [{ dimension: 'identity', pass: true, severity: 'hard', evidence: 'same person' }] };
    },
  });

  const videoBatches = () => submitted.filter((entry) => entry.batch === 'video');
  const videoIds = () => videoBatches().flatMap((entry) => entry.jobs.map((job) => job.id));

  await controller.start();

  await controller.handle(preview('still_cross', 'still-cross'));
  await controller.handle(preview('still_a', 'still-a'));

  assert.equal(videoBatches().length, 1, 'shot 0 and the cross-scene shot release together');
  assert.deepEqual(videoBatches()[0].jobs.map((job) => job.id), ['video_a', 'video_cross']);
  assert.equal(videoIds().includes('video_b'), false, 'shot 1 does not run before its previous clip exists');
  assert.equal(videoIds().includes('video_c'), false, 'shot 2 does not run before shot 1 exists');

  await controller.handle(preview('still_b', 'still-b'));
  await controller.handle(preview('still_c', 'still-c'));

  assert.equal(videoBatches().length, 1, 'chained shots stay deferred while their previous clip is missing');
  const waiting = controller.beforeRender();
  assert.equal(waiting.ok, false, 'beforeRender holds while a chained video is deferred');
  assert.ok(waiting.held.includes('video_b'));
  assert.ok(waiting.held.includes('video_c'));

  await controller.handle({ type: 'video_collected', jobId: 'video_a', path: 'assets/video_a.mp4' });

  assert.equal(videoBatches().length, 2, 'collecting shot 0 releases shot 1');
  assert.deepEqual(videoBatches()[1].jobs.map((job) => job.id), ['video_b'], 'a deferred chained shot submits alone');
  const shotB = videoBatches()[1].jobs[0];
  assert.equal(shotB.chainFromPrevious, true);
  assert.equal(shotB.loadImage, 'assets/video_a-last.png');
  assert.deepEqual(shotB.imgToVideoInplace, { strength: 0.7, strength2: 0.7 });
  assert.equal(extracted.length, 1, 'shot 1 chained from exactly one collected clip');
  assert.equal(extracted[0].id, 'video_a');
  assert.equal(extracted[0].status, 'accepted');
  assert.equal(extracted[0].localPath, 'assets/video_a.mp4');
  assert.equal(videoIds().includes('video_c'), false, 'shot 2 still waits for shot 1');
  assert.equal(controller.beforeRender().ok, false);
  assert.ok(controller.beforeRender().held.includes('video_c'));
  assert.equal(controller.beforeRender().held.includes('video_b'), false);

  await controller.handle({ type: 'video_collected', jobId: 'video_b', path: 'assets/video_b.mp4' });

  assert.equal(videoBatches().length, 3, 'collecting shot 1 releases shot 2');
  assert.deepEqual(videoBatches()[2].jobs.map((job) => job.id), ['video_c'], 'shot 2 submits alone');
  const shotC = videoBatches()[2].jobs[0];
  assert.equal(shotC.chainFromPrevious, true);
  assert.equal(shotC.loadImage, 'assets/video_b-last.png');
  assert.deepEqual(shotC.imgToVideoInplace, { strength: 0.7, strength2: 0.7 });
  assert.equal(extracted.length, 2);
  assert.equal(extracted[1].id, 'video_b');
  assert.equal(extracted[1].status, 'accepted');
  assert.equal(extracted[1].localPath, 'assets/video_b.mp4');
  assert.equal(reviewed.length, 2, 'each chained frame gets the identity review');
  assert.deepEqual(reviewed.map((input) => input.image), ['assets/video_a-last.png', 'assets/video_b-last.png']);
  assert.equal(controller.beforeRender().ok, true, 'all videos released once every collection arrived');

  const chainEvents = events.filter((event) => event.type === 'ref_chain_planned');
  for (const event of chainEvents) {
    assert.equal(typeof event.jobId, 'string');
    assert.equal(typeof event.chained, 'boolean');
    assert.ok(event.fallback === null || typeof event.fallback === 'string');
    assert.equal(typeof event.reason, 'string');
  }
  const finalChain = (jobId) => chainEvents.filter((event) => event.jobId === jobId).at(-1);
  assert.equal(finalChain('video_b').chained, true);
  assert.equal(finalChain('video_b').fallback, null);
  assert.equal(finalChain('video_c').chained, true);
  assert.equal(finalChain('video_c').fallback, null);
  assert.equal(finalChain('video_cross').chained, false, 'a cross-scene shot is not chained');
});
