/**
 * Per-scene incremental CPU render (A6).
 *
 * A package's compiled timeline is split into non-overlapping frame segments at
 * scene boundaries. Each segment is keyed by everything that can change its
 * frames (its scene, the next scene when a fade overlaps, the referenced
 * assets, the captions in range, the theme and the media sidecar). Unchanged
 * segments are reused from a content-addressed cache; only changed segments are
 * rendered again. The segments are then concatenated and the narration (if the
 * package has a ready audio asset) is muxed on. The final frame count is checked
 * against the compiled timeline, so an incremental export still matches a full
 * render.
 *
 * No network. Used by `render:example` and the per-scene re-render test.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { canonicalJson, compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { inlineGeneratedAssets, missingMediaFiles, preparePublicDir, rendererDir } from './render-package-lib.mjs';
import { collectMediaDims, dimMismatches } from '../src/media-dims.js';

/** Bump when a renderer change can alter rendered frames. */
export const RENDERER_VERSION = 3;

const BROWSER = process.env.REMOTION_BROWSER ?? '/usr/bin/google-chrome';

function pick(record, ids) {
  if (!record) return undefined;
  const out = {};
  for (const id of ids) if (record[id] !== undefined) out[id] = record[id];
  return Object.keys(out).length > 0 ? out : undefined;
}

function referencedAssetIds(scenes, timeline) {
  const ids = new Set();
  for (const scene of scenes) {
    const compiled = timeline.scenes.find(item => item.id === scene.id);
    if (!compiled) continue;
    if (compiled.background?.asset) ids.add(compiled.background.asset);
    for (const item of compiled.foreground ?? []) if (item?.asset) ids.add(item.asset);
    if (compiled.narration_asset) ids.add(compiled.narration_asset);
  }
  return [...ids].sort();
}

/**
 * The raw package scene (with current copy/foreground/background) for an id.
 * @param {any} pkg
 * @param {string} id
 * @returns {any}
 */
function packageSceneById(pkg, id) {
  const scenes = pkg.scenes;
  if (Array.isArray(scenes)) return scenes.find(scene => scene.id === id) ?? null;
  return scenes?.[id] ?? null;
}

/**
 * Merge committed timeline timing with current package content. The committed
 * timeline is the timing source of truth (measured narration durations), but
 * the package owns copy/foreground/background, so a content edit must show up
 * and invalidate a segment without recompiling a narrated timeline.
 * @param {any} pkg
 * @param {any} timeline
 * @returns {any[]}
 */
export function mergeScenes(pkg, timeline) {
  return timeline.scenes.map(scene => {
    const raw = packageSceneById(pkg, scene.id);
    if (!raw) return scene;
    return {
      ...scene,
      ...raw,
      id: scene.id,
      from: scene.from,
      durationInFrames: scene.durationInFrames,
      transitionInFrames: scene.transitionInFrames,
      transitionOutFrames: scene.transitionOutFrames,
      provisional: scene.provisional,
    };
  });
}

/**
 * Split a compiled timeline into per-scene frame segments with a content hash.
 * Pure: no rendering, so tests can assert reuse decisions without a browser.
 */
