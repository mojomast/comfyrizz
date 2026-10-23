/**
 * IL20: an audition result reports the measured RMS of its existing WAV
 * samples. The metadata is read from the cached bytes; the wave itself is
 * written unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AUDITION_LINE,
  createAuditionCache,
} from '../../src/characters/audition.mjs';

const ID = 'chr_0123456789abcdef';
const LINE = 'Fresh is best.';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-audition-rms-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A real 16-bit PCM WAV whose samples alternate between +amplitude and
 * -amplitude, so the measured RMS is exactly `amplitude` full scale.
 */
function pcmWav({ amplitude = 0.5, seconds = 0.05, sampleRate = 24000, channels = 1 } = {}) {
  const frames = Math.max(2, Math.round(sampleRate * seconds));
  const dataSize = frames * channels * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0, 'latin1');
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write('WAVE', 8, 'latin1');
  bytes.write('fmt ', 12, 'latin1');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'latin1');
  bytes.writeUInt32LE(dataSize, 40);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round((frame % 2 === 0 ? amplitude : -amplitude) * 32767);
    for (let channel = 0; channel < channels; channel += 1) {
      bytes.writeInt16LE(value, offset);
      offset += 2;
    }
  }
  return bytes;
}

function kokoro(overrides = {}) {
  return { engine: 'kokoro', voice: 'am_michael', sampleLines: [LINE], ...overrides };
}

function character(voice = kokoro()) {
  return { id: ID, name: 'Pip', handle: 'pip', voice };
}

async function ensureWith(t, amplitude) {
  const root = tempDir(t);
  const source = pcmWav({ amplitude });
  const cache = createAuditionCache({ rootDir: root, synth: async () => source });
  const result = await cache.ensure(character(), { line: LINE });
  return { root, source, cache, result };
}

test('IL20: the result reports the measured WAV RMS in dBFS and leaves the wave unchanged', async (t) => {
  const { source, result } = await ensureWith(t, 0.5);

  assert.equal(result.ok, true);
  assert.equal(typeof result.rmsDbfs, 'number');
  assert.ok(
    Math.abs(result.rmsDbfs - -6.02) < 0.05,
    `expected about -6.02 dBFS, got ${result.rmsDbfs}`,
  );
  assert.deepEqual(readFileSync(result.path), source, 'the audition wave is byte-for-byte unchanged');
  assert.deepEqual(result.audition, {
    file: result.file,
    voiceHash: result.voiceHash,
    line: LINE,
  });
});

test('IL20: a quieter wave reports a lower RMS from the same measurement', async (t) => {
  const loud = await ensureWith(t, 0.5);
  const quiet = await ensureWith(t, 0.125);

  assert.equal(loud.result.ok, true);
  assert.equal(quiet.result.ok, true);
  assert.ok(
    Math.abs(quiet.result.rmsDbfs - -18.06) < 0.05,
    `expected about -18.06 dBFS, got ${quiet.result.rmsDbfs}`,
  );
  assert.ok(loud.result.rmsDbfs > quiet.result.rmsDbfs);
});

test('IL20: a cached audition reports the same RMS as the first render', async (t) => {
  const { root, result } = await ensureWith(t, 0.25);
  assert.equal(result.cached, false);

  const fresh = createAuditionCache({ rootDir: root });
  const cached = await fresh.ensure(character(), { line: LINE });

  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  assert.equal(cached.rmsDbfs, result.rmsDbfs);
});

test('IL20: a wave without readable PCM samples reports a null RMS, never a guess', async (t) => {
  const root = tempDir(t);
  const malformed = Buffer.concat([Buffer.from('RIFF'), Buffer.from('WAVEfmt '), Buffer.from('not pcm')]);
  const cache = createAuditionCache({ rootDir: root, synth: async () => malformed });
  const result = await cache.ensure(character(), { line: LINE });

  assert.equal(result.ok, true);
  assert.equal(result.rmsDbfs, null);
});

test('IL20: silence reports a null RMS so no gain can amplify it', async (t) => {
  const root = tempDir(t);
  const cache = createAuditionCache({ rootDir: root, synth: async () => pcmWav({ amplitude: 0 }) });
  const result = await cache.ensure(character(), { line: LINE });

  assert.equal(result.ok, true);
  assert.equal(result.line, LINE);
  assert.equal(result.rmsDbfs, null);
});

test('IL20: the default sample line still reports RMS metadata', async (t) => {
  const root = tempDir(t);
  const cache = createAuditionCache({
    rootDir: root,
    synth: async () => pcmWav({ amplitude: 0.5 }),
  });
  const result = await cache.ensure({ id: ID, voice: kokoro({ sampleLines: [] }) });

  assert.equal(result.ok, true);
  assert.equal(result.line, DEFAULT_AUDITION_LINE);
  assert.equal(typeof result.rmsDbfs, 'number');
});
