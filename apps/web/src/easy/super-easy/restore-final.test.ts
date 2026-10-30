// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { completedFinalRun } from './restore-final.ts';
import { createSuperEasySession } from './session.ts';
import { createEasyStore } from '../store.ts';

const productionId = 'prod_restore', packageId = 'pkg_restore', runId = 'run_123456789abc';
function journal() {
  return { production: { id: productionId, packageId }, lastSequence: 2, events: [
    { productionId, sequence: 1, type: 'plan.proposed', data: { planHash: 'approved' } },
    { productionId, sequence: 2, type: 'action.state_changed', data: { productionId, kind: 'final', state: 'completed', runId, planHash: 'approved' } },
  ] };
}
function harness(overrides = {}) {
  const store = createEasyStore({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  store.patch({ productionId, packageId, generate: { status: 'done' } });
  const calls = [];
  const api = {
    async getRun(id) { calls.push(['run', id]); return { run: { runId, productionId, packageId, status: 'done', revision: 4 } }; },
    async getPackage(id) { calls.push(['package', id]); return { package: { id: packageId, revision: 4 } }; },
    async getRunVideo(id) { calls.push(['video', id]); return new Blob(['verified video bytes'], { type: 'video/mp4' }); },
    ...overrides,
  };
  const session = createSuperEasySession({ api, store, host: {}, go() {}, run: () => { throw Error('Reopen must never generate'); } });
  return { session, store, calls };
}

test('cold completed final-run session restores Download from read-only authenticated APIs', async () => {
  const h = harness();
  await h.session.restoreFinalVideo(journal());
  assert.equal(h.session.status(), 'done');
  assert.match(h.session.progressHtml(), /data-super-easy-download/);
  const url = h.session.snapshot().finalVideo.url;
  assert.equal(await (await fetch(url)).text(), 'verified video bytes');
  await h.session.restoreFinalVideo(journal());
  assert.deepEqual(h.calls, [['run', runId], ['package', packageId], ['video', runId]]);
  h.session.stop();
  await assert.rejects(fetch(url), 'teardown revokes the owned object URL');
});

test('incomplete, cross-project, non-final, stale-plan and newer failed journals do not restore older successes', () => {
  const variants = [];
  let value = journal(); value.gap = true; variants.push(value);
  value = journal(); value.events[1].sequence = 4; variants.push(value);
  value = journal(); value.production.packageId = 'other'; variants.push(value);
  value = journal(); value.events[1].data.kind = 'shot.generate'; variants.push(value);
  value = journal(); value.events[1].data.state = 'failed'; variants.push(value);
  value = journal(); value.events.push({ productionId, sequence: 3, type: 'plan.proposed', data: { planHash: 'newer' } }); value.lastSequence = 3; variants.push(value);
  value = journal(); value.events.push({ productionId, sequence: 3, type: 'action.state_changed', data: { productionId, kind: 'final', state: 'failed', runId: null } }); value.lastSequence = 3; variants.push(value);
  for (const snapshot of variants) assert.equal(completedFinalRun(snapshot, { productionId, packageId }), null);
});

test('wrong run identity, newer package edits and rejected receipt prevent a finished movie claim', async () => {
  for (const overrides of [
    { getRun: async () => ({ run: { runId, productionId: 'other', packageId, status: 'done', revision: 4 } }) },
    { getPackage: async () => ({ package: { id: packageId, revision: 5 } }) },
    { getRunVideo: async () => { throw Error('Movie receipt does not match'); } },
  ]) {
    const h = harness(overrides);
    await h.session.restoreFinalVideo(journal());
    assert.equal(h.session.status(), 'error');
    assert.doesNotMatch(h.session.progressHtml(), /data-super-easy-download/);
    assert.equal(h.session.failure().retryable, false);
  }
});

test('stopping or switching productions while a saved video loads discards late bytes', async () => {
  for (const stop of [true, false]) {
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const h = harness({ getRunVideo: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
    const restoring = h.session.restoreFinalVideo(journal());
    await waiting;
    if (stop) h.session.stop(); else h.store.patch({ productionId: 'prod_other' });
    release(new Blob(['late bytes']));
    await restoring;
    assert.doesNotMatch(h.session.progressHtml(), /data-super-easy-download/);
  }
});
