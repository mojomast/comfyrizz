#!/usr/bin/env node
/**
 * PN18: original, deterministic music bed and SFX for "Pip's Night Shift".
 *
 * Writes three 16-bit PCM WAV files with plain Node (no samples, no network, no models):
 *   - music-bed.wav   8 bars at 96 BPM, 4/4 (20 s), stereo
 *   - sfx-whoosh.wav  transition swell for the s1 -> s2 seam
 *   - sfx-ding.wav    counter chime for the s3 stat hit
 *
 * The bed is composed here: an A-minor / F-major / C-major / G-major pad progression with a soft
 * felt bass, a bell arpeggio and a brushed pulse. Every note starts on a 16th-note grid derived from
 * the tempo, so the package's bar-aligned scenes and the music share one clock.
 *
 * The output is a pure function of the constants below: the same script always produces the same
 * bytes, which is what lets package.json record the expected sha256. Output files are generated at
 * seed/build time and are never committed.
 *
 * Licence: CC0-1.0, author "Comfyrizz contributors". The rendered audio is dedicated to the public
 * domain; there are no third-party recordings, samples or model weights in the signal path.
 *
 * Usage:
 *   node scripts/pip-night-shift/make-music.mjs [--out <dir>]
 *   node scripts/pip-night-shift/make-music.mjs --check <package.json> [--out <dir>]
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BPM = 96;
export const BEATS_PER_BAR = 4;
export const BARS = 8;
export const SAMPLE_RATE = 44100;
export const CHANNELS = 2;
export const BITS_PER_SAMPLE = 16;
export const BEAT_SECONDS = 60 / BPM;
export const BAR_SECONDS = BEAT_SECONDS * BEATS_PER_BAR;
export const MUSIC_SECONDS = BAR_SECONDS * BARS;
/** One bar at 96 BPM is exactly 75 frames at 30 fps. */
export const FRAMES_PER_BAR = (BAR_SECONDS * 30);
export const MUSIC_FRAMES = FRAMES_PER_BAR * BARS;

export const ASSET_IDS = Object.freeze({
  music: 'a_music_bed',
  whoosh: 'a_sfx_whoosh',
  ding: 'a_sfx_ding',
});

/** The committed package and the generator share this manifest. */
export const TRACKS = Object.freeze([
  Object.freeze({
    id: 'music-bed',
    asset: ASSET_IDS.music,
    file: 'music-bed.wav',
    seconds: MUSIC_SECONDS,
    channels: CHANNELS,
    sampleRate: SAMPLE_RATE,
    title: "Pip's Night Shift — music bed",
    description: 'Original 96 BPM, 8-bar instrumental bed: felt bass, warm pad, bell arpeggio, brushed pulse.',
  }),
  Object.freeze({
    id: 'sfx-whoosh',
    asset: ASSET_IDS.whoosh,
    file: 'sfx-whoosh.wav',
    seconds: 0.7,
    channels: CHANNELS,
    sampleRate: SAMPLE_RATE,
    title: "Pip's Night Shift — transition whoosh",
    description: 'Short filtered-noise swell for the s1 -> s2 iris transition.',
  }),
  Object.freeze({
    id: 'sfx-ding',
    asset: ASSET_IDS.ding,
    file: 'sfx-ding.wav',
    seconds: 1.2,
    channels: CHANNELS,
    sampleRate: SAMPLE_RATE,
    title: "Pip's Night Shift — counter ding",
    description: 'Small bell chime for the s3 counter hit.',
  }),
]);

/** Canonical root note per two-bar phrase (MIDI): A minor, F major, C major, G major. */
const PROGRESSION = Object.freeze([
  Object.freeze({ root: 45, minor: true }),
  Object.freeze({ root: 41, minor: false }),
  Object.freeze({ root: 48, minor: false }),
  Object.freeze({ root: 43, minor: false }),
]);

/** Deterministic PRNG (mulberry32). Only used for the brushed noise, never for timing. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function secondsToFrames(seconds) {
  return Math.round(seconds * SAMPLE_RATE);
}

/** A freshly allocated stereo float buffer. */
function stereoFrames(seconds) {
  return new Float64Array(secondsToFrames(seconds) * CHANNELS);
}

/** Mix one mono signal into the stereo buffer at `startFrame`, with equal-power pan. */
function addSignal(buffer, startFrame, signal, gain, pan) {
  const angle = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  const left = Math.cos(angle) * gain;
  const right = Math.sin(angle) * gain;
  const total = buffer.length / CHANNELS;
  for (let i = 0; i < signal.length; i += 1) {
    const frame = startFrame + i;
    if (frame >= total) break;
    buffer[frame * CHANNELS] += signal[i] * left;
    buffer[frame * CHANNELS + 1] += signal[i] * right;
  }
}

