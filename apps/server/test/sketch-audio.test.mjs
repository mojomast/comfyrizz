import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { finalizeSketchAudio } from '../src/sketch-audio.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { resolveAudioMix } from '../../renderer/src/audio-mix-model.js';
import { muxPackageAudio } from '../../renderer/scripts/incremental-audio.mjs';
import { renderPackage } from '../../renderer/scripts/render-package-lib.mjs';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';
import { createApp } from '../src/app.mjs';

function fixture() {
  const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/minimal.json', import.meta.url)));
  pkg.assets = {};
  delete pkg.theme.logo_asset;
  pkg.voice = { enabled: false, engine: 'none' };
  delete pkg.scenes[0].transitionOut;
  pkg.proposal = { logline: 'A line is drawn.', look: 'Paper.', soundtrack: 'Prepared piano and graphite.' };
  pkg.scenes[0].drawing = { background: '#0d0f14', elements: [
    { type: 'path', points: [[0, 0], [900, 900]], color: '#ffffff', width: 3, start: 30, end: 60 },
    { type: 'path', points: [[0, 0], [100, 100]], color: '#ffffff', width: 3, start: 90, end: 120, erase: true },
  ] };
  return pkg;
}

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-audio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test('drawing-specific stems are valid, audible, timed, deterministic, and playable by the preview mix', t => {
  const dir = temp(t);
  const pkg = fixture();
  const options = { brief: 'Sketch the line with a 60 bpm score.', assetsDir: join(dir, 'assets') };
  const { package: result, added } = finalizeSketchAudio(pkg, options);
  assert.equal(added, true);
  assert.equal(pkg.audio, undefined, 'the input package is not mutated');
  assert.equal(validatePackage(result).valid, true, JSON.stringify(validatePackage(result).errors));
  assert.match(result.proposal.soundtrack, /Synthesized keyboard/);
  assert.doesNotMatch(result.proposal.soundtrack, /prepared piano/i);
  assert.deepEqual(finalizeSketchAudio(pkg, options).package.audio, result.audio);
  const mix = resolveAudioMix(result, compileTimeline(result));
  assert.equal(mix.music.assetId, result.audio.music.asset);
  assert.equal(mix.sfx.length, 1);
  const music = readFileSync(join(dir, result.assets[result.audio.music.asset].file));
  const effect = readFileSync(join(dir, result.assets[result.audio.sfx[0].asset].file));
  assert.match(result.assets[result.audio.music.asset].notes, /60 BPM/);
  function rms(buffer, from, to) {
    let sum = 0;
    for (let i = Math.round(from * 24000); i < Math.round(to * 24000); i++) sum += buffer.readInt16LE(44 + i * 2) ** 2;
    return Math.sqrt(sum / ((to - from) * 24000));
  }
  assert.ok(rms(music, 1, 2) > 100);
  assert.equal(rms(effect, 0, 0.5), 0, 'no texture before a stroke');
  assert.ok(rms(effect, 1.1, 1.5) > 100, 'audible while the stroke draws');
  assert.equal(rms(effect, 2.1, 2.5), 0, 'texture stops after the stroke');
  assert.ok(rms(effect, 3.1, 3.5) > 100, 'the erasure has its own timed texture');
});

test('silence and independent music/effects exclusions are respected', t => {
  const dir = temp(t);
  const apply = brief => finalizeSketchAudio(fixture(), { brief, assetsDir: join(dir, 'assets') });
  for (const brief of ['Silent video', 'no audio', 'no dialogue or music or sound effects']) assert.equal(apply(brief).added, false, brief);
  const noMusic = apply('No narration or music; use pencil sounds').package;
  assert.equal(noMusic.audio.music, undefined);
  assert.equal(noMusic.audio.sfx.length, 1);
  const noEffects = apply('No sound effects, keep the music').package;
  assert.ok(noEffects.audio.music);
  assert.equal(noEffects.audio.sfx, undefined);
  const existing = fixture();
  existing.audio = { music: { asset: 'a_existing' } };
  assert.equal(finalizeSketchAudio(existing, { assetsDir: dir }).package, existing);
  const legacy = fixture();
  legacy.assets.a_voice = { kind: 'audio', status: 'ready', file: 'audio/voice.wav' };
  assert.equal(finalizeSketchAudio(legacy, { assetsDir: dir }).added, false, 'preserve legacy narration fallback');
  const blank = fixture();
  delete blank.scenes[0].drawing;
  assert.equal(finalizeSketchAudio(blank, { assetsDir: dir }).added, false);
  const long = fixture();
  long.duration.targetFrames = 9000;
  long.scenes = Array.from({ length: 30 }, (_, index) => ({ ...structuredClone(long.scenes[0]), id: `s${index}`, preferredFrames: 300 }));
  assert.equal(finalizeSketchAudio(long, { assetsDir: dir }).added, false, 'avoid unbounded PCM allocation');
});

