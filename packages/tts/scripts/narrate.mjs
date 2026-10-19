/**
 * A4: measure Kokoro narration -> compile a narrated timeline -> export captions.
 *
 *   npm --prefix packages/tts run build
 *   node packages/tts/scripts/narrate.mjs --example examples/narrated-demo
 *
 * Requires the local model cache (scripts/fetch-models.sh). The compiled
 * timeline is the only input the player/export may use; it is not provisional.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captionsToSrt,
  captionsToVtt,
  compileOptionsFromDurations,
  parseDurations,
} from '../dist/src/index.js';
import { compileTimeline } from '../../planner/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const exampleArg = process.argv.indexOf('--example');
const exampleDir = resolve(repoRoot, exampleArg >= 0 ? process.argv[exampleArg + 1] : 'examples/narrated-demo');
const packagePath = join(exampleDir, 'package.json');
const audioDir = join(exampleDir, 'audio');
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const durations = parseDurations(JSON.parse(readFileSync(join(audioDir, 'durations.json'), 'utf8')));

const options = compileOptionsFromDurations(durations);
const timeline = compileTimeline(pkg, options);

const rawPath = join(audioDir, 'narration.wav');
const normPath = join(audioDir, 'narration.norm.wav');
const timelineSeconds = timeline.durationInFrames / timeline.fps;
const placed = timeline.scenes
  .map((scene, index) => ({ scene, index, sceneNarration: durations.scenes[scene.id] }))
  .filter(item => item.sceneNarration);
if (placed.length === 0) throw new Error('no scene has measured narration');
const inputs = [];
const filters = [];
const labels = [];
for (const [inputIndex, { scene, index }] of placed.entries()) {
  const file = join(exampleDir, 'audio', 'narration', `${scene.id}.wav`);
  inputs.push('-i', file);
  const isLastScene = index === timeline.scenes.length - 1;
  const audibleFrames = scene.durationInFrames - (isLastScene ? 0 : scene.transitionOutFrames);
  const audibleSeconds = Math.max(0.1, audibleFrames / timeline.fps);
  const delayMs = Math.round((scene.from / timeline.fps) * 1000);
  filters.push(
    `[${inputIndex}:a]atrim=0:${audibleSeconds.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1[a${inputIndex}]`,
  );
  labels.push(`[a${inputIndex}]`);
}
filters.push(
  `${labels.join('')}amix=inputs=${labels.length}:normalize=0,apad=whole_dur=${timelineSeconds.toFixed(3)},atrim=0:${timelineSeconds.toFixed(3)}[mix]`,
);
const mix = spawnSync(
  'ffmpeg',
  [
    '-y', '-hide_banner', '-nostats',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[mix]', '-ar', '24000', '-ac', '1',
    rawPath,
  ],
  { encoding: 'utf8' },
);
if (mix.status !== 0) throw new Error(`narration mix failed: ${mix.stderr}`);
const loudnorm = spawnSync(
  'ffmpeg',
  [
    '-y', '-hide_banner', '-nostats',
    '-i', rawPath,
    '-af', 'loudnorm=I=-16:TP=-1:LRA=11:print_format=json',
    '-ar', '24000', '-ac', '1',
    normPath,
  ],
  { encoding: 'utf8' },
);
if (loudnorm.status !== 0) throw new Error(`loudnorm failed: ${loudnorm.stderr}`);
const match = loudnorm.stderr.match(/\{[\s\S]*\}/);
if (!match) throw new Error('loudnorm did not print its measurement JSON');
const measured = JSON.parse(match[0]);
const loudness = {
  target: { integratedLufs: -16, truePeakDbtp: -1, rangeLu: 11 },
  measured: {
    inputIntegratedLufs: Number(measured.input_i),
    inputTruePeakDbtp: Number(measured.input_tp),
    outputIntegratedLufs: Number(measured.output_i),
    outputTruePeakDbtp: Number(measured.output_tp),
  },
  file: 'narration.norm.wav',
};
writeFileSync(join(audioDir, 'loudness.json'), `${JSON.stringify(loudness, null, 2)}\n`);
if (!Number.isFinite(loudness.measured.outputIntegratedLufs)) {
  throw new Error('loudnorm did not report an output loudness');
}

if (timeline.provisional) throw new Error('narrated timeline is still provisional');
writeFileSync(join(exampleDir, 'timeline.json'), `${JSON.stringify(timeline, null, 2)}\n`);
writeFileSync(join(exampleDir, 'captions.srt'), captionsToSrt(timeline.captions, timeline.fps));
writeFileSync(join(exampleDir, 'captions.vtt'), captionsToVtt(timeline.captions, timeline.fps));

const audioBytes = readFileSync(normPath);
const qwen = durations.engine === 'qwen3-tts';
pkg.assets = pkg.assets ?? {};
pkg.assets.a_narration = {
  kind: 'audio',
  origin: 'generated',
  status: 'ready',
  file: 'audio/narration.norm.wav',
  sha256: createHash('sha256').update(audioBytes).digest('hex'),
  bytes: statSync(normPath).size,
  media: {
    durationSeconds: Number(timelineSeconds.toFixed(3)),
    audio: 'present',
    codec: 'pcm_s16le',
  },
  license: { id: 'CC0-1.0' },
  redistributable: true,
  model_license: {
    id: 'Apache-2.0',
    url: qwen ? 'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base' : 'https://huggingface.co/hexgrad/Kokoro-82M',
    note: qwen ? 'Qwen3-TTS 1.7B VoiceDesign reference and Base-clone narration.' : 'Kokoro-82M weights; kokoro-onnx wrapper, voices and phonemizer notices are kept in packages/tts/README.md.',
  },
  gen: {
    generator: qwen ? 'qwen3-tts' : 'kokoro',
    model: qwen ? durations.model : 'kokoro-v1.0.onnx',
    inputs: {
      voice: durations.voice,
      speed: durations.speed,
      sample_rate: durations.sampleRate,
      chunks: Object.values(durations.scenes).reduce((total, scene) => total + scene.chunks.length, 0),
    },
    caption: `Measured ${qwen ? 'Qwen3-TTS' : 'Kokoro'} narration synthesized from the package narration text.`,
  },
};
// Reference the narration asset from every narrated scene so the validator does
// not raise WARN_ASSET_UNUSED (P-fix2).
for (const scene of pkg.scenes ?? []) {
  const measured = durations.scenes[scene.id];
  if (!measured) continue;
  scene.narration_asset = 'a_narration';
  scene.narration_duration_frames = Math.round(measured.seconds * timeline.fps);
}
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const validate = spawnSync(
  process.execPath,
  [join(repoRoot, 'packages/schema/bin/comfyrizz-validate.mjs'), packagePath],
  { encoding: 'utf8' },
);
process.stdout.write(validate.stdout);
if (validate.status !== 0) throw new Error('package failed schema validation');

const audioCheck = spawnSync(
  'ffprobe',
  ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,duration', '-of', 'json', normPath],
  { encoding: 'utf8' },
);
const stream = JSON.parse(audioCheck.stdout).streams?.[0] ?? {};
const report = {
  timelineHash: timeline.hash,
  durationInFrames: timeline.durationInFrames,
  seconds: Number((timeline.durationInFrames / timeline.fps).toFixed(3)),
  scenes: timeline.scenes.map(scene => ({ id: scene.id, frames: scene.durationInFrames, narrationFrames: scene.narration ? true : false })),
  captions: timeline.captions.length,
  narration: {
    voice: durations.voice,
    sampleRate: durations.sampleRate,
    seconds: Number(timelineSeconds.toFixed(3)),
    audioCodec: stream.codec_name,
    audioChannels: Number(stream.channels),
    audioDuration: Number(stream.duration),
  },
  loudness: loudness.measured,
  checks: {
    notProvisional: !timeline.provisional,
    captionsMatchScenes: timeline.captions.every(cue => timeline.scenes.some(scene => scene.id === cue.sceneId)),
    audioDurationMatchesTimeline: Math.abs(Number(stream.duration) - timelineSeconds) < 0.05,
  },
};
writeFileSync(join(exampleDir, 'narration-report.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (Object.values(report.checks).some(value => !value)) throw new Error('narration checks failed');
process.stdout.write('narrated timeline ok\n');
