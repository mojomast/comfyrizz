// UX05 regression: undo after a successful autosave must not restore an obsolete CAS revision.
//
// Original audit finding (P1): the store kept the acknowledged server revision
// inside undoable content, so undo -> save sent a stale revision and conflicted.
//
// The server here is a faithful compare-and-set fake (accept only when
// baseRevision equals the stored revision). It is the editor's real store and
// autosave module under test, with no DOM and no timers. The browser version of
// this check lives in apps/web/e2e/acceptance/ux05-undo-save.spec.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEditorStore } from '../../apps/web/src/editor/store.ts';
import { createAutosave } from '../../apps/web/src/editor/autosave.ts';
import { createMemoryDraftStore } from '../../apps/web/src/editor/recovery.ts';

function harness() {
  const store = createEditorStore({
    package: {
      id: 'pkg_qa_undo_0001',
      revision: 1,
      format: { fps: 30, width: 100, height: 100 },
      scenes: [{ id: 's1', layout: 'title', preferredFrames: 90, copy: { headline: 'Start' }, transitionOut: { type: 'none', frames: 0 } }],
    },
  });
  const server = { revision: 1, saves: [], conflicts: 0, headline: 'Start' };
  const autosave = createAutosave(store, {
    drafts: createMemoryDraftStore(),
    schedule: fn => { fn(); return 0; },
    cancel: () => {},
    save: async payload => {
      server.saves.push(payload.baseRevision);
      if (payload.baseRevision !== server.revision) {
        server.conflicts += 1;
        return { ok: false, status: 'conflict', currentRevision: server.revision };
      }
      server.revision += 1;
      server.headline = payload.package.scenes[0].copy.headline;
      return { ok: true, revision: server.revision, editSequence: payload.editSequence };
    },
  });
  const headline = () => store.getState().doc.package.scenes[0].copy.headline;
  return { store, server, autosave, headline };
}

test('CONTROL: two consecutive edits save without conflict (the CAS fake agrees with the store)', async () => {
  const { store, server, autosave } = harness();
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'One' } });
  await autosave.flush();
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Two' } });
  await autosave.flush();
  assert.equal(server.conflicts, 0);
  assert.equal(store.saveStatus(), 'saved');
  assert.equal(server.revision, 3);
});

test('CONTROL: a genuine second-writer conflict is still reported (conflicts are real, not suppressed)', async () => {
  const { store, server, autosave } = harness();
  server.revision = 5; // another tab saved first
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Mine' } });
  await autosave.flush();
  assert.equal(store.saveStatus(), 'conflict');
  assert.equal(server.conflicts, 1);
});

test('UX05 regression: edit -> save -> undo -> save -> redo -> save advances the revision with no false conflict', async () => {
  const { store, server, autosave, headline } = harness();
  store.dispatch({ type: 'SetSceneCopy', sceneId: 's1', copy: { headline: 'Edited' } });
  await autosave.flush();
  assert.equal(store.saveStatus(), 'saved');
  store.undo();
  assert.equal(headline(), 'Start');
  await autosave.flush();
  assert.equal(server.conflicts, 0, `undo save sent baseRevision ${server.saves.at(-1)} against server revision ${server.revision}`);
  assert.equal(store.saveStatus(), 'saved');
  assert.equal(server.headline, 'Start');
  store.redo();
  assert.equal(headline(), 'Edited');
  await autosave.flush();
  assert.equal(server.conflicts, 0);
  assert.equal(store.saveStatus(), 'saved');
  assert.equal(server.headline, 'Edited');
  assert.deepEqual(server.saves, [1, 2, 3], 'every save uses the latest acknowledged CAS revision');
  assert.equal(server.revision, 4);
  assert.equal(store.getState().doc.package.revision, 4);
});
