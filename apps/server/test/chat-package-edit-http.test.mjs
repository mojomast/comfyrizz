import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.mjs';
import { createProviderSettings } from '../src/provider-settings.mjs';
import { applyChatPackageEdit } from '../src/chat-package-edit.mjs';
import { createProductionStore } from '../src/productions/store.mjs';
import { createCommandHandler } from '../src/productions/commands.mjs';
import { conversationPlanSchema } from '../../../packages/agent/dist/src/index.js';
import { chatPlanFromPackage } from '../src/chat-project.mjs';

const token = 'saved-package-chat-test-token';
const conversationId = 'chat_saved_native_audio_001';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const conditioning = Buffer.from('immutable conditioning fixture bytes');

// The saved-video shape that failed: 7 shots, 24 fps / 1080 frames,
// copy-free list/hero scenes, H3 inputs referencing ready conditioning assets.
function savedFilm() {
  const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url), 'utf8'));
  Object.assign(pkg, { id: 'pkg_saved_last_signal', title: 'THE LAST SIGNAL', revision: 41,
    format: { width: 1920, height: 1080, fps: 24 }, duration: { mode: 'target', targetFrames: 1080, exact: true },
    theme: { palette: ['#0d0f14', '#6d8cff', '#e6e8ee'], font: 'Inter' }, datasets: {},
    proposal: { logline: 'A signal from tomorrow.', look: 'Photorealistic', soundtrack: 'Room tone, no music' },
    voice: { enabled: true, engine: 'kokoro', voice: 'af_heart', speed: 0.98 },
    assets: { a_identity: { kind: 'image', origin: 'generated', status: 'pending', license: { id: 'Apache-2.0' }, gen: { generator: 'flux3-klein', inputs: { prompt: 'Mara at her radio' } } } },
    scenes: [], renders: [],
  });
  const frames = [106, 122, 172, 189, 189, 188, 126];
  for (let i = 0; i < 7; i++) {
    const id = `s${i + 1}`;
    const audio = `a_dialogue_${i}`;
    if (i < 6) pkg.assets[audio] = { kind: 'audio', origin: 'generated', status: 'ready', file: `assets/${audio}.wav`, sha256: sha(conditioning), bytes: conditioning.length,
      media: { durationSeconds: 1, audio: 'present', codec: 'pcm_s16le' }, license: { id: 'CC0-1.0' }, model_license: { id: 'Apache-2.0' },
      gen: { generator: 'kokoro', inputs: { text: `Exact dialogue ${i}.`, voice: 'af_heart', speed: 1 } } };
    pkg.assets[`a_video_${i}`] = { kind: 'video', origin: 'generated', status: 'pending', license: { id: 'LicenseRef-MiniMax-H3-Community' },
      gen: { generator: 'fasth3-omni', workflow: 'workflows/fasth3_omni_ref2va.api.json', inputs: { image: 'a_identity', reference: 'a_identity', ...(i < 6 ? { audio } : {}), frames: frames[i] + 1, fps: 24, width: 832, height: 480, seed: i } } };
    pkg.scenes.push({ id, layout: i === 0 || i === 6 ? 'title' : i === 1 ? 'hero' : 'list', preferredFrames: frames[i],
      ...(i === 0 || i === 6 ? { copy: { headline: 'THE LAST SIGNAL', ...(i === 0 ? { kicker: 'A FICTIONAL MYSTERY SERIES' } : {}) } } : i === 1 ? { copy: { headline: 'Tonight, it said my name.' }, lower_third: { text: 'MARA VALE', kicker: 'RADIO ARCHIVIST' } } : {}),
      background: { asset: `a_video_${i}` }, foreground: i === 0 ? [{ asset: 'a_identity', x: 0.5, y: 0.5, w: 0.5, anim: 'fade-in' }] : [],
      ...(i < 6 ? { narration: `Exact dialogue ${i}.`, transitionOut: { type: i === 0 ? 'fade' : 'cut', frames: i === 0 ? 12 : 0 } } : {}),
      motion: { entry: 'maskRise', spring: 'settle' },
    });
  }
  return pkg;
}

