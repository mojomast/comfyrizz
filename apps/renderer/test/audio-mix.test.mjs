import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_MIX_DEFAULTS,
  dbToLinear,
  duckEnvelope,
  narrationIntervals,
  normalizeDuck,
  resolveAudioMix,
  sfxFrame,
} from '../src/audio-mix-model.js';

const timeline = {
  fps: 30,
  durationInFrames: 300,
  captions: [{ text: 'Hello there', from: 90, to: 120, sceneId: 's1', estimated: false }],
  scenes: [
    { id: 's1', from: 0, durationInFrames: 150, transitionOutFrames: 15 },
    { id: 's2', from: 150, durationInFrames: 150, transitionOutFrames: 0 },
  ],
};

const plate = { kind: 'video', status: 'ready', file: 'assets/plate.mp4', media: { audio: 'present', frames: 97, fps: 24 } };
const bed = { kind: 'audio', status: 'ready', file: 'audio/bed.wav' };
const whoosh = { kind: 'audio', status: 'ready', file: 'audio/whoosh.wav', media: { durationSeconds: 0.5 } };

test('a package without an audio block resolves to an empty mix', () => {
  const mix = resolveAudioMix({ assets: { a_bed: bed }, scenes: [] }, timeline);
  assert.equal(mix.enabled, false);
  assert.equal(mix.music, null);
  assert.deepEqual(mix.ambience, []);
  assert.deepEqual(mix.sfx, []);
});

test('the music bed resolves its file, gain and a per-frame envelope', () => {
  const pkg = { audio: { music: { asset: 'a_bed', fade_in_seconds: 0, fade_out_seconds: 0 } }, assets: { a_bed: bed }, scenes: [] };
  const mix = resolveAudioMix(pkg, timeline);
  assert.equal(mix.enabled, true);
  assert.equal(mix.music.file, 'audio/bed.wav');
  assert.equal(mix.music.gainDb, AUDIO_MIX_DEFAULTS.musicGainDb);
  assert.equal(mix.music.loop, true);
  assert.equal(mix.music.gains.length, timeline.durationInFrames);
  // No fades: the bed sits at its gain before the narration starts.
  assert.ok(Math.abs(mix.music.gains[0] - dbToLinear(-18)) < 1e-9);
});

test('music fades in and out', () => {
  const pkg = { audio: { music: { asset: 'a_bed', fade_in_seconds: 1, fade_out_seconds: 1 } }, assets: { a_bed: bed }, scenes: [] };
  const mix = resolveAudioMix(pkg, timeline);
  assert.ok(mix.music.gains[0] < mix.music.gains[30]); // 1 s fade-in
  assert.ok(mix.music.gains[299] < mix.music.gains[270]); // 1 s fade-out
});

test('the music bed ducks under narration and releases after it', () => {
  const pkg = { audio: { music: { asset: 'a_bed', fade_in_seconds: 0, fade_out_seconds: 0 } }, assets: { a_bed: bed }, scenes: [] };
  const mix = resolveAudioMix(pkg, timeline);
  const full = mix.music.gains[0];
  assert.ok(mix.music.gains[100] < full * 0.5, 'ducked while speaking');
  assert.ok(Math.abs(mix.music.gains[200] - full) / full < 0.05, 'back to level well after the release');
});

test('ambience only picks a plate with audio, and ducks it too', () => {
  const pkg = {
    audio: { ambience: {} },
    assets: { a_plate: plate, a_still: { kind: 'image', status: 'ready', file: 'assets/x.png' } },
    scenes: [
      { id: 's1', background: { asset: 'a_plate' } },
      { id: 's2', background: { asset: 'a_still' } },
    ],
  };
  const mix = resolveAudioMix(pkg, timeline);
  assert.equal(mix.ambience.length, 1);
  const [ambience] = mix.ambience;
  assert.equal(ambience.assetId, 'a_plate');
  assert.equal(ambience.from, 0);
  assert.equal(ambience.durationInFrames, 150);
  assert.equal(ambience.gains.length, 150);
  assert.ok(ambience.gains[100] < ambience.gains[0] * 0.5, 'ambience ducks under the narration');
});

test('ambience can be turned off', () => {
  const pkg = { audio: { ambience: { enabled: false } }, assets: { a_plate: plate }, scenes: [{ id: 's1', background: { asset: 'a_plate' } }] };
  assert.deepEqual(resolveAudioMix(pkg, timeline).ambience, []);
});

test('sfx are placed at the scene seam from at + offset', () => {
  assert.equal(sfxFrame(timeline, { scene: 's1', at: 'scene-start' }), 0);
  assert.equal(sfxFrame(timeline, { scene: 's1', at: 'scene-end' }), 135);
  assert.equal(sfxFrame(timeline, { scene: 's1', at: 'transition', offset_seconds: 0.5 }), 150);
  assert.equal(sfxFrame(timeline, { scene: 'nope' }), null);
});

test('sfx resolve their file, length and gain', () => {
  const pkg = {
    audio: { sfx: [{ asset: 'a_whoosh', scene: 's1', at: 'scene-end', offset_seconds: 0.5 }] },
    assets: { a_whoosh: whoosh },
    scenes: [],
  };
  const mix = resolveAudioMix(pkg, timeline);
  assert.equal(mix.sfx.length, 1);
  assert.deepEqual(
    { file: mix.sfx[0].file, from: mix.sfx[0].from, durationInFrames: mix.sfx[0].durationInFrames, gainDb: mix.sfx[0].gainDb },
    { file: 'audio/whoosh.wav', from: 150, durationInFrames: 15, gainDb: AUDIO_MIX_DEFAULTS.sfxGainDb },
  );
});

test('narration intervals merge cues and use word spans', () => {
  const withWords = {
    captions: [
      { from: 10, to: 20, words: [{ from: 8, to: 12 }, { from: 18, to: 24 }] },
      { from: 22, to: 30 },
      { from: 40, to: 40 },
    ],
  };
  assert.deepEqual(narrationIntervals(withWords), [[8, 30]]);
  assert.deepEqual(narrationIntervals({}), []);
});

test('duck defaults mirror the schema and a disabled duck is a no-op', () => {
  assert.deepEqual(normalizeDuck(undefined), { enabled: true, reductionDb: -12, attackMs: 20, releaseMs: 300 });
  assert.deepEqual(normalizeDuck({ enabled: false, reduction_db: -20 }), { enabled: false, reductionDb: -20, attackMs: 20, releaseMs: 300 });
  assert.deepEqual(duckEnvelope(10, 30, [[2, 5]], { enabled: false }), new Array(10).fill(1));
});

test('an unready or missing bus asset is skipped, never played', () => {
  const pkg = {
    audio: { music: { asset: 'a_bed' }, sfx: [{ asset: 'a_gone', scene: 's1' }] },
    assets: { a_bed: { ...bed, status: 'pending' } },
    scenes: [],
  };
  const mix = resolveAudioMix(pkg, timeline);
  assert.equal(mix.enabled, false);
  assert.equal(mix.music, null);
  assert.deepEqual(mix.sfx, []);
});
