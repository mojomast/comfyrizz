import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { recordGenerationReceipts } from '../../../packages/jobs/src/model-contribution.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { createApp } from '../src/app.mjs';
import { publishRenderArtifact } from '../src/render-artifacts.mjs';
import { createRenderReviewer } from '../src/render-review.mjs';
import { collectMockContribution, approveMockContribution } from './helpers/comfy-contribution.mjs';

const token = 'owner-render-review-http-test-token';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const line = 'A synthetic speech observation.';
const speech = { provider: 'test-only-transcriber', uncertaintySeconds: 0.1,
  segments: [{ start: 0, end: 1, text: line }] };

async function harness(t, { transcribe } = {}) {
  const runtimeDir = mkdtempSync('/tmp/opencode/render-reviews-http-');
  let effects = 0, inspections = 0;
  const forbidden = () => { effects++; throw new Error('No model, backend or renderer may run'); };
  const app = createApp({ runtimeDir, token, render: forbidden, renderScene: forbidden,
    agentRunner: forbidden, backendFactory: forbidden,
    speechInspector: async input => { inspections++; return transcribe ? transcribe(input) : speech; } });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(runtimeDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, credential = token, extraHeaders = {}) => fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json',
      ...(credential ? { 'x-comfyrizz-token': credential } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, runtimeDir, origin, request, get effects() { return effects; }, get inspections() { return inspections; } };
}

