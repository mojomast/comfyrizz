import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { join } from 'node:path';

import { createThumbService } from '../../src/thumbs/service.mjs';
import {
  WAVEFORM_BUCKETS,
  filmstripCount,
  peaksFromPcm,
  thumbKey,
  tileMap,
} from '../../src/thumbs/spec.mjs';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SOURCE_SHA = createHash('sha256').update('service-source-a').digest('hex');
const OTHER_SHA = createHash('sha256').update('service-source-b').digest('hex');
const THIRD_SHA = createHash('sha256').update('service-source-c').digest('hex');
const FAILURE_TTL_MS = 10 * 60 * 1000;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-thumbs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pcmBuffer() {
  const samples = new Int16Array(512);
  for (let index = 0; index < 256; index += 1) samples[index] = 16384;
  return Buffer.from(samples.buffer);
}

function callsOf(exec) {
  return exec.calls;
}

function outputOf(call) {
  return call.args.at(-1);
}

function imageOutputs(exec) {
  return callsOf(exec).map(outputOf).filter(path => !path.endsWith('.pcm'));
}

function makeExec(overrides = {}) {
  const exec = async (command, args, options) => {
    const call = { command, args, options, output: args.at(-1) };
    exec.calls.push(call);
    if (typeof overrides.onCall === 'function') await overrides.onCall(call, exec);
    if (call.output.endsWith('.pcm')) {
      writeFileSync(call.output, overrides.pcm ?? pcmBuffer());
    } else {
      writeFileSync(call.output, PNG_BYTES);
    }
    return { stdout: '', stderr: '' };
  };
  exec.calls = [];
  return exec;
}

function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

test('image thumbnails use a .png temp extension and land at <key>.png', async t => {
  const runtimeDir = scratch(t);
  const exec = makeExec();
  const service = createThumbService({ runtimeDir, exec });
  const source = { file: 'clip.mp4', sha256: SOURCE_SHA, kind: 'video', durationSec: 5 };

  const first = service.get(source, 'poster');
  assert.deepEqual(first, { status: 'pending' });
  const ready = await service.warm(source, ['poster']);
  const result = ready[0];

  assert.equal(result.status, 'ready');
  assert.match(result.key, /^[0-9a-f]{64}$/);
  assert.equal(result.width, 320);
  assert.equal(result.height, 180);
  assert.equal(result.file, join(runtimeDir, 'thumbs', `${result.key}.png`));
  assert.equal(existsSync(result.file), true);

  const images = imageOutputs(exec);
  assert.equal(images.length, 1);
  assert.match(images[0], new RegExp(`^${runtimeDir}/thumbs/${result.key}\\.\\d+\\.\\d+\\.tmp\\.png$`));
  assert.equal(images.every(path => path.endsWith('.png')), true);
  assert.equal(callsOf(exec)[0].options.timeoutMs, 30000);
  assert.ok(callsOf(exec)[0].options.signal instanceof AbortSignal);

  const again = service.get(source, 'poster');
  assert.equal(again.status, 'ready');
  assert.equal(callsOf(exec).length, 1);
});

test('filmstrip ready carries tiles from the filmstrip count', async t => {
  const runtimeDir = scratch(t);
  const exec = makeExec();
  const service = createThumbService({ runtimeDir, exec });
  const source = { file: 'clip.mp4', sha256: SOURCE_SHA, kind: 'video', durationSec: 5 };

  const [result] = await service.warm(source, ['filmstrip']);
  const count = filmstripCount(5);
  assert.equal(result.status, 'ready');
  assert.equal(result.width, count * 160);
  assert.equal(result.height, 90);
  assert.deepEqual(result.tiles, tileMap(count, 5));
  assert.equal(existsSync(join(runtimeDir, 'thumbs', `${result.key}.png`)), true);
  assert.equal(imageOutputs(exec).every(path => path.endsWith('.png')), true);
});

