import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorStore } from '../../src/editor/store.ts';
import { createAutosave, type SaveResult } from '../../src/editor/autosave.ts';
import { createMemoryDraftStore } from '../../src/editor/recovery.ts';
import { createCompileClient, savePackageRequest } from '../../src/editor/api.ts';

function editor() {
  return createEditorStore({
    package: {
      id: 'pkg_autosave0001',
      revision: 1,
      format: { fps: 30, width: 100, height: 100 },
      scenes: [{ id: 's1', layout: 'title', preferredFrames: 90, copy: { headline: 'Start' }, transitionOut: { type: 'none', frames: 0 } }],
    },
  });
}

test('typing during autosave keeps the newer edit pending until its own ack', async () => {
  const store = editor();
  const drafts = createMemoryDraftStore();
  let release: (result: SaveResult) => void = () => {};
  const calls: number[] = [];
  const autosave = createAutosave(store, {
    debounceMs: 5,
    drafts,
    schedule: fn => { fn(); return 0; },
    cancel: () => {},
    save: async payload => {
      calls.push(payload.editSequence);
      if (payload.editSequence === 1) return new Promise(resolve => { release = resolve; });
      assert.equal(store.saveStatus(), 'pending');
      assert.equal(store.acknowledgedSequence(), 1);
      assert.equal(store.getState().doc.package.scenes[0]?.copy?.headline, 'AB');
      return { ok: true, revision: 3, editSequence: payload.editSequence };
    },
  });
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'A' } });
  const first = autosave.flush();
  await new Promise(resolve => setTimeout(resolve, 0));
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'AB' } });
  release({ ok: true, revision: 2, editSequence: 1 });
  await first;
  await autosave.flush();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(store.getState().doc.package.scenes[0]?.copy?.headline, 'AB');
  assert.equal(store.saveStatus(), 'saved');
  assert.equal(store.getState().doc.package.revision, 3);
});

test('a revision conflict keeps a recovery copy and the local document', async () => {
  const store = editor();
  const drafts = createMemoryDraftStore();
  const autosave = createAutosave(store, {
    drafts,
    schedule: fn => { fn(); return 0; },
    cancel: () => {},
    save: async () => ({ ok: false, status: 'conflict', currentRevision: 9 }),
  });
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Local' } });
  await autosave.flush();
  assert.equal(store.saveStatus(), 'conflict');
  assert.equal(store.statusText(), 'Revision conflict. A recovery copy is kept on this device');
  assert.equal(store.getState().doc.package.scenes[0]?.copy?.headline, 'Local');
  const recovery = await drafts.get('recovery:pkg_autosave0001');
  assert.equal(recovery?.kind, 'recovery');
  assert.equal(recovery?.doc.package.scenes[0]?.copy?.headline, 'Local');
  store.dispatch({ type: 'SetCaptionText', sceneId: 's1', index: 0, text: 'Still local' });
  await autosave.flush();
  assert.equal(store.getState().doc.editor.captionOverrides[0]?.text, 'Still local');
  assert.equal(store.saveStatus(), 'conflict');
});

test('offline keeps the document and says so', async () => {
  const store = editor();
  const autosave = createAutosave(store, {
    drafts: createMemoryDraftStore(),
    schedule: fn => { fn(); return 0; },
    cancel: () => {},
    save: async () => { throw new Error('network down'); },
  });
  store.dispatch({ type: 'TrimScene', sceneId: 's1', preferredFrames: 80 });
  await autosave.flush();
  assert.equal(store.saveStatus(), 'offline');
  assert.match(store.statusText(), /Offline/);
  assert.equal(store.getState().doc.package.scenes[0]?.preferredFrames, 80);
});

