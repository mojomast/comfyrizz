import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, type ProjectDoc } from '../../src/editor/commands.ts';
import { createEditorStore } from '../../src/editor/store.ts';
import { resolveAudioMix } from '../../../renderer/src/audio-mix-model.js';

const FPS = 30;
const TIMELINE_150_150 = {
  fps: FPS,
  durationInFrames: 300,
  scenes: [
    { id: 's_one', from: 0, durationInFrames: 150, transitionOutFrames: 0 },
    { id: 's_two', from: 150, durationInFrames: 150, transitionOutFrames: 0 },
  ],
};
const TIMELINE_200_150 = {
  fps: FPS,
  durationInFrames: 350,
  scenes: [
    { id: 's_one', from: 0, durationInFrames: 200, transitionOutFrames: 0 },
    { id: 's_two', from: 200, durationInFrames: 150, transitionOutFrames: 0 },
  ],
};

const plate = { kind: 'video', status: 'ready', file: 'assets/plate.mp4', media: { audio: 'present', frames: 450, fps: FPS } };

function twoScenePackage() {
  return {
    id: 'pkg_jl0001',
    format: { width: 1280, height: 720, fps: FPS },
    audio: { ambience: { gain_db: 0, duck: { enabled: false } } },
    assets: { a_plate: structuredClone(plate) },
    scenes: [
      { id: 's_one', layout: 'hero', preferredFrames: 150, background: { asset: 'a_plate' } },
      { id: 's_two', layout: 'hero', preferredFrames: 150, background: { asset: 'a_plate' } },
    ],
  };
}

function docOf(pkg: ReturnType<typeof twoScenePackage>): ProjectDoc {
  return { package: pkg, editSequence: 0, editor: { version: 1, captionOverrides: [] } };
}

function narrationDoc() {
  const pkg = twoScenePackage();
  pkg.scenes[0].preferredFrames = 90;
  pkg.scenes[0].background = { asset: 'a_plate', trim: { startSeconds: 1, endSeconds: 2.5 } };
  pkg.scenes[0].audio_trim = { startSeconds: 1, endSeconds: 2.5, offsetFrames: 3, linked: true };
  const doc: ProjectDoc = {
    package: pkg,
    editSequence: 0,
    editor: {
      version: 1,
      captionOverrides: [],
      alignment: {
        s_one: {
          sourceHash: 'hash-jl',
          textFingerprint: 'text-jl',
          chunks: [{ text: 'narration', seconds: 6.4 }],
        },
      },
    },
  };
  return doc;
}

function placement(track: { from: number; durationInFrames: number; startSeconds?: number; endSeconds?: number }) {
  return {
    from: track.from,
    durationInFrames: track.durationInFrames,
    startSeconds: track.startSeconds,
    endSeconds: track.endSeconds,
  };
}

test('a scene without audio_trim keeps its exact legacy ambience placement', () => {
  const mix = resolveAudioMix(twoScenePackage(), TIMELINE_150_150);
  assert.equal(mix.ambience.length, 2);
  assert.deepEqual(mix.ambience.map(track => ({ sceneId: track.sceneId, from: track.from, durationInFrames: track.durationInFrames })), [
    { sceneId: 's_one', from: 0, durationInFrames: 150 },
    { sceneId: 's_two', from: 150, durationInFrames: 150 },
  ]);
  assert.equal(mix.ambience[0].gains.length, 150);
  assert.equal('startSeconds' in mix.ambience[0], false);
});

test('a picture trim alone does not shorten a scene without audio_trim', () => {
  const pkg = twoScenePackage();
  pkg.scenes[0].background = { asset: 'a_plate', trim: { startSeconds: 1, endSeconds: 2 } };

  const [first] = resolveAudioMix(pkg, TIMELINE_150_150).ambience;
  assert.deepEqual(placement(first), { from: 0, durationInFrames: 150, startSeconds: undefined, endSeconds: undefined });
  assert.equal(first.gains.length, 150);
});

test('a linked trim follows the placed scene when it is re-timed', () => {
  const pkg = twoScenePackage();
  pkg.scenes[0].background = { asset: 'a_plate', trim: { startSeconds: 1, endSeconds: 2.5 } };
  pkg.scenes[0].audio_trim = { startSeconds: 1, endSeconds: 2.5, offsetFrames: 0, linked: true };
  const retimed = {
    fps: FPS,
    durationInFrames: 390,
    scenes: [
      { id: 's_one', from: 0, durationInFrames: 240, transitionOutFrames: 0 },
      { id: 's_two', from: 240, durationInFrames: 150, transitionOutFrames: 0 },
    ],
  };

  assert.deepEqual(placement(resolveAudioMix(pkg, TIMELINE_150_150).ambience[0]), {
    from: 0,
    durationInFrames: 150,
    startSeconds: 1,
    endSeconds: 6,
  });
  assert.deepEqual(placement(resolveAudioMix(pkg, retimed).ambience[0]), {
    from: 0,
    durationInFrames: 240,
    startSeconds: 1,
    endSeconds: 9,
  });
});

