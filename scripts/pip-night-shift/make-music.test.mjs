import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BAR_SECONDS,
  BARS,
  BEAT_SECONDS,
  BEATS_PER_BAR,
  BITS_PER_SAMPLE,
  BPM,
  CHANNELS,
  FRAMES_PER_BAR,
  MUSIC_FRAMES,
  MUSIC_SECONDS,
  SAMPLE_RATE,
  TRACKS,
  buildManifest,
  encodeWav,
  musicEvents,
  renderMusicBed,
  renderTrack,
  sha256Hex,
  writeTracks,
} from './make-music.mjs';

const exampleDir = new URL('../../examples/pip-night-shift/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', exampleDir), 'utf8'));
const scriptSource = readFileSync(new URL('./make-music.mjs', import.meta.url), 'utf8');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'pip-music-'));
}

/** Minimal canonical-WAV reader: enough to prove format, length and sample layout. */
function wavInfo(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.toString('ascii', 12, 16), 'fmt ');
  assert.equal(bytes.readUInt32LE(16), 16, 'PCM fmt chunk');
  assert.equal(bytes.readUInt16LE(20), 1, 'PCM format tag');
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bitsPerSample = bytes.readUInt16LE(34);
  assert.equal(bytes.readUInt32LE(28), sampleRate * channels * (bitsPerSample / 8), 'byte rate');
  assert.equal(bytes.readUInt16LE(32), channels * (bitsPerSample / 8), 'block align');
  assert.equal(bytes.toString('ascii', 36, 40), 'data');
  const dataBytes = bytes.readUInt32LE(40);
  assert.equal(bytes.length, 44 + dataBytes, 'no trailing bytes after the data chunk');
  return {
    channels,
    sampleRate,
    bitsPerSample,
    dataBytes,
    frames: dataBytes / (channels * (bitsPerSample / 8)),
    seconds: dataBytes / (sampleRate * channels * (bitsPerSample / 8)),
  };
}

test('the score is 96 BPM in 4/4: 75 frames per bar, 8 bars, exactly 20 s', () => {
  assert.equal(BPM, 96);
  assert.equal(BEATS_PER_BAR, 4);
  assert.equal(BARS, 8);
  assert.equal(BEAT_SECONDS, 0.625);
  assert.equal(BAR_SECONDS, 2.5);
  assert.equal(FRAMES_PER_BAR, 75);
  assert.equal(MUSIC_FRAMES, 600);
  assert.equal(MUSIC_SECONDS, 20);

  const events = musicEvents();
  assert.ok(events.length > 0);
  const sixteenth = BEAT_SECONDS / 4;
  for (const event of events) {
    assert.ok(event.at >= 0 && event.at < MUSIC_SECONDS, `${event.type} starts inside the bed`);
    const grid = event.at / sixteenth;
    assert.ok(Math.abs(grid - Math.round(grid)) < 1e-9, `${event.type} at ${event.at} sits on the 16th grid`);
  }
  for (let bar = 0; bar < BARS; bar += 1) {
    const barAt = bar * BAR_SECONDS;
    assert.ok(events.some((event) => event.type === 'pad' && Math.abs(event.at - barAt) < 1e-9), `bar ${bar} has a pad`);
    assert.ok(events.some((event) => event.type === 'kick' && Math.abs(event.at - barAt) < 1e-9), `bar ${bar} starts on a kick`);
  }
});

test('the music bed renders exactly 20 s of 16-bit stereo PCM', () => {
  const bytes = renderTrack('music-bed');
  const info = wavInfo(bytes);
  assert.equal(info.channels, CHANNELS);
  assert.equal(info.sampleRate, SAMPLE_RATE);
  assert.equal(info.bitsPerSample, BITS_PER_SAMPLE);
  assert.equal(info.frames, 20 * SAMPLE_RATE);
  assert.equal(info.seconds, 20);
  assert.equal(bytes.length, 44 + 20 * SAMPLE_RATE * CHANNELS * 2);
});

