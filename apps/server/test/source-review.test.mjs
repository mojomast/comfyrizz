import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSourceReviewer, sourceFindings } from '../src/source-review.mjs';
import { applyChatPackageEdit } from '../src/chat-package-edit.mjs';
import { compilePackage } from '../src/compile-package.mjs';
import { createApp } from '../src/app.mjs';
import { createProviderSettings } from '../src/provider-settings.mjs';
import { createLocalSpeechInspector } from '../src/local-speech-inspector.mjs';
import { createTakeStore } from '../src/takes/store.mjs';
import { selectTake } from '../src/takes/select.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const line = 'At nine-oh-three, the office spoon vanished.';
const observed = { provider: 'fixture-observed-source', uncertaintySeconds: 0.1, segments: [{ start: 4.4, end: 6.62, text: line }] };

function fixture(t, { transcribe = async () => observed, real = false } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'source-review-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const packageDir = join(runtimeDir, 'packages');
  mkdirSync(join(packageDir, 'assets'), { recursive: true });
  const file = join(packageDir, 'assets', 'source.mp4');
  if (real) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', String(175 / 24), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  else writeFileSync(file, 'immutable native generated source fixture');
  const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url), 'utf8'));
  Object.assign(pkg, { id: 'pkg_source_review', revision: 25, title: 'THE SPOON FILES', format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'target', targetFrames: 900, exact: true }, voice: { enabled: false, engine: 'none' }, datasets: {}, renders: [],
    theme: { palette: ['#0d0f14', '#6d8cff', '#e6e8ee'], font: 'Inter' },
    assets: { a_native: { kind: 'video', origin: 'generated', status: 'ready', file: 'assets/source.mp4', sha256: sha(readFileSync(file)), bytes: readFileSync(file).length,
      license: { id: 'LicenseRef-MiniMax-H3-Community' }, model_license: { id: 'LicenseRef-MiniMax-H3-Community' }, media: { fps: 24, frames: 175, durationSeconds: 175 / 24, audio: 'present' },
      gen: { generator: 'fasth3-omni', workflow: 'workflows/fasth3_omni_ref2va.api.json', inputs: { frames: 175, fps: 24, seed: 1 }, direction: {
        subject: 'An office worker', composition: 'A medium interview shot', action: 'Speaks to camera', camera: 'Locked', soundscape: 'Office room tone', characterCount: 1,
        dialogue: { text: line, conditioningText: line, language: 'English', voice: 'af_heart', delivery: 'Deadpan' },
      } } } },
    scenes: [190, 190, 190, 190, 176].map((preferredFrames, i) => ({ id: `s${i + 1}`, layout: 'hero', media_only: true, preferredFrames,
      background: { asset: 'a_native', loop: false, speed: 1, muted: false }, transitionOut: { type: i < 4 ? 'fade' : 'cut', frames: i < 4 ? 9 : 0 } })),
  });
  const probe = async () => ({ durationSec: 7.292, fps: 24, frames: 175, audio: 'present' });
  const reviewer = createSourceReviewer({ runtimeDir, packageDir, transcribe, ...(!real ? { probe } : {}) });
  const inspect = (candidate = pkg, sceneId = 's1') => reviewer.inspect(candidate, { packageId: candidate.id, expectedRevision: candidate.revision, sceneId });
  return { runtimeDir, packageDir, file, pkg, reviewer, inspect, probe };
}

function selectedTake(ctx) {
  const store = createTakeStore({ runtimeDir: ctx.runtimeDir, packageDir: ctx.packageDir });
  const asset = ctx.pkg.assets.a_native;
  const take = store.addTake(ctx.pkg.id, 'a_native', { srcPath: ctx.file, media: asset.media, gen: asset.gen, verdict: 'approved' });
  const doc = store.read(ctx.pkg.id);
  const pkg = selectTake(ctx.pkg, doc, 'a_native', take.takeId);
  store.write(pkg.id, doc);
  return { pkg, take, file: join(ctx.packageDir, pkg.id, take.file), sidecar: join(ctx.runtimeDir, 'takes', `${pkg.id}.json`) };
}

