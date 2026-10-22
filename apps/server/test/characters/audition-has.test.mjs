import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  auditionFile,
  createAuditionCache,
} from '../../src/characters/audition.mjs';
import { voiceHash } from '../../src/characters/voice.mjs';

const ID = 'chr_0123456789abcdef';
const LINE = 'Morning! Let us grind.';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-character-audition-has-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function kokoro(overrides = {}) {
  return { engine: 'kokoro', voice: 'am_michael', sampleLines: [LINE], ...overrides };
}

function character(voice, overrides = {}) {
  return { id: ID, name: 'Pip', handle: 'pip', voice, ...overrides };
}

function wavBytes(samples = 16) {
  const data = Buffer.alloc(samples);
  for (let index = 0; index < data.length; index += 1) data[index] = (index * 7) & 0xff;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function counterSynth() {
  let calls = 0;
  const synth = async () => {
    calls += 1;
    return wavBytes();
  };
  return { synth, calls: () => calls };
}

function cachePath(root, voice) {
  const hash = voiceHash(voice);
  const file = auditionFile(hash, LINE);
  const directory = join(root, 'characters', ID, 'auditions');
  mkdirSync(directory, { recursive: true });
  return { hash, file, directory, target: join(directory, basename(file)) };
}

test('IP14: has() on an empty cache is false and never synthesizes or writes', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const cache = createAuditionCache({ rootDir: root, synth: fake.synth });

  assert.equal(await cache.has(character(kokoro()), { line: LINE }), false);
  assert.equal(fake.calls(), 0);
  assert.equal(existsSync(join(root, 'characters')), false);
});

test('IP14: has() is true for a valid cached WAV without calling synth', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const voice = kokoro();
  const { file, target } = cachePath(root, voice);
  writeFileSync(target, wavBytes());

  const cache = createAuditionCache({ rootDir: root, synth: fake.synth });
  assert.equal(await cache.has(character(voice), { line: LINE }), true);
  assert.equal(await cache.has(character(voice), { line: LINE }), true);
  assert.equal(fake.calls(), 0);
  assert.equal(auditionFile(voiceHash(voice), LINE), file);
  assert.deepEqual(readFileSync(target), wavBytes());
});

test('IP14: has() rejects corrupt or truncated cached WAV bytes', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const voice = kokoro();
  const { target } = cachePath(root, voice);
  const cache = createAuditionCache({ rootDir: root, synth: fake.synth });

  const corrupt = [
    Buffer.from('this is definitely not audio'),
    Buffer.from('RIFF'),
    wavBytes().subarray(0, 20),
    Buffer.concat([wavBytes().subarray(0, 12), Buffer.from('JUNK')]),
  ];

  for (const bytes of corrupt) {
    writeFileSync(target, bytes);
    assert.equal(await cache.has(character(voice), { line: LINE }), false);
    assert.deepEqual(readFileSync(target), bytes);
  }

  assert.equal(fake.calls(), 0);
  assert.deepEqual(readdirSync(join(root, 'characters', ID, 'auditions')), [basename(target)]);
});

test('IP14: has() rejects a non-empty file that is not a WAV even when its size is plausible', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const voice = kokoro();
  const { target } = cachePath(root, voice);
  writeFileSync(target, Buffer.alloc(44, 0x41));

  const cache = createAuditionCache({ rootDir: root, synth: fake.synth });
  assert.equal(await cache.has(character(voice), { line: LINE }), false);
  assert.equal(fake.calls(), 0);
});

test('IP14: has() returns false for invalid input and a missing cache directory without throwing', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const cache = createAuditionCache({ synth: fake.synth });

  assert.equal(await cache.has(undefined), false);
  assert.equal(await cache.has({ engine: 'none' }), false);
  assert.equal(await cache.has(character(kokoro()), { line: '   ' }), false);
  assert.equal(await cache.has(character(kokoro({ voice: 'am_nobody' })), { line: LINE }), false);
  assert.equal(await cache.has(character(kokoro())), false);
  assert.equal(await cache.has(character(kokoro()), { line: LINE, rootDir: root }), false);
  assert.equal(fake.calls(), 0);
});

test('IP14: has() sees a WAV produced by ensure and does not resynthesize it', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const cache = createAuditionCache({ rootDir: root, synth: fake.synth });
  const voice = kokoro();

  const first = await cache.ensure(character(voice), { line: LINE });
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(fake.calls(), 1);

  assert.equal(await cache.has(character(voice), { line: LINE }), true);
  assert.equal(fake.calls(), 1);
});

test('IP14: has() validates through injected fs reads and never writes', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const voice = kokoro();
  const { target } = cachePath(root, voice);
  writeFileSync(target, wavBytes());

  let reads = 0;
  let writes = 0;
  const fs = {
    existsSync: (...args) => existsSync(...args),
    statSync: (...args) => {
      throw new AggregateError([], 'stat must not be used for content checks');
    },
    readFileSync: (...args) => {
      reads += 1;
      return readFileSync(...args);
    },
    writeFileSync: (...args) => {
      writes += 1;
      return writeFileSync(...args);
    },
    mkdirSync: (...args) => mkdirSync(...args),
    renameSync: () => {
      throw new Error('has must not rename');
    },
    unlinkSync: () => {
      throw new Error('has must not unlink');
    },
    chmodSync: () => {
      throw new Error('has must not chmod');
    },
  };

  const cache = createAuditionCache({ rootDir: root, fs, synth: fake.synth });
  assert.equal(await cache.has(character(voice), { line: LINE }), true);
  assert.equal(reads > 0, true);
  assert.equal(writes, 0);
  assert.equal(fake.calls(), 0);
});
