import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  DEFAULT_KEYFRAME_COUNT,
  FRAME_MAX_EDGE,
  THUMB_MAX_EDGE,
  extractFrames,
  frameTimestamps,
  isInside,
  keyframeArgs,
  posterArgs,
  thumbArgs,
} from '../../src/references/frames.mjs';

const FRAME_FILTER = "scale=w='min(1024,iw)':h='min(1024,ih)':force_original_aspect_ratio=decrease";
const THUMB_FILTER = "scale=w='min(320,iw)':h='min(320,ih)':force_original_aspect_ratio=decrease";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function pngSize(file) {
  const bytes = readFileSync(file);
  assert.equal(bytes.subarray(0, 8).equals(PNG_SIGNATURE), true);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function realExec(command, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr}`));
      else resolvePromise({ code, stderr });
    });
  });
}

test('posterArgs is a golden ffmpeg argument array with -ss before -i', () => {
  const args = posterArgs('clip.mp4', 'poster.png', 1.25);
  assert.deepEqual(args, [
    '-y', '-v', 'error',
    '-ss', '1.25',
    '-i', 'clip.mp4',
    '-frames:v', '1',
    '-vf', FRAME_FILTER,
    '-an',
    'poster.png',
  ]);
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
  assert.equal(args[args.indexOf('-vf') + 1].includes('1024'), true);
});

test('keyframeArgs is a golden ffmpeg argument array that seeks each frame before its input', () => {
  const args = keyframeArgs('clip.mp4', 'frames/%d.png', { count: 4, durationSec: 2 });
  const seek = atSec => ['-ss', atSec, '-i', 'clip.mp4', '-frames:v', '1', '-vf', FRAME_FILTER, '-an'];
  assert.deepEqual(args, [
    '-y', '-v', 'error',
    ...seek('0.2'), 'frames/0.png',
    ...seek('0.733333333'), 'frames/1.png',
    ...seek('1.266666667'), 'frames/2.png',
    ...seek('1.8'), 'frames/3.png',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-ss') assert.equal(args[index + 2], '-i');
  }
});

test('keyframeArgs defaults to four frames over a given duration', () => {
  const args = keyframeArgs('clip.mp4', 'f/%02d.png', { durationSec: 10 });
  assert.equal(DEFAULT_KEYFRAME_COUNT, 4);
  const seeks = args.reduce((found, value, index) => (value === '-ss' ? [...found, args[index + 1]] : found), []);
  assert.deepEqual(seeks, ['1', '3.666666667', '6.333333333', '9']);
  assert.equal(args.filter(value => value === '-frames:v').length, 4);
  assert.deepEqual(args.filter(value => value.endsWith('.png')), ['f/00.png', 'f/01.png', 'f/02.png', 'f/03.png']);
});

test('frame timestamps are evenly spaced from 10 to 90 percent and stay inside the duration', () => {
  for (const durationSec of [0.5, 2, 7.25, 60]) {
    for (const count of [1, 2, 4, 7]) {
      const times = frameTimestamps(count, durationSec);
      assert.equal(times.length, count);
      assert.ok(times[0] >= durationSec * 0.1 - 1e-9);
      assert.ok(times.at(-1) <= durationSec * 0.9 + 1e-9);
      assert.ok(times[0] > 0 && times.at(-1) < durationSec);
      if (count === 1) {
        assert.ok(Math.abs(times[0] - durationSec * 0.1) < 1e-9);
        continue;
      }
      assert.ok(Math.abs(times[0] - durationSec * 0.1) < 1e-9);
      assert.ok(Math.abs(times.at(-1) - durationSec * 0.9) < 1e-9);
      const step = times[1] - times[0];
      for (let index = 2; index < times.length; index += 1) {
        assert.ok(Math.abs((times[index] - times[index - 1]) - step) < 1e-9);
      }
    }
  }
});

test('thumbArgs is a golden 320px JPEG argument array', () => {
  const args = thumbArgs('input.png', 'thumb.jpg');
  assert.deepEqual(args, [
    '-y', '-v', 'error',
    '-i', 'input.png',
    '-frames:v', '1',
    '-vf', THUMB_FILTER,
    '-q:v', '3',
    '-an',
    'thumb.jpg',
  ]);
  assert.equal(THUMB_MAX_EDGE, 320);
  assert.equal(FRAME_MAX_EDGE, 1024);
});

test('extractFrames calls ffmpeg once with keyframe args and returns indexed paths inside outDir', async () => {
  const dir = tempDir('comfyrizz-frames-fake-');
  try {
    const calls = [];
    const outDir = join(dir, 'frames');
    const result = await extractFrames('/tmp/clip.mp4', outDir, {
      durationSec: 2,
      count: 4,
      exec: async (command, args, options) => { calls.push({ command, args, options }); },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'ffmpeg');
    assert.deepEqual(calls[0].args, keyframeArgs('/tmp/clip.mp4', join(resolve(outDir), '%d.png'), { count: 4, durationSec: 2 }));
    assert.equal(calls[0].options.timeoutMs > 0, true);
    assert.deepEqual(result.map(frame => frame.index), [0, 1, 2, 3]);
    assert.deepEqual(result.map(frame => frame.atSec), frameTimestamps(4, 2));
    assert.ok(Math.abs(result[0].atSec - 0.2) < 1e-9);
    assert.ok(Math.abs(result[3].atSec - 1.8) < 1e-9);
    for (const frame of result) {
      assert.equal(frame.file, join(resolve(outDir), `${frame.index}.png`));
      assert.equal(isInside(resolve(outDir), frame.file), true);
      assert.equal(relative(resolve(outDir), frame.file).startsWith('..'), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractFrames rejects outDir paths that escape through parent segments', async () => {
  const dir = tempDir('comfyrizz-frames-escape-');
  try {
    let called = false;
    await assert.rejects(
      extractFrames('/tmp/clip.mp4', `${dir}/../outside`, {
        durationSec: 2,
        exec: async () => { called = true; },
      }),
      /parent-directory/,
    );
    assert.equal(called, false);
    assert.equal(isInside(dir, join(dir, '..', 'outside', '0.png')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractFrames rejects a symlinked frame target that would write outside outDir', async () => {
  const dir = tempDir('comfyrizz-frames-symlink-');
  try {
    const outDir = join(dir, 'frames');
    const outside = join(dir, 'outside.png');
    writeFileSync(outside, 'do not overwrite');
    mkdirSync(outDir, { recursive: true });
    symlinkSync(outside, join(outDir, '0.png'));
    await assert.rejects(
      extractFrames('/tmp/clip.mp4', outDir, { durationSec: 2, exec: async () => {} }),
      /escapes outDir/,
    );
    assert.equal(readFileSync(outside, 'utf8'), 'do not overwrite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('argument builders reject invalid timings and counts', () => {
  assert.throws(() => posterArgs('in.mp4', 'out.png', -1), /atSec/);
  assert.throws(() => posterArgs('', 'out.png', 1), /input/);
  assert.throws(() => keyframeArgs('in.mp4', 'f/%d.png', { count: 0, durationSec: 2 }), /count/);
  assert.throws(() => keyframeArgs('in.mp4', 'f/%d.png', { durationSec: 0 }), /durationSec/);
  assert.throws(() => thumbArgs('in.png', ''), /output/);
});

test('extractFrames honors the real ffmpeg on a generated 2 second testsrc clip', { skip: !HAS_FFMPEG }, async () => {
  const dir = tempDir('comfyrizz-frames-it-');
  try {
    const clip = join(dir, 'testsrc.mp4');
    const made = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=1600x900:rate=24:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
      '-y', clip,
    ], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    assert.equal(existsSync(clip), true);

    const outDir = join(dir, 'frames');
    const frames = await extractFrames(clip, outDir, { exec: realExec, durationSec: 2, count: 4 });
    assert.equal(frames.length, 4);
    assert.deepEqual(frames.map(frame => frame.index), [0, 1, 2, 3]);
    assert.ok(Math.abs(frames[0].atSec - 0.2) < 1e-9);
    assert.ok(Math.abs(frames.at(-1).atSec - 1.8) < 1e-9);
    const step = frames[1].atSec - frames[0].atSec;
    for (let index = 1; index < frames.length; index += 1) {
      assert.ok(Math.abs((frames[index].atSec - frames[index - 1].atSec) - step) < 1e-9);
      assert.ok(frames[index].atSec < 2);
    }
    for (const frame of frames) {
      assert.equal(existsSync(frame.file), true);
      assert.ok(statSync(frame.file).size > 0);
      const size = pngSize(frame.file);
      assert.equal(size.width, 1024);
      assert.equal(size.height, 576);
    }

    const poster = join(dir, 'poster.png');
    await realExec('ffmpeg', posterArgs(clip, poster, 1), { timeoutMs: 30000 });
    assert.deepEqual(pngSize(poster), { width: 1024, height: 576 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
