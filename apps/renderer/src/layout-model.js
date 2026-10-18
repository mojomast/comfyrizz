/**
 * Layout geometry model (pure JS + JSDoc so the target Node 20 can run it in
 * tests without stripping types).
 *
 * The renderer draws every scene as one of five layouts (see components.tsx).
 * This module encodes, in normalized 0..1 coordinates, the box where each
 * layout may draw text and the box a foreground asset occupies, so callers can
 * assert that text and assets never intersect. Added for A6 after review found
 * a foreground card covering body copy / a caption (DOLAN 12:50).
 *
 * L1 adds aspect-aware zones and re-layout rules: a 16:9 package can be
 * re-laid-out for 9:16 / 1:1 by moving foreground assets into a free area
 * below (or beside) the text-safe zone. Assets are never cropped or scaled.
 */

import { presenterBox } from './presenter-model.js';

const W = 1920;
const H = 1080;

/** @typedef {{x0:number,y0:number,x1:number,y1:number}} Box */
/** @typedef {'16:9'|'9:16'|'1:1'} Aspect */

/** Frame sizes for the three supported aspects. */
export const FORMATS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

/** @type {Aspect[]} */
export const ASPECTS = ['16:9', '9:16', '1:1'];

/**
 * Name the closest supported aspect for a format size.
 * @param {number} [width]
 * @param {number} [height]
 * @returns {Aspect}
 */
export function aspectName(width, height) {
  if (!width || !height) return '16:9';
  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) < 0.02) return '9:16';
  if (Math.abs(ratio - 1) < 0.02) return '1:1';
  return '16:9';
}

/**
 * @param {string} [aspect]
 * @returns {{width:number,height:number}}
 */
export function formatFor(aspect) {
  return FORMATS[aspect] ?? FORMATS['16:9'];
}

/**
 * Conservative safe zones (normalized) where each layout may draw text at
 * 16:9. Derived from components.tsx (SAFE_AREA = 144x96 px at 1920x1080) plus
 * each layout's padding and max-width. A drawn foreground asset must not
 * intersect these boxes.
 * @type {Record<string, Box[]>}
 */
export const TEXT_ZONES = {
  title: [{ x0: 0.07, y0: 0.24, x1: 0.93, y1: 0.74 }],
  hero: [{ x0: 0.07, y0: 0.2, x1: 0.93, y1: 0.8 }],
  'hero-split': [{ x0: 0.07, y0: 0.2, x1: 0.54, y1: 0.8 }],
  stat: [{ x0: 0.07, y0: 0.24, x1: 0.8, y1: 0.78 }],
  chart: [{ x0: 0.07, y0: 0.06, x1: 0.93, y1: 0.94 }],
  list: [{ x0: 0.07, y0: 0.08, x1: 0.7, y1: 0.92 }],
  split: [{ x0: 0.08, y0: 0.08, x1: 0.92, y1: 0.22 }, { x0: 0.06, y0: 0.62, x1: 0.46, y1: 0.9 }, { x0: 0.54, y0: 0.62, x1: 0.94, y1: 0.9 }],
  compare: [{ x0: 0.08, y0: 0.08, x1: 0.92, y1: 0.22 }, { x0: 0.06, y0: 0.62, x1: 0.46, y1: 0.9 }, { x0: 0.54, y0: 0.62, x1: 0.94, y1: 0.9 }],
  code: [{ x0: 0.08, y0: 0.12, x1: 0.92, y1: 0.88 }],
};

/**
 * Text-safe zones per aspect. Portrait stacks a split hero (copy on top, media
 * below) and keeps a bottom strip free for a foreground card; square keeps the
 * left/right split but leaves the whole lower band free.
 * @type {Record<Aspect, Record<string, Box[]>>}
 */
