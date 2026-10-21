import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDITION_INVALID_LINE,
  AUDITION_NO_SYNTH,
  AUDITION_UNAVAILABLE,
  DEFAULT_AUDITION_LINE,
  auditionFile,
  auditionKey,
  createAuditionCache,
  ensureAudition,
} from '../../src/characters/audition.mjs';
import { voiceHash } from '../../src/characters/voice.mjs';
import { createCharacterStore } from '../../src/characters/store.mjs';

const ID = 'chr_0123456789abcdef';
const LINE = 'Morning! Let us grind.';
const OTHER_LINE = 'Fresh is best.';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-character-audition-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function wav(label) {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WAVEfmt '),
    Buffer.from(String(label)),
  ]);
}

function kokoro(overrides = {}) {
  return { engine: 'kokoro', voice: 'am_michael', sampleLines: [LINE], ...overrides };
}

function qwen(overrides = {}) {
  return { engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'custom', sampleLines: [LINE], ...overrides };
}

function character(voice, overrides = {}) {
  return { id: ID, name: 'Pip', handle: 'pip', voice, ...overrides };
}

function counterSynth(build = (request) => wav(request.line)) {
  let calls = 0;
  const requests = [];
  const synth = async (request) => {
    calls += 1;
    requests.push(request);
    return build(request, calls);
  };
  return { synth, requests, calls: () => calls };
}

function filesIn(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

test('CC08: the cache key covers voiceHash and line and stays a store-valid wav name', () => {
  const hash = voiceHash(kokoro());
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.notEqual(auditionKey(hash, LINE), auditionKey(hash, OTHER_LINE));
  assert.equal(auditionKey(hash, `  ${LINE}  `), auditionKey(hash, LINE));
  assert.match(auditionFile(hash, LINE), /^auditions\/[0-9a-f]{32}\.wav$/);
  assert.throws(() => auditionKey('not-hex', LINE), TypeError);
});

test('CC08: synth runs once per (voiceHash, line) and the cached wav is reused', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const cache = createAuditionCache({ rootDir: root, synth: fake.synth });
  const voice = kokoro();

  const first = await cache.ensure(character(voice), { line: LINE });
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(first.voiceHash, voiceHash(voice));
  assert.equal(first.file, auditionFile(first.voiceHash, LINE));
  assert.match(first.path, new RegExp(`${ID}/auditions/[0-9a-f]{32}\\.wav$`));
  assert.deepEqual(readFileSync(first.path), wav(LINE));
  assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.equal(fake.calls(), 1);

  const second = await cache.ensure(character(voice), { line: LINE });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(second.path, first.path);
  assert.equal(second.size, first.size);
  assert.equal(fake.calls(), 1);

  const freshCache = createAuditionCache({ rootDir: root, synth: fake.synth });
  const third = await freshCache.ensure(character(voice), { line: LINE });
  assert.equal(third.ok, true);
  assert.equal(third.cached, true);
  assert.equal(third.path, first.path);
  assert.equal(fake.calls(), 1);

  const auditionDir = join(root, 'characters', ID, 'auditions');
  assert.deepEqual(filesIn(auditionDir), [`${auditionKey(first.voiceHash, LINE)}.wav`]);
});

test('CC08: a different line or voice setting gets its own cache entry and synth call', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const cache = createAuditionCache({ rootDir: root, synth: fake.synth });

  const first = await cache.ensure(character(kokoro()), { line: LINE });
  const second = await cache.ensure(character(kokoro()), { line: OTHER_LINE });
  const faster = await cache.ensure(character(kokoro({ speed: 1.1 })), { line: LINE });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(faster.ok, true);
  assert.equal(fake.calls(), 3);
  assert.notEqual(first.file, second.file);
  assert.equal(first.voiceHash, second.voiceHash);
  assert.notEqual(first.voiceHash, faster.voiceHash);
  assert.notEqual(first.file, faster.file);
  assert.equal(second.line, OTHER_LINE);
});

