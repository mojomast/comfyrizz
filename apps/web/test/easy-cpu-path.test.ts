// UR26: This computer path.
//
// The path waits for the editor's derived preview, then moves to Review. It
// has no API dependency, so there is nothing to dispatch and nothing to spend.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY } from '../src/easy/copy.ts';
import { createEasyStore } from '../src/easy/store.ts';
import { isPreviewCompiled, runCpuGenerate, studioClipGate } from '../src/easy/cpu-path.ts';

function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

function makeStore(compute = 'cpu') {
  const store = createEasyStore({ storage: memoryStorage(), key: 'comfyrizz.easy.test' });
  store.replace({ ...store.get(), compute, generate: { status: 'idle' } });
  return store;
}

function makeHost({ compiled = true } = {}) {
  const listeners = new Set();
  const state = {
    doc: { editSequence: 4 },
    derived: compiled
      ? { timeline: { durationInFrames: 90 }, compiledSequence: 4 }
      : { timeline: null, compiledSequence: null },
  };
  const calls = {
    refreshClips: 0,
    startRun: 0,
    announcements: [],
  };
  const host = {
    editorStore: {
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async refreshClips() {
      calls.refreshClips += 1;
    },
    announce(text) {
      calls.announcements.push(text);
    },
    startRun() {
      calls.startRun += 1;
    },
    compile() {
      state.derived = { timeline: { durationInFrames: 90 }, compiledSequence: 4 };
      for (const listener of Array.from(listeners)) listener();
    },
    calls,
  };
  return host;
}

test('the CPU path waits for the preview and ends in review with zero startRun calls', async () => {
  const host = makeHost({ compiled: false });
  const store = makeStore('cpu');
  const steps = [];
  const pending = runCpuGenerate({ host, store, go: (step) => steps.push(step) });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, [], 'review waits for the derived preview');
  assert.equal(store.get().generate.status, 'running');
  assert.equal(host.calls.refreshClips, 1);

  host.compile();
  const result = await pending;

  assert.equal(result.ok, true);
  assert.deepEqual(steps, ['review']);
  assert.equal(host.calls.startRun, 0);
  assert.equal(store.get().generate.status, 'done');
  assert.deepEqual(host.calls.announcements, [COPY.generate.cpuReady]);
  store.flush();
});

test('an already compiled preview still ends in review exactly once', async () => {
  const host = makeHost({ compiled: true });
  const store = makeStore('cpu');
  const steps = [];
  const result = await runCpuGenerate({ host, store, go: (step) => steps.push(step) });

  assert.equal(result.ok, true);
  assert.deepEqual(steps, ['review']);
  assert.equal(host.calls.startRun, 0);
  assert.equal(host.calls.refreshClips, 1);
  assert.equal(store.get().generate.status, 'done');
  store.flush();
});

test('the timeout shows the CPU timeout text and does not go to review', async () => {
  const host = makeHost({ compiled: false });
  const store = makeStore('cpu');
  const steps = [];
  const result = await runCpuGenerate({
    host,
    store,
    go: (step) => steps.push(step),
    timeoutMs: 15,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'timeout');
  assert.equal(result.message, COPY.errors.cpuTimeout);
  assert.deepEqual(steps, []);
  assert.equal(store.get().generate.status, 'error');
  assert.ok(host.calls.announcements.includes(COPY.errors.cpuTimeout));
  assert.equal(host.calls.startRun, 0);
  store.flush();
});

test('the CPU path does nothing when compute is Google Colab', async () => {
  const host = makeHost({ compiled: false });
  const store = makeStore('colab');
  const steps = [];
  const result = await runCpuGenerate({ host, store, go: (step) => steps.push(step) });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-cpu');
  assert.deepEqual(steps, []);
  assert.equal(host.calls.refreshClips, 0);
  assert.equal(store.get().generate.status, 'idle');
  store.flush();
});

test('isPreviewCompiled requires a fresh timeline', () => {
  assert.equal(isPreviewCompiled({ derived: { timeline: {}, compiledSequence: 2 }, doc: { editSequence: 2 } }), true);
  assert.equal(isPreviewCompiled({ derived: { timeline: null, compiledSequence: null }, doc: { editSequence: 2 } }), false);
  assert.equal(isPreviewCompiled({ derived: { timeline: {}, compiledSequence: 1 }, doc: { editSequence: 2 } }), false);
});

test('This computer clips with no versions are kept, and a GPU clip still blocks', () => {
  const assets = {
    a_svg: { gen: { generator: 'llm-svg' } },
    a_gpu: { gen: { generator: 'flux3-klein' } },
  };
  const open = studioClipGate([
    { clipId: 'c1', assetId: 'a_svg', state: 'planned', takeCount: 0, sceneId: 's1' },
    { clipId: 'c2', assetId: 'a_gpu', state: 'planned', takeCount: 0, sceneId: 's2' },
  ], assets);
  assert.equal(open.ok, false);
  assert.equal(open.approved, 1);
  assert.equal(open.blocking.length, 1);
  assert.equal(open.blocking[0].clipId, 'c2');

  const kept = studioClipGate([
    { clipId: 'c1', assetId: 'a_svg', state: 'planned', takeCount: 0 },
    { clipId: 'c2', assetId: 'a_svg', state: 'approved', takeCount: 2 },
  ], assets);
  assert.equal(kept.ok, true);
  assert.equal(kept.approved, 2);
});
