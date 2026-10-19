import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorStore } from '../../src/editor/store.ts';
import type { Command, ProjectDoc } from '../../src/editor/commands.ts';

function pkg() {
  return {
    id: 'pkg_editor0001',
    revision: 1,
    format: { width: 1920, height: 1080, fps: 30 },
    scenes: [
      { id: 's_open', layout: 'title', preferredFrames: 120, copy: { headline: 'Open' }, narration: 'Open the film.', transitionOut: { type: 'fade', frames: 12 } },
      { id: 's_mid', layout: 'hero', preferredFrames: 150, copy: { headline: 'Middle' }, narration: 'Show the product.', background: { asset: 'a_plate' }, transitionOut: { type: 'none', frames: 0 } },
      { id: 's_end', layout: 'list', preferredFrames: 120, copy: { headline: 'End' }, narration: 'Close.' },
    ],
    assets: { a_plate: { kind: 'video', media: { fps: 24, frames: 48 } } },
  };
}

function docBody(doc: ProjectDoc) {
  return { package: doc.package, editor: doc.editor };
}

function store() {
  return createEditorStore({ package: pkg() });
}

test('every command undoes and redoes to the same document', () => {
  const commands: Command[] = [
    { type: 'MoveScene', sceneId: 's_end', toIndex: 0 },
    { type: 'TrimScene', sceneId: 's_open', preferredFrames: 90 },
    { type: 'SetSceneCopy', sceneId: 's_mid', copy: { headline: 'Rewritten' } },
    { type: 'SetMediaRange', sceneId: 's_mid', target: 'background', startSeconds: 1.5, endSeconds: 3 },
    { type: 'SetCaptionText', sceneId: 's_open', index: 0, text: 'Corrected caption' },
    { type: 'DuplicateScene', sceneId: 's_mid', newId: 's_mid_2' },
    { type: 'DeleteScene', sceneId: 's_end' },
  ];
  for (const command of commands) {
    const editor = store();
    const before = docBody(editor.getState().doc);
    const narration = editor.getState().doc.package.scenes.map(scene => scene.narration);
    const result = editor.dispatch(command);
    assert.equal(result.ok, true, `${command.type} ${result.error ?? ''}`);
    assert.notDeepEqual(docBody(editor.getState().doc), before);
    if (command.type === 'SetCaptionText') {
      assert.deepEqual(editor.getState().doc.package.scenes.map(scene => scene.narration), narration);
      assert.equal(editor.getState().doc.editor.captionOverrides[0]?.text, 'Corrected caption');
    }
    editor.undo();
    assert.deepEqual(docBody(editor.getState().doc), before);
    assert.equal(editor.canRedo(), true);
    editor.redo();
    assert.notDeepEqual(docBody(editor.getState().doc), before);
    editor.undo();
    assert.deepEqual(docBody(editor.getState().doc), before);
  }
});

test('a gesture commits once and escape cancels it', () => {
  const editor = store();
  const before = docBody(editor.getState().doc);
  editor.preview({ type: 'TrimScene', sceneId: 's_open', preferredFrames: 80 });
  assert.equal(editor.getState().session.previewing, true);
  assert.equal(editor.getState().doc.package.scenes[0]?.preferredFrames, 80);
  assert.equal(editor.canUndo(), false);
  editor.cancelPreview();
  assert.deepEqual(docBody(editor.getState().doc), before);
  editor.preview({ type: 'TrimScene', sceneId: 's_open', preferredFrames: 80 });
  editor.dispatch({ type: 'TrimScene', sceneId: 's_open', preferredFrames: 80 });
  assert.equal(editor.getState().session.previewing, false);
  assert.equal(editor.canUndo(), true);
  editor.undo();
  assert.deepEqual(docBody(editor.getState().doc), before);
  assert.equal(editor.canUndo(), false);
});