function correction(pkg) {
  return { packageId: pkg.id, expectedRevision: pkg.revision, disableVoice: true,
    edits: pkg.scenes.map((scene, i) => ({ sceneId: scene.id, backgroundMuted: false, ...(i < 6 ? { removeNarration: true } : {}),
      ...(i === 0 ? { copy: { kicker: null }, removeForegroundAssets: ['a_identity'] } : {}),
      ...(i === 1 ? { copy: { headline: null }, lowerThird: { kicker: null } } : {}),
    })),
  };
}

function reply(res, call) {
  res.setHeader('content-type', 'text/event-stream');
  const delta = call ? { tool_calls: [{ index: 0, id: `call_${Math.random()}`, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'Reviewed the requested edits.' };
  res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
}

async function setup(t, { bound = false, intent = 'active', coldBound = false } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'saved-package-chat-'));
  t.after(() => rmSync(runtimeDir, { force: true, recursive: true }));
  const pkg = savedFilm();
  mkdirSync(join(runtimeDir, 'packages', 'assets'), { recursive: true });
  for (let i = 0; i < 6; i++) writeFileSync(join(runtimeDir, 'packages', 'assets', `a_dialogue_${i}.wav`), conditioning);
  const requests = [];
  let script = [], onModel = null;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    if (onModel) { const callback = onModel; onModel = null; callback(); }
    reply(res, script.shift());
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const settings = createProviderSettings({ runtimeDir, env: {} });
  settings.save({ id: 'custom', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fake-test-key', model: 'fixture-model', use: true });
  let app, server, base;
  const start = async () => {
    app = createApp({ token, runtimeDir, providerSettings: settings, agentRunner: async () => ({ package: pkg, svgAssets: [], pendingGpu: [], generatedAssets: {} }) });
    server = createServer(app.handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { app.close(); await new Promise(resolve => server.close(resolve)); };
  await start(); t.after(stop);
  const api = async (path, body) => {
    const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-comfyrizz-token': token, origin: base }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  const generated = await api('/api/agent', { brief: 'Preserve this exact 45-second monologue film with native speech.', provider: 'custom', model: 'fixture-model' });
  assert.equal(generated.status, 200, JSON.stringify(generated.body));
  if (coldBound) {
    mkdirSync(join(runtimeDir, 'conversations'), { recursive: true });
    writeFileSync(join(runtimeDir, 'conversations', `${conversationId}.json`), JSON.stringify({ id: conversationId, revision: 0, messages: [], plan: null, phase: 'chatting', projectId: pkg.id, projectRevision: pkg.revision }));
  }
  let productionId;
  if (bound) {
    const store = createProductionStore({ runtimeDir });
    const handler = createCommandHandler({ store });
    productionId = handler.execute({ commandId: 'cmd_saved_create', idempotencyKey: 'key_saved_create', kind: 'production.create', expected: { productionRevision: 0 },
      payload: { conversationId, packageId: pkg.id, intent, shotIds: pkg.scenes.map(scene => scene.id) } }, { actor: 'user', userEventId: 'ue_saved_create' }).productionId;
  }
  return { pkg, runtimeDir, requests, api, productionId, get store() { return app.store; },
    setScript: calls => { script = [...calls]; }, onModel: callback => { onModel = callback; },
    restart: async () => { await stop(); await start(); },
    send: (extra = {}) => api('/api/agent/chat', { conversationId, turnId: `turn_${Math.random().toString(16).slice(2)}`, baseRevision: 0,
      expectedPackageId: pkg.id, expectedPackageRevision: 41, provider: 'custom', model: 'fixture-model', mode: 'plan',
      message: 'Unmute native video audio; disable voiceover and remove narration. Remove only opening kicker and foreground still, second headline and lower-third kicker. Preserve all media, conditioning, references, 24 fps and exact 45 seconds. Stage for review.', ...extra }),
  };
}

test('normal HTTP Generate → cold saved-package chat → restart → review/apply preserves 7 H3 shots and conditioning bytes', async t => {
  const ctx = await setup(t, { bound: true, coldBound: true });
  assert.equal(conversationPlanSchema.safeParse(chatPlanFromPackage(ctx.pkg)).success, false, 'this package cannot be round-tripped through the draft schema');
  await ctx.restart();
  ctx.setScript([{ name: 'production_read', args: {} }, { name: 'project_edit_package', args: correction(ctx.pkg) }]);
  const staged = await ctx.send();
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  assert.equal(staged.body.built, false);
  assert.equal(staged.body.conversation.plan, null);
  assert.ok(staged.body.conversation.packageEdit.diff.some(change => change.path === 'voice.enabled'));
  assert.deepEqual(ctx.store.read(ctx.pkg.id), ctx.pkg, 'review does not write the package');
  assert.match(JSON.stringify(ctx.requests[0]), /THE LAST SIGNAL/);
  assert.match(JSON.stringify(ctx.requests[0]), /Preserve this exact 45-second monologue/);
  assert.ok(ctx.requests[0].tools.some(tool => tool.function.name === 'project_edit_package'));
  await ctx.restart();
  const restored = await ctx.api(`/api/agent/chat/${conversationId}`);
  assert.deepEqual(restored.body.conversation.packageEdit, staged.body.conversation.packageEdit);
  const modelCount = ctx.requests.length;
  const applied = await ctx.send({ baseRevision: 1, action: 'build', turnId: 'turn_reviewed_apply_001', message: 'Apply the reviewed edits.' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.built, true);
  assert.equal(ctx.requests.length, modelCount, 'review/apply is deterministic, no fresh LLM draft');
  const next = applied.body.project.package;
  assert.equal(next.revision, 42);
  assert.deepEqual(next.assets, ctx.pkg.assets);
  assert.deepEqual(next.format, ctx.pkg.format);
  assert.deepEqual(next.duration, ctx.pkg.duration);
  assert.equal(applied.body.project.timeline.durationInFrames, 1080);
  assert.equal(next.voice.enabled, false); assert.equal(next.voice.engine, 'none');
  for (const scene of next.scenes) { assert.equal(scene.background.muted, false); assert.equal(scene.narration, undefined); }
  assert.equal(next.scenes[0].copy.headline, 'THE LAST SIGNAL'); assert.equal(next.scenes[0].copy.kicker, undefined);
  assert.deepEqual(next.scenes[0].foreground, []); assert.equal(next.scenes[1].copy.headline, undefined);
  assert.deepEqual(next.scenes[1].lower_third, { text: 'MARA VALE' });
  for (let i = 0; i < 6; i++) assert.equal(sha(readFileSync(join(ctx.runtimeDir, 'packages', 'assets', `a_dialogue_${i}.wav`))), sha(conditioning));
  assert.deepEqual(JSON.parse(readFileSync(join(ctx.runtimeDir, 'narration-revision-context', `${ctx.pkg.id}.42.json`))), JSON.parse(readFileSync(join(ctx.runtimeDir, 'narration-revision-context', `${ctx.pkg.id}.41.json`))));
  const replay = await ctx.send({ baseRevision: 1, action: 'build', turnId: 'turn_reviewed_apply_001' });
  assert.equal(replay.status, 200); assert.equal(replay.body.project.revision, 42);
  assert.equal(applied.body.conversation.lastPackageEdit.appliedRevision, 42);
});

test('new unbound editor conversation can correct and save the existing package in one normal turn', async t => {
  const ctx = await setup(t);
  ctx.setScript([{ name: 'project_edit_package', args: correction(ctx.pkg) }, { name: 'project_build', args: {} }]);
  const result = await ctx.send({ message: 'Apply and save the native-audio cleanup, preserving 24fps and exact 45 seconds.' });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.built, true);
  assert.equal(result.body.conversation.projectId, ctx.pkg.id);
  assert.deepEqual(result.body.project.package.assets, ctx.pkg.assets);
});

test('CAS refuses a concurrent package write during the model turn without losing media or the manual change', async t => {
  const ctx = await setup(t);
  ctx.setScript([{ name: 'project_edit_package', args: correction(ctx.pkg) }, { name: 'project_build', args: {} }]);
  ctx.onModel(() => ctx.store.save(ctx.pkg.id, { ...ctx.pkg, title: 'Manual title' }, 41));
  const result = await ctx.send();
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(ctx.store.read(ctx.pkg.id).title, 'Manual title');
  assert.equal(ctx.store.read(ctx.pkg.id).voice.enabled, true);
});

test('staged edit cannot apply after package revision changes or bind to a different package', async t => {
  const ctx = await setup(t);
  ctx.setScript([{ name: 'project_edit_package', args: correction(ctx.pkg) }]);
  assert.equal((await ctx.send()).status, 200);
  ctx.store.save(ctx.pkg.id, { ...ctx.pkg, title: 'Manual title' }, 41);
  const stale = await ctx.send({ action: 'build', baseRevision: 1, expectedPackageRevision: 42 });
  assert.equal(stale.status, 409);
  const mismatch = await ctx.send({ expectedPackageId: 'pkg_other', expectedPackageRevision: 42, baseRevision: 1 });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.code, 'EDIT_PACKAGE_MISMATCH');
  assert.equal(ctx.store.read(ctx.pkg.id).voice.enabled, true);
});

test('production intent and scoped targets guard the full package-edit diff', async t => {
  const ctx = await setup(t, { bound: true, intent: 'paused' });
  ctx.setScript([{ name: 'production_read', args: {} }, { name: 'project_edit_package', args: correction(ctx.pkg) }]);
  const result = await ctx.send();
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.built, false);
  assert.equal(result.body.conversation.trace.tools.find(tool => tool.name === 'project_edit_package').ok, false);
  assert.deepEqual(ctx.store.read(ctx.pkg.id), ctx.pkg);
});

test('bounded editor rejects unsupported generation/timing controls, locked scenes and unknown placements', () => {
  const pkg = savedFilm();
  for (const extra of [{ format: { fps: 30 } }, { assets: {} }, { duration: { targetFrames: 1350 } }]) assert.throws(() => applyChatPackageEdit(pkg, { ...correction(pkg), ...extra }), /supported/);
  assert.throws(() => applyChatPackageEdit(pkg, { packageId: pkg.id, expectedRevision: 41, edits: [{ sceneId: 's1', removeForegroundAssets: ['unknown'] }] }), /existing foreground/);
  const locked = structuredClone(pkg); locked.scenes[0].locked = true;
  assert.throws(() => applyChatPackageEdit(locked, correction(locked)), /locked/);
});

test('package edits cannot escape shot scope and a production build requires a same-turn read', async t => {
  const ctx = await setup(t, { bound: true });
  ctx.setScript([{ name: 'project_edit_package', args: correction(ctx.pkg) }]);
  const scoped = await ctx.send({ targets: { shotIds: ['s1'], lineIds: [] } });
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.conversation.trace.tools[0].ok, false);
  assert.deepEqual(ctx.store.read(ctx.pkg.id), ctx.pkg);
  ctx.setScript([{ name: 'project_edit_package', args: correction(ctx.pkg) }, { name: 'project_build', args: {} }]);
  const unread = await ctx.send({ baseRevision: 1 });
  assert.equal(unread.status, 200);
  assert.equal(unread.body.built, false);
  assert.equal(unread.body.conversation.trace.tools.find(tool => tool.name === 'project_build').code, 'READ_REQUIRED');
  assert.deepEqual(ctx.store.read(ctx.pkg.id), ctx.pkg);
});
