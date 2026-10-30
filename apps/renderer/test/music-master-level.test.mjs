import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPackage } from '../scripts/render-package-lib.mjs';
import { renderPackageIncremental } from '../scripts/render-incremental.mjs';
import { renderOnVm } from '../scripts/render-remote-entry.mjs';
import { muxPackageAudio } from '../scripts/incremental-audio.mjs';
import { normalizeMixLoudness, measureLoudness } from '../scripts/mix-loudness.mjs';
import { hasMasterMusic, resolveAudioMix } from '../src/audio-mix-model.js';
import { collectMockContribution } from '../../server/test/helpers/comfy-contribution.mjs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, String(result.stderr || result.error));
  return result.stdout;
}

function pcm(file) {
  const bytes = run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
  return Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
}

function level(input, output, start, end, gainDb = 0) {
  let xx = 0, xy = 0, yy = 0;
  for (let i = Math.round(start * 48000); i < Math.round(end * 48000); i++) {
    const x = input[48000 + i], y = output[i]; // selected source offset is 1 s
    xx += x * x; xy += x * y; yy += y * y;
  }
  const measuredGainDb = 20 * Math.log10(xy / xx);
  assert.ok(Math.abs(measuredGainDb - gainDb) < 0.2, `expected ${gainDb} dB, got ${measuredGainDb}`);
  assert.ok(xy / Math.sqrt(xx * yy) > 0.995, 'decoded source window must match, not just its RMS');
  return measuredGainDb;
}

test('real full, incremental, remote-entry and pipeline exports preserve sole-master PCM level; ordinary mixes normalize', { timeout: 300_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'music-master-level-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const song = join(dir, 'song.wav');
  // Original test tones; the first second deliberately differs from the trim.
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.035*sin(2*PI*if(lt(t,1),220,440)*t)':s=48000:d=4", '-c:a', 'pcm_s16le', song]);
  const bytes = readFileSync(song), digest = createHash('sha256').update(bytes).digest('hex');
  const pkg = JSON.parse(readFileSync(new URL('./fixtures/tiny/package.json', import.meta.url)));
  pkg.format = { width: 320, height: 180, fps: 30 };
  pkg.duration = { mode: 'target', targetFrames: 60 };
  pkg.datasets = {};
  pkg.scenes = [{ id: 's_master', layout: 'title', preferredFrames: 60, copy: { headline: 'Master level' } }];
  pkg.assets = { a_song: { kind: 'audio', origin: 'upload', status: 'ready', file: 'song.wav', sha256: digest, bytes: bytes.length, redistributable: true } };
  // Omitted gain/fades exercise neutral master defaults in both renderer paths.
  pkg.audio = { music: { asset: 'a_song', trim: { startSeconds: 1, endSeconds: 3 } } };
  const packagePath = join(dir, 'package.json');
  collectMockContribution(pkg, dir);
  writeFileSync(packagePath, JSON.stringify(pkg));
  const input = pcm(song);
  const fullPath = join(dir, 'full.mp4');
  const full = renderPackage(packagePath, fullPath);
  assert.deepEqual(full.mixLoudness, { applied: false, reason: 'preserve music master' });
  const incrementalPath = join(dir, 'incremental.mp4');
  renderPackageIncremental(packagePath, incrementalPath, { cacheDir: join(dir, 'cache') });
  const remotePath = join(dir, 'remote.mp4');
  // The real VM entry point runs locally on CPU: no remote service or GPU used.
  await renderOnVm(packagePath, remotePath);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'loudness.json'))), full.mixLoudness);
  const measurements = {};
  for (const [name, file] of [['full', fullPath], ['incremental', incrementalPath], ['remote-entry-local-cpu', remotePath]]) {
    const output = pcm(file);
    measurements[name] = level(input, output, 0.1, 1.9);
    level(input, output, 0.05, 0.15); // no implicit 0.5 s fade-in
    level(input, output, 1.8, 1.95); // no implicit 1 s fade-out
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames,duration', '-of', 'json', file]));
    assert.equal(Number(probe.streams[0].nb_frames), 60);
    assert.equal(Number(probe.streams[0].duration), 2);
  }
  const runDir = join(dir, 'pipeline'); mkdirSync(runDir);
  const pipelinePath = join(runDir, 'video.mp4'); copyFileSync(fullPath, pipelinePath);
  run(process.execPath, [new URL('../../server/src/pipeline-cpu-task.mjs', import.meta.url).pathname, 'normalize', dir, runDir]);
  assert.deepEqual(readFileSync(pipelinePath), readFileSync(fullPath), 'master finishing must not re-encode the already rendered AAC');
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'loudness.json'))), full.mixLoudness);

  // An uploaded *bed*, without sole-master routing, still receives normalization.
  const ordinary = structuredClone(pkg); delete ordinary.audio.music.trim;
  const ordinaryPath = join(dir, 'ordinary.mp4'); copyFileSync(fullPath, ordinaryPath);
  assert.equal(hasMasterMusic(ordinary), false);
  assert.equal(normalizeMixLoudness(ordinaryPath, { pkg: ordinary }).applied, true);
  assert.ok(Math.abs(measureLoudness(ordinaryPath).integratedLufs + 16) < 1);

  // Explicit authored gain/fades survive master preservation (no loudnorm undo).
  const authored = structuredClone(pkg);
  Object.assign(authored.audio.music, { gain_db: -6, fade_in_seconds: 0.2, fade_out_seconds: 0.2 });
  const silent = join(dir, 'silent.mp4');
  run('ffmpeg', ['-y', '-v', 'error', '-i', fullPath, '-an', '-c:v', 'copy', silent]);
  const authoredPath = join(dir, 'authored.mp4');
  const mixed = muxPackageAudio({ silentPath: silent, outputPath: authoredPath, packageDir: dir, pkg: authored, timeline: full.timeline });
  assert.equal(mixed.loudness, null);
  const authoredPcm = pcm(authoredPath);
  level(input, authoredPcm, 0.3, 1.7, -6);
  const energy = (from, to) => authoredPcm.slice(from * 48000, to * 48000).reduce((sum, value) => sum + value * value, 0) / ((to - from) * 48000);
  assert.ok(energy(0.02, 0.08) < energy(0.4, 0.46) * 0.2, 'authored fade-in remains audible');
  assert.ok(energy(1.92, 1.98) < energy(0.4, 0.46) * 0.2, 'authored fade-out remains audible');
  const mix = resolveAudioMix(authored, full.timeline);
  assert.equal(mix.music.gains[0], 0);
  assert.equal(mix.music.gains[59], 0);
  assert.equal(createHash('sha256').update(readFileSync(song)).digest('hex'), digest);
  t.diagnostic(JSON.stringify({ measuredGainDb: measurements, sourceSha256: digest }));
});

test('missing/invalid master markers do not bypass ordinary mix finishing', () => {
  const ready = { kind: 'audio', status: 'ready', file: 'song.wav' };
  assert.equal(hasMasterMusic({ audio: { music: { asset: 'a', trim: { startSeconds: 2, endSeconds: 1 } } }, assets: { a: ready } }), false);
  assert.equal(hasMasterMusic({ audio: { music: { asset: 'a', trim: { startSeconds: 0, endSeconds: 2 } } }, assets: {} }), false);
  assert.equal(hasMasterMusic({ audio: { music: { asset: 'a', reactive: { style: 'waveform' } } }, assets: { a: ready } }), true);
});
