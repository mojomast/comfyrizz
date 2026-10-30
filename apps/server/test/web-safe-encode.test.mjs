import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WEB_SAFE_H264, withWebSafe } from '../src/web-safe-encode.mjs';
import { correctPresenters } from '../src/pipeline-media.mjs';
import { remuxFaststart } from '../../renderer/scripts/render-pipeline.mjs';

test('WEB_SAFE_H264 is the web-safe H.264 flag sequence', () => {
  assert.deepEqual([...WEB_SAFE_H264], ['-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart']);
});

test('withWebSafe inserts the flags once before the output path', () => {
  const args = ['-y', '-i', 'input.mp4', 'output.mp4'];
  const first = withWebSafe(args);
  assert.deepEqual(first, ['-y', '-i', 'input.mp4', ...WEB_SAFE_H264, 'output.mp4']);
  const second = withWebSafe(first);
  assert.deepEqual(second, first);
  assert.equal(second.filter(arg => arg === '-pix_fmt').length, 1);
  assert.equal(second.filter(arg => arg === '-profile:v').length, 1);
  assert.equal(second.filter(arg => arg === '-movflags').length, 1);
  assert.equal(second.at(-1), 'output.mp4');
});

test('withWebSafe replaces an existing pixel format instead of duplicating it', () => {
  const args = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', 'output.mp4'];
  const result = withWebSafe(args);
  assert.deepEqual(result, ['-c:v', 'libx264', '-crf', '17', ...WEB_SAFE_H264, 'output.mp4']);
});

test('pipeline-media encodes corrected presenters with the web-safe H.264 flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-web-safe-presenter-'));
  const workDir = join(root, 'work');
  const runDir = join(root, 'run');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const pkg = {
    scenes: [{ id: 's1', presenter_asset: 'a_p', narration: 'Hello' }],
    assets: { a_p: { kind: 'video', file: 'assets/a_p.mp4', status: 'ready' } },
    presenter: { enabled: true, scenes: 'all' },
  };
  writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg));

  const ffmpegCalls = [];
  let reports = 0;
  const command = async (bin, args) => {
    if (bin === 'ffprobe') {
      return { code: 0, stdout: JSON.stringify({ streams: [{ r_frame_rate: '24/1', nb_frames: '48' }] }), stderr: '' };
    }
    if (bin === 'ffmpeg') {
      ffmpegCalls.push(args);
      mkdirSync(dirname(args.at(-1)), { recursive: true });
      writeFileSync(args.at(-1), 'fake-mp4');
      return { code: 0, stdout: '', stderr: '' };
    }
    const out = args[args.indexOf('--out') + 1];
    mkdirSync(out, { recursive: true });
    reports += 1;
    const report = reports === 1
      ? { passed: false, confidence: 9, offsetMs: -125 }
      : { passed: true, confidence: 9, offsetMs: 0 };
    writeFileSync(join(out, 'report.json'), JSON.stringify(report));
    return { code: reports === 1 ? 2 : 0, stdout: '', stderr: '' };
  };

  try {
    const results = await correctPresenters(workDir, runDir, {
      command,
      env: { COMFYRIZZ_SYNCNET_PYTHON: 'fake-python', COMFYRIZZ_SYNCNET_DIR: 'fake-syncnet' },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].file, 'assets/a_p-synced.mp4');
    assert.equal(ffmpegCalls.length, 1);
    const args = ffmpegCalls[0];
    assert.equal(args.at(-1), join(workDir, 'assets/a_p-synced.mp4'));
    assert.ok(args.includes('-profile:v'));
    assert.equal(args[args.indexOf('-profile:v') + 1], 'high');
    assert.ok(args.includes('-movflags'));
    assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
    assert.ok(args.includes('-pix_fmt'));
    assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
    assert.ok(args.indexOf('-profile:v') < args.length - 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('render-pipeline remux copies streams into a faststart output and verifies High profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-web-safe-remux-'));
  const output = join(dir, 'video.mp4');
  writeFileSync(output, 'remotion-output');
  const calls = [];
  const run = (bin, args) => {
    calls.push({ bin, args });
    writeFileSync(args.at(-1), 'remuxed');
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const info = remuxFaststart(output, { run, probe: () => ({ profile: 'High', pix_fmt: 'yuv420p' }) });
    assert.equal(info.profile, 'High');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, 'ffmpeg');
    const args = calls[0].args;
    assert.equal(args[args.indexOf('-c') + 1], 'copy');
    assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
    assert.equal(args.at(-1), `${output}.faststart.mp4`);
    assert.equal(readFileSync(output, 'utf8'), 'remuxed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render-pipeline remux rejects an output that is not High profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-web-safe-remux-bad-'));
  const output = join(dir, 'video.mp4');
  writeFileSync(output, 'remotion-output');
  const run = (bin, args) => {
    writeFileSync(args.at(-1), 'remuxed');
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    assert.throws(
      () => remuxFaststart(output, { run, probe: () => ({ profile: 'Main', pix_fmt: 'yuv420p' }) }),
      /High/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
