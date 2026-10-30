import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { contributionStore } from '../../../packages/jobs/src/model-contribution.mjs';
import { readReviewArtifact } from '../src/review-artifact.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file));
const save = (file, value) => writeFileSync(file, JSON.stringify(value));

// Explicitly synthetic EXISTING ledger/MP4 fixtures. These test read contracts,
// not actual rendering, generation, final pixels or model contribution quality.
function fixture(t, normal = false) {
  const runtimeDir = mkdtempSync('/tmp/opencode/review-artifact-');
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const packageDir = join(runtimeDir, 'packages'), rendersDir = join(runtimeDir, 'renders');
  const renderId = normal ? 'r_123456abcdef' : 'run_123456abcdef';
  const runDir = join(runtimeDir, 'runs', renderId);
  for (const dir of [packageDir, rendersDir, runDir, join(contributionStore(packageDir), 'renders')]) mkdirSync(dir, { recursive: true });
  const pkg = json(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
  Object.assign(pkg, { id: 'pkg_synthetic_review', revision: 25, title: 'Explicit synthetic historical review fixture',
    voice: { enabled: false, engine: 'none' }, duration: { mode: 'target', targetFrames: 90, exact: true },
    scenes: [{ id: 's1', layout: 'title', preferredFrames: 90, copy: { headline: 'Synthetic fixture' } }] });
  const timeline = compileTimeline(pkg), video = Buffer.from('explicit synthetic MP4 contract bytes');
  const packageHash = sha(canonicalJson(pkg)), videoSha256 = sha(video);
  const render = { bytes: video.length, frames: timeline.durationInFrames, package_sha256: packageHash,
    timeline_sha256: timeline.hash, video_sha256: videoSha256, url: `/api/run/${renderId}/video` };
  const input = { runId: renderId, packageId: pkg.id, package: pkg, timeline, render };
  const state = { schema: 'comfyrizz.run-record/v1', runId: renderId, packageId: pkg.id, revision: pkg.revision,
    status: 'done', finished: true, error: null, errorCode: null, settlement: { kind: 'completed' },
    manifest: { complete: true }, render };
  const file = join(rendersDir, `${renderId}.mp4`), inputFile = join(runDir, 'render-input.json'), stateFile = join(runDir, 'state.json');
  const receiptFile = join(contributionStore(packageDir), 'renders', `${videoSha256}.json`);
  const artifactFile = join(rendersDir, `${renderId}.artifact.json`);
  const receipt = { schema: 'comfyrizz.comfy-contribution/v1/render', packageId: pkg.id, packageHash,
    timelineHash: timeline.hash, videoSha256, contribution: { ok: true, evidence: [], synthetic: true } };
  writeFileSync(file, video); save(inputFile, input); save(stateFile, state); save(receiptFile, receipt);
  if (normal) save(artifactFile, { schema: 'comfyrizz.render-artifact/v1', exportId: renderId, intent: 'final',
    packageId: pkg.id, revision: pkg.revision, packageHash, timelineHash: timeline.hash, videoSha256,
    files: [{ name: 'video.mp4', bytes: video.length, sha256: videoSha256 }], inputs: { package: pkg, timeline } });
  return { runtimeDir, packageDir, rendersDir, runDir, renderId, pkg, timeline, video, receipt,
    file, inputFile, stateFile, receiptFile, artifactFile,
    read: () => readReviewArtifact({ runtimeDir, packageDir, renderId }) };
}

for (const normal of [false, true]) test(`${normal ? 'normal artifact' : 'completed legacy run'} reads original historical inputs and existing receipt only`, t => {
  const ctx = fixture(t, normal);
  save(join(ctx.packageDir, 'package.json'), { id: ctx.pkg.id, revision: 999, title: 'Later mutable edit' });
  const before = readdirSync(ctx.runtimeDir, { recursive: true }).sort();
  const result = ctx.read();
  assert.deepEqual(result.inputs, { package: ctx.pkg, timeline: ctx.timeline });
  assert.deepEqual(result.receipt, ctx.receipt);
  assert.equal(result.metadata.revision, 25);
  assert.equal(result.metadata.videoSha256, sha(ctx.video));
  assert.equal(result.file, ctx.file);
  assert(Buffer.isBuffer(result.recordBytes));
  if (normal) assert.deepEqual(result.recordBytes, readFileSync(ctx.artifactFile));
  else {
    assert(result.recordBytes.includes(readFileSync(ctx.inputFile)));
    assert(result.recordBytes.includes(readFileSync(ctx.stateFile)));
    assert.equal(result.metadata.preflight, undefined);
    assert.equal(result.metadata.snapshot, undefined);
    assert.equal(result.metadata.exportId, undefined);
  }
  assert.deepEqual(readdirSync(ctx.runtimeDir, { recursive: true }).sort(), before);
});

test('immutable record bytes bind both input formatting and full completion state', t => {
  const ctx = fixture(t), first = sha(ctx.read().recordBytes);
  writeFileSync(ctx.inputFile, JSON.stringify(json(ctx.inputFile), null, 2));
  const second = sha(ctx.read().recordBytes);
  assert.notEqual(second, first);
  save(ctx.stateFile, { ...json(ctx.stateFile), teardown: { state: 'stopped', evidence: 'changed diagnostic' } });
  assert.notEqual(sha(ctx.read().recordBytes), second);
});

const mutations = {
  'failed final render despite completed media': ctx => { const s = json(ctx.stateFile); s.status = 'failed'; s.errorCode = 'RENDER_FAILED'; save(ctx.stateFile, s); },
  'unfinished state': ctx => { const s = json(ctx.stateFile); s.finished = false; save(ctx.stateFile, s); },
  'invented succeeded state': ctx => { const s = json(ctx.stateFile); s.status = 'succeeded'; save(ctx.stateFile, s); },
  'missing completion schema': ctx => { const s = json(ctx.stateFile); delete s.schema; save(ctx.stateFile, s); },
  'partial manifest': ctx => { const s = json(ctx.stateFile); s.manifest.complete = false; save(ctx.stateFile, s); },
  'media-only settlement': ctx => { const s = json(ctx.stateFile); s.settlement.kind = 'media_completed'; save(ctx.stateFile, s); },
  'different state run': ctx => { const s = json(ctx.stateFile); s.runId = 'run_000000000000'; save(ctx.stateFile, s); },
  'different input run': ctx => { const s = json(ctx.inputFile); s.runId = 'run_000000000000'; save(ctx.inputFile, s); },
  'different package identity': ctx => { const s = json(ctx.stateFile); s.packageId = 'pkg_elsewhere'; save(ctx.stateFile, s); },
  'different revision': ctx => { const s = json(ctx.stateFile); s.revision++; save(ctx.stateFile, s); },
  'changed historical package': ctx => { const s = json(ctx.inputFile); s.package.title = 'Tampered'; save(ctx.inputFile, s); },
  'changed timeline with unchanged hash': ctx => { const s = json(ctx.inputFile); s.timeline.width++; save(ctx.inputFile, s); },
  'changed timeline source hash': ctx => { const s = json(ctx.inputFile); s.timeline.sourceHash = 'a'.repeat(64); save(ctx.inputFile, s); },
  'different final render': ctx => { const s = json(ctx.stateFile); s.render.video_sha256 = 'a'.repeat(64); save(ctx.stateFile, s); },
  'same-size changed MP4': ctx => writeFileSync(ctx.file, Buffer.alloc(ctx.video.length, 'x')),
  'oversized MP4': ctx => truncateSync(ctx.file, 512 * 1024 * 1024 + 1),
  'empty MP4': ctx => truncateSync(ctx.file, 0),
  'missing input': ctx => rmSync(ctx.inputFile),
  'missing state': ctx => rmSync(ctx.stateFile),
  'missing receipt': ctx => rmSync(ctx.receiptFile),
  'different receipt package': ctx => { const r = json(ctx.receiptFile); r.packageId = 'pkg_elsewhere'; save(ctx.receiptFile, r); },
  'different receipt timeline': ctx => { const r = json(ctx.receiptFile); r.timelineHash = 'a'.repeat(64); save(ctx.receiptFile, r); },
  'untrusted contribution': ctx => { const r = json(ctx.receiptFile); r.contribution.ok = false; save(ctx.receiptFile, r); },
};
for (const [name, mutate] of Object.entries(mutations)) test(`legacy run rejects ${name}`, t => {
  const ctx = fixture(t); mutate(ctx);
  assert.throws(ctx.read, { code: 'ARTIFACT_MISSING' });
});

for (const target of ['file', 'inputFile', 'stateFile', 'runDir', 'rendersDir', 'receiptFile']) test(`rejects symlink aliases for ${target}`, t => {
  const ctx = fixture(t), path = ctx[target], other = `${path}-elsewhere`;
  renameSync(path, other); symlinkSync(other, path);
  assert.throws(ctx.read, { code: 'ARTIFACT_MISSING' });
});

test('rejects traversal and non-string IDs before filesystem lookup', t => {
  const ctx = fixture(t);
  for (const renderId of ['../run_123456abcdef', 'run_123456abcdef/../elsewhere', 'r_123456abcdef.mp4', 'RUN_123456abcdef', ['run_123456abcdef'], null]) {
    assert.throws(() => readReviewArtifact({ ...ctx, renderId }), { code: 'ARTIFACT_MISSING' });
  }
});

test('normal artifact also rejects forged timeline content and oversized or symlinked MP4', t => {
  const ctx = fixture(t, true), original = readFileSync(ctx.artifactFile);
  const record = json(ctx.artifactFile); record.inputs.timeline.width++;
  save(ctx.artifactFile, record); assert.throws(ctx.read, { code: 'ARTIFACT_MISSING' });
  writeFileSync(ctx.artifactFile, original);
  truncateSync(ctx.file, 512 * 1024 * 1024 + 1); assert.throws(ctx.read, { code: 'ARTIFACT_MISSING' });
  writeFileSync(ctx.file, ctx.video);
  renameSync(ctx.file, `${ctx.file}-elsewhere`); symlinkSync(`${ctx.file}-elsewhere`, ctx.file);
  assert.throws(ctx.read, { code: 'ARTIFACT_MISSING' });
});

test('rehashed substituted historical timeline cannot reuse the existing receipt', t => {
  const ctx = fixture(t), input = json(ctx.inputFile), state = json(ctx.stateFile);
  const { hash, ...body } = input.timeline;
  body.width++;
  input.timeline = { ...body, hash: sha(canonicalJson(body)) };
  input.render.timeline_sha256 = input.timeline.hash;
  state.render = input.render;
  save(ctx.inputFile, input); save(ctx.stateFile, state);
  assert.throws(ctx.read, { code: 'ARTIFACT_MISSING' });
});

test('rehashed sourceHash detached from the historical package is rejected even with matching synthetic receipt', t => {
  const ctx = fixture(t), input = json(ctx.inputFile), state = json(ctx.stateFile), receipt = json(ctx.receiptFile);
  const { hash, ...body } = input.timeline;
  body.sourceHash = 'a'.repeat(64);
  input.timeline = { ...body, hash: sha(canonicalJson(body)) };
  input.render.timeline_sha256 = input.timeline.hash;
  state.render = input.render;
  receipt.timelineHash = input.timeline.hash;
  save(ctx.inputFile, input); save(ctx.stateFile, state); save(ctx.receiptFile, receipt);
  assert.throws(ctx.read, { code: 'ARTIFACT_MISSING' });
});

// Opt-in, read-only smoke against the genuine Spoon r25 source; no reports,
// registration aliases or provenance records are saved to that runtime.
test('genuine Spoon r25 read-only receipt/root smoke', { skip: !process.env.COMFYRIZZ_REVIEW_SMOKE_RUNTIME }, () => {
  const runtimeDir = process.env.COMFYRIZZ_REVIEW_SMOKE_RUNTIME;
  const packageDir = join(runtimeDir, 'packages'), renderId = 'run_8b3abf9d8459';
  const hash = '58e0c33a657cdcfc9d1d7a492bdf22cc2f16ce7da1f05b3c214dc6a7e9198180';
  const files = [join(runtimeDir, 'runs', renderId, 'render-input.json'), join(runtimeDir, 'runs', renderId, 'state.json'),
    join(runtimeDir, 'renders', `${renderId}.mp4`), join(runtimeDir, '.comfy-provenance', 'renders', `${hash}.json`)];
  const snapshot = () => files.map(file => ({ sha: sha(readFileSync(file)), mtime: statSync(file).mtimeMs }));
  const before = snapshot(), names = readdirSync(runtimeDir).sort();
  const result = readReviewArtifact({ runtimeDir, packageDir, renderId });
  assert.equal(contributionStore(packageDir), join(runtimeDir, '.comfy-provenance'));
  assert.equal(result.metadata.packageId, 'pkg_42de342a7f5929c4');
  assert.equal(result.metadata.revision, 25);
  assert.equal(result.metadata.videoSha256, hash);
  assert.equal(result.metadata.packageHash, 'ad44d38a646c09f367189c6b3c0f567e144110f0da516e73916708f8bc709978');
  assert.equal(result.metadata.timelineHash, 'e5d41444b2590baab628fa07791f1b4f3114a512c6a9d243cbd68908edfcc19d');
  assert.deepEqual(result.receipt, json(files[3]));
  assert(result.receipt.contribution.ok);
  assert(result.receipt.contribution.evidence.some(item => item.receipt?.generator === 'fasth3-omni'));
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(readdirSync(runtimeDir).sort(), names);
});
