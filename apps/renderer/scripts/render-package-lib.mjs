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
import { listMediaFiles } from '../src/media-model.js';
import { collectMediaDims, dimMismatches } from '../src/media-dims.js';

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
  const add = file => {
    if (typeof file !== 'string') return;
    const [top] = file.split('/');
    if (top && top !== file) dirs.add(top);
  };
  for (const asset of Object.values(pkg.assets ?? {})) add(asset?.file);
  // B1: a brand font lives in `theme.fonts[].file`, not in `assets`, but the
  // renderer still loads it through `staticFile`, so its directory must be copied.
  for (const font of pkg.theme?.fonts ?? []) add(font?.file);
  return [...dirs];
}

function needsMediaPublicDir(pkg) {
  return Object.values(pkg.assets ?? {}).some(asset => asset?.kind === 'image' || asset?.kind === 'video' || asset?.kind === 'audio');
}

/** A9: the final export resolution. The Player preview stays at the package's working size. */
export const FINAL_WIDTH = 1920;
export const FINAL_HEIGHT = 1080;

/**
 * A9: the x2 upscaled variant of a media asset, if the package declares one.
 * Field agreed with H12: `assets[<id>].variants.upscaled = { file, width, height }`.
 * Only image/video assets are candidates; a missing or malformed variant returns null.
 */
export function upscaledVariant(asset) {
  if (asset?.kind !== 'image' && asset?.kind !== 'video') return null;
  const variant = asset?.variants?.upscaled;
  if (!variant || typeof variant !== 'object' || typeof variant.file !== 'string' || variant.file.length === 0) return null;
  return variant;
}

/**
 * A9: the final render prefers each media asset's upscaled file when this clone has it, and falls
 * back to the base file (A8 scales it with the real probed size) otherwise. Runs on a clone and
 * never mutates the stored package.
 */
export function preferUpscaledAssets(pkg, packageDir) {
  const out = structuredClone(pkg);
  const used = [];
  for (const [id, asset] of Object.entries(out.assets ?? {})) {
    const variant = upscaledVariant(asset);
    if (!variant) continue;
    if (!existsSync(join(packageDir, variant.file))) continue;
    const base = asset.file;
    asset.file = variant.file;
    used.push({ id, file: variant.file, base, ...(variant.width && variant.height ? { width: variant.width, height: variant.height } : {}) });
  }
  return { pkg: out, used };
}

/** A9: the package a final export renders — 1920×1080, upscaled media when present. */
export function applyFinalRender(pkg, packageDir, final = {}) {
  const width = final.width ?? FINAL_WIDTH;
  const height = final.height ?? FINAL_HEIGHT;
  const base = structuredClone(pkg);
  base.format = { ...(base.format ?? {}), width, height };
  const { pkg: withMedia, used } = final.preferUpscaled === false ? { pkg: base, used: [] } : preferUpscaledAssets(base, packageDir);
  return { pkg: withMedia, used, width, height };
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
    narration[sceneId] = (scene.chunks ?? []).map(chunk =>
      chunk.words && chunk.words.length > 0
        ? { text: chunk.text, seconds: chunk.seconds, words: chunk.words }
        : { text: chunk.text, seconds: chunk.seconds },
    );
  }
  return {
    narration,
    narrationGapSeconds: durations.gapSeconds,
    narrationPaddingSeconds: durations.paddingSeconds,
  };
}

/**
 * P-fix4: image/video/audio files a package declares but this clone does not
 * have. The GPU examples gitignore assets/*.mp4|png and audio/*.wav, so a clean
 * clone must draw a labelled placeholder for each instead of crashing. Returns
 * the declaration order so warnings read like the manifest.
 */
