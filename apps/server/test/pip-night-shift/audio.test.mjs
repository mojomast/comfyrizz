import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePackage } from '../../../../packages/schema/src/index.mjs';
import { dbToLinear, resolveAudioMix, sfxFrame } from '../../../../apps/renderer/src/audio-mix-model.js';
import { TRACKS, renderTrack, sha256Hex } from '../../../../scripts/pip-night-shift/make-music.mjs';

const exampleDir = new URL('../../../../examples/pip-night-shift/', import.meta.url);
const repoRoot = new URL('../../../../', import.meta.url);

const pkg = JSON.parse(readFileSync(new URL('package.json', exampleDir), 'utf8'));
const timeline = JSON.parse(readFileSync(new URL('timeline.json', exampleDir), 'utf8'));
const BAR_FRAMES = 75;

function wavInfo(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt16LE(20), 1);
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bitsPerSample = bytes.readUInt16LE(34);
  const dataBytes = bytes.readUInt32LE(40);
  assert.equal(bytes.length, 44 + dataBytes);
  return { channels, sampleRate, bitsPerSample, frames: dataBytes / (channels * bitsPerSample / 8), seconds: dataBytes / (sampleRate * channels * bitsPerSample / 8) };
}

/** The planner ships as compiled JS; build it once if a fresh checkout has no dist yet. */
async function loadPlanner() {
  const entry = new URL('../../../../packages/planner/dist/src/index.js', import.meta.url);
  if (!existsSync(fileURLToPath(entry))) {
    const plannerDir = fileURLToPath(new URL('../../../../packages/planner/', import.meta.url));
    const build = spawnSync('pnpm', ['run', 'build'], { cwd: plannerDir, encoding: 'utf8' });
    if (build.status !== 0) {
      throw new Error(`planner build failed: ${build.stderr || build.stdout || build.error?.message || 'unknown error'}`);
    }
  }
  return import(entry.href);
}

function audioErrors(mutate) {
  const copy = structuredClone(pkg);
  mutate(copy);
  return validatePackage(copy).errors.map((error) => error.code);
}

test('the package validates with the music bed and two SFX', () => {
  const report = validatePackage(pkg);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.valid, true);
  assert.equal(report.schemaOk, true);

  assert.equal(pkg.audio.music.asset, 'a_music_bed');
  assert.equal(pkg.audio.music.gain_db, -16);
  assert.equal(pkg.audio.music.fade_in_seconds, 0.5);
  assert.equal(pkg.audio.music.fade_out_seconds, 1.5);
  assert.equal(pkg.audio.music.loop, false);
  assert.deepEqual(pkg.audio.music.duck, { enabled: true, reduction_db: -12, attack_ms: 20, release_ms: 300 });
  assert.deepEqual(pkg.audio.sfx.map((sfx) => [sfx.asset, sfx.scene, sfx.at]), [
    ['a_sfx_whoosh', 's1_dawn', 'scene-end'],
    ['a_sfx_ding', 's3_juno', 'scene-start'],
  ]);
});

test('every audio asset is ready, generated locally and CC0-1.0', () => {
  for (const track of TRACKS) {
    const asset = pkg.assets[track.asset];
    assert.equal(asset.kind, 'audio');
    assert.equal(asset.status, 'ready');
    assert.equal(asset.file, `assets/${track.file}`);
    assert.equal(asset.license.id, 'CC0-1.0');
    assert.equal(asset.license.url, 'https://creativecommons.org/publicdomain/zero/1.0/');
    assert.equal(asset.license.attribution, 'Comfyrizz contributors');
    assert.equal(asset.redistributable, true);
    assert.equal(asset.source.provider, 'repo');
    assert.equal(asset.source.creator, 'Comfyrizz contributors');
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(asset.bytes > 44);
    assert.equal(asset.media.audio, 'present');
    assert.match(asset.notes, /make-music\.mjs/);
  }
});