// Real CPU MP4 container, simulated Comfy collection, and injected ASR. These
// fixtures make no claim of genuine generated pixels, speech or human approval.
function publishFixture(h) {
  const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url)));
  Object.assign(pkg, { id: 'pkg_review_http', revision: 1, assets: {}, datasets: {}, renders: [],
    format: { width: 64, height: 64, fps: 24 }, duration: { mode: 'target', targetFrames: 96, exact: true },
    voice: { enabled: false, engine: 'none' },
    scenes: [{ id: 's1', layout: 'hero', media_only: true, preferredFrames: 96,
      background: { asset: 'a_native', muted: false, loop: false, speed: 1 } }] });
  delete pkg.theme.logo_asset;
  collectMockContribution(pkg, h.app.store.dir);
  const renderId = 'r_123456abcdef', file = join(h.runtimeDir, 'renders', `${renderId}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  const bytes = readFileSync(file), workflow = 'workflows/fasth3_omni_ref2va.api.json';
  const graph = readFileSync(new URL(`../../../${workflow}`, import.meta.url));
  writeFileSync(join(h.app.store.dir, 'assets/native.mp4'), bytes);
  writeFileSync(join(h.app.store.dir, 'assets/native.workflow.api.json'), graph);
  pkg.assets.a_native = { kind: 'video', origin: 'generated', status: 'ready', file: 'assets/native.mp4', sha256: hash(bytes), bytes: bytes.length,
    license: { id: 'CC0-1.0' }, redistributable: true, model_license: { id: 'MiniMax-H3-Community' },
    media: { width: 64, height: 64, fps: 24, frames: 96, durationSeconds: 4, audio: 'present' },
    gen: { generator: 'fasth3-omni', workflow, workflow_sha256: hash(graph), inputs: { fps: 24, frames: 96 },
      direction: { subject: 'Synthetic fixture', composition: 'Static frame', action: 'Synthetic observation', camera: 'Locked',
        soundscape: 'Synthetic tone', characterCount: 1,
        dialogue: { text: line, conditioningText: line, language: 'English', voice: 'Synthetic voice', delivery: 'Neutral' } } } };
  const jobsDoc = { hash: hash('synthetic-native-job'), jobs: [{ id: 'native', generator: 'fasth3-omni', workflow, workflowSha256: hash(graph) }] };
  recordGenerationReceipts({ outputDir: h.app.store.dir, backend: 'byo-comfyui', jobsDoc,
    manifest: { run_id: 'synthetic-native-run', jobsHash: jobsDoc.hash, jobs: [{ job: 'native', status: 'succeeded', job_id: 'synthetic-job', attempt_id: 'synthetic-attempt',
      outputs: [{ relative: 'assets/native.mp4', sha256: hash(bytes), bytes: bytes.length, workflow_submitted: true, measured: pkg.assets.a_native.media }] }] } });
  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  h.app.store.write(pkg);
  approveMockContribution(h.app.takeStore, pkg, h.app.store.dir);
  h.app.takeStore.addTake(pkg.id, 'a_native', { srcPath: join(h.app.store.dir, 'assets/native.mp4'),
    gen: pkg.assets.a_native.gen, media: pkg.assets.a_native.media, verdict: 'approved', verdictNote: 'Synthetic contract fixture only' });
  const timeline = compileTimeline(pkg);
  const metadata = publishRenderArtifact({ renderId, rendersDir: join(h.runtimeDir, 'renders'), receiptDir: h.app.store.dir,
    staged: { packageDir: h.app.store.dir }, snapshot: { intent: 'final', package: pkg, timeline },
    result: { output: file }, revision: pkg.revision, preflight: { final: true } });
  return { pkg, file, metadata, input: { packageId: pkg.id, expectedRevision: pkg.revision, renderId } };
}

test('owner review HTTP validates exact identity, auth and revision before inspection or effects', async t => {
  const h = await harness(t), { pkg, input } = publishFixture(h);
  const post = (body, credential, headers) => h.request('/api/render-reviews', body, credential, headers);
  assert.equal((await post(input, null)).status, 401);
  assert.equal((await post(input, 'wrong')).status, 401);
  assert.equal((await post(input, token, { origin: 'https://other.invalid' })).status, 403);
  assert.equal((await h.request('/api/render-reviews')).status, 405);
  for (const body of [null, [], {}, { ...input, expectedRevision: '1' }, { ...input, expectedRevision: -1 },
    { ...input, packageId: '../outside' }, { ...input, renderId: 'pipe_123456abcdef' }, { ...input, renderId: '../outside' },
    ...['file', 'report', 'findings', 'model', 'conversationId', 'authorizeExistingMediaRepair'].map(key => ({ ...input, [key]: 'injected' }))]) {
    const response = await post(body);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal((await response.json()).code, 'RENDER_REVIEW_INVALID');
  }
  const malformed = await fetch(h.origin + '/api/render-reviews', { method: 'POST',
    headers: { origin: h.origin, 'x-comfyrizz-token': token }, body: '{' });
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).code, 'INVALID_JSON');
  let response = await post({ ...input, packageId: 'pkg_unknown' });
  assert.equal(response.status, 404); assert.equal((await response.json()).code, 'PACKAGE_NOT_FOUND');
  response = await post({ ...input, expectedRevision: 2 });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'RENDER_REVIEW_STALE');
  response = await post({ ...input, renderId: 'r_000000000000' });
  assert.equal(response.status, 404); assert.equal((await response.json()).code, 'ARTIFACT_MISSING');
  assert.equal(h.inspections, 0); assert.equal(h.effects, 0);
  assert.deepEqual(h.app.store.read(pkg.id), pkg);
  assert.equal(existsSync(join(h.runtimeDir, 'render-reviews')), false);
  const artifact = JSON.parse(readFileSync(join(h.runtimeDir, 'renders', `${input.renderId}.artifact.json`)));
  const receiptFile = join(h.runtimeDir, '.comfy-provenance/renders', `${artifact.videoSha256}.json`);
  rmSync(receiptFile);
  response = await post(input);
  assert.equal(response.status, 404); assert.equal((await response.json()).code, 'ARTIFACT_MISSING');
  assert.equal(existsSync(receiptFile), false); assert.equal(h.inspections, 0);
});

test('review returns the full immutable receipt-bound report; normal empty conversation and repair polling work', async t => {
  const h = await harness(t), { pkg, input, file, metadata } = publishFixture(h);
  const before = [h.app.store.path(pkg.id), file, join(h.runtimeDir, '.comfy-provenance/renders', `${metadata.videoSha256}.json`)]
    .map(path => [path, hash(readFileSync(path))]);
  const response = await h.request('/api/render-reviews', input);
  assert.equal(response.status, 200, await response.clone().text());
  const report = await response.json();
  assert.match(report.reviewId, /^rr_[a-f0-9]{64}$/);
  assert.equal(report.packageId, pkg.id); assert.equal(report.packageRevision, 1);
  assert.equal(report.artifact.renderId, input.renderId);
  assert.equal(report.artifact.videoSha256, hash(readFileSync(file)));
  assert.equal(report.capabilities.contribution, 'receipt_verified');
  assert.equal(report.speech.status, 'measured'); assert.deepEqual(report.speech.segments, speech.segments);
  assert.equal(report.findings.find(item => item.check === 'frame_count').status, 'pass');
  assert.equal(report.findings.find(item => item.check === 'native_source_contribution').status, 'pass');
  assert.equal(report.acceptance, 'not_assessed');
  assert.deepEqual(JSON.parse(readFileSync(join(h.runtimeDir, 'render-reviews', `${report.reviewId}.json`))), report);
  assert.deepEqual(await createRenderReviewer({ runtimeDir: h.runtimeDir, packageDir: h.app.store.dir })
    .read(pkg, { ...input, reviewId: report.reviewId }), report);
  for (const [path, digest] of before) assert.equal(hash(readFileSync(path)), digest);
  assert.equal(h.effects, 0);
  assert.equal(existsSync(join(h.runtimeDir, 'self-repairs/packages', `${pkg.id}.json`)), false);

  const created = await h.request('/api/conversations', { packageId: pkg.id });
  assert.equal(created.status, 201);
  const { chatId } = await created.json();
  const sessionFile = join(h.runtimeDir, 'conversations', `${chatId}.json`), sessionBytes = readFileSync(sessionFile);
  const chat = await h.request(`/api/agent/chat/${chatId}`);
  assert.equal(chat.status, 200);
  const view = await chat.json();
  assert.equal(view.conversation.revision, 0); assert.equal(view.conversation.packageId, pkg.id);
  assert.deepEqual(view.conversation.messages, []); assert.equal(view.conversation.projectId, null);
  assert.deepEqual(readFileSync(sessionFile), sessionBytes, 'GET normalization does not fabricate chat history');
  const repair = { ...input, repairId: 'repair_review_http', conversationId: chatId, maxRepairs: 1, authorizeExistingMediaRepair: true };
  const started = await h.request('/api/self-repairs', repair);
  assert.equal(started.status, 202, await started.clone().text());
  assert.equal(started.headers.get('location'), '/api/self-repairs/repair_review_http');
  let record;
  for (let i = 0; i < 100; i++) {
    const polled = await h.request('/api/self-repairs/repair_review_http');
    assert.equal(polled.status, 200); record = await polled.json();
    if (record.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(record.status, 'stopped');
  assert.equal(record.error?.code, 'SELF_REPAIR_PROVIDER', JSON.stringify(record));
  assert.equal(record.attempts, 1); assert.equal(record.renders, 0);
  assert.equal((await h.request('/api/self-repairs', repair)).status, 200);
  assert.equal((await h.request('/api/self-repairs', { ...repair, maxRepairs: 2 })).status, 409);
  assert.deepEqual(readFileSync(sessionFile), sessionBytes);
  assert.deepEqual(h.app.store.read(pkg.id), pkg); assert.equal(h.effects, 0);
});

test('a package edit during inspection returns stale, and altered receipt/video never reach transcription', async t => {
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const h = await harness(t, { transcribe: async () => { entered(); await wait; return speech; } });
  const { pkg, input, file } = publishFixture(h);
  const pending = h.request('/api/render-reviews', input);
  await ready;
  h.app.store.save(pkg.id, { ...pkg, title: 'Edited during inspection' }, pkg.revision);
  release();
  const response = await pending;
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'RENDER_REVIEW_STALE');
  assert.equal(h.effects, 0);
  const newer = { ...input, expectedRevision: 2 };
  assert.equal((await h.request('/api/render-reviews', newer)).status, 409);
  writeFileSync(file, 'tampered');
  assert.equal((await h.request('/api/render-reviews', newer)).status, 404);
  assert.equal(h.inspections, 1);
});

test('invite guests cannot read or start review/repair in either hosted or local mode', async t => {
  const previous = process.env.COMFYRIZZ_HOSTED_INVITES;
  delete process.env.COMFYRIZZ_HOSTED_INVITES;
  t.after(() => { if (previous === undefined) delete process.env.COMFYRIZZ_HOSTED_INVITES; else process.env.COMFYRIZZ_HOSTED_INVITES = previous; });
  const h = await harness(t);
  const minted = await h.request('/api/invites/mint', { cu: 2, ttlDays: 1 });
  assert.equal(minted.status, 200);
  const { path } = await minted.json();
  const redeemed = await h.request(path, undefined, null);
  const { guestToken } = await redeemed.json();
  assert.equal(typeof guestToken, 'string');
  const paths = ['/api/render-reviews', '/api/render-reviews/rr_unknown', '/api/self-repairs', '/api/self-repairs/repair_unknown'];
  for (const flag of ['0', '1']) {
    process.env.COMFYRIZZ_HOSTED_INVITES = flag;
    for (const path of paths) for (const body of [undefined, {}]) {
      const response = await h.request(path, body, guestToken);
      assert.equal(response.status, 403, `${flag}: ${path}`);
      assert.equal((await response.json()).code, 'GUEST_FORBIDDEN');
      assert.equal((await h.request(path, body, null)).status, 401);
    }
  }
  assert.equal(h.inspections, 0); assert.equal(h.effects, 0);
  assert.equal(existsSync(join(h.runtimeDir, 'render-reviews')), false);
  assert.deepEqual(readdirSync(join(h.runtimeDir, 'self-repairs')).filter(name => name.endsWith('.json')), []);
});
