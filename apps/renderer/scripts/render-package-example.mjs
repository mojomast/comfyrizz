/**
 * A6 acceptance: export any bundled example on CPU through the per-scene
 * incremental path and verify the MP4 with ffprobe. No LLM, no GPU, no network.
 *
 *   node scripts/render-package-example.mjs --example examples/product-explainer
 *
 * The example's committed timeline.json is the timing source of truth; the
 * export frame count must equal it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPackageIncremental } from './render-incremental.mjs';
import { findLayoutOverlaps } from '../src/layout-model.js';
import { collectMediaDims } from '../src/media-dims.js';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..');
const repoRoot = join(rendererDir, '..', '..');
const exampleArg = process.argv.indexOf('--example');
const exampleDir = resolve(repoRoot, exampleArg >= 0 ? process.argv[exampleArg + 1] : 'examples/product-explainer');
const exampleName = basename(exampleDir);
const timeline = JSON.parse(readFileSync(join(exampleDir, 'timeline.json'), 'utf8'));

// Layout gate: refuse to export a scene where a foreground card would cover
// text (see test/layout.test.mjs). Real probed sizes (A8) beat declared ones.
const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
const layoutOverlaps = findLayoutOverlaps(pkg, { mediaDims: collectMediaDims(pkg, exampleDir) });
if (layoutOverlaps.length > 0) {
  const detail = layoutOverlaps.map(item => `${item.scene}/${item.asset}`).join(', ');
  throw new Error(`layout check failed (text/asset overlap): ${detail}`);
}

const outDir = join(exampleDir, 'out');
mkdirSync(outDir, { recursive: true });
const output = process.env.OUTPUT ?? join(outDir, `${exampleName}.mp4`);
const force = process.argv.includes('--force');

const started = Date.now();
const result = renderPackageIncremental(join(exampleDir, 'package.json'), output, {
  force,
  onLog: line => process.stdout.write(`  [+${((Date.now() - started) / 1000).toFixed(1)}s] ${line}\n`),
});
const renderSeconds = (Date.now() - started) / 1000;

const probe = spawnSync(
  'ffprobe',
  ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,nb_frames', '-show_entries', 'format=duration,size', '-of', 'json', output],
  { encoding: 'utf8' },
);
if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
const info = JSON.parse(probe.stdout);
const video = info.streams.find(stream => stream.codec_type === 'video') ?? {};
const audio = info.streams.find(stream => stream.codec_type === 'audio');

// A10: a narrated example commits its normalised mix, so the export must carry
// an AAC audio stream. Examples whose audio is not on disk (clean GPU clone)
// fall back to the P-fix4 missing-media path and are reported without audio.
const narrationFile = pkg.assets?.a_narration?.file;
const hasNarration = typeof narrationFile === 'string' && existsSync(join(exampleDir, narrationFile));

const checks = [
  ['width', Number(video.width), timeline.width],
  ['height', Number(video.height), timeline.height],
  ['fps', video.r_frame_rate, `${timeline.fps}/1`],
  ['frames', Number(video.nb_frames), timeline.durationInFrames],
  ['codec', video.codec_name, 'h264'],
];
if (hasNarration) checks.push(['audio codec', audio?.codec_name ?? null, 'aac']);
const failures = checks.filter(([, actual, expected]) => actual !== expected);
for (const [name, actual, expected] of checks) {
  process.stdout.write(`${actual === expected ? 'ok  ' : 'FAIL'} ${name}: ${actual} (expected ${expected})\n`);
}

const report = {
  example: exampleName,
  output,
  renderSeconds: Number(renderSeconds.toFixed(1)),
  width: Number(video.width),
  height: Number(video.height),
  fps: video.r_frame_rate,
  codec: video.codec_name,
  pixelFormat: video.pix_fmt,
  frames: Number(video.nb_frames),
  durationSeconds: Number(info.format?.duration ?? 0),
  timelineHash: timeline.hash,
  audioCodec: audio?.codec_name ?? null,
  segments: result.segments.length,
  rendered: result.rendered.length,
  reused: result.reused.length,
  checkedAt: new Date().toISOString(),
};
writeFileSync(join(outDir, 'render-report.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) throw new Error(`ffprobe checks failed: ${failures.map(([name]) => name).join(', ')}`);
process.stdout.write(`export ok in ${renderSeconds.toFixed(1)}s (${result.rendered.length} rendered, ${result.reused.length} reused)\n`);
