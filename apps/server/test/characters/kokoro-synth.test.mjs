// IP45K: the free Kokoro audition synthesizer.
//
// createKokoroSynth runs packages/tts/py/synth.py through an injected
// runCommand, writes one cached wave per (voice, line), and never shells out.
// These tests use a fake runCommand that writes a tiny valid WAV, so no Python
// or Kokoro model is needed. The single real-runtime test is opt-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createKokoroSynth } from '../../src/characters/kokoro-synth.mjs';
import { voiceHash } from '../../src/characters/voice.mjs';

const VOICE = Object.freeze({ engine: 'kokoro', voice: 'af_heart', language: 'en-us', speed: 1, chunking: 'sentence' });
const LINE = 'Hello! This is a free Kokoro audition.';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-kokoro-synth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tinyWav(label = 'kokoro', frames = 2400) {
  const data = Buffer.alloc(frames * 2);
  const prefix = Buffer.from(label, 'utf8');
  prefix.copy(data, 0, 0, Math.min(prefix.length, data.length));
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

function arg(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function fakeRun(t, { wav = () => tinyWav(), calls = [], after } = {}) {
  return async (file, args, options) => {
    calls.push({ file, args: [...args], options });
    if (after) await after(file, args, options);
    const out = arg(args, '--out');
    assert.ok(out, 'synth.py is invoked with --out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'narration.raw.wav'), wav(args));
    return { stdout: '', stderr: '' };
  };
}

test('IP45K: createKokoroSynth writes a verified WAV and a cache hit runs nothing', async (t) => {
  const cacheDir = workspace(t);
  const calls = [];
  const synth = createKokoroSynth({
    runCommand: fakeRun(t, { calls }),
    cacheDir,
    timeoutMs: 5000,
  });

  const first = await synth({ voice: VOICE, text: LINE });
  assert.equal(first.voicePath, 'kokoro');
  assert.equal(first.bytes, statSync(first.file).size);
  assert.equal(first.sha256, (await import('node:crypto')).createHash('sha256').update(readFileSync(first.file)).digest('hex'));
  assert.ok(Math.abs(first.durationSeconds - 0.1) < 0.001);
  assert.equal(existsSync(first.file), true);
  assert.equal(readFileSync(first.file).subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].args.includes('--package'));
  assert.ok(calls[0].args.includes('--out'));
  assert.equal(calls[0].args.some((value) => value.includes(LINE)), false, 'the line travels in the package JSON, never in argv');

  const second = await synth({ voice: VOICE, text: LINE });
  assert.equal(calls.length, 1, 'a cache hit never spawns the synthesizer');
  assert.equal(second.file, first.file);
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.bytes, first.bytes);
  assert.equal(readFileSync(second.file).equals(readFileSync(first.file)), true);
});

test('IP45K: a timeout aborts the child and leaves no partial cache entry', async (t) => {
  const cacheDir = workspace(t);
  const synth = createKokoroSynth({
    cacheDir,
    timeoutMs: 40,
    runCommand: async (_file, _args, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });

  const started = Date.now();
  await assert.rejects(() => synth({ voice: VOICE, text: LINE }), /timed out|timeout/i);
  assert.ok(Date.now() - started < 2000, 'the timeout returns promptly');
  const leftovers = existsSync(cacheDir) ? readdirSync(cacheDir).filter((name) => name.startsWith('.work-')) : [];
  assert.deepEqual(leftovers, []);
});

test('IP45K: non-WAV output is rejected and never cached', async (t) => {
  const cacheDir = workspace(t);
  const synth = createKokoroSynth({
    cacheDir,
    runCommand: fakeRun(t, { wav: () => Buffer.from('definitely not a wave', 'utf8') }),
  });

  await assert.rejects(() => synth({ voice: VOICE, text: LINE }), /wave|wav|RIFF/i);
  const leftovers = existsSync(cacheDir)
    ? readdirSync(cacheDir, { recursive: true }).filter((name) => String(name).endsWith('.wav'))
    : [];
  assert.deepEqual(leftovers, []);
});

test('IP45K: unknown, non-Kokoro and non-object voices are rejected', async (t) => {
  const cacheDir = workspace(t);
  const synth = createKokoroSynth({ cacheDir, runCommand: fakeRun(t) });

  await assert.rejects(
    () => synth({ voice: { engine: 'kokoro', voice: 'am_nobody' }, text: LINE }),
    /unknown Kokoro voice|voice/i,
  );
  await assert.rejects(
    () => synth({ voice: { engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'custom' }, text: LINE }),
    /kokoro/i,
  );
  await assert.rejects(() => synth({ voice: 'af_heart', text: LINE }), /object|voice/i);
  await assert.rejects(() => synth({ voice: VOICE }), /text|line/i);
});

test('IP45K: shell metacharacters in the line stay data, never argv', async (t) => {
  const cacheDir = workspace(t);
  const calls = [];
  const hostile = 'Hello; touch /tmp/pwned && echo $(id) | cat';
  let packageJson;
  const runCommand = async (file, args, options) => {
    calls.push({ file, args: [...args], options });
    packageJson = JSON.parse(readFileSync(arg(args, '--package'), 'utf8'));
    const out = arg(args, '--out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'narration.raw.wav'), tinyWav());
    return { stdout: '', stderr: '' };
  };
  const synth = createKokoroSynth({ cacheDir, runCommand });

  const result = await synth({ voice: VOICE, text: hostile });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(Array.isArray(call.args), true);
  assert.equal(call.options.shell, false);
  assert.equal(call.args.some((value) => value.includes('touch') || value.includes('$(id)')), false);
  assert.equal(packageJson.scenes[0].narration, hostile);
  assert.equal(resolve(result.file).startsWith(`${resolve(cacheDir)}/`), true);
});

test('IP45K: the real Kokoro runtime synthesises one line (opt-in)', {
  skip: process.env.COMFYRIZZ_KOKORO_REAL !== '1',
  timeout: 300000,
}, async (t) => {
  const cacheDir = workspace(t);
  const synth = createKokoroSynth({ cacheDir, timeoutMs: 280000 });
  const result = await synth({
    voice: { engine: 'kokoro', voice: 'af_heart', language: 'en-us', speed: 1, chunking: 'sentence' },
    text: 'Kokoro speaks this line locally.',
  });
  assert.equal(readFileSync(result.file).subarray(0, 4).toString('latin1'), 'RIFF');
  assert.ok(result.durationSeconds > 0);
  assert.equal(result.voicePath, 'kokoro');
  assert.equal(voiceHash({ ...VOICE }), voiceHash(VOICE));
});
