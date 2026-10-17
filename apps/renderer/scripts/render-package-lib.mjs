// Shared CPU render path: validate package -> A2 compile -> Remotion render -> ffprobe-free
// metadata. Used by the C1 dev route and the C2 local server. No network.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { renderCheck, sanitizeSvg, SANITIZER_VERSION } from '../../../packages/vector/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..', '..');
export const rendererDir = join(repoRoot, 'apps', 'renderer');

export function inlineGeneratedAssets(pkg, packageDir) {
  const assets = {};
  for (const [id, asset] of Object.entries(pkg.assets ?? {})) {
    const isVector = asset?.gen?.generator === 'llm-svg' || asset?.kind === 'svg' || asset?.kind === 'vector-anim';
    if (!isVector || typeof asset.file !== 'string') continue;
    const file = join(packageDir, asset.file);
    const raw = readFileSync(file, 'utf8');
    const sanitized = sanitizeSvg(raw);
    if (!sanitized.ok) throw new Error(`${id}: sanitize failed: ${sanitized.errors.map(error => error.code).join(', ')}`);
    const check = renderCheck(sanitized.svg, { width: 512, palette: pkg.theme?.palette });
    if (!check.ok) throw new Error(`${id}: render-check failed: ${check.errors.map(error => error.code).join(', ')}`);
    assets[id] = {
      kind: asset.kind ?? 'svg',
      svg: sanitized.svg,
      width: check.width,
      height: check.height,
      sanitizerVersion: SANITIZER_VERSION,
    };
  }
  return assets;
}

function assetDirs(pkg) {
  const dirs = new Set();
  for (const asset of Object.values(pkg.assets ?? {})) {
    if (typeof asset?.file !== 'string') continue;
    const [top] = asset.file.split('/');
    if (top && top !== asset.file) dirs.add(top);
  }
  return [...dirs];
}

function needsMediaPublicDir(pkg) {
  return Object.values(pkg.assets ?? {}).some(asset => asset?.kind === 'image' || asset?.kind === 'video' || asset?.kind === 'audio');
}

/**
 * Measured narration options for the timeline compiler (N7). When the package
 * directory carries an audio/durations.json from a Kokoro run, feed those
 * chunk seconds to compileTimeline so scene lengths and captions match the
 * audio instead of falling back to preferredFrames and rendering silent.
 */
export function narrationOptions(packageDir) {
  const durationsPath = join(packageDir, 'audio', 'durations.json');
  if (!existsSync(durationsPath)) return {};
  const durations = JSON.parse(readFileSync(durationsPath, 'utf8'));
  const narration = {};
  for (const [sceneId, scene] of Object.entries(durations.scenes ?? {})) {
    narration[sceneId] = (scene.chunks ?? []).map(chunk => ({ text: chunk.text, seconds: chunk.seconds }));
  }
  return {
    narration,
    narrationGapSeconds: durations.gapSeconds,
    narrationPaddingSeconds: durations.paddingSeconds,
  };
}

/** Copy fonts + the package's asset folders into a throwaway Remotion public dir. */
export function preparePublicDir(pkg, packageDir) {
  const temp = mkdtempSync(join(tmpdir(), 'comfyrizz-public-'));
  cpSync(join(rendererDir, 'public', 'fonts'), join(temp, 'fonts'), { recursive: true });
  for (const dir of assetDirs(pkg)) {
    const source = join(packageDir, dir);
    if (existsSync(source)) cpSync(source, join(temp, dir), { recursive: true });
  }
  return temp;
}

export function renderPackage(packagePath, outputPath = packagePath.replace(/\.json$/, '.mp4'), { onLog = () => {}, publicDir, compositionId = 'PackageDemo' } = {}) {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const validation = validatePackage(pkg);
  if (!validation.valid) {
    const detail = validation.errors.map(error => `${error.code} ${error.path}: ${error.message}`).join('; ');
    throw new Error(`package invalid: ${detail}`);
  }
  const packageDir = dirname(packagePath);
  const timeline = compileTimeline(pkg, narrationOptions(packageDir));
  const generatedAssets = inlineGeneratedAssets(pkg, packageDir);
  const mediaPath = join(packageDir, 'media.json');
  const media = existsSync(mediaPath) ? JSON.parse(readFileSync(mediaPath, 'utf8')) : undefined;
  const propsPath = outputPath.replace(/\.mp4$/, '.props.json');
  writeFileSync(propsPath, JSON.stringify({ pkg, timeline, generatedAssets, ...(media ? { media } : {}) }));
  onLog(`inlined ${Object.keys(generatedAssets).length} generated asset(s)`);
  onLog(`compiled ${timeline.durationInFrames} frames, hash ${timeline.hash}`);
  if (timeline.provisional) onLog('warning: narration is not measured; timeline is provisional and must not be exported as final');

  let resolvedPublicDir = publicDir;
  let cleanupDir = null;
  if (!resolvedPublicDir) {
    if (needsMediaPublicDir(pkg)) {
      resolvedPublicDir = preparePublicDir(pkg, packageDir);
      cleanupDir = resolvedPublicDir;
      onLog(`prepared public dir ${resolvedPublicDir}`);
    } else {
      resolvedPublicDir = join(rendererDir, 'public');
    }
  }

  let render;
  try {
    render = spawnSync(
      'npx',
      [
        'remotion', 'render', 'src/index.ts', compositionId, outputPath,
        `--props=${propsPath}`,
        `--public-dir=${resolvedPublicDir}`,
        '--browser-executable=/usr/bin/google-chrome',
        '--concurrency=2',
        '--log=error',
      ],
      { cwd: rendererDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
  }
  if (render.status !== 0) {
    throw new Error(`remotion render exited ${render.status}: ${(render.stderr || render.stdout || '').slice(-1200)}`);
  }
  return {
    output: outputPath,
    frames: timeline.durationInFrames,
    hash: timeline.hash,
    bytes: statSync(outputPath).size,
    timeline,
    package: pkg,
    ...(media ? { media } : {}),
  };
}
