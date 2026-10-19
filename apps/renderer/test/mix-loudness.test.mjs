import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MIX_LOUDNESS_TARGET, hasAudioStream, measureLoudness, normalizeMixLoudness } from '../scripts/mix-loudness.mjs';

function ffmpeg(args) {
  const run = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
}

/** A 1 s black clip with a quiet tone, and one with no audio at all. */
function fixtures(dir) {
  const quiet = join(dir, 'quiet.mp4');
  ffmpeg([
    '-y', '-hide_banner', '-nostats',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-filter:a', 'volume=-30dB',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', quiet,
  ]);
  const silent = join(dir, 'silent.mp4');
  ffmpeg(['-y', '-hide_banner', '-nostats', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  return { quiet, silent };
}

test('a clip with no audio stream is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mix-loudness-'));
  try {
    const { silent } = fixtures(dir);
    assert.equal(hasAudioStream(silent), false);
    assert.deepEqual(normalizeMixLoudness(silent), { applied: false, reason: 'no audio stream' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the mix is normalised to about -16 LUFS and the picture is copied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mix-loudness-'));
  try {
    const { quiet } = fixtures(dir);
    assert.equal(hasAudioStream(quiet), true);
    const before = measureLoudness(quiet);
    assert.ok(before && before.integratedLufs < -20, `expected a quiet input, got ${JSON.stringify(before)}`);
    const result = normalizeMixLoudness(quiet);
    assert.equal(result.applied, true);
    assert.equal(result.target, MIX_LOUDNESS_TARGET);
    const after = measureLoudness(quiet);
    assert.ok(after && Math.abs(after.integratedLufs - MIX_LOUDNESS_TARGET.integratedLufs) < 2, `expected about -16 LUFS, got ${JSON.stringify(after)}`);
    assert.ok(after.truePeakDbtp <= MIX_LOUDNESS_TARGET.truePeakDbtp + 0.5, `true peak ${after.truePeakDbtp} exceeds the ceiling`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