test('native incremental export muxes the generated stems into a real non-silent MP4', { timeout: 120000 }, t => {
  const dir = temp(t);
  const pkg = finalizeSketchAudio(fixture(), { assetsDir: join(dir, 'assets') }).package;
  const timeline = compileTimeline(pkg);
  const silent = join(dir, 'silent.mp4');
  const output = join(dir, 'output.mp4');
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=black:s=64x64:r=30:d=${timeline.durationInFrames / timeline.fps}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  const result = muxPackageAudio({ silentPath: silent, outputPath: output, packageDir: dir, pkg, timeline });
  assert.equal(result.audio.sources, 2);
  const streams = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'json', output])).streams;
  assert.equal(streams[0].codec_name, 'aac');
  const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '24000', 'pipe:1'], { maxBuffer: 2 * 1024 * 1024 });
  assert.equal(pcm.status, 0);
  assert.ok(pcm.stdout.some(byte => byte !== 0), 'decoded output contains audible samples');
});

test('the actual live-agent runner finalizes a storyboard.draw package before proposal and persists its media', async t => {
  const dir = temp(t);
  const drawing = fixture().scenes[0].drawing;
  const brief = 'Draw an impossible line in a 5 second sketch with a 60 bpm score.';
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief, title: 'A line', proposal: fixture().proposal, scenes: [{ id: 's1', layout: 'hero', preferredFrames: 150, copy: { headline: 'A line' } }] } },
    { name: 'storyboard.draw', args: { scene_id: 's1', drawing } },
  ]);
  t.after(() => provider.close());
  const runner = createCpuAgentRunner({ runtimeDir: dir, providers: { custom: { baseUrl: provider.url } } });
  const result = await runner({ brief, provider: 'custom', videoType: 'sketch-build' });
  assert.equal(result.live, true);
  assert.ok(result.events.some(event => event.name === 'storyboard.draw' && event.ok));
  assert.match(result.package.proposal.soundtrack, /Synthesized keyboard/);
  for (const id of [result.package.audio.music.asset, ...result.package.audio.sfx.map(cue => cue.asset)]) {
    assert.ok(readFileSync(join(dir, 'packages', result.package.assets[id].file)).length > 44);
  }
});

test('Super Easy agent endpoint saves generated audio for authenticated preview hydration', async t => {
  const dir = temp(t);
  const brief = 'Draw a line in a 5 second sketch.';
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief, title: 'A line', proposal: fixture().proposal, scenes: [{ id: 's1', layout: 'hero', preferredFrames: 150, copy: { headline: 'A line' } }] } },
    { name: 'storyboard.draw', args: { scene_id: 's1', drawing: fixture().scenes[0].drawing } },
  ]);
  const runner = createCpuAgentRunner({ runtimeDir: dir, providers: { custom: { baseUrl: provider.url } } });
  t.after(() => provider.close());
  const app = createApp({ root: new URL('../../..', import.meta.url).pathname, runtimeDir: dir, token: 'sketch-audio-test-token', agentRunner: runner });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin: base, 'x-comfyrizz-token': 'sketch-audio-test-token' };
  const response = await fetch(`${base}/api/agent`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ brief, provider: 'custom', videoType: 'sketch-build' }) });
  assert.equal(response.status, 200, await response.clone().text());
  const { package: pkg } = await response.json();
  assert.match(pkg.proposal.soundtrack, /Synthesized keyboard/);
  for (const id of [pkg.audio.music.asset, ...pkg.audio.sfx.map(cue => cue.asset)]) {
    const asset = pkg.assets[id];
    const media = await fetch(`${base}/api/package/${pkg.id}/media?path=${encodeURIComponent(asset.file)}`, { headers });
    assert.equal(media.status, 200);
    assert.equal(Buffer.from(await media.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
  }
});

test('full Remotion render includes the generated score and drawing sound', { timeout: 120000 }, t => {
  const dir = temp(t);
  const input = fixture();
  input.format.width = 320;
  input.format.height = 180;
  const pkg = finalizeSketchAudio(input, { assetsDir: join(dir, 'assets') }).package;
  const path = join(dir, 'package.json');
  const output = join(dir, 'full.mp4');
  writeFileSync(path, JSON.stringify(pkg));
  renderPackage(path, output, { normalizeLoudness: false });
  const streams = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'json', output])).streams;
  assert.equal(streams[0]?.codec_name, 'aac');
  const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '24000', 'pipe:1'], { maxBuffer: 2 * 1024 * 1024 });
  assert.equal(pcm.status, 0);
  assert.ok(pcm.stdout.some(byte => byte !== 0));
});