export function planSegments(pkg, timeline, { generatedAssets = {}, media, compositionId = 'PackageDemo', missingMedia = [], mediaDims = {} } = {}) {
  const segments = [];
  const renderScenes = mergeScenes(pkg, timeline);
  for (let index = 0; index < renderScenes.length; index += 1) {
    const scene = renderScenes[index];
    const next = renderScenes[index + 1];
    const start = scene.from;
    const end = next ? next.from - 1 : timeline.durationInFrames - 1;
    const frames = end - start + 1;
    if (frames <= 0) continue;
    // A fade after this scene draws the next scene too, so it is part of this segment.
    const affected = [scene];
    if (next && (scene.transitionOutFrames ?? 0) > 0) affected.push(next);
    const ids = referencedAssetIds(affected, timeline);
    const assets = ids.map(id => ({ id, vector: generatedAssets[id] ?? null, asset: pkg.assets?.[id] ?? null }));
    const captions = (timeline.captions ?? []).filter(cue => cue.to > start && cue.from <= end);
    const mediaInputs = media
      ? {
          scrim: pick(media.scrim, affected.map(item => item.id)),
          lowerThird: pick(media.lowerThird, affected.map(item => item.id)),
          skipLayout: (media.skipLayout ?? []).filter(id => affected.some(item => item.id === id)),
        }
      : undefined;
    const keyInput = {
      renderer: RENDERER_VERSION,
      compositionId,
      width: timeline.width,
      height: timeline.height,
      fps: timeline.fps,
      theme: pkg.theme ?? null,
      start,
      end,
      scenes: affected,
      assets,
      captions,
      media: mediaInputs,
      missing: missingMedia.map(item => item.file),
      dims: mediaDims,
    };
    const key = createHash('sha256').update(canonicalJson(keyInput)).digest('hex').slice(0, 32);
    segments.push({ index, sceneId: scene.id, start, end, frames, key });
  }
  return segments;
}

function ffprobeFrames(file) {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
  return Number(JSON.parse(probe.stdout).streams?.[0]?.nb_read_frames);
}

