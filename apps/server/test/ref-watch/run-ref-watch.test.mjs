import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REF_VERDICT_SCHEMA } from '../../../../packages/schema/src/ref-review.mjs';
import { createRunController } from '../../src/run.mjs';
import { createPiRefReviewer } from '../../src/ref-watch/pi-reviewer.mjs';

const SHA = 'a'.repeat(64);
const IMAGE = Object.freeze({ path: 'assets/still_a.png', mediaType: 'image/png' });

function shaOf(value) {
  return createHash('sha256').update(value).digest('hex');
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

function video(id, stillId) {
  return {
    id,
    kind: 'plate',
    batch: 'plates',
    outputKind: 'video',
    output: `assets/${id}.mp4`,
    fileInputs: [{ param: 'image', from: 'job', job: stillId, path: `assets/${stillId}.png` }],
  };
}

function preview(jobId, digest) {
  return {
    type: 'preview_ready',
    manifest: {
      jobs: [{ job: jobId, status: 'succeeded', outputs: [{ relative: `assets/${jobId}.png`, sha256: digest, bytes: 16 }] }],
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
    checks: [{ dimension: 'framing', pass: true, severity: 'soft', evidence: 'the frame holds the subject' }],
    fixHints: [],
  };
}

function fakeBackendFactory(seen, jobs) {
  return async (backendId, opts = {}) => {
    seen.push(opts);
    return {
      id: backendId,
      async describe() {
        return { label: 'Fake backend', costVisibility: 'external-unknown' };
      },
      async runPackage() {
        return {
          jobsDoc: { productionId: 'prod_ref_watch', runId: 'run_ref_watch', jobs },
          estimate: { gpuMinutes: 0, overheadMinutes: 0 },
        };
      },
      async teardown() {
        return { state: 'stopped' };
      },
    };
  };
}

async function gateFor(runtimeDir, jobs, refWatch, env = {}) {
  const seen = [];
  const controller = createRunController({
    runtimeDir,
    backendFactory: fakeBackendFactory(seen, jobs),
    refWatch,
    refWatchEnv: env,
  });
  await controller.estimate({ backendId: 'byo-comfyui', pkg: { id: 'pkg_ref_watch' } });
  return { opts: seen[0], controller };
}

test('reference watch is off by default and passes a null gate to the backend', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-run-off-'));
  try {
    const jobs = [still('still_a'), video('video_a', 'still_a')];
    const { opts } = await gateFor(runtimeDir, jobs, false);
    assert.equal(opts.refWatch, null);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('the REF_WATCH env setting turns the gate on with the Pi adapter', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-run-env-'));
  try {
    const jobs = [still('still_a'), video('video_a', 'still_a')];
    const { opts } = await gateFor(runtimeDir, jobs, false, { REF_WATCH: 'true' });
    assert.equal(typeof opts.refWatch, 'function');
    assert.equal(typeof opts.refWatch.reviewer, 'function');
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('a scripted reviewer is called for a keyframe still and the verdict opens the gate', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-run-on-'));
  try {
    const jobs = [still('still_a'), video('video_a', 'still_a')];
    const calls = [];
    const submitted = [];
    const events = [];
    const reviewer = async ({ request }) => {
      calls.push(request);
      return passVerdict(request);
    };
    const { opts } = await gateFor(runtimeDir, jobs, { reviewer });
    const gate = await opts.refWatch({
      jobsDoc: { productionId: 'prod_ref_watch', runId: 'run_ref_watch', jobs },
      onEvent: (event) => events.push(event),
      submitJobs: async (payload) => submitted.push(payload),
      receiptsDir: null,
    });
    await gate.start();
    await gate.handle(preview('still_a', shaOf('still-a')));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].jobId, 'still_a');
    assert.equal(calls[0].keyframeSha256, shaOf('still-a'));
    assert.equal(events.some((event) => event.type === 'ref_review_verdict'
      && event.jobId === 'still_a'
      && event.verdict?.reviewer === 'fake'), true);
    assert.equal(events.some((event) => event.type === 'ref_gate_open' && event.jobId === 'still_a'), true);
    assert.equal(submitted.some((payload) => payload.batch === 'video'), true);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('the Pi adapter loads the image and forwards the review request and signal', async () => {
  const request = {
    schema: 'comfyrizz.ref-review.request/v1',
    productionId: 'prod_ref_watch',
    runId: 'run_ref_watch',
    jobId: 'still_a',
    shotId: 'still_a',
    keyframeSha256: SHA,
    imagePath: IMAGE.path,
    width: 1024,
    height: 576,
    plannedWidth: 1024,
    plannedHeight: 576,
    prompt: 'A medium shot of the hero in warm window light.',
    attempt: 0,
    characters: [],
  };
  const loaded = [];
  const reviewed = [];
  const model = async () => JSON.stringify(passVerdict(request));
  const adapter = createPiRefReviewer({
    reviewStill: async (input) => {
      reviewed.push(input);
      return passVerdict(input.request);
    },
    model,
    loadImage: async (imagePath) => {
      loaded.push(imagePath);
      return IMAGE;
    },
  });
  const abort = new AbortController();
  const verdict = await adapter(request, { signal: abort.signal });

  assert.equal(verdict.overall, 'pass');
  assert.deepEqual(loaded, [IMAGE.path]);
  assert.equal(reviewed.length, 1);
  assert.deepEqual(reviewed[0].request, request);
  assert.deepEqual(reviewed[0].image, IMAGE);
  assert.equal(reviewed[0].model, model);
  assert.equal(reviewed[0].signal, abort.signal);
});

test('a throwing reviewer becomes an error verdict and holds the gate', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-run-throw-'));
  try {
    const jobs = [still('still_a'), video('video_a', 'still_a')];
    const submitted = [];
    const events = [];
    const reviewer = createPiRefReviewer({
      reviewStill: async () => {
        throw new Error('Pi review failed');
      },
      model: async () => '',
      loadImage: async () => IMAGE,
    });
    const failed = await reviewer({
      jobId: 'still_a',
      keyframeSha256: shaOf('still-a'),
      imagePath: 'assets/still_a.png',
    }, { signal: new AbortController().signal });
    assert.equal(failed.overall, 'error');
    assert.equal(failed.reviewer, 'pi');
    const { opts } = await gateFor(runtimeDir, jobs, { reviewer });
    const gate = await opts.refWatch({
      jobsDoc: { productionId: 'prod_ref_watch', runId: 'run_ref_watch', jobs },
      onEvent: (event) => events.push(event),
      submitJobs: async (payload) => submitted.push(payload),
      receiptsDir: null,
    });
    await gate.start();
    await gate.handle(preview('still_a', shaOf('still-a')));

    const error = events.find((event) => event.type === 'ref_review_error');
    assert.equal(error?.verdict?.overall ?? 'error', 'error');
    assert.equal(events.some((event) => event.type === 'ref_gate_held' && event.jobId === 'still_a'), true);
    assert.equal(events.some((event) => event.type === 'ref_gate_open' && event.jobId === 'still_a'), false);
    assert.equal(submitted.some((payload) => payload.batch === 'video'), false);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