test('both SFX are short, non-silent PCM clips', () => {
  for (const id of ['sfx-whoosh', 'sfx-ding']) {
    const bytes = renderTrack(id);
    const info = wavInfo(bytes);
    const track = TRACKS.find((entry) => entry.id === id);
    assert.equal(info.seconds, track.seconds);
    assert.ok(info.seconds > 0 && info.seconds < 2, `${id} stays short`);
    let energy = 0;
    for (let offset = 44; offset < bytes.length; offset += 2) energy += Math.abs(bytes.readInt16LE(offset));
    assert.ok(energy > 0, `${id} is not silent`);
  }
});

test('rendering twice produces byte-identical WAVs', () => {
  for (const track of TRACKS) {
    const first = renderTrack(track.id);
    const second = renderTrack(track.id);
    assert.deepEqual(first, second, `${track.id} is deterministic`);
  }

  const a = tempDir();
  const b = tempDir();
  try {
    const first = writeTracks({ outDir: a });
    const second = writeTracks({ outDir: b });
    assert.deepEqual(first, second);
    for (const track of TRACKS) {
      assert.deepEqual(readFileSync(join(a, track.file)), readFileSync(join(b, track.file)), `${track.file} is byte-identical`);
    }
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('the recorded package hashes and byte counts match a fresh render', () => {
  const manifest = buildManifest();
  assert.equal(manifest.bpm, 96);
  assert.equal(manifest.seconds, 20);
  assert.equal(manifest.tracks.length, 2 + 1);

  for (const track of manifest.tracks) {
    const asset = pkg.assets[track.asset];
    assert.ok(asset, `${track.asset} is in package.json`);
    assert.equal(asset.kind, 'audio');
    assert.equal(asset.status, 'ready');
    assert.equal(asset.file, `assets/${track.file}`);
    assert.equal(asset.bytes, track.bytes, `${track.asset} bytes`);
    assert.equal(asset.sha256, track.sha256, `${track.asset} sha256`);
    assert.equal(sha256Hex(renderTrack(track.id)), track.sha256);
    assert.equal(asset.media.durationSeconds, track.seconds);
    assert.equal(asset.media.audio, 'present');
    assert.equal(asset.license.id, 'CC0-1.0');
    assert.equal(asset.redistributable, true);
  }
});

test('encodeWav clamps and writes little-endian PCM', () => {
  const bytes = encodeWav([0, 1, -1, 0.5], { sampleRate: 8000, channels: 1, bitsPerSample: 16 });
  assert.equal(bytes.length, 44 + 8);
  assert.equal(bytes.readInt16LE(44), 0);
  assert.equal(bytes.readInt16LE(46), 32767);
  assert.equal(bytes.readInt16LE(48), -32767);
  assert.equal(bytes.readInt16LE(50), 16384);
});

test('no WAV binary is committed for the example', (t) => {
  const generated = new URL('assets/', exampleDir);
  if (existsSync(generated)) t.diagnostic('assets/ exists locally (generated, gitignored); git decides what is committed');
  const result = spawnSync('git', ['ls-files', '--', 'examples/pip-night-shift'], { encoding: 'utf8' });
  const listed = result.status === 0 ? result.stdout : '';
  assert.doesNotMatch(listed, /\.wav$/m, 'audio is generated at seed/build time, never committed');
});

test('the generator carries no secret values or local machine paths', () => {
  const forbidden = [
    /ghp_[A-Za-z0-9]{8,}/,
    /github_pat_[A-Za-z0-9_]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{8,}/,
    /secret[_-]?key\s*[:=]/i,
    /\/home\//,
    /\/workspace\//,
    /C:\\Users/,
    /\.ts\.net/,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(scriptSource, pattern);
  assert.doesNotMatch(JSON.stringify(buildManifest()), /ghp_|github_pat_|Bearer\s/);
});
