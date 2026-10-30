import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTimeline } from '../../../../packages/planner/dist/src/browser.js';
import { createEditorStore } from '../../src/editor/store.ts';
import { createAutosave } from '../../src/editor/autosave.ts';
import { createMemoryDraftStore } from '../../src/editor/recovery.ts';
import { validateEditor } from '../../../server/src/editor-sidecar.mjs';
import type { SetTransition } from '../../src/editor/commands.ts';
import { neon } from '../fixtures/editor/neon.ts';

const transition = (sceneId = 'shot1', frames = 10, type = 'wipe'): SetTransition => ({ type: 'SetTransition', sceneId, transitionOut: { type, frames, direction: 'right' } });
const lengths = (store: ReturnType<typeof createEditorStore>) => store.getState().derived.timeline!.scenes.map(scene => scene.durationInFrames);

test('Neon normal transitions compile at exact 360, compensate once, undo/redo and persist one revision per edit', async () => {
  const pkg = neon();
  const store = createEditorStore({ package: pkg });
  assert.equal(store.getState().derived.timeline?.durationInFrames, 360);
  const requests: any[] = [];
  let persisted = structuredClone(store.getState().doc);
  const autosave = createAutosave(store, {
    schedule: () => 0, cancel: () => {}, drafts: createMemoryDraftStore(),
    save: async payload => {
      assert.equal(compileTimeline({ package: payload.package, editor: payload.editor }).durationInFrames, 360);
      requests.push(structuredClone(payload));
      const checked = validateEditor(payload.editor);
      assert.equal(checked.error, undefined);
      persisted = { package: structuredClone(payload.package), editor: checked.editor, editSequence: payload.editSequence };
      persisted.package.revision = payload.baseRevision + 1;
      return { ok: true, revision: payload.baseRevision + 1, editSequence: payload.editSequence };
    },
  });
  try {
    assert.equal(store.dispatch(transition()).ok, true);
    assert.deepEqual(lengths(store), [130, 120, 120]);
    assert.equal(store.getState().doc.editSequence, 1);
    assert.deepEqual(store.getState().session.selectedSceneIds, ['shot1']);
    await autosave.flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].baseRevision, 22);
    assert.equal(store.saveState().acknowledgedRevision, 23);
    store.undo();
    assert.deepEqual(lengths(store), [120, 120, 120]);
    assert.equal(store.getState().derived.timeline?.durationInFrames, 360);
    store.redo();
    assert.deepEqual(lengths(store), [130, 120, 120]);
    assert.equal(store.getState().derived.timeline?.durationInFrames, 360);
    await autosave.flush();
    assert.equal(requests.length, 2);
    assert.equal(store.dispatch(transition('shot2', 10, 'push')).ok, true);
    assert.deepEqual(lengths(store), [130, 130, 120]);
    assert.equal(store.getState().derived.timeline?.durationInFrames, 360);
    assert.deepEqual(store.getState().session.selectedSceneIds, ['shot2']);
    await autosave.flush();
    assert.equal(requests.length, 3);
    assert.deepEqual(persisted.package.assets, pkg.assets);
    assert.deepEqual(persisted.package.scenes.map(scene => [scene.background, scene.motion, scene.copy]), pkg.scenes.map(scene => [scene.background, scene.motion, scene.copy]));
    const reopened = createEditorStore({ package: persisted.package, editor: persisted.editor });
    for (const frames of [15, 8, 10]) {
      assert.equal(reopened.dispatch(transition('shot1', frames, 'iris')).ok, true);
      assert.deepEqual(lengths(reopened), [120 + frames, 130, 120]);
      assert.equal(reopened.getState().derived.timeline?.durationInFrames, 360);
    }
    assert.equal(reopened.dispatch({ type: 'ResetSceneTransition', sceneId: 'shot1' }).ok, true);
    assert.deepEqual(lengths(reopened), [120, 130, 120]);
    assert.equal(reopened.dispatch({ type: 'SetTransition', sceneId: 'shot2', transitionOut: null }).ok, true);
    assert.deepEqual(lengths(reopened), [120, 120, 120]);
    assert.equal(reopened.getState().doc.editor.transitionCompensation, undefined);
  } finally { autosave.dispose(); }
});