export const TEXT_ZONES_BY_ASPECT = {
  '16:9': TEXT_ZONES,
  '9:16': {
    title: [{ x0: 0.1, y0: 0.3, x1: 0.9, y1: 0.66 }],
    hero: [{ x0: 0.1, y0: 0.28, x1: 0.9, y1: 0.66 }],
    'hero-split': [{ x0: 0.08, y0: 0.05, x1: 0.92, y1: 0.46 }],
    stat: [{ x0: 0.1, y0: 0.26, x1: 0.9, y1: 0.62 }],
    chart: [{ x0: 0.08, y0: 0.06, x1: 0.92, y1: 0.58 }],
    list: [{ x0: 0.08, y0: 0.08, x1: 0.92, y1: 0.66 }],
    split: [{ x0: 0.08, y0: 0.28, x1: 0.92, y1: 0.46 }, { x0: 0.08, y0: 0.54, x1: 0.92, y1: 0.72 }],
    compare: [{ x0: 0.08, y0: 0.28, x1: 0.92, y1: 0.46 }, { x0: 0.08, y0: 0.54, x1: 0.92, y1: 0.72 }],
    code: [{ x0: 0.08, y0: 0.28, x1: 0.92, y1: 0.72 }],
  },
  '1:1': {
    title: [{ x0: 0.1, y0: 0.26, x1: 0.9, y1: 0.66 }],
    hero: [{ x0: 0.08, y0: 0.24, x1: 0.92, y1: 0.66 }],
    'hero-split': [{ x0: 0.07, y0: 0.14, x1: 0.5, y1: 0.86 }],
    stat: [{ x0: 0.08, y0: 0.24, x1: 0.78, y1: 0.64 }],
    chart: [{ x0: 0.08, y0: 0.06, x1: 0.92, y1: 0.66 }],
    list: [{ x0: 0.08, y0: 0.08, x1: 0.72, y1: 0.66 }],
    split: [{ x0: 0.08, y0: 0.08, x1: 0.92, y1: 0.2 }, { x0: 0.08, y0: 0.62, x1: 0.46, y1: 0.9 }, { x0: 0.54, y0: 0.62, x1: 0.92, y1: 0.9 }],
    compare: [{ x0: 0.08, y0: 0.08, x1: 0.92, y1: 0.2 }, { x0: 0.08, y0: 0.62, x1: 0.46, y1: 0.9 }, { x0: 0.54, y0: 0.62, x1: 0.92, y1: 0.9 }],
    code: [{ x0: 0.1, y0: 0.14, x1: 0.9, y1: 0.86 }],
  },
};

/**
 * The free area a re-laid-out foreground asset may occupy: the complement of
 * the text-safe zone where the layout can still draw media. Landscape is the
 * identity (16:9 keeps its authored item coordinates).
 * @type {Record<Aspect, Record<string, Box>>}
 */
export const FREE_AREAS = {
  '16:9': {},
  '9:16': {
    title: { x0: 0.08, y0: 0.72, x1: 0.92, y1: 0.96 },
    hero: { x0: 0.08, y0: 0.7, x1: 0.92, y1: 0.96 },
    'hero-split': { x0: 0.08, y0: 0.5, x1: 0.92, y1: 0.96 },
    stat: { x0: 0.08, y0: 0.68, x1: 0.92, y1: 0.96 },
    chart: { x0: 0.08, y0: 0.64, x1: 0.92, y1: 0.96 },
    list: { x0: 0.08, y0: 0.72, x1: 0.92, y1: 0.96 },
    split: { x0: 0.08, y0: 0.74, x1: 0.92, y1: 0.96 },
    compare: { x0: 0.08, y0: 0.74, x1: 0.92, y1: 0.96 },
    code: { x0: 0.08, y0: 0.74, x1: 0.92, y1: 0.96 },
  },
  '1:1': {
    title: { x0: 0.08, y0: 0.72, x1: 0.92, y1: 0.96 },
    hero: { x0: 0.08, y0: 0.72, x1: 0.92, y1: 0.96 },
    'hero-split': { x0: 0.54, y0: 0.14, x1: 0.94, y1: 0.86 },
    stat: { x0: 0.08, y0: 0.7, x1: 0.92, y1: 0.96 },
    chart: { x0: 0.08, y0: 0.72, x1: 0.92, y1: 0.96 },
    list: { x0: 0.08, y0: 0.72, x1: 0.92, y1: 0.96 },
    split: { x0: 0.08, y0: 0.92, x1: 0.92, y1: 0.98 },
    compare: { x0: 0.08, y0: 0.92, x1: 0.92, y1: 0.98 },
    code: { x0: 0.08, y0: 0.92, x1: 0.92, y1: 0.98 },
  },
};

/**
 * @param {string} [aspect]
 * @param {string} [key] `hero` / `hero-split` / a layout id
 * @returns {Box | null}
 */
export function freeArea(aspect, key) {
  const table = FREE_AREAS[aspect] ?? FREE_AREAS['16:9'];
  return table[key] ?? null;
}

/**
 * Text zones for a scene, taking its variant and aspect into account.
 * @param {any} scene
 * @param {Aspect} [aspect]
 * @returns {Box[]}
 */
export function textZones(scene, aspect = '16:9') {
  const table = TEXT_ZONES_BY_ASPECT[aspect] ?? TEXT_ZONES;
  const layout = scene?.layout;
  if (layout === 'hero') {
    return table[scene.variant === 'full-bleed' ? 'hero' : 'hero-split'];
  }
  return table[layout] ?? [];
}

