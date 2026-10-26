// UX06: the This computer preview is handed to Review as a preview, not as a
// finished MP4. The path is measured from the editor's derived preview; it
// never dispatches work and never invents a final artifact.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from './copy.ts';
import { createEasyStore } from './store.ts';
import { runCpuGenerate } from './cpu-path.ts';

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
  const store = createEasyStore({ storage: memoryStorage(), key: 'comfyrizz.easy.ux06' });
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
  const calls = { refreshClips: 0, startRun: 0, announcements: [] };
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

test('a compiled preview is reported as preview-ready, never as a finished video', async () => {
  const host = makeHost({ compiled: false });
  const store = makeStore('cpu');
  const steps = [];
  const pending = runCpuGenerate({ host, store, go: (step) => steps.push(step) });

  await new Promise((resolve) => setImmediate(resolve));
  host.compile();
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(result.step, 'review');
  assert.equal(result.previewReady, true);
  assert.equal(result.finalReady, false);
  assert.deepEqual(result.artifact, {
    kind: 'preview',
    compiledSequence: 4,
    editSequence: 4,
    playable: true,
  });
  assert.deepEqual(steps, ['review']);
  assert.equal(host.calls.startRun, 0);
  assert.deepEqual(host.calls.announcements, [COPY.generate.cpuReady]);
  store.flush();
});

test('a preview timeout is retryable, announced once, and stays out of Review', async () => {
  const host = makeHost({ compiled: false });
  const store = makeStore('cpu');
  const steps = [];
  const result = await runCpuGenerate({
    host,
    store,
    go: (step) => steps.push(step),
    timeoutMs: 10,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'timeout');
  assert.equal(result.retryable, true);
  assert.equal(result.message, COPY.errors.cpuTimeout);
  assert.deepEqual(steps, []);
  assert.equal(store.get().generate.status, 'error');
  assert.equal(host.calls.startRun, 0);
  store.flush();
});

test('a preview refresh failure is retryable and reports the real message', async () => {
  const host = makeHost();
  host.refreshClips = async () => {
    throw new Error('The shot list could not be read.');
  };
  const store = makeStore('cpu');
  const steps = [];
  const result = await runCpuGenerate({ host, store, go: (step) => steps.push(step) });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'refresh-failed');
  assert.equal(result.retryable, true);
  assert.equal(result.message, 'The shot list could not be read.');
  assert.deepEqual(steps, []);
  assert.equal(store.get().generate.status, 'error');
  store.flush();
});