export function renderPackageIncremental(packagePath, outputPath, options = {}) {
  const { cacheDir, onLog = () => {}, force = false, compositionId = 'PackageDemo', renderSegment } = options;
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const validation = validatePackage(pkg);
  if (!validation.valid) {
    const detail = validation.errors.map(error => `${error.code} ${error.path}: ${error.message}`).join('; ');
    throw new Error(`package invalid: ${detail}`);
  }
  const packageDir = dirname(packagePath);
  // The committed timeline.json is the timing source of truth; only compile when
  // an example has not been compiled yet (e.g. an in-memory agent draft).
  const timelinePath = join(packageDir, 'timeline.json');
  const timeline = existsSync(timelinePath) ? JSON.parse(readFileSync(timelinePath, 'utf8')) : compileTimeline(pkg);
  const generatedAssets = inlineGeneratedAssets(pkg, packageDir);
  const missingMedia = missingMediaFiles(pkg, packageDir);
  const mediaDims = collectMediaDims(pkg, packageDir);
  const dimProblems = dimMismatches(pkg, mediaDims);
  const scenes = mergeScenes(pkg, timeline);
  const mediaPath = join(packageDir, 'media.json');
  const media = existsSync(mediaPath) ? JSON.parse(readFileSync(mediaPath, 'utf8')) : undefined;

  // Cache keyed by package id (stable across edits); segment keys do the invalidation.
  // Kept under apps/renderer/.cache so it stays inside the owned tree.
  const cache = cacheDir ?? join(rendererDir, '.cache', pkg.id);
  mkdirSync(cache, { recursive: true });
  const propsPath = join(cache, 'props.json');
  writeFileSync(propsPath, JSON.stringify({ pkg, timeline, scenes, generatedAssets, ...(media ? { media } : {}), ...(missingMedia.length > 0 ? { missingMedia: missingMedia.map(item => item.file) } : {}), ...(Object.keys(mediaDims).length > 0 ? { mediaDims } : {}) }));
  onLog(`compiled ${timeline.durationInFrames} frames, hash ${timeline.hash}`);
  for (const item of missingMedia) onLog(`warning: media not in this clone: ${item.id} (${item.file})`);
  for (const item of dimProblems) onLog(`warning: declared ${item.declared.width}x${item.declared.height} for ${item.id} (${item.file}) but the file is ${item.real.width}x${item.real.height}; using the real size`);

  const segments = planSegments(pkg, timeline, { generatedAssets, media, compositionId, missingMedia, mediaDims });
  const rendered = [];
  const reused = [];

  const ownsPublicDir = options.publicDir === undefined;
  const publicDir = options.publicDir ?? preparePublicDir(pkg, packageDir);

  const render = renderSegment ?? ((segment, segmentPath) => {
    const result = spawnSync(
      'npx',
      [
        'remotion', 'render', 'src/index.ts', compositionId, segmentPath,
        `--props=${propsPath}`,
        `--public-dir=${publicDir}`,
        `--frames=${segment.start}-${segment.end}`,
        `--browser-executable=${BROWSER}`,
        '--concurrency=2',
        '--log=error',
      ],
      { cwd: rendererDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      throw new Error(`remotion segment ${segment.sceneId} exited ${result.status}: ${(result.stderr || result.stdout || '').slice(-1200)}`);
    }
  });

  try {
    for (const segment of segments) {
      const segmentPath = join(cache, `${segment.key}.mp4`);
      if (!force && existsSync(segmentPath) && statSync(segmentPath).size > 0) {
        reused.push(segment);
        onLog(`reuse ${segment.sceneId} frames ${segment.start}-${segment.end} (${segment.key.slice(0, 8)})`);
        continue;
      }
      rmSync(segmentPath, { force: true });
      onLog(`render ${segment.sceneId} frames ${segment.start}-${segment.end} (${segment.key.slice(0, 8)})`);
      render(segment, segmentPath, { propsPath, publicDir });
      if (!existsSync(segmentPath)) throw new Error(`segment ${segment.sceneId} was not written`);
      rendered.push(segment);
    }

    const listPath = join(cache, 'concat.txt');
    writeFileSync(listPath, `${segments.map(segment => `file '${join(cache, `${segment.key}.mp4`).replace(/'/g, "'\\''")}'`).join('\n')}\n`);
    const silentPath = join(cache, 'silent.mp4');
    rmSync(silentPath, { force: true });
    const concat = spawnSync('ffmpeg', ['-y', '-hide_banner', '-nostats', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', silentPath], { encoding: 'utf8' });
    if (concat.status !== 0) throw new Error(`concat failed: ${concat.stderr}`);
  } finally {
    if (ownsPublicDir) rmSync(publicDir, { recursive: true, force: true });
  }

  const audioAsset = Object.values(pkg.assets ?? {}).find(asset => asset?.kind === 'audio' && asset.status === 'ready' && typeof asset.file === 'string');
  let audio = null;
  const silentPath = join(cache, 'silent.mp4');
  if (audioAsset) {
    const audioPath = join(packageDir, audioAsset.file);
    if (!existsSync(audioPath)) {
      // P-fix4: a clean clone has no narration file. Export silent with the
      // committed captions instead of crashing.
      onLog(`warning: media not in this clone: ${audioAsset.file}; exporting silent`);
      copyFileSync(silentPath, outputPath);
      audio = null;
    } else {
      rmSync(outputPath, { force: true });
      const mux = spawnSync(
        'ffmpeg',
        ['-y', '-hide_banner', '-nostats', '-i', silentPath, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outputPath],
        { encoding: 'utf8' },
      );
      if (mux.status !== 0) throw new Error(`audio mux failed: ${mux.stderr}`);
      audio = { file: audioAsset.file, codec: 'aac' };
    }
  } else {
    copyFileSync(silentPath, outputPath);
  }

  const frames = ffprobeFrames(outputPath);
  if (frames !== timeline.durationInFrames) {
    throw new Error(`incremental export has ${frames} frames, compiled timeline has ${timeline.durationInFrames}`);
  }

  return {
    output: outputPath,
    bytes: statSync(outputPath).size,
    frames,
    timelineHash: timeline.hash,
    timeline,
    package: pkg,
    cacheDir: cache,
    audio,
    segments: segments.map(segment => ({ index: segment.index, sceneId: segment.sceneId, start: segment.start, end: segment.end, frames: segment.frames, key: segment.key })),
    rendered: rendered.map(segment => segment.key),
    reused: reused.map(segment => segment.key),
  };
}