test('CC08: concurrent requests for one entry call synth once', async (t) => {
  const root = tempDir(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const synth = async () => {
    calls += 1;
    await gate;
    return wav('slow');
  };
  const cache = createAuditionCache({ rootDir: root, synth });

  const pending = [
    cache.ensure(character(kokoro()), { line: LINE }),
    cache.ensure(character(kokoro()), { line: LINE }),
    cache.ensure(character(kokoro()), { line: LINE }),
  ];
  release();
  const results = await Promise.all(pending);

  assert.equal(calls, 1);
  assert.equal(results.every(result => result.ok), true);
  assert.equal(results.filter(result => result.cached).length, 2);
  assert.equal(new Set(results.map(result => result.path)).size, 1);
});

test('CC08: Qwen without a runtime is unavailable and never calls synth', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const cache = createAuditionCache({ rootDir: root, synth: fake.synth });

  const result = await cache.ensure(character(qwen()), { line: LINE });
  assert.equal(result.ok, false);
  assert.equal(result.code, AUDITION_UNAVAILABLE);
  assert.equal(result.engine, 'qwen3-tts');
  assert.equal(fake.calls(), 0);
  assert.deepEqual(filesIn(join(root, 'characters', ID, 'auditions')), []);

  const oneShot = await ensureAudition(character(qwen()), { rootDir: root, synth: fake.synth, line: LINE });
  assert.equal(oneShot.ok, false);
  assert.equal(oneShot.code, AUDITION_UNAVAILABLE);
  assert.equal(fake.calls(), 0);
});

test('CC08: Qwen auditions once a runtime is injected', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const cache = createAuditionCache({
    rootDir: root,
    synth: fake.synth,
    qwenRuntime: { available: true, kind: 'local' },
  });

  const result = await cache.ensure(character(qwen()), { line: LINE });
  assert.equal(result.ok, true);
  assert.equal(result.engine, 'qwen3-tts');
  assert.equal(fake.calls(), 1);
  assert.equal(fake.requests[0].voice.voice, 'Ryan');
  assert.equal(fake.requests[0].text, LINE);
  assert.equal(fake.requests[0].format, 'wav');
  assert.equal(fake.requests[0].voiceHash, voiceHash(qwen()));
});

test('CC08: an engine-specific synth object also proves the Qwen runtime', async (t) => {
  const root = tempDir(t);
  const kokoroCalls = [];
  const qwenCalls = [];
  const cache = createAuditionCache({
    rootDir: root,
    synth: {
      kokoro: async (request) => {
        kokoroCalls.push(request);
        return wav('kokoro');
      },
      qwen: async (request) => {
        qwenCalls.push(request);
        return wav('qwen');
      },
    },
  });

  const kokoroResult = await cache.ensure(character(kokoro()), { line: LINE });
  const qwenResult = await cache.ensure(character(qwen()), { line: LINE });

  assert.equal(kokoroResult.ok, true);
  assert.equal(qwenResult.ok, true);
  assert.equal(kokoroCalls.length, 1);
  assert.equal(qwenCalls.length, 1);
  assert.equal(qwenCalls[0].engine, 'qwen3-tts');
});

test('CC08: disabled voices and missing synthesizers return stable failures', async (t) => {
  const root = tempDir(t);
  const cache = createAuditionCache({ rootDir: root });

  const disabled = await cache.ensure(character({ engine: 'none' }), { line: LINE });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, AUDITION_UNAVAILABLE);

  const noSynth = await cache.ensure(character(kokoro()), { line: LINE });
  assert.equal(noSynth.ok, false);
  assert.equal(noSynth.code, AUDITION_NO_SYNTH);

  const invalid = await cache.ensure(character(kokoro()), { line: '   ' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, AUDITION_INVALID_LINE);

  const invalidVoice = await cache.ensure(character({ engine: 'kokoro', voice: 'am_nobody' }), { line: LINE });
  assert.equal(invalidVoice.ok, false);
  assert.equal(invalidVoice.code, 'AUDITION_INVALID_VOICE');
});

