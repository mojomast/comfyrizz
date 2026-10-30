// SPW02: the last-frame extractor and keyframe reviewer bridge the chained-shot
// plan to ffmpeg and the Pi reviewer. Scripted fakes only: no real ffmpeg, no
// model, no network, no Google Colab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REF_VERDICT_SCHEMA } from '../../../../packages/schema/src/ref-review.mjs';
import { createRefWatchGate } from '../../src/run.mjs';
import { createKeyframeReviewer, createLastFrameExtractor } from '../../src/ref-watch/last-frame.mjs';

const LOCK = 'Mara has a narrow face, dark cropped hair, and a small scar on her left brow.';

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
    prompt: 'A medium shot of the hero in warm window light.',
    params: { prompt: 'A medium shot of the hero in warm window light.' },
    dims: { width: 1024, height: 576 },
    characters: [],
  };
}

function video(id, stillId, extra = {}) {
  return {
    id,
    kind: 'plate',
    batch: 'plates',
    outputKind: 'video',
    output: `assets/${id}.mp4`,
    generator: 'ltx25',
    workflow: 'workflows/ltx25_i2v_2stage.api.json',
    fileInputs: [{ param: 'image', from: 'job', job: stillId, path: `assets/${stillId}.png` }],
    characters: [{ characterId: 'hero', identityLock: LOCK }],
    ...extra,
  };
}

function preview(jobId, digest) {
  return {
    type: 'preview_ready',
    manifest: {
      jobs: [{
        job: jobId,
        status: 'succeeded',
        outputs: [{ relative: `assets/${jobId}.png`, sha256: digest, bytes: 128 }],
      }],
    },
  };
}

function passVerdict(request) {
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: request.jobId,
    keyframeSha256: request.keyframeSha256 ?? 'c'.repeat(64),
    reviewer: 'fake',
    overall: 'pass',
    checks: [{ dimension: 'identity', pass: true, severity: 'hard', evidence: 'same face' }],
    fixHints: [],
  };
}

test('SPW02: the extractor builds the exact ffmpeg argv and returns the png image', async () => {
  const calls = [];
  const outDir = join(tmpdir(), 'comfyrizz-chain-frames');
  const extractLastFrame = createLastFrameExtractor({
    runFfmpeg: async (args) => { calls.push(args); },
    outDir,
  });

  const image = await extractLastFrame({
    id: 'video_a',
    localPath: '/tmp/comfyrizz-run/out/video_a.mp4',
  });

  const expected = join(outDir, 'video_a.last.png');
  assert.deepEqual(calls, [[
    '-y',
    '-sseof', '-0.2',
    '-i', '/tmp/comfyrizz-run/out/video_a.mp4',
    '-frames:v', '1',
    '-update', '1',
    expected,
  ]]);
  assert.deepEqual(image, { path: expected, mediaType: 'image/png' });
});

test('SPW02: a missing localPath is refused before ffmpeg runs', async () => {
  const calls = [];
  const extractLastFrame = createLastFrameExtractor({
    runFfmpeg: async (args) => { calls.push(args); },
    outDir: join(tmpdir(), 'comfyrizz-chain-frames'),
  });

  for (const previousClip of [{ id: 'video_a' }, { id: 'video_a', localPath: '' }, { id: 'video_a', localPath: null }]) {
    await assert.rejects(extractLastFrame(previousClip), /localPath/);
  }
  assert.deepEqual(calls, []);
});

test('SPW02: an ffmpeg failure rejects instead of inventing an image', async () => {
  const extractLastFrame = createLastFrameExtractor({
    runFfmpeg: async () => { throw new Error('ffmpeg exited with code 1'); },
    outDir: join(tmpdir(), 'comfyrizz-chain-frames'),
  });

  await assert.rejects(
    extractLastFrame({ id: 'video_a', localPath: '/tmp/video_a.mp4' }),
    /ffmpeg exited with code 1/,
  );
});

test('SPW02: the keyframe reviewer forwards the image, characters, and identity dimensions', async () => {
  const requests = [];
  const verdict = passVerdict({ jobId: 'chain:frame', keyframeSha256: 'd'.repeat(64) });
  const reviewKeyframe = createKeyframeReviewer({
    reviewer: async (input) => {
      requests.push(input.request);
      return verdict;
    },
  });
  const image = { path: 'assets/video_a.last.png', mediaType: 'image/png' };
  const characters = [{ characterId: 'hero', identityLock: LOCK }];

  const result = await reviewKeyframe({
    kind: 'keyframe',
    image,
    characters,
    dimensions: ['identity'],
  });

  assert.equal(result, verdict);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    jobId: 'chain:assets/video_a.last.png',
    imagePath: image.path,
    kind: 'keyframe',
    characters,
    dimensions: ['identity'],
  });
});

test('SPW02: the run gate wires the default extractor and reviewer into a chained shot', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-spw02-'));
  try {
    const receiptsDir = join(runtimeDir, 'receipts');
    const clipPath = join(runtimeDir, 'out', 'video_a.mp4');
    const framePath = join(receiptsDir, 'chain-frames', 'video_a.last.png');
    const ffmpegCalls = [];
    const reviews = [];
    const submitted = [];
    const scene = 'scene_01';
    const jobs = [
      still('still_a'),
      video('video_a', 'still_a', {
        status: 'accepted',
        localPath: clipPath,
        shot: { sceneId: scene, index: 0 },
      }),
      still('still_b'),
      video('video_b', 'still_b', { shot: { sceneId: scene, index: 1 } }),
    ];
    const gateFor = createRefWatchGate({
      refWatch: {
        reviewer: async ({ request }) => {
          reviews.push(request);
          return passVerdict(request);
        },
        runFfmpeg: async (args) => { ffmpegCalls.push(args); },
      },
    });
    const gate = await gateFor({
      jobsDoc: { productionId: 'prod_spw02', runId: 'run_spw02', jobs },
      onEvent: () => {},
      submitJobs: async (payload) => { submitted.push(payload); },
      receiptsDir,
    });

    await gate.start();
    await gate.handle(preview('still_a', shaOf('spw02-a')));
    await gate.handle(preview('still_b', shaOf('spw02-b')));

    assert.deepEqual(ffmpegCalls, [[
      '-y',
      '-sseof', '-0.2',
      '-i', clipPath,
      '-frames:v', '1',
      '-update', '1',
      framePath,
    ]]);

    const chainReview = reviews.find((request) => String(request.jobId).startsWith('chain:'));
    assert.ok(chainReview, 'the chained frame reached the reviewer');
    assert.equal(chainReview.imagePath, framePath);
    assert.equal(chainReview.kind, 'keyframe');
    assert.deepEqual(chainReview.dimensions, ['identity']);
    assert.deepEqual(chainReview.characters, [{ characterId: 'hero', identityLock: LOCK }]);

    const videoB = submitted
      .filter((payload) => payload.batch === 'video')
      .flatMap((payload) => payload.jobs)
      .find((job) => job.id === 'video_b');
    assert.deepEqual(videoB.loadImage, { path: framePath, mediaType: 'image/png' });
    assert.deepEqual(videoB.imgToVideoInplace, { strength: 0.7, strength2: 0.7 });
    assert.equal(videoB.chainFallback, undefined);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