test('an agent batch is one undo step', () => {
  const editor = store();
  const before = docBody(editor.getState().doc);
  const result = editor.dispatch([
    { type: 'SetSceneCopy', sceneId: 's_mid', copy: { headline: 'Agent' } },
    { type: 'MoveScene', sceneId: 's_end', toIndex: 0 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(editor.getState().doc.package.scenes[0]?.id, 's_end');
  assert.equal(editor.getState().doc.package.scenes.find(scene => scene.id === 's_mid')?.copy?.headline, 'Agent');
  editor.undo();
  assert.deepEqual(docBody(editor.getState().doc), before);
  assert.equal(editor.canUndo(), false);
});

test('trims below the speech floor are rejected and do not change narration', () => {
  const editor = createEditorStore({
    package: pkg(),
    measured: { narration: { s_open: [{ text: 'Open the film.', seconds: 4 }] }, narrationPaddingSeconds: 0.25 },
  });
  const before = docBody(editor.getState().doc);
  const result = editor.dispatch({ type: 'TrimScene', sceneId: 's_open', preferredFrames: 40 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'below-speech-floor');
  assert.deepEqual(docBody(editor.getState().doc), before);
  assert.match(result.error ?? '', /script/i);
});

test('a stale compile acknowledgement is ignored', () => {
  const editor = store();
  editor.dispatch({ type: 'SetSceneCopy', sceneId: 's_mid', copy: { headline: 'Now' } });
  const current = editor.getState();
  const applied = editor.applyCompileResult({
    editSequence: 0,
    inputHash: 'stale',
    timeline: current.derived.timeline!,
  });
  assert.equal(applied, false);
  assert.equal(current.derived.compiledSequence, 1);
  const fresh = editor.applyCompileResult({
    editSequence: current.doc.editSequence,
    inputHash: current.derived.inputHash!,
    timeline: current.derived.timeline!,
  });
  assert.equal(fresh, true);
});

test('an older save acknowledgement does not mark a newer edit saved', () => {
  const editor = store();
  editor.dispatch({ type: 'SetSceneCopy', sceneId: 's_open', copy: { headline: 'A' } });
  editor.noteSave({ type: 'start' });
  editor.dispatch({ type: 'SetSceneCopy', sceneId: 's_open', copy: { headline: 'AB' } });
  editor.noteSave({ type: 'ack', editSequence: 1, revision: 2 });
  assert.equal(editor.getState().doc.package.scenes[0]?.copy?.headline, 'AB');
  assert.equal(editor.getState().doc.package.revision, 2);
  assert.equal(editor.saveStatus(), 'pending');
  assert.equal(editor.acknowledgedSequence(), 1);
  editor.noteSave({ type: 'ack', editSequence: 2, revision: 3 });
  assert.equal(editor.saveStatus(), 'saved');
});

test('media ranges keep source seconds and integer source frames', () => {
  const editor = store();
  editor.dispatch({ type: 'SetMediaRange', sceneId: 's_mid', target: 'background', startSeconds: 1.5, endSeconds: 3 });
  const range = editor.getState().derived.mediaRanges[0];
  assert.equal(range?.startSeconds, 1.5);
  assert.equal(range?.sourceFps, 24);
  assert.equal(range?.startFrame, 36);
  assert.equal(Number.isInteger(range?.startFrame), true);
});

test('undo restores selection and a failed batch changes nothing', () => {
  const editor = store();
  editor.setSession({ selectedSceneIds: ['s_mid'] });
  editor.dispatch({ type: 'DeleteScene', sceneId: 's_end' });
  assert.deepEqual(editor.getState().session.selectedSceneIds, ['s_mid']);
  editor.undo();
  assert.deepEqual(editor.getState().session.selectedSceneIds, ['s_mid']);
  const before = docBody(editor.getState().doc);
  const result = editor.dispatch([
    { type: 'SetSceneCopy', sceneId: 's_open', copy: { headline: 'Kept' } },
    { type: 'DeleteScene', sceneId: 'missing' },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(docBody(editor.getState().doc), before);
});
