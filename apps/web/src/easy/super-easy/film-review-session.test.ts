// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperEasySession } from './session.ts';
import { createEasyStore } from '../store.ts';
import { createEasyApi } from '../api.ts';

const packageId = 'pkg_review', productionId = 'prod_review', runId = 'run_123456789abc', renderId = 'r_123456789abc';
const journal = { production: { id: productionId, packageId }, lastSequence: 2, events: [
  { productionId, sequence: 1, type: 'plan.proposed', data: { planHash: 'approved' } },
  { productionId, sequence: 2, type: 'action.state_changed', data: { productionId, kind: 'final', state: 'completed', runId, planHash: 'approved' } },
] };
const record = (status = 'stopped') => ({ repairId: 'repair_test', input: { packageId, expectedRevision: 4, renderId: runId, maxRepairs: 1 },
  currentRevision: 5, status, stage: 'render', reports: [], attempts: 1, renders: 1 });
async function harness(overrides = {}) {
  const store = createEasyStore({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  store.patch({ packageId, productionId, generate: { status: 'done' } });
  let saved = { id: packageId, revision: 4, scenes: [] }, local = structuredClone(saved), adopted = 0;
  const api = {
    getRun: async () => ({ run: { runId, productionId, packageId, revision: 4, status: 'done' } }),
    getPackage: async () => ({ package: saved }),
    getRunVideo: async () => new Blob(['original'], { type: 'video/mp4' }),
    compilePackage: async () => ({ timeline: { durationInFrames: 30 } }),
    getSavedRenderVideo: async () => ({ blob: new Blob(['repaired']), exportId: renderId }), ...overrides,
  };
  const host = { getPackage: () => local, adoptBuiltPackage: body => { local = body.package; adopted++; },
    editorStore: { saveState: () => ({ status: 'saved', acknowledgedRevision: local.revision, editSequence: 0, acknowledgedSequence: 0 }) } };
  const session = createSuperEasySession({ api, store, host, go() {} });
  await session.restoreFinalVideo(journal);
  return { session, api, store, host, adopted: () => adopted,
    edit: () => { saved = { ...saved, revision: 5 }; } };
}

test('final target is immutable run metadata, never parsed from an object URL', async () => {
  const h = await harness();
  assert.deepEqual(h.session.finalTarget(), { packageId, expectedRevision: 4, renderId: runId });
  const target = h.session.finalTarget(); target.expectedRevision = 100;
  assert.equal(h.session.finalTarget().expectedRevision, 4);
  h.session.stop();
});

test('changed revision invalidates old Download even when repair is blocked and output is missing', async () => {
  const h = await harness({ getSavedRenderVideo: async () => { throw Error('Missing output'); } });
  const previous = h.session.snapshot().finalVideo.url;
  h.edit();
  await assert.rejects(h.session.syncRepairedFilm(record()), /Missing output/);
  assert.equal(h.session.finalTarget(), null);
  assert.doesNotMatch(h.session.progressHtml(), /data-super-easy-download/);
  assert.equal(h.session.previousVideo(), previous);
  assert.equal(await (await fetch(previous)).text(), 'original');
  assert.equal(h.host.getPackage().revision, 5);
  assert.equal(h.store.get().exported.revision, null);
  h.session.stop(); await assert.rejects(fetch(previous));
});

test('verified repair export adopts compiled saved package, updates current Download, and retains previous video separately', async () => {
  const h = await harness(); const previous = h.session.snapshot().finalVideo.url;
  h.edit(); await h.session.syncRepairedFilm({ ...record('completed'), lastRenderId: renderId });
  assert.deepEqual(h.session.finalTarget(), { packageId, expectedRevision: 5, renderId });
  assert.equal(h.session.previousVideo(), previous);
  assert.equal(await (await fetch(h.session.snapshot().finalVideo.url)).text(), 'repaired');
  assert.match(h.session.progressHtml(), /data-super-easy-download/);
  assert.equal(h.store.get().exported.revision, 5);
  h.session.stop();
});

test('status claiming a different export cannot turn an unrelated export into repaired success', async () => {
  const h = await harness(); h.edit();
  await assert.rejects(h.session.syncRepairedFilm({ ...record(), lastRenderId: 'r_aaaaaaaaaaaa' }), /does not match/);
  assert.doesNotMatch(h.session.progressHtml(), /data-super-easy-download/);
  h.session.stop();
});

test('real artifact client refuses tampered repaired bytes before publishing a current Download', async () => {
  const api = createEasyApi(async path => {
    if (String(path).endsWith('/video')) return new Response('tampered', { headers: { 'x-comfyrizz-video-sha256': 'a'.repeat(64) } });
    return Response.json({ exportId: renderId, packageId, revision: 5, intent: 'final', videoSha256: 'a'.repeat(64),
      files: [{ bytes: 8 }], videoUrl: `/api/render/artifacts/${renderId}/video` });
  });
  const h = await harness({ getSavedRenderVideo: api.getSavedRenderVideo }); h.edit();
  await assert.rejects(h.session.syncRepairedFilm(record()), /bytes no longer match/);
  assert.equal(h.session.finalTarget(), null);
  assert.doesNotMatch(h.session.progressHtml(), /data-super-easy-download/);
  h.session.stop();
});

test('navigation or a package switch discards late compile and artifact results', async () => {
  for (const navigate of [true, false]) {
    const h = await harness(); h.edit();
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    h.api.compilePackage = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
    let current = true;
    const syncing = h.session.syncRepairedFilm(record(), () => current);
    await ready;
    if (navigate) current = false; else h.store.startNew();
    release({ timeline: {} }); await syncing;
    assert.equal(h.adopted(), 0);
    assert.equal(h.session.finalTarget(), null);
    h.session.stop();
  }
});

test('cold reconciliation discovers only the current revision export and never starts work', async () => {
  const h = await harness(); h.edit();
  const cold = createSuperEasySession({ api: h.api, store: h.store, host: h.host, go() {},
    run: () => { throw Error('No model or render starts on reload'); } });
  await cold.syncRepairedFilm();
  assert.deepEqual(cold.finalTarget(), { packageId, expectedRevision: 5, renderId });
  assert.match(cold.progressHtml(), /data-super-easy-download/);
  cold.stop(); h.session.stop();
});

test('concurrent reload and status reconciliation keep one stable verified download URL', async () => {
  const h = await harness(); h.edit();
  let downloads = 0;
  h.api.getSavedRenderVideo = async () => { downloads++; return { blob: new Blob(['verified']), exportId: renderId }; };
  await Promise.all([h.session.syncRepairedFilm(), h.session.syncRepairedFilm({ ...record('completed'), lastRenderId: renderId })]);
  const url = h.session.snapshot().finalVideo.url;
  await h.session.syncRepairedFilm({ ...record('completed'), lastRenderId: renderId });
  assert.equal(downloads, 1);
  assert.equal(h.session.snapshot().finalVideo.url, url);
  assert.equal(await (await fetch(url)).text(), 'verified');
  h.session.stop();
});

test('reopening durable repair status restores original verified bytes only as previous video', async () => {
  const h = await harness(); h.edit();
  const cold = createSuperEasySession({ api: h.api, store: h.store, host: h.host, go() {} });
  await cold.syncRepairedFilm({ ...record('completed'), lastRenderId: renderId });
  assert.equal(await (await fetch(cold.previousVideo())).text(), 'original');
  assert.equal(await (await fetch(cold.snapshot().finalVideo.url)).text(), 'repaired');
  assert.equal(cold.finalTarget().renderId, renderId);
  cold.stop(); h.session.stop();
});
