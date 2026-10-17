import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const exampleDir = join(repoRoot, 'examples', 'narrated-demo');
const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
const timeline = JSON.parse(readFileSync(join(exampleDir, 'timeline.json'), 'utf8'));
const durations = JSON.parse(readFileSync(join(exampleDir, 'audio', 'durations.json'), 'utf8'));
const report = JSON.parse(readFileSync(join(exampleDir, 'narration-report.json'), 'utf8'));

test('the narrated timeline is compiled from measured speech, not estimates', () => {
  assert.equal(timeline.provisional, false);
  assert.equal(timeline.captions.every(cue => cue.estimated === false), true);
  const chunkCount = Object.values(durations.scenes).reduce((total, scene) => total + scene.chunks.length, 0);
  assert.equal(timeline.captions.length, chunkCount);
  assert.ok(timeline.durationInFrames > 0);
  assert.equal(timeline.hash, report.timelineHash);
});

test('every scene is long enough for its measured narration', () => {
  for (const scene of timeline.scenes) {
    const measured = durations.scenes[scene.id];
    assert.ok(measured, `${scene.id} has no measured narration`);
    const narrationFrames = Math.ceil(measured.seconds * timeline.fps);
    assert.ok(
      scene.durationInFrames >= narrationFrames,
      `${scene.id}: ${scene.durationInFrames} frames < ${narrationFrames} measured`,
    );
    assert.ok(scene.durationInFrames >= pkg.scenes.find(item => item.id === scene.id).preferredFrames - 1);
  }
});

test('captions are derived from the same measured chunks', () => {
  const texts = timeline.captions.map(cue => cue.text);
  const measured = Object.values(durations.scenes).flatMap(scene => scene.chunks.map(chunk => chunk.text));
  assert.deepEqual(texts, measured);
  for (const cue of timeline.captions) assert.ok(cue.to > cue.from);
});

test('SRT and VTT exports exist and start with valid headers/first cue', () => {
  const srt = readFileSync(join(exampleDir, 'captions.srt'), 'utf8');
  const vtt = readFileSync(join(exampleDir, 'captions.vtt'), 'utf8');
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.match(vtt, /^WEBVTT\n\ncue-1\n00:00:00\.000 --> /);
  assert.equal((srt.match(/-->/g) ?? []).length, timeline.captions.length);
  assert.equal((vtt.match(/-->/g) ?? []).length, timeline.captions.length);
});

test('the normalized narration is 24 kHz mono and matches the timeline duration', () => {
  const file = join(exampleDir, 'audio', 'narration.norm.wav');
  assert.ok(existsSync(file), 'run packages/tts/scripts/narrate.mjs first');
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,duration', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  assert.equal(probe.status, 0, probe.stderr);
  const stream = JSON.parse(probe.stdout).streams[0];
  assert.equal(stream.codec_name, 'pcm_s16le');
  assert.equal(Number(stream.sample_rate), 24000);
  assert.equal(Number(stream.channels), 1);
  assert.ok(Math.abs(Number(stream.duration) - timeline.durationInFrames / timeline.fps) < 0.05);
  assert.equal(pkg.assets.a_narration.media.durationSeconds, Number((timeline.durationInFrames / timeline.fps).toFixed(3)));
});

test('ffmpeg loudnorm lands near -16 LUFS and -1 dBTP', () => {
  assert.ok(report.loudness.outputIntegratedLufs >= -17 && report.loudness.outputIntegratedLufs <= -15);
  assert.ok(report.loudness.outputTruePeakDbtp <= -0.9);
  assert.equal(report.checks.audioDurationMatchesTimeline, true);
});
