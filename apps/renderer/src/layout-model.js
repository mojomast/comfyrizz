/**
 * Layout geometry model (pure JS + JSDoc so the target Node 20 can run it in
 * tests without stripping types).
 *
 * The renderer draws every scene as one of five layouts (see components.tsx).
 * This module encodes, in normalized 0..1 coordinates, the box where each
 * layout may draw text and the box a foreground asset occupies, so callers can
 * assert that text and assets never intersect. Added for A6 after review found
 * a foreground card covering body copy / a caption (DOLAN 12:50).
 */

const W = 1920;
const H = 1080;

/** @typedef {{x0:number,y0:number,x1:number,y1:number}} Box */

/**
 * Conservative safe zones (normalized) where each layout may draw text.
 * Derived from components.tsx (SAFE_AREA = 144x96 px at 1920x1080) plus each
 * layout's padding and max-width. A drawn foreground asset must not intersect
 * these boxes.
 * @type {Record<string, Box[]>}
 */
export const TEXT_ZONES = {
  title: [{ x0: 0.07, y0: 0.24, x1: 0.93, y1: 0.74 }],
  hero: [{ x0: 0.07, y0: 0.2, x1: 0.93, y1: 0.8 }],
  'hero-split': [{ x0: 0.07, y0: 0.2, x1: 0.54, y1: 0.8 }],
  stat: [{ x0: 0.07, y0: 0.24, x1: 0.8, y1: 0.78 }],
  chart: [{ x0: 0.07, y0: 0.06, x1: 0.93, y1: 0.94 }],
  list: [{ x0: 0.07, y0: 0.08, x1: 0.7, y1: 0.92 }],
};

/**
 * Text zones for a scene, taking its variant into account.
 * @param {any} scene
 * @returns {Box[]}
 */
export function textZones(scene) {
  const layout = scene?.layout;
  if (layout === 'hero') {
    return TEXT_ZONES[scene.variant === 'full-bleed' ? 'hero' : 'hero-split'];
  }
  return TEXT_ZONES[layout] ?? [];
}

/**
 * Aspect ratio (width / height) of a foreground asset. Prefers the probed real
 * size (A8), then the SVG render-check raster size, then media metadata, and
 * defaults to 16:9.
 * @param {any} asset
 * @param {Record<string, {width:number,height:number}>} [dims] probed file sizes, keyed by package-relative file
 * @returns {number}
 */
export function assetAspect(asset, dims) {
  const real = typeof asset?.file === 'string' ? dims?.[asset.file] : undefined;
  if (real?.width && real?.height) return real.width / real.height;
  const rc = asset?.gen?.render_check;
  if (rc?.width && rc?.height) return rc.width / rc.height;
  const media = asset?.media;
  if (media?.width && media?.height) return media.width / media.height;
  return W / H;
}

/**
 * Whether the renderer actually draws this asset as a foreground element.
 * Mirrors isRenderableMedia: pending/failed GPU slots are skipped and fall
 * through to procedural backgrounds.
 * @param {any} asset
 * @returns {boolean}
 */
export function isDrawnForeground(asset) {
  if (!asset) return false;
  if (asset.kind === 'svg' || asset.kind === 'vector-anim') return true;
  if (asset.kind !== 'image' && asset.kind !== 'video') return false;
  return asset.status === 'ready' && Boolean(asset.file);
}

/**
 * Normalized box a foreground item occupies. The renderer centers the item on
 * (x, y) and sets width = w; height follows the asset aspect ratio (probed real
 * size when available, so a wrong declared size cannot stretch the panel).
 * @param {any} item
 * @param {any} asset
 * @param {Record<string, {width:number,height:number}>} [dims]
 * @returns {Box}
 */
export function foregroundBox(item, asset, dims) {
  const w = item?.w ?? 0.4;
  const h = (w * W) / (assetAspect(asset, dims) * H);
  const cx = item?.x ?? 0.5;
  const cy = item?.y ?? 0.5;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

/**
 * @param {Box} a
 * @param {Box} b
 * @param {number} [margin] shrink both boxes by this before testing
 * @returns {boolean}
 */
export function intersects(a, b, margin = 0) {
  return a.x0 < b.x1 - margin && b.x0 < a.x1 - margin && a.y0 < b.y1 - margin && b.y0 < a.y1 - margin;
}

/** @param {any} pkg @returns {[string, any][]} */
function sceneEntries(pkg) {
  const scenes = pkg?.scenes;
  if (Array.isArray(scenes)) return scenes.map(scene => [scene.id, scene]);
  return Object.entries(scenes ?? {});
}

/**
 * Find text/asset overlaps across a package. Only drawn foreground assets are
 * considered.
 * @param {any} pkg
 * @param {{margin?:number, mediaDims?:Record<string, {width:number,height:number}>}} [options]
 * @returns {{scene:string,asset:string,text:Box,box:Box}[]}
 */
export function findLayoutOverlaps(pkg, { margin = 0.005, mediaDims } = {}) {
  const overlaps = [];
  for (const [sceneId, scene] of sceneEntries(pkg)) {
    const zones = textZones(scene);
    for (const item of scene?.foreground ?? []) {
      const asset = pkg?.assets?.[item.asset];
      if (!isDrawnForeground(asset)) continue;
      const box = foregroundBox(item, asset, mediaDims);
      for (const zone of zones) {
        if (intersects(box, zone, margin)) {
          overlaps.push({ scene: sceneId, asset: item.asset, text: zone, box });
        }
      }
    }
  }
  return overlaps;
}
