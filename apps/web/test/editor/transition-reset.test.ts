import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorStore } from '../../src/editor/store.ts';
import type { ProjectDoc } from '../../src/editor/commands.ts';

function pkg() {
  return {
    id: 'pkg_transition0001',
    revision: 1,
    format: { width: 1280, height: 720, fps: 30 },
    scenes: [
      { id: 's_open', layout: 'title', preferredFrames: 90, copy: { headline: 'Open' }, transitionOut: { type: 'fade', frames: 12 } },
      { id: 's_mid', layout: 'hero', preferredFrames: 120, copy: { headline: 'Middle' }, transitionOut: { type: 'slide', frames: 8, direction: 'left' } },
      { id: 's_end', layout: 'list', preferredFrames: 90, copy: { headline: 'End' } },
    ],
  };
}

function scene(doc: ProjectDoc, id: string) {
  return doc.package.scenes.find(item => item.id === id);
}

test('SetTransition(null) keeps cut/0; ResetSceneTransition removes the override', () => {
  const editor = createEditorStore({ package: pkg() });
  const before = structuredClone(editor.getState().doc);

  const cut = editor.dispatch({ type: 'SetTransition', sceneId: 's_mid', transitionOut: null });
  assert.equal(cut.ok, true, cut.error);
  assert.deepEqual(scene(editor.getState().doc, 's_mid')?.transitionOut, { type: 'cut', frames: 0 });

  editor.undo();
  assert.deepEqual(editor.getState().doc.package, before.package);
  assert.deepEqual(editor.getState().doc.editor, before.editor);
  assert.ok(editor.getState().doc.editSequence > before.editSequence, 'undo is a new autosave sequence');
  editor.redo();
  assert.deepEqual(scene(editor.getState().doc, 's_mid')?.transitionOut, { type: 'cut', frames: 0 });

  const reset = editor.dispatch({ type: 'ResetSceneTransition', sceneId: 's_mid' });
  assert.equal(reset.ok, true, reset.error);
  assert.equal('transitionOut' in (scene(editor.getState().doc, 's_mid') ?? {}), false, 'the package/compiler default is represented by an absent override');
  assert.equal(editor.getState().derived.timeline?.scenes.find(item => item.id === 's_mid')?.transitionOutFrames, 0);

  editor.undo();
  assert.deepEqual(scene(editor.getState().doc, 's_mid')?.transitionOut, { type: 'cut', frames: 0 });
});

test('tail transitions clear to cut on reorder and can still be explicitly reset', () => {
  const editor = createEditorStore({ package: pkg() });
  assert.equal(editor.dispatch({ type: 'SetTransition', sceneId: 's_mid', transitionOut: { type: 'fade', frames: 10 } }).ok, true);
  assert.equal(editor.dispatch({ type: 'MoveScene', sceneId: 's_mid', toIndex: 2 }).ok, true);
  const tail = scene(editor.getState().doc, 's_mid');
  assert.deepEqual(tail?.transitionOut, { type: 'cut', frames: 0 }, 'the new last scene has no outgoing overlap');

  const rejected = editor.dispatch({ type: 'SetTransition', sceneId: 's_mid', transitionOut: { type: 'fade', frames: 10 } });
  assert.equal(rejected.ok, false, 'a last scene cannot gain an outgoing transition');

  const reset = editor.dispatch({ type: 'ResetSceneTransition', sceneId: 's_mid' });
  assert.equal(reset.ok, true, reset.error);
  assert.equal('transitionOut' in (scene(editor.getState().doc, 's_mid') ?? {}), false);
  assert.equal(editor.getState().derived.timeline?.scenes.at(-1)?.transitionOutFrames, 0);

  editor.dispatch({ type: 'DeleteScene', sceneId: 's_mid' });
  assert.equal(scene(editor.getState().doc, 's_end')?.transitionOut, undefined);
});

test('a locked scene rejects both transition commands', () => {
  const locked = pkg();
  locked.scenes[1]!.locked = true;
  const editor = createEditorStore({ package: locked });
  assert.equal(editor.dispatch({ type: 'SetTransition', sceneId: 's_mid', transitionOut: { type: 'fade', frames: 10 } }).ok, false);
  assert.equal(editor.dispatch({ type: 'ResetSceneTransition', sceneId: 's_mid' }).ok, false);
  assert.deepEqual(scene(editor.getState().doc, 's_mid')?.transitionOut, { type: 'slide', frames: 8, direction: 'left' });
});