/**
 * The safe-zone key for a scene: split heroes use their own zone at portrait
 * and square, otherwise the layout id.
 * @param {any} scene
 * @returns {string}
 */
function zoneKey(scene) {
  if (scene?.layout === 'hero') return scene.variant === 'full-bleed' ? 'hero' : 'hero-split';
  return scene?.layout;
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
 * @param {Aspect} [aspect]
 * @returns {Box}
 */
export function foregroundBox(item, asset, dims, aspect = '16:9') {
  const frame = formatFor(aspect);
  if (item?.frame === 'pip') {
    const box = presenterBox({
      placement: item.placement ?? 'pip-br',
      shape: item.mask === 'circle' ? 'circle' : 'rounded-rect',
      size: typeof item.size === 'number' ? item.size : 0.24,
      width: frame.width,
      height: frame.height,
    });
    return {
      x0: box.left / frame.width,
      y0: box.top / frame.height,
      x1: (box.left + box.width) / frame.width,
      y1: (box.top + box.height) / frame.height,
    };
  }
  const w = item?.w ?? 0.4;
  const h = (w * frame.width) / (assetAspect(asset, dims) * frame.height);
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
 * @param {{margin?:number, mediaDims?:Record<string, {width:number,height:number}>, aspect?:Aspect}} [options]
 * @returns {{scene:string,asset:string,text:Box,box:Box}[]}
 */
export function findLayoutOverlaps(pkg, { margin = 0.005, mediaDims, aspect } = {}) {
  const resolved = aspect ?? aspectName(pkg?.format?.width, pkg?.format?.height);
  const overlaps = [];
  for (const [sceneId, scene] of sceneEntries(pkg)) {
    const zones = textZones(scene, resolved);
    for (const item of scene?.foreground ?? []) {
      const asset = pkg?.assets?.[item.asset];
      if (!isDrawnForeground(asset)) continue;
      const box = foregroundBox(item, asset, mediaDims, resolved);
      for (const zone of zones) {
        if (intersects(box, zone, margin)) {
          overlaps.push({ scene: sceneId, asset: item.asset, text: zone, box });
        }
      }
    }
  }
  return overlaps;
}

/**
 * Fit one foreground item into an aspect's free area without changing the
 * asset: keep the authored width when it fits, otherwise shrink to the free
 * area. Anchored to the bottom of the strip so copy above stays clear.
 * @param {any} item
 * @param {any} asset
 * @param {Box} free
 * @param {Aspect} aspect
 * @returns {{x:number,y:number,w:number}}
 */
export function fitForeground(item, asset, free, aspect) {
  const frame = formatFor(aspect);
  const aspectRatio = assetAspect(asset);
  const heightPerWidth = frame.width / (aspectRatio * frame.height);
  const freeW = free.x1 - free.x0;
  const freeH = free.y1 - free.y0;
  let w = Math.min(item?.w ?? 0.4, freeW);
  let h = w * heightPerWidth;
  if (h > freeH) {
    h = freeH;
    w = h / heightPerWidth;
  }
  const round = value => Number(value.toFixed(4));
  const x = (free.x0 + free.x1) / 2;
  const y = free.y1 - h / 2 - 0.02;
  return { x: round(x), y: round(y), w: round(w) };
}

/**
 * Re-lay-out a package at a different aspect by setting the frame size and
 * fitting every foreground asset into the free area for its layout. Assets are
 * never cropped or re-encoded, and 16:9 is the identity transform.
 * @param {any} pkg
 * @param {Aspect} aspect
 * @returns {any} a new package
 */
export function relayoutPackage(pkg, aspect) {
  const frame = formatFor(aspect);
  const variant = structuredClone(pkg);
  variant.format = { ...(pkg.format ?? {}), width: frame.width, height: frame.height };
  if (aspect === '16:9') return variant;
  for (const scene of variant.scenes ?? []) {
    if (!Array.isArray(scene?.foreground) || scene.foreground.length === 0) continue;
    const free = freeArea(aspect, zoneKey(scene));
    if (!free) continue;
    scene.foreground = scene.foreground.map(item => {
      if (item?.frame === 'pip') return item;
      const asset = variant.assets?.[item.asset];
      const fitted = fitForeground(item, asset, free, aspect);
      return { ...item, ...fitted };
    });
  }
  return variant;
}

/**
 * Re-lay-out every requested aspect (16:9 included as a no-op baseline).
 * @param {any} pkg
 * @param {Aspect[]} [aspects]
 * @returns {Record<string, any>}
 */
export function relayoutVariants(pkg, aspects = ASPECTS) {
  return Object.fromEntries(aspects.map(aspect => [aspect, relayoutPackage(pkg, aspect)]));
}