/** Soft attack, exponential body, short release. Never returns NaN. */
function pluckEnvelope(length, attackSeconds, decay) {
  const out = new Float64Array(length);
  const attack = Math.max(1, Math.round(attackSeconds * SAMPLE_RATE));
  for (let i = 0; i < length; i += 1) {
    const attackGain = Math.min(1, i / attack);
    const tail = Math.min(1, (length - i) / Math.max(1, Math.round(0.01 * SAMPLE_RATE)));
    out[i] = attackGain * Math.exp(-decay * (i / SAMPLE_RATE)) * tail;
  }
  return out;
}

/** Felt/plucked tone: a few harmonics with 1/n^2 weights. */
function feltNote(midi, seconds, { attack = 0.012, decay = 3.2 } = {}) {
  const length = Math.max(1, secondsToFrames(seconds));
  const freq = midiToHz(midi);
  const envelope = pluckEnvelope(length, attack, decay);
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE;
    let value = 0;
    for (let harmonic = 1; harmonic <= 4; harmonic += 1) {
      value += Math.sin(2 * Math.PI * freq * harmonic * t) / harmonic ** 2;
    }
    out[i] = value * envelope[i];
  }
  return out;
}

/** Warm pad: detuned sines with a slow raised-cosine swell. */
function padNote(midi, seconds, { detune = 0.35 } = {}) {
  const length = Math.max(1, secondsToFrames(seconds));
  const freq = midiToHz(midi);
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE;
    const swell = Math.sin(Math.PI * Math.min(1, i / length)) ** 2;
    const tail = Math.min(1, (length - i) / Math.max(1, Math.round(0.05 * SAMPLE_RATE)));
    out[i] =
      (Math.sin(2 * Math.PI * freq * t) +
        0.5 * Math.sin(2 * Math.PI * (freq + detune) * t) +
        0.18 * Math.sin(2 * Math.PI * freq * 2 * t)) *
      swell *
      tail;
  }
  return out;
}

/** Bell: an inharmonic partial stack with a fast attack and exponential decay. */
function bellNote(midi, seconds, { attack = 0.004, decay = 2.6 } = {}) {
  const length = Math.max(1, secondsToFrames(seconds));
  const freq = midiToHz(midi);
  const envelope = pluckEnvelope(length, attack, decay);
  const partials = [
    [1, 1],
    [2.01, 0.25],
    [2.76, 0.16],
    [5.4, 0.07],
  ];
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE;
    let value = 0;
    for (const [ratio, weight] of partials) value += Math.sin(2 * Math.PI * freq * ratio * t) * weight;
    out[i] = value * envelope[i];
  }
  return out;
}

/** Soft kick: a pitch-dropping sine, more felt than heard. */
function kick(seconds = 0.24) {
  const length = Math.max(1, secondsToFrames(seconds));
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE;
    const freq = 52 + 46 * Math.exp(-t * 22);
    const envelope = Math.min(1, i / 24) * Math.exp(-t * 13);
    out[i] = Math.sin(2 * Math.PI * freq * t) * envelope;
  }
  return out;
}

/** Brushed pulse: a very short, low-level noise tick. */
function brush(random, seconds = 0.09) {
  const length = Math.max(1, secondsToFrames(seconds));
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.exp(-t * 48) * Math.min(1, i / 8);
    out[i] = (random() * 2 - 1) * envelope;
  }
  return out;
}

/** The 16th-note grid the whole score is written on. Exported so tests can assert beat alignment. */
export function musicEvents() {
  const events = [];
  for (let bar = 0; bar < BARS; bar += 1) {
    const phrase = PROGRESSION[Math.floor(bar / 2) % PROGRESSION.length];
    const third = phrase.minor ? 3 : 4;
    const barAt = bar * BAR_SECONDS;
    const chord = [phrase.root + 12, phrase.root + 12 + third, phrase.root + 19, phrase.root + 24];

    for (const [index, midi] of chord.entries()) {
      events.push({ type: 'pad', at: barAt, seconds: BAR_SECONDS * 0.96, midi, pan: (index - 1.5) / 3.2 });
    }
    for (const beat of [0, 2]) {
      events.push({ type: 'bass', at: barAt + beat * BEAT_SECONDS, seconds: BEAT_SECONDS * 1.7, midi: phrase.root - 12, pan: 0 });
    }
    for (let beat = 0; beat < BEATS_PER_BAR; beat += 1) {
      events.push({ type: 'kick', at: barAt + beat * BEAT_SECONDS, seconds: 0.24, midi: null, pan: 0 });
      const tone = chord[(beat + bar) % chord.length] + 12;
      events.push({ type: 'bell', at: barAt + beat * BEAT_SECONDS, seconds: BEAT_SECONDS * 1.4, midi: tone, pan: beat % 2 === 0 ? -0.28 : 0.28 });
      if (beat < BEATS_PER_BAR - 1) {
        events.push({ type: 'brush', at: barAt + (beat + 0.5) * BEAT_SECONDS, seconds: 0.09, midi: null, pan: 0.15 });
      }
    }
  }
  return events.sort((a, b) => a.at - b.at || a.type.localeCompare(b.type));
}

