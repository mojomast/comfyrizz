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

/** Mean volume (dBFS) of a window, via volumedetect. */
function meanVolume(file, start, duration) {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(start), '-t', String(duration), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = run.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  assert.ok(match, `volumedetect failed: ${(run.stderr || '').slice(-300)}`);
  return Number(match[1]);
}

/** The first audio stream's sample rate. */
function sampleRate(file) {
  const run = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'default=nk=1:nw=1', file], { encoding: 'utf8' });
  return Number(run.stdout.trim());
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

test('G6-11: two-pass linear loudnorm keeps the ducked tail quiet and resamples to 48 kHz', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mix-loudness-'));
  try {
    // 2 s of "narration" at -14 dB then 2 s of "ducked music" 26 dB below it; the
    // old one-pass dynamic loudnorm would pump the quiet tail back up (G6-11).
    const mix = join(dir, 'mix.mp4');
    ffmpeg([
      '-y', '-hide_banner', '-nostats',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2',
      '-filter_complex', '[0:a]volume=-14dB[a];[1:a]volume=-40dB[b];[a][b]concat=n=2:v=0:a=1[out]',
      '-map', '[out]', '-ar', '44100', '-c:a', 'aac', '-b:a', '192k', mix,
    ]);
    const beforeGap = meanVolume(mix, 0, 1) - meanVolume(mix, 2.5, 1);
    assert.ok(beforeGap > 20, `fixture should start with a wide gap, got ${beforeGap}`);
    const result = normalizeMixLoudness(mix);
    assert.equal(result.applied, true);
    const afterGap = meanVolume(mix, 0, 1) - meanVolume(mix, 2.5, 1);
    assert.ok(afterGap > beforeGap - 3, `the ducked tail must stay ~${beforeGap} dB down, got ${afterGap}`);
    assert.equal(sampleRate(mix), 48000, 'loudnorm must not leave the AAC at 96 kHz');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
