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

test('trims below the speech floor or layout minimum are floored and do not change narration', () => {
  const editor = createEditorStore({
    package: pkg(),
    measured: { narration: { s_open: [{ text: 'Open the film.', seconds: 4 }] }, narrationPaddingSeconds: 0.25 },
  });
  const narration = editor.getState().doc.package.scenes.map(scene => scene.narration);
  const spoken = editor.dispatch({ type: 'TrimScene', sceneId: 's_open', preferredFrames: 40 });
  assert.equal(spoken.ok, true, spoken.error);
  assert.equal(spoken.floored, true);
  assert.equal(spoken.effective, 128);
  assert.equal(editor.getState().doc.package.scenes[0]?.preferredFrames, 40);
  assert.equal(editor.getState().derived.timeline?.scenes[0]?.durationInFrames, 128);
  assert.deepEqual(editor.getState().doc.package.scenes.map(scene => scene.narration), narration);

  const silent = createEditorStore({ package: pkg() });
  const layout = silent.dispatch({ type: 'TrimScene', sceneId: 's_end', preferredFrames: 5 });
  assert.equal(layout.ok, true, layout.error);
  assert.equal(layout.floored, true);
  assert.equal(layout.effective, 45);
  assert.equal(silent.getState().doc.package.scenes.find(scene => scene.id === 's_end')?.preferredFrames, 5);
});

test('reorder and delete clear the new last scene tail transition', () => {
  const editor = store();
  assert.equal(editor.dispatch({ type: 'SetTransition', sceneId: 's_mid', transitionOut: { type: 'fade', frames: 10 } }).ok, true);
  assert.equal(editor.dispatch({ type: 'DeleteScene', sceneId: 's_end' }).ok, true);
  const afterDelete = editor.getState().doc.package.scenes.at(-1);
  assert.equal(afterDelete?.id, 's_mid');
  assert.deepEqual(afterDelete?.transitionOut, { type: 'cut', frames: 0 });

  const moved = store();
  assert.equal(moved.dispatch({ type: 'SetTransition', sceneId: 's_open', transitionOut: { type: 'fade', frames: 12 } }).ok, true);
  assert.equal(moved.dispatch({ type: 'MoveScene', sceneId: 's_open', toIndex: 2 }).ok, true);
  const tail = moved.getState().doc.package.scenes.at(-1);
  assert.equal(tail?.id, 's_open');
  assert.deepEqual(tail?.transitionOut, { type: 'cut', frames: 0 });
});

test('project fps is floored before frames are counted', () => {
  const editor = createEditorStore({
    package: { ...pkg(), format: { width: 1920, height: 1080, fps: 30.9 } },
  });
  assert.equal(editor.getState().derived.timeline?.fps, 30);
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

test('transition, narration, voice and split undo back to the same document', () => {
  const editor = createEditorStore({
    package: {
      ...pkg(),
      voice: { enabled: true, engine: 'kokoro', voice: 'af_heart', speed: 1 },
      scenes: [
        { id: 's_open', layout: 'title', preferredFrames: 90, copy: { headline: 'Open' }, narration: 'one two three four', transitionOut: { type: 'cut', frames: 0 } },
        { id: 's_end', layout: 'list', preferredFrames: 90, copy: { headline: 'End' }, narration: 'Close.', transitionOut: { type: 'cut', frames: 0 } },
      ],
    },
    editor: {
      version: 1,
      captionOverrides: [],
      takes: {
        s_open: {
          takeId: 'take-open', assetId: 'a_plate', sourceHash: 'hash-open', inputFingerprint: 'stale-on-purpose',
          sampleRate: 8000, sampleCount: 8000, range: { inSample: 0, outSample: 8000 },
        },
      },
      alignment: {
        s_open: {
          sourceHash: 'hash-open', textFingerprint: 'will-change',
          chunks: [{ text: 'one two three four', seconds: 1, words: [
            { text: 'one', start: 0, end: 0.25 }, { text: 'two', start: 0.25, end: 0.5 },
            { text: 'three', start: 0.5, end: 0.75 }, { text: 'four', start: 0.75, end: 1 },
          ] }],
        },
      },
      presenterClips: {},
    },
  });
  const before = docBody(editor.getState().doc);
  const commands: Command[] = [
    { type: 'SetTransition', sceneId: 's_open', transitionOut: { type: 'fade', frames: 8 } },
    { type: 'SetNarrationText', sceneId: 's_open', text: 'rewritten line' },
    { type: 'SetVoice', voice: { enabled: true, engine: 'none', voice: 'af_heart', speed: 1 } },
    { type: 'SplitScene', sceneId: 's_open', frame: 15, newSceneId: 's_open_b' },
  ];
  for (const command of commands) {
    const one = createEditorStore({
      package: structuredClone(editor.getState().doc.package),
      editor: structuredClone(before.editor),
    });
    const start = docBody(one.getState().doc);
    const result = one.dispatch(command);
    assert.equal(result.ok, true, `${command.type} ${result.error ?? ''}`);
    assert.notDeepEqual(docBody(one.getState().doc), start);
    one.undo();
    assert.deepEqual(docBody(one.getState().doc), start);
    assert.equal(one.canRedo(), true);
    one.redo();
    assert.notDeepEqual(docBody(one.getState().doc), start);
  }
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