test('CC08: the first sample line is the default audition text', async (t) => {
  const root = tempDir(t);
  const fake = counterSynth();
  const cache = createAuditionCache({ rootDir: root, synth: fake.synth });

  const fromSample = await cache.ensure(character(kokoro({ sampleLines: [OTHER_LINE] })));
  assert.equal(fromSample.ok, true);
  assert.equal(fromSample.line, OTHER_LINE);

  const fallback = await cache.ensure(character(kokoro({ sampleLines: [] })));
  assert.equal(fallback.ok, true);
  assert.equal(fallback.line, DEFAULT_AUDITION_LINE);
});

test('CC08: a synth may write the outPath directly or return a path', async (t) => {
  const root = tempDir(t);
  const dir = join(root, 'manual');
  const cache = createAuditionCache({
    dir,
    synth: async (request) => {
      writeFileSync(request.outPath, wav('direct'));
    },
  });

  const direct = await cache.ensure(character(kokoro()), { line: LINE });
  assert.equal(direct.ok, true);
  assert.deepEqual(readFileSync(direct.path), wav('direct'));

  const source = join(root, 'source.wav');
  writeFileSync(source, wav('source'));
  const fromPath = await cache.ensure(character(kokoro()), { line: OTHER_LINE, synth: async () => source });
  assert.equal(fromPath.ok, true);
  assert.deepEqual(readFileSync(fromPath.path), wav('source'));
});

test('CC08: synth failures leave no cache entry and a retry can succeed', async (t) => {
  const root = tempDir(t);
  let attempt = 0;
  const cache = createAuditionCache({
    rootDir: root,
    synth: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('runtime died');
      if (attempt === 2) return Buffer.alloc(0);
      return wav('retry');
    },
  });

  const failed = await cache.ensure(character(kokoro()), { line: LINE });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'AUDITION_SYNTH_FAILED');

  const empty = await cache.ensure(character(kokoro()), { line: LINE });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'AUDITION_SYNTH_FAILED');

  const auditionDir = join(root, 'characters', ID, 'auditions');
  assert.deepEqual(filesIn(auditionDir), []);

  const retried = await cache.ensure(character(kokoro()), { line: LINE });
  assert.equal(retried.ok, true);
  assert.equal(attempt, 3);
  assert.deepEqual(filesIn(auditionDir), [`${auditionKey(retried.voiceHash, LINE)}.wav`]);
});

test('CC08: cache writes stay atomic and leave no temp files behind', async (t) => {
  const root = tempDir(t);
  const cache = createAuditionCache({ rootDir: root, synth: async () => wav('atomic') });
  const result = await cache.ensure(character(kokoro()), { line: LINE });
  assert.equal(result.ok, true);

  const auditionDir = join(root, 'characters', ID, 'auditions');
  assert.deepEqual(filesIn(auditionDir), [`${auditionKey(result.voiceHash, LINE)}.wav`]);
  assert.equal(readdirSync(auditionDir).some(name => name.endsWith('.tmp')), false);
});

test('CC08: a CC03 store supplies the contained audition directory', async (t) => {
  const root = tempDir(t);
  const store = createCharacterStore({ rootDir: root, randomId: () => '0123456789abcdef' });
  const created = store.create({
    name: 'Pip',
    role: 'mascot',
    summary: 'Round coffee bean',
    visual: { identityPrompt: 'glossy brown bean' },
    voice: kokoro({ sampleLines: [LINE] }),
  });

  const fake = counterSynth();
  const cache = createAuditionCache({ store, synth: fake.synth });
  const result = await cache.ensure(created, { line: LINE });

  assert.equal(result.ok, true);
  assert.equal(result.path, join(store.auditionsDir(created.id), `${auditionKey(result.voiceHash, LINE)}.wav`));
  assert.equal(existsSync(result.path), true);
  assert.equal(fake.calls(), 1);
});

test('CC08: an injected fs is used for cache I/O', async (t) => {
  const root = tempDir(t);
  let writes = 0;
  const fs = { ...nodeFs };
  fs.writeFileSync = (...args) => {
    writes += 1;
    return nodeFs.writeFileSync(...args);
  };
  const cache = createAuditionCache({ rootDir: root, fs, synth: async () => wav('injected') });
  const result = await cache.ensure(character(kokoro()), { line: LINE });

  assert.equal(result.ok, true);
  assert.equal(writes, 1);
  assert.deepEqual(readFileSync(result.path), wav('injected'));
});