test('waveform writes a .png plus raw PCM, returns 256 peaks, and reuses them after restart', async t => {
  const runtimeDir = scratch(t);
  const pcm = pcmBuffer();
  const exec = makeExec({ pcm });
  const service = createThumbService({ runtimeDir, exec });
  const source = { file: 'voice.wav', sha256: SOURCE_SHA, kind: 'audio', durationSec: 4 };

  const [result] = await service.warm(source, ['waveform']);
  const expectedPeaks = peaksFromPcm(pcm, WAVEFORM_BUCKETS);
  assert.equal(result.status, 'ready');
  assert.equal(result.width, 640);
  assert.equal(result.height, 64);
  assert.equal(result.peaks.length, 256);
  assert.deepEqual(result.peaks, expectedPeaks);
  assert.equal(result.key, thumbKey({ sourceSha256: SOURCE_SHA, kind: 'waveform', params: {} }));

  const outputs = callsOf(exec).map(outputOf);
  assert.equal(outputs.some(path => path.endsWith('.png')), true);
  assert.equal(outputs.some(path => path.endsWith('.pcm')), true);
  for (const path of outputs) {
    assert.match(path, new RegExp(`^${runtimeDir}/thumbs/${result.key}\\.\\d+\\.\\d+\\.tmp\\.(png|pcm)$`));
  }
  assert.equal(existsSync(result.file), true);
  assert.equal(readdirSync(join(runtimeDir, 'thumbs')).some(name => name.endsWith('.pcm')), false);

  const restartExec = makeExec();
  const restarted = createThumbService({ runtimeDir, exec: restartExec });
  const cached = restarted.get(source, 'waveform');
  assert.equal(cached.status, 'ready');
  assert.deepEqual(cached.peaks, expectedPeaks);
  assert.equal(restartExec.calls.length, 0);
});

test('three concurrent gets for one key share a single exec', async t => {
  const runtimeDir = scratch(t);
  const exec = makeExec();
  const service = createThumbService({ runtimeDir, exec });
  const source = { file: 'clip.mp4', sha256: SOURCE_SHA, kind: 'video', durationSec: 2 };

  const results = [service.get(source, 'poster'), service.get(source, 'poster'), service.get(source, 'poster')];
  assert.deepEqual(results, [{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }]);
  assert.equal(exec.calls.length, 1);

  const [ready] = await service.warm(source, ['poster']);
  assert.equal(ready.status, 'ready');
  assert.equal(exec.calls.length, 1);
});

test('the exec queue runs at most two ffmpeg processes at once', async t => {
  const runtimeDir = scratch(t);
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const exec = async (command, args, options) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    exec.calls.push({ command, args, options, output: args.at(-1) });
    await gate;
    writeFileSync(args.at(-1), PNG_BYTES);
    active -= 1;
    return { stdout: '', stderr: '' };
  };
  exec.calls = [];
  const service = createThumbService({ runtimeDir, exec });
  const sources = [SOURCE_SHA, OTHER_SHA, THIRD_SHA].map((sha256, index) => ({
    file: `clip-${index}.mp4`,
    sha256,
    kind: 'video',
    durationSec: 2,
  }));

  const pending = sources.map(source => service.warm(source, ['poster']));
  await waitFor(() => active === 2 && exec.calls.length === 2);
  assert.equal(maxActive, 2);
  release();
  const results = await Promise.all(pending);
  assert.equal(results.every(([result]) => result.status === 'ready'), true);
  assert.equal(maxActive, 2);
  assert.equal(exec.calls.length, 3);
});

