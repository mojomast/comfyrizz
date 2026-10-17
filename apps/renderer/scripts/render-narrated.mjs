/**
 * A4 acceptance: narrated example with Kokoro audio + on-screen sentence captions.
 * Proves the exported MP4 has exactly the compiled frame count and an audio stream.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..');
const repoRoot = join(rendererDir, '..', '..');
const exampleDir = join(repoRoot, 'examples', 'narrated-demo');
const timeline = JSON.parse(readFileSync(join(exampleDir, 'timeline.json'), 'utf8'));
const outDir = join(exampleDir, 'out');
mkdirSync(outDir, { recursive: true });
const output = process.env.OUTPUT ?? join(outDir, 'narrated-demo.mp4');
// Remotion only serves files inside public/, and symlinks are not bundled.
copyFileSync(join(exampleDir, 'audio', 'narration.norm.wav'), join(rendererDir, 'public', 'narration.norm.wav'));
const browser = process.env.REMOTION_BROWSER ?? '/usr/bin/google-chrome';

const started = Date.now();
const render = spawnSync(
  'npx',
  ['remotion', 'render', 'src/index.ts', 'NarratedDemo', output, `--browser-executable=${browser}`],
  { cwd: rendererDir, stdio: 'inherit' },
);
if (render.status !== 0) throw new Error(`remotion render failed with code ${render.status}`);
const renderSeconds = (Date.now() - started) / 1000;

const probe = spawnSync(
  'ffprobe',
  [
    '-v', 'error',
    '-show_entries', 'stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration,sample_rate,channels',
    '-show_entries', 'format=duration,size',
    '-of', 'json', output,
  ],
  { encoding: 'utf8' },
);
if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
const info = JSON.parse(probe.stdout);
const video = info.streams.find(stream => stream.codec_type === 'video') ?? {};
const audio = info.streams.find(stream => stream.codec_type === 'audio');
const checks = [
  ['width', Number(video.width), timeline.width],
  ['height', Number(video.height), timeline.height],
  ['fps', video.r_frame_rate, `${timeline.fps}/1`],
  ['frames', Number(video.nb_frames), timeline.durationInFrames],
  ['video codec', video.codec_name, 'h264'],
  ['audio present', Boolean(audio), true],
  ['audio codec', audio?.codec_name, 'aac'],
  // Remotion encodes the 24 kHz mono narration to standard 48 kHz AAC stereo.
  ['audio rate', Number(audio?.sample_rate), 48000],
  ['audio channels', Number(audio?.channels), 2],
];
const failures = checks.filter(([, actual, expected]) => actual !== expected);
for (const [name, actual, expected] of checks) {
  process.stdout.write(`${actual === expected ? 'ok  ' : 'FAIL'} ${name}: ${actual} (expected ${expected})\n`);
}

const report = {
  output,
  renderSeconds: Number(renderSeconds.toFixed(1)),
  width: Number(video.width),
  height: Number(video.height),
  fps: video.r_frame_rate,
  frames: Number(video.nb_frames),
  durationSeconds: Number(info.format?.duration ?? 0),
  videoCodec: video.codec_name,
  audioCodec: audio?.codec_name ?? null,
  audioSampleRate: Number(audio?.sample_rate ?? 0),
  audioChannels: Number(audio?.channels ?? 0),
  timelineHash: timeline.hash,
  captions: timeline.captions.length,
  checkedAt: new Date().toISOString(),
};
writeFileSync(join(outDir, 'narrated-render-report.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) throw new Error(`ffprobe checks failed: ${failures.map(([name]) => name).join(', ')}`);
process.stdout.write(`narrated export ok in ${renderSeconds.toFixed(1)}s\n`);