test('licence is recorded in the example CREDITS.md', () => {
  const credits = readFileSync(new URL('CREDITS.md', exampleDir), 'utf8');
  assert.match(credits, /CC0-1\.0/);
  assert.match(credits, /Comfyrizz contributors/);
  assert.match(credits, /make-music\.mjs/);
  assert.match(credits, /no samples/i);
});

test('the generated WAVs match package.json bytes and sha256, and are 96 BPM / 20 s', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pip-audio-'));
  try {
    const songs = [];
    for (const track of TRACKS) {
      const bytes = renderTrack(track.id);
      songs.push({ track, bytes });
      const info = wavInfo(bytes);
      assert.equal(info.channels, 2);
      assert.equal(info.sampleRate, 44100);
      assert.equal(info.bitsPerSample, 16);
      assert.equal(bytes.length, pkg.assets[track.asset].bytes);
      assert.equal(sha256Hex(bytes), pkg.assets[track.asset].sha256, `${track.id} sha256`);
      assert.equal(info.seconds, track.seconds, `${track.id} duration`);
    }
    const bed = songs.find((song) => song.track.id === 'music-bed');
    assert.equal(bed.bytes.length, 44 + 20 * 44100 * 2 * 2);
    assert.equal(wavInfo(bed.bytes).frames, 20 * 44100);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('scene boundaries are 75-frame bars at 96 BPM', () => {
  assert.equal((60 / 96) * 4 * 30, BAR_FRAMES);
  const compiled = timeline.scenes;
  assert.deepEqual(compiled.map((scene) => scene.durationInFrames), [150, 150, 150, 150]);
  for (const scene of compiled) assert.equal(scene.durationInFrames % BAR_FRAMES, 0, `${scene.id} duration`);

  // Planned boundaries (sum of scene lengths, before transition overlap) are downbeats:
  // 2 bars, 4 bars, 6 bars and the 8-bar/20 s end. Overlapping transitions shift the compiled
  // start frames backwards, but every cut is authored on the same bar grid.
  let planned = 0;
  for (const scene of compiled) {
    planned += scene.durationInFrames;
    assert.equal(planned % BAR_FRAMES, 0, `${scene.id} ends on a bar line`);
  }
  assert.equal(planned, 8 * BAR_FRAMES);
  assert.equal(planned / 30, 20);
});

test('timeline.json is still exactly the planner compile of package.json', async () => {
  const { compileTimeline } = await loadPlanner();
  const recompiled = compileTimeline(pkg);
  assert.deepEqual(timeline, recompiled);
  assert.equal(timeline.sourceHash, recompiled.sourceHash);
  assert.equal(timeline.hash, recompiled.hash);
  assert.equal(timeline.durationInFrames, 572);
  assert.equal(Object.hasOwn(timeline, 'audio'), false, 'audio is mixed from the package, not baked into the timeline');
});

test('not-ready and unknown audio assets are semantic errors, not silent skips', () => {
  assert.ok(audioErrors((copy) => { copy.assets.a_music_bed.status = 'pending'; }).includes('SEM_AUDIO_ASSET_NOT_READY'));
  assert.ok(audioErrors((copy) => { delete copy.assets.a_music_bed; }).includes('SEM_AUDIO_ASSET_UNKNOWN'));
  assert.ok(audioErrors((copy) => { copy.assets.a_sfx_ding.status = 'missing'; }).includes('SEM_AUDIO_ASSET_NOT_READY'));
  assert.ok(audioErrors((copy) => { copy.audio.sfx[0].asset = 'a_nope'; }).includes('SEM_AUDIO_ASSET_UNKNOWN'));
  assert.ok(audioErrors((copy) => { copy.assets.a_sfx_whoosh.kind = 'image'; }).includes('SEM_AUDIO_ASSET_NOT_AUDIO'));
  assert.ok(audioErrors((copy) => { copy.audio.sfx[1].scene = 's9_missing'; }).includes('SEM_AUDIO_UNKNOWN_SCENE'));
});

test('audio-mix-model resolves the bed with fades and narration ducking', () => {
  const mix = resolveAudioMix(pkg, timeline);
  assert.equal(mix.enabled, true);
  assert.ok(mix.music);
  assert.equal(mix.music.assetId, 'a_music_bed');
  assert.equal(mix.music.file, 'assets/music-bed.wav');
  assert.equal(mix.music.gainDb, -16);
  assert.equal(mix.music.loop, false);
  assert.equal(mix.music.duck.reductionDb, -12);
  assert.equal(mix.music.gains.length, timeline.durationInFrames);

  const base = dbToLinear(-16);
  assert.equal(mix.music.gains[0], 0, '0.5 s fade-in starts at silence');
  assert.ok(mix.music.gains[5] > 0, 'fade-in is progressing');
  assert.ok(mix.music.gains[5] < mix.music.gains[15], 'fade-in rises over 0.5 s');
  assert.ok(Math.abs(mix.music.gains[15] - mix.music.gains[100]) < 1e-9, 'fade-in reaches the bed level after 0.5 s');

  // Narration runs continuously from the first caption through the end of s3 (frames 0-430).
  const ducked = mix.music.gains[100];
  const released = mix.music.gains[500];
  assert.ok(ducked < released * 0.5, 'the bed is ducked under narration');
  assert.ok(Math.abs(ducked / released - dbToLinear(-12)) < 0.02, 'ducking is the declared -12 dB');
  assert.ok(Math.abs(released - base) < base * 1e-3, 'the bed recovers to its gain after the release');
  assert.ok(mix.music.gains[571] < mix.music.gains[540], '1.5 s fade-out ends the bed');
});

test('both SFX resolve at their authored scene seams', () => {
  const mix = resolveAudioMix(pkg, timeline);
  assert.equal(mix.sfx.length, 2);
  const [whoosh, ding] = mix.sfx;
  assert.deepEqual(
    { assetId: whoosh.assetId, file: whoosh.file, from: whoosh.from, durationInFrames: whoosh.durationInFrames, gainDb: whoosh.gainDb },
    { assetId: 'a_sfx_whoosh', file: 'assets/sfx-whoosh.wav', from: 140, durationInFrames: 21, gainDb: -6 },
  );
  assert.deepEqual(
    { assetId: ding.assetId, file: ding.file, from: ding.from, durationInFrames: ding.durationInFrames, gainDb: ding.gainDb },
    { assetId: 'a_sfx_ding', file: 'assets/sfx-ding.wav', from: 281, durationInFrames: 36, gainDb: -6 },
  );

  assert.equal(sfxFrame(timeline, pkg.audio.sfx[0]), 140);
  assert.equal(sfxFrame(timeline, pkg.audio.sfx[1]), 281);
  // The whoosh leads into the s1 -> s2 cut, the ding starts with the s3 counter hit.
  assert.equal(timeline.scenes[0].from + timeline.scenes[0].durationInFrames - timeline.scenes[0].transitionOutFrames, 140);
  assert.equal(timeline.scenes[2].from, 281);
});

test('no audio binary is committed and generated media stays out of git', () => {
  const result = spawnSync('git', ['ls-files', '--', 'examples/pip-night-shift'], { cwd: fileURLToPath(repoRoot), encoding: 'utf8' });
  if (result.status !== 0) return;
  assert.doesNotMatch(result.stdout, /\.(wav|mp3|m4a|mp4|webm)$/m);
});

test('package audio metadata and tests carry no secret values', () => {
  const forbidden = [
    /ghp_[A-Za-z0-9]{8,}/,
    /github_pat_[A-Za-z0-9_]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{8,}/,
    /secret[_-]?key\s*[:=]/i,
  ];
  for (const name of ['package.json', 'timeline.json']) {
    const text = readFileSync(new URL(name, exampleDir), 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${name} matches ${pattern}`);
  }
});
