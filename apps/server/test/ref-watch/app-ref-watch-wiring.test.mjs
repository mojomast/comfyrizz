import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REF_DECISION_SCHEMA, REF_VERDICT_SCHEMA } from '../../../../packages/schema/src/ref-review.mjs';
import { createApp } from '../../src/app.mjs';

const TOKEN = 'ref-watch-wiring-token';
const PRODUCTION = 'prod_ref_watch';
const KEYFRAME = 'still_a';
const STILL_SHA = createHash('sha256').update('still-a').digest('hex');
const OTHER_SHA = createHash('sha256').update('other-still').digest('hex');

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

function fakeBackend(id, runPackage) {
  return {
    id,
    async describe() {
      return { label: 'Fake backend', costVisibility: 'external-unknown' };
    },
    runPackage,
    async teardown() {
      return { state: 'stopped' };
    },
  };
}

async function listen(t, app) {
  const server = createServer(app.handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function getJson(origin, path) {
  return fetch(`${origin}${path}`, { headers: { 'x-comfyrizz-token': TOKEN } });
}

function sseFrame(origin, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${origin}${path}`);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('SSE frame timed out'));
    }, 3000);
    fetch(url, { headers: { 'x-comfyrizz-token': TOKEN }, signal: controller.signal })
      .then(async response => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        while (!text.includes('\n\n')) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        clearTimeout(timer);
        controller.abort();
        resolve({ status: response.status, text });
      })
      .catch(error => {
        clearTimeout(timer);
        if (error.name === 'AbortError') return;
        reject(error);
      });
  });
}

function writeEvidence(runtimeDir, { productionId, keyframeId, stillSha }) {
  const dir = join(runtimeDir, 'runs', 'run_ref_watch_evidence', 'receipts', 'ref-review');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(runtimeDir, 'runs', 'run_ref_watch_evidence'), { recursive: true });
  writeFileSync(join(runtimeDir, 'runs', 'run_ref_watch_evidence', 'state.json'), JSON.stringify({ productionId }));
  writeFileSync(join(dir, `${stillSha}.json`), JSON.stringify({
    schema: 'comfyrizz.ref-review.evidence/v1',
    keyframeSha256: stillSha,
    imageSha256: stillSha,
    verdicts: [passVerdict({ jobId: keyframeId, keyframeSha256: stillSha })],
    decision: {
      schema: REF_DECISION_SCHEMA,
      jobId: keyframeId,
      keyframeSha256: stillSha,
      action: 'escalate',
      reason: 'reviewer needs an owner decision',
      attempt: 0,
    },
  }));
}

test('reference watch is off by default: no ref events, empty list and unchanged run options', async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-app-off-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const seen = [];
  const jobs = [still(KEYFRAME), video('video_a', KEYFRAME)];
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    backendFactory: async (id, options = {}) => {
      seen.push(options);
      return fakeBackend(id, async () => ({
        jobsDoc: { productionId: PRODUCTION, runId: 'run_off', jobs },
        estimate: { gpuMinutes: 0, overheadMinutes: 0 },
      }));
    },
  });
  await app.runs.estimate({ backendId: 'byo-comfyui', pkg: { id: 'pkg_ref_watch_off' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].refWatch, null);

  const { origin } = await listen(t, app);
  const response = await getJson(origin, `/api/productions/${PRODUCTION}/ref-review`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { productionId: PRODUCTION, keyframes: [] });
});

test('one app-owned bus carries a controller verdict to the list route and SSE', async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-app-on-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const reviewerCalls = [];
  const seen = [];
  const jobs = [still(KEYFRAME), video('video_a', KEYFRAME)];
  const jobsDoc = { productionId: PRODUCTION, runId: 'run_on', jobs };
  const reviewer = async ({ request }) => {
    reviewerCalls.push(request);
    return passVerdict(request);
  };
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    refWatch: { reviewer },
    backendFactory: async (id, options = {}) => {
      seen.push(options);
      return fakeBackend(id, async (pkg, runOptions = {}) => {
        const gate = await options.refWatch({
          jobsDoc,
          onEvent: runOptions.onEvent ?? (() => {}),
          submitJobs: async () => {},
          receiptsDir: join(runtimeDir, 'runs', 'run_on', 'receipts'),
        });
        await gate.start();
        await gate.handle(preview(KEYFRAME, STILL_SHA));
        return { jobsDoc, estimate: { gpuMinutes: 0, overheadMinutes: 0 } };
      });
    },
  });
  await app.runs.estimate({ backendId: 'byo-comfyui', pkg: { id: 'pkg_ref_watch_on' } });

  assert.equal(typeof seen[0].refWatch, 'function');
  assert.equal(seen[0].refWatch.reviewer, reviewer);
  assert.equal(reviewerCalls.length, 1);

  const { origin } = await listen(t, app);
  const list = await getJson(origin, `/api/productions/${PRODUCTION}/ref-review`);
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.keyframes.length, 1);
  assert.equal(body.keyframes[0].keyframeId, KEYFRAME);
  assert.equal(body.keyframes[0].state, 'accepted');
  assert.equal(body.keyframes[0].verdict.overall, 'pass');
  assert.equal(body.keyframes[0].lastEvent, 'ref_gate_open');

  const stream = await sseFrame(origin, `/api/productions/${PRODUCTION}/ref-review/events`);
  assert.equal(stream.status, 200);
  assert.equal(stream.text.includes('event: ref_review_verdict'), true);
});

test('override with a stale still sha returns 409 REF_REVIEW_STALE through the mounted app', async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ref-watch-app-override-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  writeEvidence(runtimeDir, { productionId: PRODUCTION, keyframeId: KEYFRAME, stillSha: STILL_SHA });
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    backendFactory: async (id) => fakeBackend(id, async () => ({})),
  });
  const { origin } = await listen(t, app);
  const response = await fetch(`${origin}/api/productions/${PRODUCTION}/ref-review/override`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-comfyrizz-token': TOKEN,
      origin,
    },
    body: JSON.stringify({ keyframeId: KEYFRAME, stillSha: OTHER_SHA, receiptId: STILL_SHA, reason: 'owner override' }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'REF_REVIEW_STALE');
});