/** Render the 20 s music bed as interleaved stereo Float64 samples. */
export function renderMusicBed() {
  const buffer = stereoFrames(MUSIC_SECONDS);
  const random = seededRandom(0x5eed1058);
  for (const event of musicEvents()) {
    const start = secondsToFrames(event.at);
    switch (event.type) {
      case 'pad':
        addSignal(buffer, start, padNote(event.midi, event.seconds), 0.055, event.pan ?? 0);
        break;
      case 'bass':
        addSignal(buffer, start, feltNote(event.midi, event.seconds, { attack: 0.016, decay: 2.2 }), 0.1, event.pan ?? 0);
        break;
      case 'bell':
        addSignal(buffer, start, bellNote(event.midi, event.seconds), 0.042, event.pan ?? 0);
        break;
      case 'kick':
        addSignal(buffer, start, kick(event.seconds), 0.13, 0);
        break;
      case 'brush':
        addSignal(buffer, start, brush(random, event.seconds), 0.024, event.pan ?? 0);
        break;
      default:
        break;
    }
  }
  return finish(buffer, { fadeInSeconds: 0.02, fadeOutSeconds: 0.03, peak: 0.86 });
}

/** Filtered-noise swell with a rising pitch under it. */
export function renderWhoosh(seconds = 0.7) {
  const buffer = stereoFrames(seconds);
  const length = buffer.length / CHANNELS;
  const random = seededRandom(0x0f0f1058);
  let low = 0;
  let high = 0;
  for (let i = 0; i < length; i += 1) {
    const x = i / length;
    const cutoff = 0.015 + 0.16 * Math.sin(Math.PI * Math.min(1, x));
    const noise = random() * 2 - 1;
    low += (noise - low) * cutoff;
    high += (noise - high) * Math.min(1, cutoff * 3.2);
    const band = high - low;
    const envelope = x ** 1.6 * Math.exp(-6.2 * Math.max(0, x - 0.45));
    const sweep = Math.sin(2 * Math.PI * (180 + 620 * x) * (i / SAMPLE_RATE)) * 0.16 * envelope;
    const value = band * envelope * 0.9 + sweep;
    buffer[i * CHANNELS] += value * 0.92;
    buffer[i * CHANNELS + 1] += value * 0.84;
  }
  return finish(buffer, { fadeInSeconds: 0.01, fadeOutSeconds: 0.08, peak: 0.72 });
}

/** Small bell chime for the stat hit. */
export function renderDing(seconds = 1.2) {
  const buffer = stereoFrames(seconds);
  const start = 0;
  addSignal(buffer, start, bellNote(84, seconds, { attack: 0.003, decay: 3.1 }), 0.5, -0.1);
  addSignal(buffer, start, bellNote(91, seconds, { attack: 0.004, decay: 3.6 }), 0.24, 0.12);
  addSignal(buffer, start + secondsToFrames(0.005), feltNote(72, seconds, { attack: 0.004, decay: 4.2 }), 0.08, 0);
  return finish(buffer, { fadeInSeconds: 0.004, fadeOutSeconds: 0.12, peak: 0.74 });
}

/** Remove DC, de-click the edges and normalise to a predictable peak. */
function finish(buffer, { fadeInSeconds, fadeOutSeconds, peak }) {
  const frames = buffer.length / CHANNELS;
  const fadeIn = Math.max(1, secondsToFrames(fadeInSeconds));
  const fadeOut = Math.max(1, secondsToFrames(fadeOutSeconds));
  let sumLeft = 0;
  let sumRight = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    sumLeft += buffer[frame * CHANNELS];
    sumRight += buffer[frame * CHANNELS + 1];
  }
  const dcLeft = sumLeft / frames;
  const dcRight = sumRight / frames;
  let maximum = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const gain = Math.min(1, frame / fadeIn, (frames - 1 - frame) / fadeOut);
    const left = (buffer[frame * CHANNELS] - dcLeft) * gain;
    const right = (buffer[frame * CHANNELS + 1] - dcRight) * gain;
    buffer[frame * CHANNELS] = left;
    buffer[frame * CHANNELS + 1] = right;
    maximum = Math.max(maximum, Math.abs(left), Math.abs(right));
  }
  const scale = maximum > 0 ? peak / maximum : 0;
  for (let i = 0; i < buffer.length; i += 1) buffer[i] *= scale;
  return buffer;
}

