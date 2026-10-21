import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorStore } from '../../src/editor/store.ts';
import { createAutosave } from '../../src/editor/autosave.ts';
import { createMemoryDraftStore } from '../../src/editor/recovery.ts';

function editor() {
  return createEditorStore({
    package: {
      id: 'pkg_retry0000001',
      revision: 1,
      format: { fps: 30, width: 100, height: 100 },
      scenes: [{ id: 's1', layout: 'title', preferredFrames: 90, copy: { headline: 'Start' }, transitionOut: { type: 'none', frames: 0 } }],
    },
  });
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('flush retries the same editSequence after an offline failure', async () => {
  const store = editor();
  const calls: number[] = [];
  let offline = true;
  const autosave = createAutosave(store, {
    debounceMs: 5,
    drafts: createMemoryDraftStore(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    save: async payload => {
      calls.push(payload.editSequence);
      if (offline) throw new Error('network down');
      return { ok: true, revision: 3, editSequence: payload.editSequence };
    },
  });
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'While offline' } });
  await autosave.flush();
  assert.deepEqual(calls, [1]);
  assert.equal(store.saveStatus(), 'offline');
  assert.equal(store.getState().doc.package.scenes[0]?.copy?.headline, 'While offline');
  offline = false;
  await autosave.flush();
  assert.deepEqual(calls, [1, 1]);
  assert.equal(store.saveStatus(), 'saved');
  assert.equal(store.getState().doc.package.revision, 3);
  assert.equal(store.getState().doc.package.scenes[0]?.copy?.headline, 'While offline');
});

test('the subscriber does not hot-loop while offline, and a later flush retries', async () => {
  const store = editor();
  const calls: number[] = [];
  const autosave = createAutosave(store, {
    debounceMs: 5,
    drafts: createMemoryDraftStore(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    save: async payload => {
      calls.push(payload.editSequence);
      throw new Error('network down');
    },
  });
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Offline edit' } });
  await wait(60);
  assert.deepEqual(calls, [1]);
  assert.equal(store.saveStatus(), 'offline');
  await wait(60);
  assert.deepEqual(calls, [1]);
  await autosave.flush();
  assert.deepEqual(calls, [1, 1]);
  assert.equal(store.saveStatus(), 'offline');
});

test('a rejected save is not auto-looped, and a later edit saves on flush', async () => {
  const store = editor();
  const calls: number[] = [];
  let reject = true;
  const autosave = createAutosave(store, {
    debounceMs: 5,
    drafts: createMemoryDraftStore(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    save: async payload => {
      calls.push(payload.editSequence);
      if (reject) return { ok: false, status: 'rejected', error: 'invalid package' };
      return { ok: true, revision: 5, editSequence: payload.editSequence };
    },
  });
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Rejected first' } });
  await autosave.flush();
  assert.deepEqual(calls, [1]);
  assert.equal(store.saveStatus(), 'rejected');
  await wait(60);
  assert.deepEqual(calls, [1]);
  assert.equal(store.saveStatus(), 'rejected');
  reject = false;
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Accepted later' } });
  await autosave.flush();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(store.saveStatus(), 'saved');
  assert.equal(store.getState().doc.package.revision, 5);
});

test('conflict behaviour is unchanged: recovery copy, no extra saves while conflicted', async () => {
  const store = editor();
  const drafts = createMemoryDraftStore();
  const calls: number[] = [];
  const autosave = createAutosave(store, {
    debounceMs: 5,
    drafts,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    save: async payload => {
      calls.push(payload.editSequence);
      return { ok: false, status: 'conflict', currentRevision: 9 };
    },
  });
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Local' } });
  await autosave.flush();
  assert.deepEqual(calls, [1]);
  assert.equal(store.saveStatus(), 'conflict');
  const recovery = await drafts.get('recovery:pkg_retry0000001');
  assert.equal(recovery?.kind, 'recovery');
  await wait(60);
  assert.deepEqual(calls, [1]);
  await autosave.flush();
  assert.deepEqual(calls, [1]);
  assert.equal(store.saveStatus(), 'conflict');
  assert.equal(store.getState().doc.package.scenes[0]?.copy?.headline, 'Local');
});