test('timeout aborts the exec signal, records a retryAfter failure, and retry runs again', async t => {
  const runtimeDir = scratch(t);
  let aborted = false;
  let signals = 0;
  const exec = (command, args, options) => {
    const output = args.at(-1);
    exec.calls.push({ command, args, options, output });
    if (args.includes('slow.mp4')) {
      signals += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted by test'), { name: 'AbortError' }));
        }, { once: true });
      });
    }
    writeFileSync(output, PNG_BYTES);
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  exec.calls = [];
  const now = () => 1_000_000;
  const service = createThumbService({ runtimeDir, exec, now, timeoutMs: 20 });
  const slow = { file: 'slow.mp4', sha256: SOURCE_SHA, kind: 'video', durationSec: 2 };
  const slowKey = thumbKey({ sourceSha256: SOURCE_SHA, kind: 'poster', params: { durationSec: 2 } });

  const [failed] = await service.warm(slow, ['poster']);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'timeout');
  assert.equal(failed.retryAfter, 1_000_000 + FAILURE_TTL_MS);
  assert.equal(aborted, true);
  assert.equal(signals, 1);
  assert.equal(exec.calls[0].options.timeoutMs, 20);

  const cachedFailure = service.get(slow, 'poster');
  assert.equal(cachedFailure.status, 'failed');
  assert.equal(exec.calls.length, 1);

  const fast = { file: 'fast.mp4', sha256: OTHER_SHA, kind: 'video', durationSec: 2 };
  const [fastResult] = await service.warm(fast, ['poster']);
  assert.equal(fastResult.status, 'ready');

  assert.equal(service.retry(slowKey), true);
  const afterRetry = service.get(slow, 'poster');
  assert.equal(afterRetry.status, 'pending');
  const [retried] = await service.warm(slow, ['poster']);
  assert.equal(retried.status, 'failed');
  assert.equal(signals, 2);
});

test('ENOENT records ffmpeg-unavailable and text assets return none', async t => {
  const runtimeDir = scratch(t);
  const exec = async (command, args, options) => {
    exec.calls.push({ command, args, options, output: args.at(-1) });
    throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
  };
  exec.calls = [];
  const service = createThumbService({ runtimeDir, exec, now: () => 5_000 });
  const source = { file: 'clip.mp4', sha256: SOURCE_SHA, kind: 'video', durationSec: 2 };

  const [failed] = await service.warm(source, ['poster']);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'ffmpeg-unavailable');
  assert.equal(failed.retryAfter, 5_000 + FAILURE_TTL_MS);
  assert.equal(existsSync(join(runtimeDir, 'thumbs', 'failures.json')), true);

  const restartExec = makeExec();
  const restarted = createThumbService({ runtimeDir, exec: restartExec, now: () => 5_000 });
  const persisted = restarted.get(source, 'poster');
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.reason, 'ffmpeg-unavailable');
  assert.equal(restartExec.calls.length, 0);

  const text = { file: 'notes.txt', sha256: OTHER_SHA, kind: 'text' };
  assert.deepEqual(service.get(text, 'poster'), { status: 'none', reason: 'text' });
  assert.deepEqual(service.get(text, 'waveform'), { status: 'none', reason: 'text' });
});

test('expired failures are retried on the next get', async t => {
  const runtimeDir = scratch(t);
  let current = 0;
  let fail = true;
  const exec = async (command, args, options) => {
    exec.calls.push({ command, args, options, output: args.at(-1) });
    if (fail) throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    writeFileSync(args.at(-1), PNG_BYTES);
    return { stdout: '', stderr: '' };
  };
  exec.calls = [];
  const service = createThumbService({ runtimeDir, exec, now: () => current });
  const source = { file: 'clip.mp4', sha256: SOURCE_SHA, kind: 'video', durationSec: 2 };

  const [failed] = await service.warm(source, ['poster']);
  assert.equal(failed.status, 'failed');
  current += FAILURE_TTL_MS + 1;
  fail = false;

  const [ready] = await service.warm(source, ['poster']);
  assert.equal(ready.status, 'ready');
  assert.equal(exec.calls.length, 2);
});

test('rejects malformed sources and keys without running ffmpeg', t => {
  const runtimeDir = scratch(t);
  const exec = makeExec();
  const service = createThumbService({ runtimeDir, exec });

  assert.throws(() => service.get({ file: '', sha256: SOURCE_SHA, kind: 'video', durationSec: 1 }, 'poster'), /file/);
  assert.throws(() => service.get({ file: 'x.mp4', sha256: 'nope', kind: 'video', durationSec: 1 }, 'poster'), /sha256/);
  assert.throws(() => service.get({ file: 'x.mp4', sha256: SOURCE_SHA, kind: 'video', durationSec: 1 }, 'gif'), /kind/);
  assert.throws(() => service.get({ file: 'x.mp4', sha256: SOURCE_SHA, kind: 'video' }, 'filmstrip'), /durationSec/);
  assert.throws(() => service.retry('nope'), /key/);
  assert.equal(exec.calls.length, 0);
});
