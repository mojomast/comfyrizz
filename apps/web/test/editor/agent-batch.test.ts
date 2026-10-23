// IP52: an agent edit is one command batch against the editor store.
//
// It must use the same command validation boundary as a click, keep the user's
// earlier undo history, and undo/redo as a single step. It must never replace
// the open document (replaceDocument resets history by design).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorStore } from '../../src/editor/store.ts';
import type { Command, ProjectDoc } from '../../src/editor/commands.ts';

function pkg() {
  return {
    id: 'pkg_agent0001',
    revision: 1,
    format: { width: 1920, height: 1080, fps: 30 },
    scenes: [
      { id: 's_open', layout: 'title', preferredFrames: 120, copy: { headline: 'Open' }, narration: 'Open the film.' },
      { id: 's_mid', layout: 'hero', preferredFrames: 150, copy: { headline: 'Middle' }, narration: 'Show the product.' },
      { id: 's_end', layout: 'list', preferredFrames: 120, copy: { headline: 'End' }, narration: 'Close.' },
    ],
  };
}

function docBody(doc: ProjectDoc) {
  return { package: doc.package, editor: doc.editor };
}

function store() {
  return createEditorStore({ package: pkg() });
}

function headline(doc: ProjectDoc, sceneId: string): string | undefined {
  return doc.package.scenes.find(scene => scene.id === sceneId)?.copy?.headline as string | undefined;
}

const agentEdits: Command[] = [
  { type: 'SetSceneCopy', sceneId: 's_open', copy: { headline: 'Agent open' } },
  { type: 'MoveScene', sceneId: 's_end', toIndex: 0 },
  { type: 'TrimScene', sceneId: 's_mid', preferredFrames: 60 },
];

test('an agent batch keeps the earlier undo history and undoes as one step', () => {
  const editor = store();
  const initial = docBody(editor.getState().doc);
  assert.equal(editor.dispatch({ type: 'SetSceneCopy', sceneId: 's_mid', copy: { headline: 'Manual' } }).ok, true);
  const manual = docBody(editor.getState().doc);
  const manualSequence = editor.getState().doc.editSequence;

  const result = editor.applyAgentBatch(agentEdits);

  assert.equal(result.ok, true, result.error);
  assert.equal(editor.getState().doc.editSequence, manualSequence + 1, 'a batch advances the edit cursor once');
  assert.equal(editor.getState().doc.package.scenes[0]?.id, 's_end');
  assert.equal(headline(editor.getState().doc, 's_open'), 'Agent open');
  assert.equal(headline(editor.getState().doc, 's_mid'), 'Manual', 'the batch only changes what it names');
  assert.equal(editor.getState().doc.package.scenes.find(scene => scene.id === 's_mid')?.preferredFrames, 60);

  editor.undo();
  assert.deepEqual(docBody(editor.getState().doc), manual, 'undo removes the whole agent batch, not one command');
  assert.equal(editor.canUndo(), true, 'the manual edit is still in history');
  assert.equal(editor.canRedo(), true);

  editor.undo();
  assert.deepEqual(docBody(editor.getState().doc), initial);
  assert.equal(editor.canUndo(), false);
});

test('redo reapplies the whole agent batch as one step', () => {
  const editor = store();
  const initial = docBody(editor.getState().doc);
  assert.equal(editor.applyAgentBatch(agentEdits).ok, true);
  const edited = docBody(editor.getState().doc);

  editor.undo();
  assert.deepEqual(docBody(editor.getState().doc), initial);
  assert.equal(editor.canRedo(), true);

  editor.redo();
  assert.deepEqual(docBody(editor.getState().doc), edited);
  assert.equal(editor.canUndo(), true);

  editor.undo();
  assert.deepEqual(docBody(editor.getState().doc), initial);
});