/** Encode interleaved float samples as a canonical 16-bit PCM WAV. */
export function encodeWav(samples, { sampleRate = SAMPLE_RATE, channels = CHANNELS, bitsPerSample = BITS_PER_SAMPLE } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = samples.length * bytesPerSample;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  out.writeUInt16LE(channels * bytesPerSample, 32);
  out.writeUInt16LE(bitsPerSample, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = clamp(samples[i], -1, 1);
    out.writeInt16LE(Math.round(clamped * 32767), offset);
    offset += 2;
  }
  return out;
}

/** Render one manifest entry to WAV bytes. */
export function renderTrack(id) {
  const track = TRACKS.find((entry) => entry.id === id);
  if (!track) throw new Error(`unknown track ${JSON.stringify(id)}`);
  let samples;
  if (id === 'music-bed') samples = renderMusicBed();
  else if (id === 'sfx-whoosh') samples = renderWhoosh(track.seconds);
  else if (id === 'sfx-ding') samples = renderDing(track.seconds);
  else throw new Error(`no renderer for ${JSON.stringify(id)}`);
  return encodeWav(samples, { sampleRate: track.sampleRate, channels: track.channels });
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The manifest the package records: file name, length, bytes and sha256 for every track. */
export function buildManifest() {
  return {
    bpm: BPM,
    beatsPerBar: BEATS_PER_BAR,
    bars: BARS,
    framesPerBar: FRAMES_PER_BAR,
    seconds: MUSIC_SECONDS,
    tracks: TRACKS.map((track) => {
      const bytes = renderTrack(track.id);
      return {
        id: track.id,
        asset: track.asset,
        file: track.file,
        seconds: track.seconds,
        channels: track.channels,
        sampleRate: track.sampleRate,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
      };
    }),
  };
}

/**
 * Write every track into `outDir`.
 * @param {{ outDir: string, fs?: { mkdirSync: Function, writeFileSync: Function } }} options
 */
export function writeTracks({ outDir, fs = { mkdirSync, writeFileSync } } = {}) {
  if (!outDir) throw new Error('writeTracks needs an outDir');
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const track of TRACKS) {
    const bytes = renderTrack(track.id);
    const target = join(outDir, track.file);
    fs.writeFileSync(target, bytes);
    written.push({ id: track.id, asset: track.asset, file: track.file, seconds: track.seconds, bytes: bytes.length, sha256: sha256Hex(bytes) });
  }
  return { bpm: BPM, beatsPerBar: BEATS_PER_BAR, bars: BARS, framesPerBar: FRAMES_PER_BAR, seconds: MUSIC_SECONDS, tracks: written };
}

/** Read a package and check every recorded audio hash/byte count against a fresh render. */
export function checkPackage(packagePath) {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const assets = pkg.assets ?? {};
  const problems = [];
  for (const track of TRACKS) {
    const assetId = track.asset;
    const asset = assets[assetId];
    if (!asset) {
      problems.push(`${assetId}: missing from package assets`);
      continue;
    }
    const bytes = renderTrack(track.id);
    const sha = sha256Hex(bytes);
    if (asset.sha256 !== sha) problems.push(`${assetId}: sha256 ${asset.sha256} does not match ${sha}`);
    if (asset.bytes !== bytes.length) problems.push(`${assetId}: bytes ${asset.bytes} does not match ${bytes.length}`);
    if (asset.file !== `assets/${track.file}`) problems.push(`${assetId}: file ${JSON.stringify(asset.file)} should be assets/${track.file}`);
  }
  return { ok: problems.length === 0, problems };
}

function parseArgs(argv) {
  const out = { outDir: fileURLToPath(new URL('../../examples/pip-night-shift/assets/', import.meta.url)), check: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out needs a directory');
      out.outDir = resolve(value);
      i += 1;
    } else if (arg === '--check') {
      const value = argv[i + 1];
      if (!value) throw new Error('--check needs a package.json path');
      out.check = resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    const report = checkPackage(args.check);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (!existsSync(dirname(args.outDir))) mkdirSync(dirname(args.outDir), { recursive: true });
  const manifest = writeTracks({ outDir: args.outDir });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) main();