test('a rejected save keeps the edit, and a later edit can save', async () => {
  const store = editor();
  const calls: number[] = [];
  const autosave = createAutosave(store, {
    drafts: createMemoryDraftStore(),
    schedule: fn => { fn(); return 0; },
    cancel: () => {},
    save: async payload => {
      calls.push(payload.editSequence);
      if (payload.editSequence === 1) return { ok: false, status: 'rejected', error: 'invalid package' };
      assert.equal(payload.package.scenes[0]?.copy?.headline, 'Kept then saved');
      return { ok: true, revision: 4, editSequence: payload.editSequence };
    },
  });
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Kept locally' } });
  await autosave.flush();
  assert.equal(calls.length, 1);
  assert.equal(store.saveStatus(), 'rejected');
  assert.equal(store.statusText(), 'Save rejected: invalid package');
  assert.equal(store.getState().doc.package.scenes[0]?.copy?.headline, 'Kept locally');
  assert.equal(store.acknowledgedSequence(), 0);
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Kept then saved' } });
  await autosave.flush();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(store.saveStatus(), 'saved');
  assert.equal(store.getState().doc.package.revision, 4);
  assert.equal(store.getState().doc.package.scenes[0]?.copy?.headline, 'Kept then saved');
});

test('undo after a rejected save restores the document and does not stay on saving', async () => {
  const store = editor();
  const calls: number[] = [];
  const autosave = createAutosave(store, {
    drafts: createMemoryDraftStore(),
    schedule: fn => { fn(); return 0; },
    cancel: () => {},
    save: async payload => {
      calls.push(payload.package.scenes[0]?.preferredFrames ?? 0);
      return { ok: false, status: 'rejected', error: 'invalid package' };
    },
  });
  store.dispatch({ type: 'TrimScene', sceneId: 's1', preferredFrames: 5 });
  await autosave.flush();
  assert.equal(store.saveStatus(), 'rejected');
  assert.equal(store.statusText(), 'Save rejected: invalid package');
  assert.equal(store.getState().doc.package.scenes[0]?.preferredFrames, 5);
  store.undo();
  await autosave.flush();
  assert.equal(store.getState().doc.package.scenes[0]?.preferredFrames, 90);
  assert.equal(store.saveStatus(), 'rejected');
  assert.equal(store.statusText(), 'Save rejected: invalid package');
  assert.deepEqual(calls, [5, 90]);
  assert.equal(store.acknowledgedSequence(), 0);
});

test('a 422 keeps the validation detail on the rejected result', async () => {
  const result = await savePackageRequest(async () => new Response(JSON.stringify({
    error: 'invalid package',
    details: [{ path: '/scenes/0/preferredFrames', message: 'must be integer' }],
  }), { status: 422, headers: { 'content-type': 'application/json' } }), {
    packageId: 'pkg_autosave0001',
    baseRevision: 1,
    package: { id: 'pkg_autosave0001', scenes: [] },
    editor: { version: 1, captionOverrides: [] },
    editSequence: 1,
  });
  assert.equal(result.ok, false);
  if (!result.ok && result.status === 'rejected') {
    assert.equal(result.error, 'invalid package: /scenes/0/preferredFrames must be integer');
  } else {
    assert.fail(`expected rejected, got ${JSON.stringify(result)}`);
  }
});

test('out-of-order compile responses are dropped', async () => {
  let release: (value: { revision: number | null; editSequence: number | null; inputHash: string; timeline: unknown }) => void = () => {};
  const client = createCompileClient(async body => {
    const sequence = body.editSequence as number;
    if (sequence === 1) return new Promise(resolve => { release = resolve; });
    return { revision: 1, editSequence: sequence, inputHash: 'new', timeline: { sequence } };
  });
  const first = client.compile({ editSequence: 1 });
  const second = await client.compile({ editSequence: 2 });
  assert.equal(second.dropped, false);
  if (!second.dropped) assert.equal(second.response.editSequence, 2);
  release({ revision: 1, editSequence: 1, inputHash: 'old', timeline: { sequence: 1 } });
  const stale = await first;
  assert.equal(stale.dropped, true);
  if (stale.dropped) assert.equal(stale.reason, 'superseded');
});

test('an older edit sequence is dropped even when it is the latest request', async () => {
  const client = createCompileClient(async body => ({
    revision: 1,
    editSequence: body.editSequence as number,
    inputHash: 'h',
    timeline: {},
  }));
  const newer = await client.compile({ editSequence: 4 });
  assert.equal(newer.dropped, false);
  const older = await client.compile({ editSequence: 2 });
  assert.equal(older.dropped, true);
  if (older.dropped) assert.equal(older.reason, 'out-of-order');
});
