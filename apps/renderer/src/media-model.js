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
 * A media asset can only be drawn once it is ready and has a file. Pending GPU
 * slots keep the scene's procedural fallback instead of loading an empty path.
 * @param {Asset} [asset]
 * @returns {boolean}
 */
export function isRenderableMedia(asset) {
  return Boolean(asset) && isMediaKind(asset?.kind) && asset?.status === 'ready' && typeof asset.file === 'string' && asset.file.length > 0;
}

/**
 * @param {Scene} scene
 * @param {PackageV1} pkg
 * @param {MediaSidecar} [media]
 * @returns {ResolvedSceneMedia}
 */
export function resolveSceneMedia(scene, pkg, media) {
  const withMedia = /** @type {{ id: string, media_only?: boolean, lower_third?: LowerThirdContent, background?: { asset?: string, scrim?: number } | null }} */ (scene);
  const backgroundId = withMedia.background?.asset;
  const background = backgroundId ? pkg.assets?.[backgroundId] : undefined;
  const scrim = normalizeScrim(withMedia.background?.scrim ?? media?.scrim?.[scene.id]);
  const mediaOnly = withMedia.media_only === true || media?.skipLayout?.includes(scene.id) === true;
  const lowerThird = withMedia.lower_third ?? media?.lowerThird?.[scene.id];
  return {
    ...(background ? { background } : {}),
    scrim,
    mediaOnly,
    ...(lowerThird ? { lowerThird } : {}),
  };
}
