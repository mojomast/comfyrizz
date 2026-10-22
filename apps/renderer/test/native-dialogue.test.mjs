import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_MIX_DEFAULTS, dbToLinear, resolveAudioMix } from '../src/audio-mix-model.js';

const timeline = {
  fps: 30,
  durationInFrames: 300,
  captions: [{ text: 'Hello there', from: 90, to: 120, sceneId: 's1', estimated: false }],
  scenes: [
    { id: 's1', from: 0, durationInFrames: 150, transitionOutFrames: 15 },
    { id: 's2', from: 150, durationInFrames: 150, transitionOutFrames: 0 },
  ],
};

function plate(extra = {}) {
  return { kind: 'video', status: 'ready', file: 'assets/plate.mp4', media: { audio: 'present', frames: 97, fps: 24 }, ...extra };
}

const nativeDialogue = plate({
  gen: {
    generator: 'fasth3-omni',
    direction: {
      subject: 'Pip',
      composition: 'head and shoulders',
      action: 'speaks to camera',
      camera: 'locked',
      soundscape: 'quiet room',
      characterCount: 1,
      dialogue: { text: 'Hello there', conditioningText: 'Hello there', language: 'en', voice: 'Pip', delivery: 'warm' },
    },
  },
});

const ltxPlate = plate({ gen: { generator: 'ltx25' } });
const fasth3Soundscape = plate({
  gen: {
    generator: 'fasth3-omni',
    direction: {
      subject: 'Pip',
      composition: 'wide',
      action: 'crosses the room',
      camera: 'locked',
      soundscape: 'footsteps',
      characterCount: 1,
    },
  },
});

test('native FastH3 dialogue resolves to its own dialogue bus, not ambience', () => {
  const pkg = {
    audio: { ambience: {} },
    assets: { a_dialogue: nativeDialogue },
    scenes: [{ id: 's1', background: { asset: 'a_dialogue' } }],
  };
  const mix = resolveAudioMix(pkg, timeline);
  assert.equal(mix.enabled, true);
  assert.deepEqual(mix.ambience, []);
  assert.equal(mix.dialogue.length, 1);
  const [dialogue] = mix.dialogue;
  assert.equal(dialogue.assetId, 'a_dialogue');
  assert.equal(dialogue.file, 'assets/plate.mp4');
  assert.equal(dialogue.sceneId, 's1');
  assert.equal(dialogue.from, 0);
  assert.equal(dialogue.durationInFrames, 150);
  assert.equal(dialogue.gainDb, AUDIO_MIX_DEFAULTS.dialogueGainDb);
  assert.equal(dialogue.duck.enabled, false);
  assert.equal(dialogue.gains.length, 150);
});

test('native dialogue plays at unity and is not ducked under narration', () => {
  const pkg = {
    audio: { ambience: { gain_db: -24, duck: { reduction_db: -18 } } },
    assets: { a_dialogue: nativeDialogue },
    scenes: [{ id: 's1', background: { asset: 'a_dialogue' } }],
  };
  const mix = resolveAudioMix(pkg, timeline);
  const [dialogue] = mix.dialogue;
  assert.equal(dialogue.gainDb, 0);
  for (const frame of [0, 89, 100, 119, 149]) {
    assert.ok(Math.abs(dialogue.gains[frame] - 1) < 1e-9, `dialogue stays at unity on frame ${frame}`);
  }
});

test('native dialogue survives ambience being disabled', () => {
  const pkg = {
    audio: { ambience: { enabled: false } },
    assets: { a_dialogue: nativeDialogue },
    scenes: [{ id: 's1', background: { asset: 'a_dialogue' } }],
  };
  const mix = resolveAudioMix(pkg, timeline);
  assert.deepEqual(mix.ambience, []);
  assert.equal(mix.dialogue.length, 1);
  assert.equal(mix.enabled, true);
});

test('LTX plate audio remains ambience and still ducks', () => {
  const pkg = {
    audio: { ambience: {} },
    assets: { a_plate: ltxPlate },
    scenes: [{ id: 's1', background: { asset: 'a_plate' } }],
  };
  const mix = resolveAudioMix(pkg, timeline);
  assert.deepEqual(mix.dialogue, []);
  assert.equal(mix.ambience.length, 1);
  assert.equal(mix.ambience[0].gainDb, AUDIO_MIX_DEFAULTS.ambienceGainDb);
  assert.ok(mix.ambience[0].gains[100] < mix.ambience[0].gains[0] * 0.5);
});

test('a FastH3 plate without a dialogue direction stays ambience', () => {
  const pkg = {
    audio: { ambience: {} },
    assets: { a_soundscape: fasth3Soundscape },
    scenes: [{ id: 's1', background: { asset: 'a_soundscape' } }],
  };
  const mix = resolveAudioMix(pkg, timeline);
  assert.deepEqual(mix.dialogue, []);
  assert.equal(mix.ambience.length, 1);
});

test('dialogue and ambience plates split across scenes', () => {
  const pkg = {
    audio: { ambience: {} },
    assets: { a_dialogue: nativeDialogue, a_plate: ltxPlate },
    scenes: [
      { id: 's1', background: { asset: 'a_dialogue' } },
      { id: 's2', background: { asset: 'a_plate' } },
    ],
  };
  const mix = resolveAudioMix(pkg, timeline);
  assert.deepEqual(mix.dialogue.map(track => track.sceneId), ['s1']);
  assert.deepEqual(mix.ambience.map(track => track.sceneId), ['s2']);
  assert.equal(mix.dialogue[0].from, 0);
  assert.equal(mix.ambience[0].from, 150);
});

test('an explicit dialogue gain is applied without changing the source routing', () => {
  const pkg = {
    audio: { dialogue: { gain_db: -6 }, ambience: {} },
    assets: { a_dialogue: nativeDialogue },
    scenes: [{ id: 's1', background: { asset: 'a_dialogue' } }],
  };
  const mix = resolveAudioMix(pkg, timeline);
  assert.equal(mix.dialogue[0].gainDb, -6);
  assert.ok(Math.abs(mix.dialogue[0].gains[10] - dbToLinear(-6)) < 1e-9);
});