test('a linked trim is bounded by its scene even when the picture trim is longer', () => {
  const pkg = twoScenePackage();
  pkg.scenes[0].background = { asset: 'a_plate', trim: { startSeconds: 0, endSeconds: 20 } };
  pkg.scenes[0].audio_trim = { startSeconds: 0, endSeconds: 20, offsetFrames: 0, linked: true };

  const [first, second] = resolveAudioMix(pkg, TIMELINE_150_150).ambience;
  assert.deepEqual(placement(first), { from: 0, durationInFrames: 150, startSeconds: 0, endSeconds: 5 });
  assert.equal(first.gains.length, 150);
  assert.ok(first.from + first.durationInFrames <= second.from, 'linked audio never plays over the next scene');
});

test('a linked trim starts at the picture in-point and spans the placed scene, not the picture trim length', () => {
  const pkg = twoScenePackage();
  pkg.scenes[0].preferredFrames = 200;
  pkg.scenes[0].background = { asset: 'a_plate', trim: { startSeconds: 1, endSeconds: 2.5 } };
  pkg.scenes[0].audio_trim = { startSeconds: 0, endSeconds: 99, offsetFrames: 5, linked: true };

  const [first] = resolveAudioMix(pkg, TIMELINE_200_150).ambience;
  assert.deepEqual(placement(first), { from: 5, durationInFrames: 200, startSeconds: 1, endSeconds: 7.666666666666667 });
  assert.equal(first.gains.length, 200);
});

test('an unlinked trim is an independent J/L window placed by offsetFrames', () => {
  const pkg = twoScenePackage();
  pkg.scenes[1].audio_trim = { startSeconds: 1, endSeconds: 2.5, offsetFrames: -6, linked: false };

  const mix = resolveAudioMix(pkg, TIMELINE_150_150);
  assert.deepEqual(placement(mix.ambience[1]), { from: 144, durationInFrames: 45, startSeconds: 1, endSeconds: 2.5 });
  assert.equal(mix.ambience[1].gains.length, 45);
});

test('UnlinkAudio snapshots the placed duration, so nothing jumps', () => {
  const doc = narrationDoc();
  const before = resolveAudioMix(doc.package, TIMELINE_200_150).ambience[0];
  assert.deepEqual(placement(before), { from: 3, durationInFrames: 200, startSeconds: 1, endSeconds: 7.666666666666667 });

  const unlinked = applyCommand(doc, { type: 'UnlinkAudio', sceneId: 's_one' });
  assert.equal(unlinked.ok, true);
  const trim = unlinked.doc.package.scenes[0].audio_trim;
  assert.deepEqual(trim, { startSeconds: 1, endSeconds: 7.666666666666667, offsetFrames: 3, linked: false });

  const after = resolveAudioMix(unlinked.doc.package, TIMELINE_200_150).ambience[0];
  assert.deepEqual(placement(after), { from: 3, durationInFrames: 200, startSeconds: 1, endSeconds: 7.666666666666667 });
});

test('RelinkAudio keeps the sync offset and derives the scene window again', () => {
  const unlinked = applyCommand(narrationDoc(), { type: 'UnlinkAudio', sceneId: 's_one' });
  assert.equal(unlinked.ok, true);
  const relinked = applyCommand(unlinked.doc, { type: 'RelinkAudio', sceneId: 's_one' });
  assert.equal(relinked.ok, true);
  assert.deepEqual(relinked.doc.package.scenes[0].audio_trim, {
    startSeconds: 1,
    endSeconds: 7.666666666666667,
    offsetFrames: 3,
    linked: true,
  });

  const after = resolveAudioMix(relinked.doc.package, TIMELINE_200_150).ambience[0];
  assert.deepEqual(placement(after), { from: 3, durationInFrames: 200, startSeconds: 1, endSeconds: 7.666666666666667 });
});