test('normal Keep storage resolves package-owned take bytes for real ffprobe and repair revalidation', async t => {
  const ctx = fixture(t, { real: true });
  const selected = selectedTake(ctx);
  assert.match(selected.pkg.assets.a_native.file, /^takes\/a_native\/tk_[a-f0-9]{12}\.mp4$/);
  assert.ok(existsSync(selected.file));
  const shadow = join(ctx.packageDir, selected.take.file);
  assert.equal(existsSync(shadow), false, 'the normal take store does not create a root/takes file');
  // Even an unrelated flat copy must never override the owning package's take.
  mkdirSync(dirname(shadow), { recursive: true }); writeFileSync(shadow, 'wrong flat source');
  const originalSidecar = readFileSync(selected.sidecar);
  const report = await ctx.inspect(selected.pkg);
  assert.equal(report.source.sha256, selected.take.sha256);
  assert.equal(report.source.fps, 24); assert.equal(report.source.audio, 'present');
  const request = { inspectionId: report.inspectionId, inFrame: 18 };
  assert.deepEqual(await ctx.reviewer.validateTrim(selected.pkg, 's1', request), { startSeconds: 0.75 });
  const evidencePath = join(ctx.runtimeDir, 'source-reviews', `${report.inspectionId}.json`);
  const originalEvidence = readFileSync(evidencePath);
  writeFileSync(selected.file, 'changed selected take bytes');
  await assert.rejects(ctx.reviewer.validateTrim(selected.pkg, 's1', request), { code: 'SOURCE_REVIEW_STALE' });
  await assert.rejects(ctx.inspect(selected.pkg), { code: 'SOURCE_REVIEW_STALE' });
  assert.equal(sha(readFileSync(ctx.file)), ctx.pkg.assets.a_native.sha256, 'shared original is untouched');
  assert.deepEqual(readFileSync(evidencePath), originalEvidence, 'failed revalidation retains prior evidence');
  assert.deepEqual(readFileSync(selected.sidecar), originalSidecar, 'inspection never changes Keep/approval history');
});

test('a missing package-owned take cannot fall back to matching flat take bytes', async t => {
  const ctx = fixture(t);
  const selected = selectedTake(ctx);
  const shadow = join(ctx.packageDir, selected.take.file);
  mkdirSync(dirname(shadow), { recursive: true }); writeFileSync(shadow, readFileSync(selected.file));
  rmSync(selected.file);
  await assert.rejects(ctx.inspect(selected.pkg), /missing from its owning package/);
});

test('selected sources reject traversal, direct cross-package takes and invalid owner IDs', async t => {
  const ctx = fixture(t);
  const selected = selectedTake(ctx);
  const foreign = join(ctx.packageDir, 'pkg_other', selected.take.file);
  mkdirSync(dirname(foreign), { recursive: true }); writeFileSync(foreign, readFileSync(selected.file));
  for (const file of [
    `pkg_other/${selected.take.file}`, `takes/../../pkg_other/${selected.take.file}`,
    `assets/../pkg_other/${selected.take.file}`, `./${selected.take.file}`,
    selected.take.file.replaceAll('/', '\\'), foreign,
  ]) {
    const pkg = structuredClone(selected.pkg); pkg.assets.a_native.file = file;
    await assert.rejects(ctx.inspect(pkg), { code: 'SOURCE_REVIEW_INVALID' }, file);
  }
  for (const id of ['../pkg_other', 'pkg_other/../pkg_source_review']) {
    await assert.rejects(ctx.inspect({ ...selected.pkg, id }), /valid owning package ID/);
  }
});

test('source resolution rejects same-hash symlink escapes at file, take directory and owning package boundaries', async t => {
  for (const mode of ['file-outside', 'file-sibling', 'takes-directory', 'owner-directory', 'shared-alias']) {
    const ctx = fixture(t);
    const selected = selectedTake(ctx);
    const report = await ctx.inspect(selected.pkg);
    const foreign = join(ctx.packageDir, 'pkg_other', selected.take.file);
    mkdirSync(dirname(foreign), { recursive: true }); writeFileSync(foreign, readFileSync(selected.file));
    if (mode === 'file-outside' || mode === 'file-sibling') {
      const target = mode === 'file-outside' ? join(ctx.runtimeDir, 'outside.mp4') : foreign;
      if (mode === 'file-outside') writeFileSync(target, readFileSync(selected.file));
      rmSync(selected.file); symlinkSync(target, selected.file);
    } else if (mode === 'takes-directory') {
      const takes = join(ctx.packageDir, selected.pkg.id, 'takes');
      rmSync(takes, { recursive: true }); symlinkSync(join(ctx.packageDir, 'pkg_other', 'takes'), takes);
    } else if (mode === 'owner-directory') {
      const owner = join(ctx.packageDir, selected.pkg.id);
      rmSync(owner, { recursive: true }); symlinkSync(join(ctx.packageDir, 'pkg_other'), owner);
    } else {
      selected.pkg.assets.a_native.file = 'assets/alias.mp4';
      symlinkSync(foreign, join(ctx.packageDir, 'assets', 'alias.mp4'));
    }
    await assert.rejects(ctx.inspect(selected.pkg), { code: 'SOURCE_REVIEW_INVALID' }, mode);
    if (mode !== 'shared-alias') await assert.rejects(ctx.reviewer.validateTrim(selected.pkg, 's1', { inspectionId: report.inspectionId, inFrame: 18 }), { code: 'SOURCE_REVIEW_INVALID' }, `revalidate ${mode}`);
  }
});

