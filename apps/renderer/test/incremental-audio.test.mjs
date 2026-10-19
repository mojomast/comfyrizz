import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { muxPackageAudio } from '../scripts/incremental-audio.mjs';
import { hasAudioStream, measureLoudness } from '../scripts/mix-loudness.mjs';

function ffmpeg(args) {
  const run = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
}

function tone(path, { frequency, seconds, volumeDb }) {
  ffmpeg(['-y', '-hide_banner', '-nostats', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`, '-filter:a', `volume=${volumeDb}dB`, path]);
}

/** A 3 s silent video plus narration, music and one SFX in `audio/`. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'incremental-audio-'));
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const silent = join(dir, 'silent.mp4');
  ffmpeg(['-y', '-hide_banner', '-nostats', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  tone(join(dir, 'audio', 'narration.wav'), { frequency: 440, seconds: 2, volumeDb: -20 });
  tone(join(dir, 'audio', 'music.wav'), { frequency: 220, seconds: 3, volumeDb: -20 });
  tone(join(dir, 'audio', 'sfx.wav'), { frequency: 880, seconds: 0.3, volumeDb: -10 });
  const pkg = {
    audio: { music: { asset: 'a_music', gain_db: -18 }, sfx: [{ asset: 'a_sfx', scene: 's1', at: 'scene-start' }] },
    assets: {
      a_narr: { kind: 'audio', status: 'ready', file: 'audio/narration.wav' },
      a_music: { kind: 'audio', status: 'ready', file: 'audio/music.wav' },
      a_sfx: { kind: 'audio', status: 'ready', file: 'audio/sfx.wav', media: { durationSeconds: 0.3 } },
    },
    scenes: [{ id: 's1', narration_asset: 'a_narr' }],
  };
  const timeline = {
    fps: 10,
    durationInFrames: 30,
    scenes: [{ id: 's1', from: 0, durationInFrames: 30, transitionOutFrames: 0 }],
    captions: [{ from: 5, to: 15 }],
  };
  return { dir, silent, pkg, timeline };
}

test('no narration and no mix leaves the file silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'incremental-audio-'));
  try {
    const silent = join(dir, 'silent.mp4');
    ffmpeg(['-y', '-hide_banner', '-nostats', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
    const result = muxPackageAudio({ silentPath: silent, outputPath: join(dir, 'out.mp4'), packageDir: dir, pkg: { assets: {}, scenes: [] }, timeline: { fps: 10, durationInFrames: 10, scenes: [], captions: [] } });
    assert.deepEqual(result, { audio: null, loudness: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('narration + music + SFX are mixed, ducked and normalised to -16 LUFS', () => {
  const { dir, silent, pkg, timeline } = fixture();
  try {
    const output = join(dir, 'out.mp4');
    const result = muxPackageAudio({ silentPath: silent, outputPath: output, packageDir: dir, pkg, timeline });
    assert.equal(result.audio.sources, 3);
    assert.equal(hasAudioStream(output), true);
    const loudness = measureLoudness(output);
    assert.ok(loudness && Math.abs(loudness.integratedLufs - (-16)) < 2, `expected about -16 LUFS, got ${JSON.stringify(loudness)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixAudio:false keeps only the narration', () => {
  const { dir, silent, pkg, timeline } = fixture();
  try {
    const output = join(dir, 'out.mp4');
    const result = muxPackageAudio({ silentPath: silent, outputPath: output, packageDir: dir, pkg, timeline, mixAudio: false });
    assert.equal(result.audio.sources, 1);
    assert.equal(hasAudioStream(output), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