export function missingMediaFiles(pkg, packageDir) {
  return listMediaFiles(pkg).filter(item => !existsSync(join(packageDir, item.file)));
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

export function renderPackage(packagePath, outputPath = packagePath.replace(/\.json$/, '.mp4'), { onLog = () => {}, publicDir, compositionId = 'PackageDemo', still = false, frame = 0, final = null, narration } = {}) {
  const raw = JSON.parse(readFileSync(packagePath, 'utf8'));
  const packageDir = dirname(packagePath);
  // A9: validate the package as stored — the base `file` and `variants` are checked (H12 variant
  // semantics: same file, relative path, bigger) before the final render swaps in a variant.
  const validation = validatePackage(raw);
  if (!validation.valid) {
    const detail = validation.errors.map(error => `${error.code} ${error.path}: ${error.message}`).join('; ');
    throw new Error(`package invalid: ${detail}`);
  }
  // A9: the final-export option overrides the format to 1920×1080 and prefers upscaled media.
  const applied = final ? applyFinalRender(raw, packageDir, typeof final === 'boolean' ? {} : final) : null;
  const pkg = applied?.pkg ?? raw;
  // L1: a language variant has its own narration text, so callers pass the
  // variant's measured durations (or `{}` to re-estimate from the translated
  // `scene.narration`) instead of the base package's English durations.
  const compileOptions = narration !== undefined ? narration : narrationOptions(packageDir);
  const timeline = compileTimeline(pkg, compileOptions);
  if (applied) {
    onLog(`final render ${applied.width}×${applied.height}${applied.used.length > 0 ? `, ${applied.used.length} upscaled variant(s)` : ', no upscaled variants'}`);
    for (const item of applied.used) onLog(`using upscaled ${item.id}: ${item.file}`);
  }
  const generatedAssets = inlineGeneratedAssets(pkg, packageDir);
  const missingMedia = missingMediaFiles(pkg, packageDir);
  const mediaDims = collectMediaDims(pkg, packageDir);
  const dimProblems = dimMismatches(pkg, mediaDims);
  const mediaPath = join(packageDir, 'media.json');
  const media = existsSync(mediaPath) ? JSON.parse(readFileSync(mediaPath, 'utf8')) : undefined;
  const propsPath = `${outputPath.replace(/\.(mp4|png|jpg)$/, '')}.props.json`;
  writeFileSync(propsPath, JSON.stringify({ pkg, timeline, generatedAssets, ...(media ? { media } : {}), ...(missingMedia.length > 0 ? { missingMedia: missingMedia.map(item => item.file) } : {}), ...(Object.keys(mediaDims).length > 0 ? { mediaDims } : {}) }));
  onLog(`inlined ${Object.keys(generatedAssets).length} generated asset(s)`);
  onLog(`compiled ${timeline.durationInFrames} frames, hash ${timeline.hash}`);
  if (timeline.provisional) onLog('warning: narration is not measured; timeline is provisional and must not be exported as final');
  for (const item of missingMedia) onLog(`warning: media not in this clone: ${item.id} (${item.file})`);
  for (const item of dimProblems) onLog(`warning: declared ${item.declared.width}x${item.declared.height} for ${item.id} (${item.file}) but the file is ${item.real.width}x${item.real.height}; using the real size`);

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
      still
        ? [
            'remotion', 'still', 'src/index.ts', compositionId, outputPath,
            `--props=${propsPath}`,
            `--public-dir=${resolvedPublicDir}`,
            `--frame=${frame}`,
            '--browser-executable=/usr/bin/google-chrome',
            '--log=error',
          ]
        : [
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
    frames: still ? 1 : timeline.durationInFrames,
    hash: timeline.hash,
    bytes: statSync(outputPath).size,
    timeline,
    package: pkg,
    ...(still ? { still: true } : {}),
    ...(applied ? { final: { width: applied.width, height: applied.height, upscaled: applied.used } } : {}),
    ...(missingMedia.length > 0 ? { missingMedia } : {}),
    ...(dimProblems.length > 0 ? { dimProblems } : {}),
    ...(media ? { media } : {}),
  };
}
