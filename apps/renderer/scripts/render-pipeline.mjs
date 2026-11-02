// Complete package composition with actual Remotion frame/encoding telemetry.
// Invoked in an isolated pipeline worker, keeping the HTTP server responsive.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { inlineGeneratedAssets, narrationOptions, missingMediaFiles, preparePublicDir, rendererDir } from './render-package-lib.mjs';
import { collectMediaDims } from '../src/media-dims.js';
import { materializeCompositions } from './composition-worker.mjs';
import { resolveBrowserExecutable } from './browser-executable.mjs';
import { assertModelContribution } from '../../../packages/jobs/src/model-contribution.mjs';

// Resolve the exact renderer/bundler versions used by the pinned CLI.
const require = createRequire(import.meta.resolve('@remotion/cli/package.json'));
const { bundle } = require('@remotion/bundler');
const { selectComposition, renderMedia, makeCancelSignal } = require('@remotion/renderer');

function runCommand(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${bin} exited ${result.status}: ${(result.stderr || '').slice(-800)}`);
  return result;
}

function probeVideo(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=profile,pix_fmt', '-of', 'json', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffprobe exited ${result.status}: ${(result.stderr || '').slice(-800)}`);
  const stream = JSON.parse(result.stdout).streams?.[0];
  if (!stream) throw new Error('Remuxed output has no video stream');
  return stream;
}

export function remuxFaststart(output, { run = runCommand, probe = probeVideo } = {}) {
  const tmp = `${output}.faststart.mp4`;
  try {
    run('ffmpeg', ['-y', '-v', 'error', '-i', output, '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp]);
    const stream = probe(tmp);
    if (stream.profile !== 'High') throw new Error(`Rendered video profile is ${stream.profile}, expected High`);
    if (stream.pix_fmt !== 'yuv420p') throw new Error(`Rendered video pixel format is ${stream.pix_fmt}, expected yuv420p`);
    rmSync(output, { force: true });
    renameSync(tmp, output);
    return stream;
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export async function renderPipeline(packagePath, output, { signal, onEvent = () => {}, concurrency = 2, entryPoint = join(rendererDir, 'src/index.ts'), remux = remuxFaststart } = {}) {
  const packageDir = join(packagePath, '..');
  let pkg = JSON.parse(readFileSync(packagePath));
  const validation = validatePackage(pkg);
  if (!validation.valid) throw new Error('Render package failed validation');
  let timeline = compileTimeline(pkg, narrationOptions(packageDir));
  assertModelContribution({ pkg, packageDir, timeline });
  if (pkg.voice?.enabled && timeline.provisional) throw new Error('Narration timing is still provisional');
  const materialized = await materializeCompositions({ pkg, packageDir, timeline, signal, onEvent });
  pkg = materialized.pkg;
  timeline = compileTimeline(pkg, narrationOptions(packageDir));
  if (!validatePackage(pkg).valid) throw new Error('Materialized render package failed validation');
  const missing = missingMediaFiles(pkg, packageDir);
  if (missing.length) throw new Error(`Missing render media: ${missing.map(m => m.id).join(', ')}`);
  const props = { pkg, timeline, generatedAssets: inlineGeneratedAssets(pkg, packageDir), mediaDims: collectMediaDims(pkg, packageDir) };
  if (existsSync(join(packageDir, 'media.json'))) props.media = JSON.parse(readFileSync(join(packageDir, 'media.json')));
  writeFileSync(output.replace(/\.mp4$/, '.props.json'), JSON.stringify(props));
  const publicDir = preparePublicDir(pkg, packageDir);
  const cancel = makeCancelSignal();
  const abort = () => cancel.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  let serveUrl;
  try {
    signal?.throwIfAborted();
    onEvent({ phase: 'bundling', progress: null });
    serveUrl = await bundle({ entryPoint, publicDir });
    signal?.throwIfAborted();
    const browserExecutable = resolveBrowserExecutable();
    const composition = await selectComposition({ serveUrl, id: 'PackageDemo', inputProps: props, browserExecutable });
    let last = 0;
    await renderMedia({
      serveUrl, composition, inputProps: props, outputLocation: output, codec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'aac', audioSampleRate: 48000,
      browserExecutable, concurrency, cancelSignal: cancel.cancelSignal,
      onProgress: value => {
        const now = Date.now();
        if (now - last < 500 && value.progress < 1) return;
        last = now;
        onEvent({ phase: value.stitchStage, progress: { mode: 'measured', completed: value.renderedFrames, total: timeline.durationInFrames, unit: 'frames', encodedFrames: value.encodedFrames, fraction: value.progress, source: 'remotion' } });
      },
    });
    signal?.throwIfAborted();
    await remux(output);
    signal?.throwIfAborted();
    return { frames: timeline.durationInFrames, hash: timeline.hash, bytes: statSync(output).size, fps: timeline.fps, width: timeline.width, height: timeline.height, package: pkg, compositions: materialized.report };
  } finally {
    signal?.removeEventListener('abort', abort);
    rmSync(publicDir, { recursive: true, force: true });
    if (serveUrl) rmSync(serveUrl, { recursive: true, force: true });
  }
}
