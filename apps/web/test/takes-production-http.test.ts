// @ts-nocheck -- Node-only integration: real HTTP app/journal, synthetic local media and renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../server/src/app.mjs';
import { genFingerprint } from '../../server/src/takes/model.mjs';
import { collectMockContribution } from '../../server/test/helpers/comfy-contribution.mjs';
import { createTakesApi } from '../src/takes/api.ts';
import { keepVersion } from '../src/easy/shot-card.ts';

async function fixture(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'review-production-http-'));
  const renders = [];
  let backendCalls = 0;
  const token = 'review-http-test-token-0123456789';
  const app = createApp({
    runtimeDir, token,
    backendFactory: async () => { backendCalls++; throw new Error('Review must not generate'); },
    render: async (packagePath, output) => {
      renders.push(JSON.parse(readFileSync(packagePath, 'utf8')));
      writeFileSync(output, 'synthetic-render-test-output');
      return { output, bytes: 28, frames: 360, hash: 'synthetic-render' };
    },
  });
  const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url), 'utf8'));
  pkg.assets = {};
  pkg.theme = { palette: ['#000000', '#ffffff'], font: 'Inter' };
  pkg.voice.enabled = false;
  pkg.duration.targetFrames = 360;
  pkg.renders = [];
  pkg.scenes = ['NEON AFTER RAIN', 'LIGHT IN MOTION', 'MAKE IT ELECTRIC'].map((headline, i) => ({
    id: `shot${i + 1}`, layout: 'title', variant: 'centered', preferredFrames: 120,
    copy: { headline }, data: null, locked: false,
  }));
  for (const scene of pkg.scenes) {
    const { id } = collectMockContribution(pkg, app.store.dir, { sceneId: scene.id, id: `a_${scene.id}` });
    delete scene.foreground;
    scene.background = { asset: id, fit: 'cover', loop: false };
  }
  app.store.seed(pkg);
  // Ingested takes retain resolved job inputs, while the package retains the
  // authored request. Their recorded source fingerprint keeps them fresh.
  for (const assetId of ['a_shot1', 'a_shot2']) {
    const asset = pkg.assets[assetId];
    app.takeStore.addTake(pkg.id, assetId, {
      srcPath: join(app.store.dir, asset.file), media: asset.media,
      gen: { ...asset.gen, prompt: 'resolved job prompt', inputs: { ...asset.gen.inputs, width: 1088 } },
      sourceGenFingerprint: genFingerprint(asset.gen, pkg.assets),
    });
  }
  // Real adoption on GET creates unreviewed takes; no approved fixture metadata.
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await app.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
  const apiFetch = async (path, init = {}) => {
    const response = await fetch(base + path, {
      ...init, headers: { origin: base, 'x-comfyrizz-token': token, ...init.headers },
    });
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, status: response.status });
    return response;
  };
  const post = (path, body) => apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const created = await post('/api/productions', {
    commandId: 'create-review-production', kind: 'production.create',
    expected: { productionRevision: 0, packageRevision: pkg.revision },
    payload: { conversationId: 'conv_review_http', packageId: pkg.id },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { productionId } = await created.json();
  const api = createTakesApi({ apiFetch });
  return { app, pkg, api, apiFetch, post, productionId, calls, renders, backendCalls: () => backendCalls };
}

test('normal Keep after a copy edit approves three bound clips and exports existing media without generation', async t => {
  const ctx = await fixture(t);
  const { app, pkg, api, post, apiFetch, productionId } = ctx;
  const before = await api.listClips(pkg.id);
  assert.equal(before.productionId, productionId);
  assert.equal(before.clips.length, 3);
  assert.ok(before.clips.every(clip => clip.state === 'review'));
  const edited = structuredClone(app.store.read(pkg.id));
  edited.scenes[2].copy.headline = 'KEEP IT ELECTRIC';
  const saved = await apiFetch(`/api/package/${pkg.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: edited.revision, package: edited }),
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const revised = structuredClone(app.store.read(pkg.id));
  const reviewed = await api.listClips(pkg.id);
  assert.deepEqual(revised.assets, pkg.assets);
  const render = async id => {
    const snapshot = await (await apiFetch(`/api/productions/${productionId}`)).json();
    return post('/api/render', { packageId: pkg.id, baseRevision: revised.revision,
      commandId: id, expected: { productionRevision: snapshot.revision }, mixAudio: false });
  };
  const blocked = await render('render-before-review');
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, 'RENDER_GATE_BLOCKED');
  let refreshes = 0;
  const host = { refreshClips: async () => { refreshes++; await api.listClips(pkg.id); } };
  await keepVersion({ packageId: pkg.id, clipId: reviewed.clips[0].clipId,
    takeId: reviewed.clips[0].selected, takesApi: api, host });
  const partial = await api.listClips(pkg.id);
  assert.equal(partial.clips.filter(clip => clip.state === 'approved').length, 1);
  assert.equal((await render('render-partial-review')).status, 409);
  // Two explicit Keep actions at once still use consecutive production revisions.
  await Promise.all(reviewed.clips.slice(1).map(clip => keepVersion({
    packageId: pkg.id, clipId: clip.clipId, takeId: clip.selected, takesApi: api, host,
  })));
  assert.equal(refreshes, 3);
  assert.ok((await api.listClips(pkg.id)).clips.every(clip => clip.state === 'approved'));
  assert.deepEqual(app.store.read(pkg.id), revised, 'Keep does not rewrite the copy, timing or generated assets');
  const commands = ctx.calls.filter(call => /\/(select|verdict)$/.test(call.path));
  assert.equal(commands.length, 6);
  assert.deepEqual(commands.map(call => call.body.expected.productionRevision), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(commands.map(call => call.body.commandId)).size, 6);
  assert.ok(commands.every(call => call.status === 200 && call.body.commandId === call.body.idempotencyKey));
  assert.ok(commands.every(call => call.body.expected.packageRevision === revised.revision));
  const rendered = await render('render-revised-copy');
  assert.equal(rendered.status, 200, await rendered.clone().text());
  assert.equal(ctx.renders.length, 1);
  assert.equal(ctx.renders[0].scenes[2].copy.headline, 'KEEP IT ELECTRIC');
  assert.deepEqual(ctx.renders[0].assets, revised.assets);
  assert.equal(ctx.backendCalls(), 0);
});

test('bound review preserves stale package, selection and production conflicts, including same-take copy edits', async t => {
  const ctx = await fixture(t);
  const { app, pkg, api, apiFetch, post, productionId } = ctx;
  const { clips } = await api.listClips(pkg.id);
  const clip = clips[0];
  const changed = structuredClone(app.store.read(pkg.id));
  changed.scenes[0].copy.headline = 'A NEW COPY EDIT';
  app.store.save(pkg.id, changed, changed.revision);
  await assert.rejects(api.select(pkg.id, clip.clipId, clip.selected), { status: 409, code: 'REVISION_CONFLICT' });
  assert.equal(app.takeStore.read(pkg.id).clips[clip.assetId].takes[0].verdict, 'unreviewed');
  await api.getTakes(pkg.id, clip.clipId);
  await api.select(pkg.id, clip.clipId, clip.selected);
  const revision = app.store.read(pkg.id).revision;
  const snapshot = await (await apiFetch(`/api/productions/${productionId}`)).json();
  const path = `/api/package/${pkg.id}/clips/${encodeURIComponent(clip.clipId)}/verdict`;
  for (const [name, expected, code] of [
    ['stale-package', { productionRevision: snapshot.revision, packageRevision: revision - 1, selected: clip.selected }, 'REVISION_CONFLICT'],
    ['stale-selection', { productionRevision: snapshot.revision, packageRevision: revision, selected: null }, 'SELECTION_CONFLICT'],
    ['stale-production', { productionRevision: snapshot.revision - 1, packageRevision: revision, selected: clip.selected }, 'REVISION_CONFLICT'],
  ]) {
    const response = await post(path, { commandId: name, verdict: 'approved', takeId: clip.selected, expected });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, code);
  }
  const missingIdentity = await post(path, { verdict: 'approved', takeId: clip.selected });
  assert.equal(missingIdentity.status, 400);
  assert.equal((await missingIdentity.json()).code, 'MISSING_COMMAND_ID');
  assert.ok((await api.listClips(pkg.id)).clips.every(clip => clip.state === 'review'));
  assert.equal(ctx.renders.length, 0);
  assert.equal(ctx.backendCalls(), 0);
});

test('bound select advances package CAS before verdict; Revert is journaled and an identical replay is safe', async t => {
  const ctx = await fixture(t);
  const { app, pkg, api, apiFetch, post, productionId } = ctx;
  const first = (await api.listClips(pkg.id)).clips[0];
  const source = join(app.store.dir, 'alternate.png');
  writeFileSync(source, 'different synthetic take');
  const asset = pkg.assets[first.assetId];
  const alternate = app.takeStore.addTake(pkg.id, first.assetId, {
    srcPath: source, media: asset.media, gen: asset.gen,
    sourceGenFingerprint: genFingerprint(asset.gen, pkg.assets),
  });
  await api.getTakes(pkg.id, first.clipId);
  await api.select(pkg.id, first.clipId, alternate.takeId);
  assert.equal(app.store.read(pkg.id).revision, pkg.revision + 1);
  await api.verdict(pkg.id, first.clipId, 'approved', { takeId: alternate.takeId });
  const verdict = ctx.calls.find(call => call.path.endsWith('/verdict'));
  assert.equal(verdict.body.expected.packageRevision, pkg.revision + 1);
  assert.equal(verdict.body.expected.productionRevision, 2);
  await api.select(pkg.id, first.clipId, first.selected);
  const reverted = await api.revert(pkg.id, first.clipId);
  assert.equal(reverted.takeId, alternate.takeId);
  const command = ctx.calls.findLast(call => call.path.endsWith('/revert'));
  const replay = await post(command.path, command.body);
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal((await replay.json()).duplicate, true);
  const snapshot = await (await apiFetch(`/api/productions/${productionId}`)).json();
  assert.equal(snapshot.revision, 5);
  const events = await (await apiFetch(`/api/productions/${productionId}/events`)).json();
  assert.equal(events.events.filter(event => event.type === 'take.selected').length, 3);
  assert.equal(events.events.filter(event => event.type === 'clip.reviewed').length, 1);
});
