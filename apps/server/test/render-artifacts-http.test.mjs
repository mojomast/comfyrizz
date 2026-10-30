import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { seedMockContribution, approveMockContribution } from './helpers/comfy-contribution.mjs';

const token = 'render-artifact-contract-test-local-token';
const seed = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url)));
seed.id = 'pkg_artifacttest0001';
seed.scenes = [{ ...seed.scenes[0], foreground: [] }];
delete seed.scenes[0].transitionOut;
seed.assets = {};
const hash = b => createHash('sha256').update(b).digest('hex');

async function harness(t, render) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'render-artifact-'));
  let app, server, base;
  async function start() {
    app = createApp({ root: new URL('../../..', import.meta.url).pathname, runtimeDir, token, render });
    server = createServer(app.handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { app.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await start(); seedMockContribution(app.store, structuredClone(seed));
  approveMockContribution(app.takeStore, app.store.read(seed.id), app.store.dir);
  t.after(async () => { await stop(); rmSync(runtimeDir, { recursive: true, force: true }); });
  return { runtimeDir, get app() { return app; }, async restart() { await stop(); await start(); },
    request(path, body, authenticated = true) { return fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', origin: base, ...(authenticated ? { 'x-comfyrizz-token': token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }); } };
}

test('fresh final HTTP render publishes immutable receipt-bound access across restart and later edits', async t => {
  let release, entered;
  const ready = new Promise(r => { entered = r; }), wait = new Promise(r => { release = r; });
  const bytes = Buffer.from('contract renderer output; not a real movie');
  let stagedBefore, stagedAfter;
  const h = await harness(t, async (packagePath, output) => {
    stagedBefore = readFileSync(packagePath); entered(); await wait; stagedAfter = readFileSync(packagePath);
    writeFileSync(output, bytes); return { output, bytes: bytes.length, frames: 42, hash: 'contract' };
  });
  const original = h.app.store.read(seed.id);
  const pending = h.request('/api/render', { packageId: seed.id, baseRevision: original.revision });
  await Promise.race([ready, pending.then(async response => { throw new Error(`Render refused before entry: ${response.status} ${await response.clone().text()}`); })]);
  const changed = structuredClone(original); changed.title = 'Edited while rendering';
  h.app.store.save(seed.id, changed, original.revision);
  // The accepted staging copy, including its trusted media, is independent.
  writeFileSync(join(h.app.store.dir, original.assets.a_mock_comfy.file), 'later overwritten source');
  release(); const response = await pending; assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(stagedBefore, stagedAfter);
  const url = response.headers.get('x-comfyrizz-artifact-url'); assert.match(url, /^\/api\/render\/artifacts\/r_/);
  assert.equal(response.headers.get('x-comfyrizz-video-sha256'), hash(bytes));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  let metadata = await (await h.request(url)).json();
  assert.equal(metadata.revision, original.revision); assert.equal(metadata.preflight.final, true);
  assert.equal(metadata.videoSha256, hash(bytes));
  const latest = `/api/render/artifacts/latest?packageId=${seed.id}`;
  assert.equal((await h.request(latest)).status, 404, 'newer unexported edits cannot discover the older render');
  assert.equal((await h.request(metadata.videoUrl, undefined, false)).status, 401);
  const receipts = join(h.runtimeDir, '.comfy-provenance/renders');
  assert(readdirSync(receipts).includes(hash(bytes) + '.json'));
  await h.restart();
  assert.equal((await h.request(url)).status, 200);
  assert.deepEqual(Buffer.from(await (await h.request(metadata.videoUrl)).arrayBuffer()), bytes);
  const artifactPath = join(h.runtimeDir, 'renders', metadata.exportId + '.artifact.json');
  const artifactBytes = readFileSync(artifactPath), artifact = JSON.parse(artifactBytes);
  artifact.inputs.package.title = 'forged historical title'; writeFileSync(artifactPath, JSON.stringify(artifact));
  assert.equal((await h.request(url)).status, 404);
  writeFileSync(artifactPath, artifactBytes);
  const receipt = join(receipts, hash(bytes) + '.json'), receiptBytes = readFileSync(receipt);
  rmSync(receipt); assert.equal((await h.request(metadata.videoUrl)).status, 404);
  writeFileSync(receipt, receiptBytes);
  writeFileSync(join(h.runtimeDir, 'renders', metadata.exportId + '.mp4'), 'tampered');
  assert.equal((await h.request(url)).status, 404);
  assert.equal((await h.request(metadata.videoUrl)).status, 404);
});

test('current-revision discovery verifies exact bytes across restart and rejects later edits or tampering', async t => {
  const bytes = Buffer.from('synthetic edited render');
  const h = await harness(t, async (packagePath, output) => {
    writeFileSync(output, bytes); return { output, bytes: bytes.length, frames: 42, hash: 'contract' };
  });
  const pkg = h.app.store.read(seed.id);
  const rendered = await h.request('/api/render', { packageId: seed.id, baseRevision: pkg.revision });
  assert.equal(rendered.status, 200, await rendered.clone().text());
  const latest = `/api/render/artifacts/latest?packageId=${seed.id}`;
  assert.equal((await h.request(latest, undefined, false)).status, 401);
  assert.equal((await h.request('/api/render/artifacts/latest?packageId=pkg_other')).status, 404);
  await h.restart();
  const response = await h.request(latest); assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.revision, pkg.revision); assert.equal(saved.videoSha256, hash(bytes));
  const path = join(h.runtimeDir, 'renders', saved.exportId + '.mp4');
  writeFileSync(path, 'tampered'); assert.equal((await h.request(latest)).status, 404);
  writeFileSync(path, bytes);
  h.app.store.save(seed.id, { ...pkg, title: 'New unexported edit' }, pkg.revision);
  assert.equal((await h.request(latest)).status, 404);
});

test('missing staged generation evidence fails final publication; draft remains available without a receipt', async t => {
  const h = await harness(t, async (packagePath, output) => {
    rmSync(join(dirname(dirname(packagePath)), '.comfy-provenance'), { recursive: true, force: true });
    writeFileSync(output, 'draft bytes'); return { output, bytes: 11, frames: 1, hash: 'test' };
  });
  const body = { packageId: seed.id, baseRevision: seed.revision };
  const final = await h.request('/api/render', body); assert.equal(final.status, 500);
  assert.equal(readdirSync(join(h.runtimeDir, 'renders')).filter(n => n.endsWith('.artifact.json')).length, 0);
  const draft = await h.request('/api/render', { ...body, intent: 'draft' }); assert.equal(draft.status, 200);
  assert.equal(draft.headers.get('x-comfyrizz-artifact-url'), null);
});

test('a renderer returning old output cannot mint a new final receipt', async t => {
  const h = await harness(t, async (packagePath, output) => {
    const old = join(dirname(output), 'old.mp4'); writeFileSync(old, 'old bytes');
    return { output: old, bytes: 9, frames: 1, hash: 'test' };
  });
  const response = await h.request('/api/render', { packageId: seed.id, baseRevision: seed.revision });
  assert.equal(response.status, 500); assert.match((await response.json()).error, /different output path/);
  assert.equal(readdirSync(join(h.runtimeDir, 'renders')).filter(n => n.endsWith('.artifact.json')).length, 0);
});
