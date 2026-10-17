/**
 * A3 acceptance: CPU export of the bundled example + ffprobe verification.
 * No LLM, no GPU, no network. Output lands in examples/launch-demo/out (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..');
const repoRoot = join(rendererDir, '..', '..');
const exampleDir = join(repoRoot, 'examples', 'launch-demo');
const timeline = JSON.parse(readFileSync(join(exampleDir, 'timeline.json'), 'utf8'));
const outDir = join(exampleDir, 'out');
mkdirSync(outDir, { recursive: true });
const output = process.env.OUTPUT ?? join(outDir, 'launch-demo.mp4');
const browser = process.env.REMOTION_BROWSER ?? '/usr/bin/google-chrome';

const started = Date.now();
const render = spawnSync(
  'npx',
  ['remotion', 'render', 'src/index.ts', 'LaunchDemo', output, `--browser-executable=${browser}`],
  { cwd: rendererDir, stdio: 'inherit' },
);
if (render.status !== 0) throw new Error(`remotion render failed with code ${render.status}`);
const renderSeconds = (Date.now() - started) / 1000;

const probe = spawnSync(
  'ffprobe',
  ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames', '-show_entries', 'format=duration', '-of', 'json', output],
  { encoding: 'utf8' },
);
if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
const info = JSON.parse(probe.stdout);
const stream = info.streams?.[0] ?? {};
const audio = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'json', output], { encoding: 'utf8' });
const audioStreams = JSON.parse(audio.stdout || '{"streams":[]}').streams ?? [];

const checks = [
  ['width', Number(stream.width), timeline.width],
  ['height', Number(stream.height), timeline.height],
  ['fps', stream.r_frame_rate, `${timeline.fps}/1`],
  ['frames', Number(stream.nb_frames), timeline.durationInFrames],
];
const failures = checks.filter(([, actual, expected]) => actual !== expected);
for (const [name, actual, expected] of checks) {
  process.stdout.write(`${actual === expected ? 'ok  ' : 'FAIL'} ${name}: ${actual} (expected ${expected})\n`);
}

const report = {
  output,
  renderSeconds: Number(renderSeconds.toFixed(1)),
  width: Number(stream.width),
  height: Number(stream.height),
  fps: stream.r_frame_rate,
  frames: Number(stream.nb_frames),
  durationSeconds: Number(info.format?.duration ?? 0),
  timelineHash: timeline.hash,
  audioStreams: audioStreams.map(item => item.codec_name),
  checkedAt: new Date().toISOString(),
};
writeFileSync(join(exampleDir, 'out', 'render-report.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (failures.length > 0) throw new Error(`ffprobe checks failed: ${failures.map(([name]) => name).join(', ')}`);
process.stdout.write(`export ok in ${renderSeconds.toFixed(1)}s\n`);