test('a take symlink staying within its owning package retains byte validation', async t => {
  const ctx = fixture(t);
  const selected = selectedTake(ctx);
  const actual = join(dirname(selected.file), 'actual.mp4');
  renameSync(selected.file, actual); symlinkSync(actual, selected.file);
  const report = await ctx.inspect(selected.pkg);
  assert.equal(report.source.sha256, selected.take.sha256);
});

test('late native speech: observed 4.40–6.62s fails a 190/30s shot; 18 source frames repairs it without changing 900-frame timeline', async t => {
  const ctx = fixture(t);
  const report = await ctx.inspect();
  assert.equal(report.findings.find(f => f.check === 'detected_speech_coverage').status, 'fail');
  assert.equal(report.capabilities.finalRender, 'not_inspected');
  assert.equal(report.acceptance, 'not_assessed');
  assert.ok(report.suggestedInFrame >= 17 && report.suggestedInFrame <= 18);
  const request = { inspectionId: report.inspectionId, inFrame: 18 };
  const trim = await ctx.reviewer.validateTrim(ctx.pkg, 's1', request);
  assert.deepEqual(trim, { startSeconds: 0.75 });
  const edit = { packageId: ctx.pkg.id, expectedRevision: 25, edits: [{ sceneId: 's1', backgroundSourceIn: request }] };
  const next = applyChatPackageEdit(ctx.pkg, edit, { sourceTrims: new Map([['s1', trim]]) });
  assert.deepEqual(next.diff, [{ path: 'scenes.s1.background.trim', before: null, after: { startSeconds: 0.75 } }]);
  assert.deepEqual(next.package.assets, ctx.pkg.assets);
  const before = compilePackage(ctx.pkg, ctx.packageDir), after = compilePackage(next.package, ctx.packageDir);
  assert.equal(after.durationInFrames, 900);
  assert.deepEqual(after.scenes.map(s => [s.from, s.durationInFrames, s.transitionOutFrames]), before.scenes.map(s => [s.from, s.durationInFrames, s.transitionOutFrames]));
  next.package.revision++;
  const reviewed = await ctx.inspect(next.package);
  const coverage = reviewed.findings.find(f => f.check === 'detected_speech_coverage');
  assert.equal(coverage.status, 'pass');
  assert.equal(reviewed.suggestedInFrame, null, 'a passing source mapping needs no speculative repair');
  assert.ok(Math.abs(coverage.startSeconds - 3.65) < 1e-7);
  assert.ok(Math.abs(coverage.endSeconds - 5.87) < 1e-7);
  assert.equal(readdirSync(join(ctx.runtimeDir, 'source-reviews')).length, 2, 'failed and corrected observations retained');
});

test('admission timing is measured from generated source; source-in fixes overlap with an unchanged 104/30s lower third', async t => {
  const ctx = fixture(t, { transcribe: async () => ({ ...observed, segments: [{ start: 2.74, end: 4.08, text: 'It was in my pocket.' }] }) });
  ctx.pkg.scenes[0].lower_third = { text: 'CASE CLOSED', start_frame: 104 };
  const report = await ctx.inspect();
  assert.equal(report.findings.find(f => f.check === 'speech_lower_third_overlap').status, 'needs_review');
  assert.equal(report.suggestedInFrame, 18);
  assert.equal(sourceFindings(report, 18 / 24).find(f => f.check === 'speech_lower_third_overlap').status, 'pass');
});

