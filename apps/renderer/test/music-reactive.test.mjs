import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compositionDurationInFrames,
  normalizeMusicReactive,
  resolveAudioMix,
  timelineWithMasterMusicDuration,
} from '../src/audio-mix-model.js';
import { resolvePackageComposition } from '../src/composition-model.js';
import {
  musicAmplitudeRange,
  musicSourceTime,
  reduceMusicAmplitudes,
  requiredMusicAnalysisWindows,
  scaleMusicAmplitudes,
} from '../src/music-reactive-model.js';
import { planAudioBuses } from '../scripts/incremental-audio.mjs';
import { planSegments } from '../scripts/render-incremental.mjs';

const SAMPLE_RATE = 8000;

function writePcm16Wav(path, samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2));
  writeFileSync(path, buffer);
}

function fixtureAudio(path) {
  const wav = readFileSync(path);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  const samples = new Float32Array((wav.length - 44) / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = wav.readInt16LE(44 + index * 2) / 32768;
  return {
    channelWaveforms: [samples],
    sampleRate: SAMPLE_RATE,
    durationInSeconds: samples.length / SAMPLE_RATE,
    numberOfChannels: 1,
    resultId: `fixture:${path}`,
    isRemote: false,
  };
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'music-reactive-pcm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const quiet = join(dir, 'quiet.wav');
  const loud = join(dir, 'loud.wav');
  const stepped = join(dir, 'stepped.wav');
  writePcm16Wav(quiet, new Array(SAMPLE_RATE * 2).fill(0.1));
  writePcm16Wav(loud, new Array(SAMPLE_RATE * 2).fill(0.7));
  writePcm16Wav(stepped, [
    ...new Array(SAMPLE_RATE).fill(0.1),
    ...new Array(SAMPLE_RATE).fill(0.8),
  ]);
  return { quiet: fixtureAudio(quiet), loud: fixtureAudio(loud), stepped: fixtureAudio(stepped) };
}

function amplitudes(audioData, sourceTime = 0, trim = null) {
  return reduceMusicAmplitudes({ audioData, sourceTime, trim, numberOfSamples: 16 });
}

test('two real PCM fixtures produce distinct, deterministic media-utils amplitudes', t => {
  const { quiet, loud } = fixture(t);
  const quietValues = amplitudes(quiet);
  const loudValues = amplitudes(loud);
  assert.equal(quietValues.length, 16);
  assert.deepEqual(amplitudes(quiet), quietValues, 'same PCM + frame gives identical values');
  assert.notDeepEqual(loudValues, quietValues, 'no per-window normalization or fabricated common shape');
  assert.ok(Math.abs(quietValues[0] - 0.1) < 0.002, quietValues[0]);
  assert.ok(Math.abs(loudValues[0] - 0.7) < 0.002, loudValues[0]);
  assert.ok(loudValues[0] > quietValues[0] * 5);
});

test('the amplitude reducer reads the trim source offset and never samples before it', t => {
  const { stepped } = fixture(t);
  const trim = { startSeconds: 1, endSeconds: 2 };
  const sourceTime = musicSourceTime(0, 25, trim);
  assert.equal(sourceTime, 1);
  const trimmed = amplitudes(stepped, sourceTime, trim);
  const untrimmed = amplitudes(stepped, 0);
  assert.ok(Math.abs(trimmed[0] - 0.8) < 0.002, trimmed[0]);
  assert.ok(Math.abs(untrimmed[0] - 0.1) < 0.002, untrimmed[0]);
  const range = musicAmplitudeRange(1, trim);
  assert.equal(range.startTimeInSeconds, 1);
  assert.ok(Math.abs(range.endTimeInSeconds - 1.36) < 1e-9);
  assert.deepEqual(requiredMusicAnalysisWindows({ startTimeInSeconds: 1.8, endTimeInSeconds: 2.2 }), [0, 1]);
});

test('missing analysis data is explicitly unavailable, never a zero/sample fallback', () => {
  assert.equal(reduceMusicAmplitudes({ audioData: null, sourceTime: 4 }), null);
  assert.deepEqual(scaleMusicAmplitudes([0.25, 4, -1], 3), [0.5, 1, 0], 'intensity and PCM are bounded');
  assert.deepEqual(scaleMusicAmplitudes([0.25, 1], 0), [0, 0], 'zero intensity is intentionally static');
});

test('reactive style and intensity are validated without inferring beats or lyrics', () => {
  assert.deepEqual(normalizeMusicReactive({ reactive: { style: 'waveform', intensity: 0.4 } }), { style: 'waveform', intensity: 0.4 });
  assert.deepEqual(normalizeMusicReactive({ reactive: { style: 'bars', intensity: 8 } }), { style: 'bars', intensity: 1 });
  assert.deepEqual(normalizeMusicReactive({ reactive: { style: 'bars', intensity: -2 } }), { style: 'bars', intensity: 0 });
  assert.equal(normalizeMusicReactive({ reactive: { style: 'beat-detector', intensity: 1 } }), null);
});

const masterTimeline = {
  fps: 25,
  durationInFrames: 150,
  captions: [{ text: 'Legacy narration', from: 10, to: 50, estimated: false }],
  scenes: [{ id: 's1', from: 0, durationInFrames: 150, transitionOutFrames: 0 }],
};

function masterPackage() {
  return {
    audio: {
      music: {
        asset: 'a_song',
        trim: { startSeconds: 1.04, endSeconds: 3.52 },
        reactive: { style: 'bars', intensity: 0.8 },
        fade_in_seconds: 0,
        fade_out_seconds: 0,
        loop: true,
      },
      dialogue: { enabled: true },
      ambience: { enabled: true },
      sfx: [{ asset: 'a_sfx', scene: 's1', at: 'scene-start' }],
    },
    assets: {
      a_song: { kind: 'audio', status: 'ready', file: 'audio/song.wav' },
      a_narration: { kind: 'audio', status: 'ready', file: 'audio/narration.wav' },
      a_sfx: { kind: 'audio', status: 'ready', file: 'audio/sfx.wav', media: { durationSeconds: 1 } },
      a_performance: {
        kind: 'video', status: 'ready', file: 'assets/performance.mp4', media: { audio: 'present' },
        gen: { direction: { dialogue: { text: 'Native performance audio' } } },
      },
    },
    scenes: [{ id: 's1', narration_asset: 'a_narration', background: { asset: 'a_performance', muted: false } }],
  };
}

test('a trimmed reactive master owns duration and is the only audio bus', () => {
  const pkg = masterPackage();
  const mix = resolveAudioMix(pkg, masterTimeline);
  assert.equal(mix.music.master, true);
  assert.equal(mix.music.loop, false, 'explicit loop:true cannot loop a primary song');
  assert.equal(mix.music.duck.enabled, false, 'master never ducks under legacy narration cues');
  assert.equal(mix.music.startSeconds, 1.04);
  assert.equal(mix.music.endSeconds, 3.52);
  assert.equal(mix.music.durationInFrames, 62);
  assert.equal(mix.music.gains.length, 62);
  assert.deepEqual(mix.music.reactive, { style: 'bars', intensity: 0.8 });
  assert.ok(mix.music.gains.every(gain => Math.abs(gain - mix.music.gains[0]) < 1e-9), 'no duck envelope');
  assert.deepEqual(mix.dialogue, []);
  assert.deepEqual(mix.ambience, []);
  assert.deepEqual(mix.sfx, []);
  assert.equal(resolvePackageComposition(pkg, masterTimeline).narration, null, 'no duplicate narration/performance master');
  assert.equal(compositionDurationInFrames(pkg, masterTimeline), 62);
  assert.equal(timelineWithMasterMusicDuration(pkg, masterTimeline).durationInFrames, 62);
  const multiScene = {
    ...timelineWithMasterMusicDuration(pkg, masterTimeline),
    scenes: [
      { id: 's1', from: 0, durationInFrames: 75, transitionOutFrames: 0 },
      { id: 's2', from: 75, durationInFrames: 75, transitionOutFrames: 0 },
    ],
  };
  const segments = planSegments(pkg, multiScene);
  assert.deepEqual(segments.map(segment => [segment.start, segment.end]), [[0, 61]], 'no segment requests frames beyond the trimmed composition');
  const buses = planAudioBuses({ pkg, timeline: masterTimeline });
  assert.equal(buses.length, 1);
  assert.equal(buses[0].kind, 'music');
  assert.equal(buses[0].startSeconds, 1.04);
  assert.equal(buses[0].endSeconds, 3.52);
  assert.equal(buses[0].seconds, 2.48);
  assert.equal(buses[0].loop, false);
  assert.equal(buses[0].duck.enabled, false);
});

test('master song and reactive edits invalidate the incremental picture cache', () => {
  const pkg = masterPackage();
  const base = planSegments(pkg, masterTimeline);
  const restyled = structuredClone(pkg);
  restyled.audio.music.reactive = { style: 'waveform', intensity: 0.2 };
  assert.notDeepEqual(planSegments(restyled, masterTimeline).map(segment => segment.key), base.map(segment => segment.key));
  const replaced = structuredClone(pkg);
  replaced.assets.a_song.sha256 = 'b'.repeat(64);
  assert.notDeepEqual(planSegments(replaced, masterTimeline).map(segment => segment.key), base.map(segment => segment.key));
  const legacy = masterPackage();
  delete legacy.audio.music.trim;
  delete legacy.audio.music.reactive;
  const legacyBase = planSegments(legacy, masterTimeline);
  legacy.audio.music.gain_db = -30;
  assert.deepEqual(planSegments(legacy, masterTimeline).map(segment => segment.key), legacyBase.map(segment => segment.key), 'legacy audio-only edits stay out of picture keys');
});

test('legacy packages and mixAudio:false narration behavior stay unchanged', () => {
  const pkg = masterPackage();
  delete pkg.audio.music.trim;
  delete pkg.audio.music.reactive;
  const mix = resolveAudioMix(pkg, masterTimeline);
  assert.equal(mix.music.master, undefined);
  assert.equal(mix.music.reactive, undefined);
  assert.equal(mix.music.startSeconds, undefined);
  assert.equal(mix.music.loop, true);
  assert.equal(mix.music.duck.enabled, true);
  assert.equal(mix.dialogue.length, 1);
  assert.equal(mix.ambience.length, 0, 'native dialogue remains on its old bus');
  assert.equal(mix.sfx.length, 1);
  assert.ok(resolvePackageComposition(pkg, masterTimeline).narration);
  assert.equal(timelineWithMasterMusicDuration(pkg, masterTimeline), masterTimeline);
  assert.ok(resolvePackageComposition(masterPackage(), masterTimeline, { mixAudio: false }).narration);
});