test('source coverage shares adjacent handles and inversely removes them without ratcheting', () => {
  const pkg = neon();
  pkg.scenes[0].background!.trim = { startSeconds: 0, endSeconds: 4.1 };
  const store = createEditorStore({ package: pkg });
  assert.equal(store.dispatch(transition()).ok, true);
  assert.deepEqual(lengths(store), [123, 127, 120]);
  assert.deepEqual(store.getState().doc.package.scenes[0].background, pkg.scenes[0].background);
  assert.equal(store.dispatch(transition('shot1', 10, 'push')).ok, true);
  assert.deepEqual(lengths(store), [123, 127, 120]);
  assert.equal(store.dispatch({ type: 'SetTransition', sceneId: 'shot1', transitionOut: null }).ok, true);
  assert.deepEqual(lengths(store), [120, 120, 120]);
});

for (const constraint of ['trim', 'speed', 'pending-plan', 'rounded-pending-plan', 'unknown-pending', 'secondary-video', 'locked'] as const) {
  test(`insufficient ${constraint} coverage rejects atomically, without source/job/playback edits`, () => {
    const pkg = neon();
    for (const scene of pkg.scenes) {
      if (constraint === 'trim') scene.background!.trim = { startSeconds: 1.375, endSeconds: 5.375 };
      if (constraint === 'speed') scene.background!.speed = 2;
      if (constraint === 'pending-plan') (pkg.assets![scene.background!.asset!] as any).gen.inputs.frames = 97;
      if (constraint === 'rounded-pending-plan') (pkg.assets![scene.background!.asset!] as any).gen.inputs.frames = 100;
      if (constraint === 'unknown-pending') delete (pkg.assets![scene.background!.asset!] as any).gen;
      if (constraint === 'secondary-video') {
        pkg.assets!.short = { kind: 'video', media: { frames: 96, fps: 24 } };
        scene.media = [{ asset: 'short', loop: false }];
      }
      if (constraint === 'locked') scene.locked = true;
    }
    const store = createEditorStore({ package: pkg });
    const before = structuredClone(store.getState().doc);
    const result = store.dispatch(transition('shot1', constraint === 'rounded-pending-plan' ? 5 : 10));
    assert.equal(result.ok, false);
    assert.match(result.error!, constraint === 'locked' ? /locked/ : /Cannot change this overlap.*exact 360-frame.*source-backed.*No edit was applied/);
    assert.deepEqual(store.getState().doc, before);
    assert.equal(store.canUndo(), false);
    assert.equal(store.isDirty(), false);
  });
}

test('combined normal edit redistributes available non-adjacent coverage; invalid partial edits do not commit', () => {
  const pkg = neon();
  pkg.scenes.slice(0, 2).forEach(scene => { scene.background!.trim = { startSeconds: 0, endSeconds: 4 }; });
  const store = createEditorStore({ package: pkg });
  assert.equal(store.dispatch(transition()).ok, false);
  assert.equal(store.dispatch({ type: 'TrimScene', sceneId: 'shot3', preferredFrames: 130 }).ok, false);
  const result = store.dispatch({ ...transition(), sceneFrames: { shot1: 120, shot2: 120, shot3: 130 } });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(lengths(store), [120, 120, 130]);
  assert.equal(store.getState().derived.timeline?.durationInFrames, 360);
  assert.equal(store.getState().doc.editSequence, 1);
  assert.equal(store.dispatch(transition('shot3')).ok, false);
  assert.equal(store.dispatch({ type: 'SetTransition', sceneId: 'shot1', transitionOut: null }).ok, true);
  assert.deepEqual(lengths(store), [120, 120, 120], 'removal also reverses explicitly redistributed compensation');
  store.undo();
  assert.deepEqual(lengths(store), [120, 120, 130]);
  store.undo();
  assert.deepEqual(lengths(store), [120, 120, 120]);
});

test('server sidecar rejects malformed compensation instead of persisting arbitrary offsets', () => {
  for (const transitionCompensation of [[], { invalid: { shot1: 10 } }, { shot1: [] }, { shot1: { shot2: 0.5 } }, { shot1: { shot2: 108001 } }]) {
    assert.ok(validateEditor({ version: 1, captionOverrides: [], transitionCompensation }).error);
  }
});

test('authored slow playback and source trims are retained, not overwritten to manufacture coverage', () => {
  const pkg = neon();
  pkg.scenes[0].background = { ...pkg.scenes[0].background, speed: 0.5, trim: { startSeconds: 1, endSeconds: 3.5 }, loop: false };
  const store = createEditorStore({ package: pkg });
  assert.equal(store.dispatch(transition()).ok, true);
  assert.deepEqual(lengths(store), [130, 120, 120]);
  assert.deepEqual(store.getState().doc.package.scenes[0].background, pkg.scenes[0].background);
});
