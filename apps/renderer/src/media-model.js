/**
 * P-fix1 media resolution, kept free of JSX/Remotion so it can be unit-tested
 * on plain Node (20+) and imported by the TSX renderer. Types live in the
 * JSDoc below; the file is JS so `node --test` does not need a type stripper.
 *
 * @typedef {import('../../../packages/schema/types').Asset} Asset
 * @typedef {import('../../../packages/schema/types').PackageV1} PackageV1
 * @typedef {import('../../../packages/schema/types').Scene} Scene
 *
 * @typedef {Object} LowerThirdContent
 * @property {string} [kicker]
 * @property {string} text
 *
 * @typedef {Object} MediaSidecar
 * @property {Record<string, number>} [scrim] Per-scene dark overlay opacity 0..1.
 * @property {string[]} [skipLayout] Scenes that should skip their layout.
 * @property {Record<string, LowerThirdContent>} [lowerThird] Per-scene lower-third overlay.
 *
 * @typedef {Object} ResolvedSceneMedia
 * @property {Asset} [background]
 * @property {string} [backgroundId]
 * @property {number} scrim
 * @property {boolean} mediaOnly
 * @property {LowerThirdContent} [lowerThird]
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeScrim(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

/**
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isMediaKind(kind) {
  return kind === 'image' || kind === 'video';
}

/**
 * Playback length used by MediaFill. Upload probes commonly provide
 * durationSeconds without a frame count; that measured duration must win over
 * the legacy 97/24 fallback. Explicit frames retain the original frames/fps path.
 * @param {Asset} asset
 * @returns {number}
 */
export function mediaPlaybackDurationSeconds(asset) {
  const media = asset?.media;
  const sourceFps = typeof media?.fps === 'number' && Number.isFinite(media.fps) && media.fps > 0 ? media.fps : 24;
  if (typeof media?.frames === 'number' && Number.isFinite(media.frames) && media.frames >= 0) {
    return media.frames / sourceFps;
  }
  if (typeof media?.durationSeconds === 'number' && Number.isFinite(media.durationSeconds) && media.durationSeconds > 0) {
    return media.durationSeconds;
  }
  return 97 / 24;
}

/**
 * A media asset can only be drawn once it is ready and has a file. Pending GPU
 * slots keep the scene's procedural fallback instead of loading an empty path.
 * @param {Asset} [asset]
 * @returns {boolean}
 */
export function isRenderableMedia(asset) {
  return Boolean(asset) && isMediaKind(asset?.kind) && asset?.status === 'ready' && typeof asset.file === 'string' && asset.file.length > 0;
}

/**
 * Every image/video/audio file the package declares, in declaration order.
 * Packages that gitignore their media (the GPU examples) leave these files out
 * of a clean clone, so callers match them against what actually exists.
 * @param {PackageV1} pkg
 * @returns {Array<{ id: string, file: string, kind: string }>}
 */
export function listMediaFiles(pkg) {
  const files = [];
  for (const [id, asset] of Object.entries(pkg?.assets ?? {})) {
    if (!isMediaKind(asset?.kind) && asset?.kind !== 'audio') continue;
    if (typeof asset?.file !== 'string' || asset.file.length === 0) continue;
    files.push({ id, file: asset.file, kind: asset.kind });
  }
  return files;
}

/**
 * True when the asset points at a file the caller has declared missing
 * (P-fix4). The renderer then draws a labelled placeholder instead of asking
 * Remotion for a file that is not in this clone.
 * @param {Asset} [asset]
 * @param {Set<string> | string[]} [missing]
 * @returns {boolean}
 */
export function isMissingMedia(asset, missing) {
  if (!asset || typeof asset.file !== 'string' || asset.file.length === 0) return false;
  const set = missing instanceof Set ? missing : new Set(missing ?? []);
  return set.has(asset.file);
}

/**
 * @param {Scene} scene
 * @param {PackageV1} pkg
 * @param {MediaSidecar} [media]
 * @returns {ResolvedSceneMedia}
 */
export function resolveSceneMedia(scene, pkg, media) {
  const withMedia = /** @type {{ id: string, media_only?: boolean, mediaOnly?: boolean, lower_third?: LowerThirdContent, lowerThird?: LowerThirdContent, background?: { asset?: string, scrim?: number } | null }} */ (scene);
  const backgroundId = withMedia.background?.asset;
  const background = backgroundId ? pkg.assets?.[backgroundId] : undefined;
  const scrim = normalizeScrim(withMedia.background?.scrim ?? media?.scrim?.[scene.id]);
  // The compiled timeline carries camelCase mediaOnly/lowerThird; raw package
  // scenes and the media.json sidecar use the schema/sidecar spellings.
  const mediaOnly = withMedia.media_only === true || withMedia.mediaOnly === true || media?.skipLayout?.includes(scene.id) === true;
  const lowerThird = withMedia.lower_third ?? withMedia.lowerThird ?? media?.lowerThird?.[scene.id];
  return {
    ...(background ? { background, backgroundId: backgroundId } : {}),
    scrim,
    mediaOnly,
    ...(lowerThird ? { lowerThird } : {}),
  };
}
