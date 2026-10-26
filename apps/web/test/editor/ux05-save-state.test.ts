import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorStore } from '../../src/editor/store.ts';
import { createAutosave, type SavePayload, type SaveResult } from '../../src/editor/autosave.ts';
import { createMemoryDraftStore } from '../../src/editor/recovery.ts';
import { validateSaveState, type SaveState } from '../../src/editor/save-state.ts';

function editor() {
  return createEditorStore({
    package: {
      id: 'pkg_ux05save001',
      revision: 1,
      format: { fps: 30, width: 100, height: 100 },
      scenes: [{
        id: 's1',
        layout: 'title',
        preferredFrames: 90,
        copy: { headline: 'Start' },
        transitionOut: { type: 'none', frames: 0 },
      }],
    },
  });
}

function manualAutosave(
  store: ReturnType<typeof editor>,
  save: (payload: SavePayload) => Promise<SaveResult>,
) {
  return createAutosave(store, {
    debounceMs: 5,
    drafts: createMemoryDraftStore(),
    schedule: () => 0,
    cancel: () => {},
    save,
  });
}

test('save-state subscription deduplicates and never calls a local draft Saved', () => {
  const store = editor();
  const seen: SaveState[] = [];
  const unsubscribe = store.subscribeSaveState(state => seen.push(state));

  const initial = store.saveState();
  assert.equal(initial.status, 'offline');
  assert.equal(initial.acknowledgedRevision, null);
  assert.deepEqual(validateSaveState(initial), { ok: true, errors: [] });

  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Draft' } });
  assert.deepEqual(seen.map(state => state.status), ['pending']);

  store.noteSave({ type: 'start' });
  assert.equal(seen.length, 1, 'a repeated saving state is not republished');

  store.noteSave({ type: 'ack', editSequence: 1, revision: 2 });
  assert.equal(seen.at(-1)?.status, 'saved');
  assert.equal(seen.at(-1)?.acknowledgedSequence, 1);
  assert.equal(seen.at(-1)?.acknowledgedRevision, 2);

  const published = seen.length;
  store.setSession({ zoom: 2 });
  store.preview({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Preview' } });
  assert.equal(seen.length, published, 'session and preview changes do not publish save state');
  for (const state of seen) assert.deepEqual(validateSaveState(state), { ok: true, errors: [] });

  unsubscribe();
  store.noteSave({ type: 'offline' });
  assert.equal(seen.length, published);
});

test('edit, save, undo, save, redo, save advances the revision from the acknowledgement', async () => {
  const store = editor();
  const payloads: SavePayload[] = [];
  let revision = 1;
  const autosave = manualAutosave(store, async payload => {
    payloads.push(payload);
    revision += 1;
    return { ok: true, revision, editSequence: payload.editSequence };
  });

  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Revisioned' } });
  await autosave.flush();
  assert.deepEqual(payloads.map(payload => [payload.baseRevision, payload.editSequence]), [[1, 1]]);
  assert.equal(store.saveState().status, 'saved');
  assert.equal(store.saveState().acknowledgedRevision, 2);

  store.undo();
  assert.equal(store.getState().doc.editSequence, 2);
  assert.equal(store.getState().doc.package.revision, 2, 'undo keeps the acknowledged revision');
  assert.equal(store.saveState().acknowledgedRevision, 2);
  assert.equal(store.saveState().status, 'pending');
  await autosave.flush();
  assert.deepEqual(payloads.map(payload => [payload.baseRevision, payload.editSequence]), [[1, 1], [2, 2]]);
  assert.equal(store.saveState().acknowledgedRevision, 3);

  store.redo();
  assert.equal(store.getState().doc.editSequence, 3);
  assert.equal(store.getState().doc.package.revision, 3);
  await autosave.flush();
  assert.deepEqual(payloads.map(payload => [payload.baseRevision, payload.editSequence]), [[1, 1], [2, 2], [3, 3]]);
  assert.equal(store.getState().doc.package.scenes[0]?.copy?.headline, 'Revisioned');
  assert.equal(store.getState().doc.package.revision, 4);
  assert.equal(store.saveState().acknowledgedRevision, 4);
  assert.equal(store.saveState().acknowledgedSequence, 3);
  assert.equal(store.saveState().status, 'saved');
});

test('a second-tab edit still surfaces a conflict with the server revision', async () => {
  const store = editor();
  const bases: number[] = [];
  let serverRevision = 1;
  const autosave = manualAutosave(store, async payload => {
    bases.push(payload.baseRevision);
    if (payload.baseRevision !== serverRevision) {
      return { ok: false, status: 'conflict', currentRevision: serverRevision };
    }
    serverRevision += 1;
    return { ok: true, revision: serverRevision, editSequence: payload.editSequence };
  });

  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Mine' } });
  await autosave.flush();
  assert.deepEqual(bases, [1]);
  assert.equal(store.saveState().acknowledgedRevision, 2);

  serverRevision = 9;
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Mine again' } });
  await autosave.flush();
  assert.deepEqual(bases, [1, 2]);
  const conflicted = store.saveState();
  assert.equal(conflicted.status, 'conflict');
  assert.equal(conflicted.currentRevision, 9);
  assert.equal(conflicted.acknowledgedRevision, 2);
  assert.equal(conflicted.acknowledgedSequence, 1);
  assert.equal(store.saveStatus(), 'conflict');
  assert.deepEqual(validateSaveState(conflicted), { ok: true, errors: [] });

  await autosave.flush();
  assert.deepEqual(bases, [1, 2], 'a conflict does not loop saves');
  assert.equal(store.saveState().status, 'conflict');
});

test('an offline save publishes a local draft, never Saved', async () => {
  const store = editor();
  const autosave = manualAutosave(store, async () => {
    throw new Error('network down');
  });
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Offline' } });
  await autosave.flush();
  const state = store.saveState();
  assert.equal(state.status, 'offline');
  assert.equal(state.acknowledgedRevision, null);
  assert.equal(state.error, null);
  assert.deepEqual(validateSaveState(state), { ok: true, errors: [] });
});

test('a held or rejected save reports the server reason and never Saved', async () => {
  const store = editor();
  const autosave = manualAutosave(store, async () => {
    return { ok: false, status: 'rejected', error: 'invalid package' };
  });
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Rejected' } });
  await autosave.flush();
  const state = store.saveState();
  assert.equal(state.status, 'rejected');
  assert.equal(state.error, 'invalid package');
  assert.equal(state.acknowledgedSequence, 0);
  assert.equal(state.acknowledgedRevision, null);
  assert.notEqual(state.status, 'saved');
  assert.deepEqual(validateSaveState(state), { ok: true, errors: [] });
  assert.equal(store.statusText(), 'Save rejected: invalid package');
});