test('reject stale revisions, cross-project/scene evidence, changed package bytes and changed source bytes', async t => {
  const ctx = fixture(t);
  const report = await ctx.inspect();
  const request = { inspectionId: report.inspectionId, inFrame: 18 };
  for (const pkg of [{ ...ctx.pkg, revision: 26 }, { ...ctx.pkg, id: 'pkg_other' }, { ...ctx.pkg, title: 'Changed without revision' }]) {
    await assert.rejects(ctx.reviewer.validateTrim(pkg, 's1', request), { code: 'SOURCE_REVIEW_STALE' });
  }
  await assert.rejects(ctx.reviewer.validateTrim(ctx.pkg, 's2', request), { code: 'SOURCE_REVIEW_STALE' });
  writeFileSync(ctx.file, 'replaced source bytes');
  await assert.rejects(ctx.reviewer.validateTrim(ctx.pkg, 's1', request), { code: 'SOURCE_REVIEW_STALE' });
});

test('reject fabricated, model-authored or modified evidence and invalid/out-of-bounds trims', async t => {
  const ctx = fixture(t);
  const report = await ctx.inspect();
  for (const request of [
    { inspectionId: `sr_${'0'.repeat(64)}`, inFrame: 18 },
    { inspectionId: report.inspectionId, inFrame: 18, segments: observed.segments },
    { inspectionId: report.inspectionId, inFrame: -1 },
    { inspectionId: report.inspectionId, inFrame: 0 },
    { inspectionId: report.inspectionId, inFrame: 24 },
  ]) await assert.rejects(ctx.reviewer.validateTrim(ctx.pkg, 's1', request), { code: 'SOURCE_REVIEW_INVALID' });
  assert.throws(() => applyChatPackageEdit(ctx.pkg, { packageId: ctx.pkg.id, expectedRevision: 25, edits: [{ sceneId: 's1', backgroundSourceIn: { inspectionId: report.inspectionId, inFrame: 18 } }] }), /server-validated/);
  const path = join(ctx.runtimeDir, 'source-reviews', `${report.inspectionId}.json`);
  const changed = JSON.parse(readFileSync(path)); changed.source.durationSeconds = 100;
  writeFileSync(path, JSON.stringify(changed));
  await assert.rejects(ctx.reviewer.validateTrim(ctx.pkg, 's1', { inspectionId: report.inspectionId, inFrame: 18 }), /modified/);
});

test('unknown/invalid ASR, locked/looped/retimed/unlinked sources cannot self-certify or repair', async t => {
  for (const transcribe of [null, async () => ({ ...observed, segments: [] }), async () => ({ ...observed, segments: [{ start: 6, end: 99, text: line }] }), async () => { throw new Error('offline provider unavailable'); }]) {
    const ctx = fixture(t, { transcribe });
    const report = await ctx.inspect();
    assert.equal(report.suggestedInFrame, null);
    assert.equal(report.findings.find(f => f.check === 'detected_speech_coverage').status, 'unknown');
    await assert.rejects(ctx.reviewer.validateTrim(ctx.pkg, 's1', { inspectionId: report.inspectionId, inFrame: 18 }), /observed speech timing/);
  }
  for (const mutate of [s => { s.locked = true; }, s => { s.background.loop = true; }, s => { s.background.speed = 0.9; }, s => { s.audio_trim = { linked: false }; }]) {
    const ctx = fixture(t); mutate(ctx.pkg.scenes[0]);
    const report = await ctx.inspect();
    assert.equal(report.repairSupported, false); assert.equal(report.suggestedInFrame, null);
  }
  assert.equal(createLocalSpeechInspector({ env: {} }), null);
  await assert.rejects(createLocalSpeechInspector({ env: { COMFYRIZZ_QA_WHISPER_PYTHON: 'python', COMFYRIZZ_QA_WHISPER_WEIGHTS: 'base.en' } })({ file: '/unused' }), /no automatic installation/);
});

test('real CPU ffprobe supplies source bounds/audio presence, with ASR explicitly unavailable', async t => {
  const ctx = fixture(t, { real: true, transcribe: null });
  const report = await ctx.inspect();
  assert.equal(report.source.fps, 24); assert.equal(report.source.audio, 'present');
  assert.ok(Math.abs(report.source.durationSeconds - 175 / 24) < 0.01);
  assert.equal(report.capabilities.speechTiming, 'unavailable');
  assert.equal(report.suggestedInFrame, null);
});