test('SetAudioRange, SetMediaRange target audio and SetAudioSync validate offsets', () => {
  let doc = docOf(twoScenePackage());
  const range = applyCommand(doc, { type: 'SetAudioRange', sceneId: 's_one', startSeconds: 2, endSeconds: 3, offsetFrames: -10 });
  assert.equal(range.ok, true);
  assert.deepEqual(range.doc.package.scenes[0].audio_trim, { startSeconds: 2, endSeconds: 3, offsetFrames: -10, linked: false });

  const media = applyCommand(range.doc, { type: 'SetMediaRange', sceneId: 's_one', target: 'audio', startSeconds: 1, endSeconds: 2 });
  assert.equal(media.ok, true);
  assert.deepEqual(media.doc.package.scenes[0].audio_trim, { startSeconds: 1, endSeconds: 2, offsetFrames: -10, linked: false });

  const synced = applyCommand(media.doc, { type: 'SetAudioSync', sceneId: 's_one', offsetFrames: 12 });
  assert.equal(synced.ok, true);
  assert.deepEqual(synced.doc.package.scenes[0].audio_trim, { startSeconds: 1, endSeconds: 2, offsetFrames: 12, linked: false });

  const bad = applyCommand(synced.doc, { type: 'SetAudioSync', sceneId: 's_one', offsetFrames: 1.5 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad-offset');

  const badRange = applyCommand(doc, { type: 'SetAudioRange', sceneId: 's_one', startSeconds: 2, endSeconds: 2 });
  assert.equal(badRange.ok, false);
  assert.equal(badRange.code, 'bad-range');

  const cleared = applyCommand(synced.doc, { type: 'SetAudioRange', sceneId: 's_one', startSeconds: null });
  assert.equal(cleared.ok, true);
  assert.equal('audio_trim' in cleared.doc.package.scenes[0], false);
});

test('locked scenes reject every audio edit', () => {
  const pkg = twoScenePackage();
  pkg.scenes[0].locked = true;
  pkg.scenes[0].audio_trim = { startSeconds: 1, endSeconds: 2, offsetFrames: 0, linked: false };
  const doc = docOf(pkg);
  const commands = [
    { type: 'SetAudioRange', sceneId: 's_one', startSeconds: 1, endSeconds: 2 },
    { type: 'SetMediaRange', sceneId: 's_one', target: 'audio', startSeconds: 1, endSeconds: 2 },
    { type: 'UnlinkAudio', sceneId: 's_one' },
    { type: 'RelinkAudio', sceneId: 's_one' },
    { type: 'SetAudioSync', sceneId: 's_one', offsetFrames: 5 },
  ] as const;
  for (const command of commands) {
    const result = applyCommand(doc, command);
    assert.equal(result.ok, false, command.type);
    assert.equal(result.code, 'locked', command.type);
  }
});

test('audio edits are undoable and redoable', () => {
  const doc = narrationDoc();
  const store = createEditorStore({ package: doc.package, editor: doc.editor });
  const before = structuredClone(store.getState().doc.package);
  const sequence = store.getState().doc.editSequence;

  assert.equal(store.dispatch({ type: 'UnlinkAudio', sceneId: 's_one' }).ok, true);
  assert.equal(store.getState().doc.package.scenes[0].audio_trim?.linked, false);
  assert.equal(store.getState().doc.package.scenes[0].audio_trim?.endSeconds, 7.666666666666667);

  store.undo();
  assert.deepEqual(store.getState().doc.package, before);
  assert.ok(store.getState().doc.editSequence > sequence, 'undo is a new autosave sequence');

  store.redo();
  assert.equal(store.getState().doc.package.scenes[0].audio_trim?.linked, false);
});

test('SplitScene divides an unlinked audio window so the same source is not played twice', () => {
  const pkg = twoScenePackage();
  pkg.scenes[0].preferredFrames = 150;
  pkg.scenes[0].narration = 'one two three four';
  pkg.scenes[0].narration_asset = 'a_voice';
  pkg.scenes[0].audio_trim = { startSeconds: 1, endSeconds: 4, offsetFrames: 0, linked: false };
  pkg.assets = { ...pkg.assets, a_voice: { kind: 'audio', status: 'ready', file: 'audio/s1.wav' } };
  const doc: ProjectDoc = {
    package: pkg,
    editSequence: 0,
    editor: {
      version: 1,
      captionOverrides: [],
      takes: {},
      alignment: {},
    },
  };
  doc.editor.takes = {
    s_one: {
      takeId: 'take-s1',
      assetId: 'a_voice',
      sourceHash: 'hash-s1',
      inputFingerprint: 'fp-s1',
      sampleRate: 8000,
      sampleCount: 8000,
      range: { inSample: 0, outSample: 8000 },
    },
  };
  doc.editor.alignment = {
    s_one: {
      sourceHash: 'hash-s1',
      textFingerprint: 'text-s1',
      chunks: [{
        text: 'one two three four',
        seconds: 1,
        words: [
          { text: 'one', start: 0, end: 0.25 },
          { text: 'two', start: 0.25, end: 0.5 },
          { text: 'three', start: 0.5, end: 0.75 },
          { text: 'four', start: 0.75, end: 1 },
        ],
      }],
    },
  };

  const store = createEditorStore({ package: doc.package, editor: doc.editor });
  const split = store.dispatch({ type: 'SplitScene', sceneId: 's_one', frame: 15, newSceneId: 's_one_b' });
  assert.equal(split.ok, true, split.error);

  const next = store.getState().doc;
  assert.deepEqual(next.package.scenes[0].audio_trim, { startSeconds: 1, endSeconds: 1.5, offsetFrames: 0, linked: false });
  assert.deepEqual(next.package.scenes[1].audio_trim, { startSeconds: 1.5, endSeconds: 4, offsetFrames: 0, linked: false });

  const timeline = store.getState().derived.timeline;
  assert.ok(timeline);
  const mix = resolveAudioMix(next.package, timeline);
  const left = mix.ambience.find(track => track.sceneId === 's_one');
  const right = mix.ambience.find(track => track.sceneId === 's_one_b');
  assert.deepEqual(placement(left), { from: 0, durationInFrames: 15, startSeconds: 1, endSeconds: 1.5 });
  assert.deepEqual(placement(right), { from: 45, durationInFrames: 75, startSeconds: 1.5, endSeconds: 4 });
  assert.equal(left.endSeconds, right.startSeconds, 'the source window is cut, not repeated');
});