test('a failed agent batch is atomic and does not disturb history', () => {
  const editor = store();
  assert.equal(editor.dispatch({ type: 'SetSceneCopy', sceneId: 's_open', copy: { headline: 'Manual' } }).ok, true);
  const before = docBody(editor.getState().doc);
  const sequence = editor.getState().doc.editSequence;
  editor.setSession({ selectedSceneIds: ['s_mid'] });

  const result = editor.applyAgentBatch([
    { type: 'SetSceneCopy', sceneId: 's_mid', copy: { headline: 'Never applied' } },
    { type: 'DeleteScene', sceneId: 's_missing' },
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(docBody(editor.getState().doc), before);
  assert.equal(editor.getState().doc.editSequence, sequence);
  assert.deepEqual(editor.getState().session.selectedSceneIds, ['s_mid']);

  editor.undo();
  assert.equal(headline(editor.getState().doc, 's_open'), 'Open', 'only the manual edit is undone');
});

test('a malformed agent batch is rejected before it can change anything', () => {
  const editor = store();
  const before = docBody(editor.getState().doc);

  const result = editor.applyAgentBatch([null as never]);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-batch');
  assert.deepEqual(docBody(editor.getState().doc), before);
  assert.equal(editor.canUndo(), false);
  assert.equal(editor.getState().doc.editSequence, 0);
});

test('an empty agent batch is a no-op', () => {
  const editor = store();
  const before = docBody(editor.getState().doc);
  const result = editor.applyAgentBatch([]);
  assert.equal(result.ok, true);
  assert.deepEqual(docBody(editor.getState().doc), before);
  assert.equal(editor.getState().doc.editSequence, 0);
  assert.equal(editor.canUndo(), false);
});

test('an agent batch commits over an open preview as one undo step', () => {
  const editor = store();
  const initial = docBody(editor.getState().doc);
  editor.preview({ type: 'TrimScene', sceneId: 's_open', preferredFrames: 80 });
  assert.equal(editor.getState().session.previewing, true);

  assert.equal(editor.applyAgentBatch([
    { type: 'SetSceneCopy', sceneId: 's_mid', copy: { headline: 'From agent' } },
    { type: 'MoveScene', sceneId: 's_mid', toIndex: 0 },
  ]).ok, true);

  assert.equal(editor.getState().session.previewing, false);
  assert.equal(editor.getState().doc.package.scenes[0]?.id, 's_mid');
  assert.equal(editor.getState().doc.package.scenes.find(scene => scene.id === 's_open')?.preferredFrames, 120);

  editor.undo();
  assert.deepEqual(docBody(editor.getState().doc), initial, 'the cancelled preview is not in history');
  assert.equal(editor.canUndo(), false);
});

test('sequential edits to one scene in a batch undo together', () => {
  const editor = store();
  const initial = docBody(editor.getState().doc);
  const result = editor.applyAgentBatch([
    { type: 'SetSceneCopy', sceneId: 's_mid', copy: { headline: 'First' } },
    { type: 'SetSceneCopy', sceneId: 's_mid', copy: { headline: 'Final' } },
    { type: 'TrimScene', sceneId: 's_mid', preferredFrames: 90 },
  ]);

  assert.equal(result.ok, true, result.error);
  assert.equal(headline(editor.getState().doc, 's_mid'), 'Final');
  assert.equal(editor.getState().doc.package.scenes.find(scene => scene.id === 's_mid')?.preferredFrames, 90);

  editor.undo();
  assert.deepEqual(docBody(editor.getState().doc), initial);
  assert.equal(editor.canUndo(), false);
});

test('the public dispatch array path keeps the same history guarantee', () => {
  const editor = store();
  assert.equal(editor.dispatch({ type: 'TrimScene', sceneId: 's_end', preferredFrames: 100 }).ok, true);
  const manual = docBody(editor.getState().doc);

  assert.equal(editor.dispatch(agentEdits).ok, true);
  assert.equal(editor.getState().doc.package.scenes[0]?.id, 's_end');

  editor.undo();
  assert.deepEqual(docBody(editor.getState().doc), manual);
  assert.equal(editor.canUndo(), true);
});