test('normal chat tool loop inspects actual bytes, stages a repair, survives restart and saves through revision guards', async t => {
  const ctx = fixture(t, { real: true });
  const token = 'source-review-http-token';
  let script = [], inspection;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.tools?.length) assert.ok(body.tools.some(tool => tool.function.name === 'project_inspect_source'));
    for (const message of body.messages) if (message.role === 'tool') {
      const result = JSON.parse(message.content);
      if (result.inspectionId) inspection = result;
    }
    const item = script.shift();
    const call = typeof item === 'function' ? item() : item;
    const delta = call ? { tool_calls: [{ index: 0, id: `call_${Math.random()}`, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'Source inspection and requested trim staged. Final render is not inspected.' };
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const settings = createProviderSettings({ runtimeDir: ctx.runtimeDir, env: {} });
  settings.save({ id: 'custom', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-key', model: 'fixture-model', use: true });
  let app, server, base;
  const start = async () => {
    app = createApp({ runtimeDir: ctx.runtimeDir, token, providerSettings: settings, speechInspector: async () => observed,
      agentRunner: async () => ({ package: ctx.pkg, svgAssets: [], pendingGpu: [], generatedAssets: {} }) });
    server = createServer(app.handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { app.close(); await new Promise(resolve => server.close(resolve)); };
  await start(); t.after(stop);
  const api = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-comfyrizz-token': token, origin: base }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  await api('/api/agent', { brief: 'Preserve this exact 30-second native audio film.', provider: 'custom', model: 'fixture-model' });
  const input = { conversationId: 'chat_source_review_001', turnId: 'turn_source_inspect', baseRevision: 0, expectedPackageId: ctx.pkg.id, expectedPackageRevision: 25,
    provider: 'custom', model: 'fixture-model', mode: 'plan', message: 'Inspect the first generated source and stage a source-in trim of 18 source frames to retain the full spoken line. Preserve all authored timings.' };
  script = [{ name: 'project_inspect_source', args: { packageId: ctx.pkg.id, expectedRevision: 25, sceneId: 's1' } },
    () => ({ name: 'project_edit_package', args: { packageId: ctx.pkg.id, expectedRevision: 25, edits: [{ sceneId: 's1', backgroundSourceIn: { inspectionId: inspection.inspectionId, inFrame: 18 } }] } })];
  const staged = await api('/api/agent/chat', input);
  assert.equal(staged.built, false);
  assert.equal(staged.conversation.trace.tools.find(item => item.name === 'project_inspect_source').ok, true);
  assert.ok(staged.conversation.packageEdit);
  assert.equal(app.store.read(ctx.pkg.id).revision, 25);
  await stop(); await start();
  const applied = await api('/api/agent/chat', { ...input, baseRevision: 1, turnId: 'turn_source_apply', action: 'build', message: 'Apply the reviewed trim.' });
  assert.equal(applied.built, true); assert.equal(applied.project.package.revision, 26);
  assert.equal(applied.project.timeline.durationInFrames, 900);
  assert.deepEqual(applied.project.package.scenes[0].background.trim, { startSeconds: 0.75 });
  assert.deepEqual(applied.project.package.assets, ctx.pkg.assets);
  assert.equal(applied.conversation.sourceRepairBatches[ctx.pkg.id], 1);
  assert.equal(readFileSync(ctx.file).length, ctx.pkg.assets.a_native.bytes);
  const replay = await api('/api/agent/chat', { ...input, baseRevision: 1, turnId: 'turn_source_apply', action: 'build', message: 'Apply the reviewed trim.' });
  assert.equal(replay.conversation.sourceRepairBatches[ctx.pkg.id], 1, 'idempotent replay does not spend another repair');
  const repair = (revision, inFrame) => [
    { name: 'project_inspect_source', args: { packageId: ctx.pkg.id, expectedRevision: revision, sceneId: 's1' } },
    () => ({ name: 'project_edit_package', args: { packageId: ctx.pkg.id, expectedRevision: revision, edits: [{ sceneId: 's1', backgroundSourceIn: { inspectionId: inspection.inspectionId, inFrame } }] } }),
  ];
  script = [...repair(26, 17), { name: 'project_build', args: {} }];
  const second = await api('/api/agent/chat', { ...input, baseRevision: 2, expectedPackageRevision: 26, turnId: 'turn_source_second', message: 'Apply source-in 17 frames after inspecting the current source.' });
  assert.equal(second.built, true); assert.equal(second.project.package.revision, 27);
  assert.equal(second.conversation.sourceRepairBatches[ctx.pkg.id], 2);
  await stop(); await start();
  script = repair(27, 18);
  const limited = await api('/api/agent/chat', { ...input, baseRevision: 3, expectedPackageRevision: 27, turnId: 'turn_source_third' });
  assert.equal(limited.built, false);
  assert.equal(limited.conversation.trace.tools.find(item => item.name === 'project_edit_package').code, 'SOURCE_REPAIR_LIMIT');
  assert.equal(app.store.read(ctx.pkg.id).revision, 27);
});
