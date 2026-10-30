import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEditorStore } from '../../src/editor/store.ts';
import { createAutosave } from '../../src/editor/autosave.ts';
import { savePackageRequest } from '../../src/editor/api.ts';
import { createMemoryDraftStore } from '../../src/editor/recovery.ts';

const packageAt = (id = 'pkg_native_save', revision = 5) => ({
  id, revision, format: { fps: 30, width: 1280, height: 720 },
  scenes: ['s1', 's2'].map(id => ({ id, layout: 'title', preferredFrames: 90, copy: { headline: 'MORNING STILL', kicker: 'Keep me' } })),
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('native commands use acknowledged HTTP revisions, retain edits during save, and stop on real 409', async t => {
  let stored = packageAt();
  const requests: any[] = [];
  let hold: ReturnType<typeof deferred> | null = null;
  let received = deferred();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    received.resolve();
    if (hold) await hold.promise;
    res.setHeader('content-type', 'application/json');
    if (body.baseRevision !== stored.revision) {
      res.writeHead(409).end(JSON.stringify({ error: 'conflict', currentRevision: stored.revision }));
      return;
    }
    stored = { ...body.package, revision: stored.revision + 1 };
    res.end(JSON.stringify({ revision: stored.revision, editSequence: body.editSequence }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const store = createEditorStore({ package: stored });
  store.noteSave({ type: 'ack', editSequence: 0, revision: 5 });
  const autosave = createAutosave(store, {
    schedule: () => 0, cancel: () => {}, drafts: createMemoryDraftStore(),
    save: payload => savePackageRequest((url, init) => fetch(`http://127.0.0.1:${address.port}${url}`, init), payload),
  });
  t.after(() => autosave.dispose());
  store.dispatch([{ type: 'DeleteScene', sceneId: 's2' }, { type: 'DuplicateScene', sceneId: 's1' }]);
  await autosave.flush();
  assert.equal(stored.revision, 6);
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1_2', copy: { headline: 'A SMALL PAUSE', kicker: 'Keep me' } });
  await autosave.flush();
  assert.equal(stored.revision, 7);
  store.dispatch({ type: 'SetPresenter', args: { scenes: { s1_2: 'off' } } });
  await autosave.flush();
  assert.equal(stored.revision, 8);
  assert.deepEqual(requests.map(request => request.baseRevision), [5, 6, 7]);
  assert.deepEqual(store.getState().doc.package, stored);
  assert.equal(store.saveState().acknowledgedRevision, 8);

  hold = deferred();
  received = deferred();
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1_2', copy: { headline: 'First typing' } });
  const saving = autosave.flush();
  await received.promise;
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1_2', copy: { headline: 'Newer typing', sub: 'Never lost' } });
  hold.resolve();
  await saving;
  assert.equal(stored.scenes[1].copy.headline, 'Newer typing');
  assert.deepEqual(store.getState().doc.package, stored);
  assert.deepEqual(requests.map(request => request.baseRevision), [5, 6, 7, 8, 9]);

  stored.revision += 1; // a different client really changed the persisted revision
  store.dispatch({ type: 'SetPresenter', args: { scenes: { s1_2: 'pip' } } });
  await autosave.flush();
  assert.equal(store.saveState().status, 'conflict');
  assert.equal(store.saveState().currentRevision, 11);
  assert.equal(store.getState().doc.package.scenes[1].presenter, 'pip');
  const count = requests.length;
  await autosave.flush();
  assert.equal(requests.length, count, 'conflict never retries over the external edit');
});

for (const sameId of [false, true]) {
  test(`late autosave ack cannot leak into ${sameId ? 'a reopened' : 'another'} package`, async () => {
    const store = createEditorStore({ package: packageAt() });
    const gate = deferred();
    const started = deferred();
    const requests: any[] = [];
    const autosave = createAutosave(store, {
      schedule: () => 0, cancel: () => {}, drafts: createMemoryDraftStore(),
      save: async payload => {
        requests.push(payload);
        if (requests.length === 1) { started.resolve(); await gate.promise; }
        return { ok: true, revision: payload.baseRevision + 1, editSequence: payload.editSequence };
      },
    });
    store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Old project' } });
    const saving = autosave.flush();
    await started.promise;
    store.replaceDocument({ package: packageAt(sameId ? 'pkg_native_save' : 'pkg_other', 20) });
    store.noteSave({ type: 'ack', editSequence: 0, revision: 20 });
    const revisions: Array<number | null> = [];
    const unsubscribe = store.subscribeSaveState(state => revisions.push(state.acknowledgedRevision));
    store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'New project edit' } });
    gate.resolve();
    await saving;
    assert.deepEqual(requests.map(request => request.baseRevision), [5, 20]);
    assert.equal(store.getState().doc.package.scenes[0].copy?.headline, 'New project edit');
    assert.equal(store.saveState().acknowledgedRevision, 21);
    assert.ok(!revisions.includes(6));
    unsubscribe(); autosave.dispose();
  });
}

test('native palette, chart and presenter edits share undo and do not mutate a prior save snapshot', () => {
  const pkg = {
    ...packageAt(),
    theme: { palette: ['#000000', '#111111', '#222222', '#ffffff'] },
    datasets: { d1: { values: [{ label: 'First', value: 4 }] } },
    scenes: [{ ...packageAt().scenes[0], data: { dataset: 'd1' }, background: { procedural: { pattern: 'mesh', palette: ['#000000', '#111111', '#222222'] } } }],
  };
  const store = createEditorStore({ package: pkg });
  const before = store.getState().doc.package;
  assert.equal(store.dispatch([
    { type: 'SetPalette', index: 1, color: '#abcdef' },
    { type: 'SetDatasetValue', sceneId: 's1', index: 0, value: 12 },
    { type: 'SetPresenter', args: { coverage: 'none', label: '' } },
  ]).ok, true);
  const edited = store.getState().doc.package as typeof pkg;
  assert.equal(edited.theme.palette[1], '#abcdef');
  assert.equal(edited.scenes[0].background.procedural.palette[1], '#abcdef');
  assert.equal(edited.datasets.d1.values[0].value, 12);
  assert.deepEqual(before, pkg);
  store.noteSave({ type: 'ack', editSequence: 1, revision: 6 });
  store.undo();
  assert.deepEqual(store.getState().doc.package, { ...pkg, revision: 6 });
  assert.equal(store.saveState().status, 'pending');
  store.redo();
  assert.deepEqual(store.getState().doc.package, { ...edited, revision: 6 });
});
