// AI2: shared geometry for the six renderer recipes.
//
// All geometry is derived from the composition's native width/height (never a
// fixed 1080 canvas), the scene's layout safe zones and an optional user focus
// rect. The helpers are pure and deterministic; the React layers only map the
// returned numbers to SVG/CSS.

import { aspectName, textZones } from '../layout-model.js';
import { clamp } from './model.js';

/** Mirrors theme.ts SAFE_AREA, kept here so a plain Node test does not import Remotion. */
export const SAFE_PX = { x: 144, y: 96 };

/**
 * @typedef {{x0:number,y0:number,x1:number,y1:number}} Box
 * @typedef {{x:number,y:number,w:number,h:number}} Rect
 */

/** @param {number} width @param {number} height @returns {string} */
export function aspectOf(width, height) {
  return aspectName(width, height);
}

/**
 * The caption band is protected: recipe decoration never sits in the bottom
 * SAFE_AREA strip. 9:16 needs a little more clearance because big-word captions
 * are taller than the landscape sentence style.
 * @param {number} width
 * @param {number} height
 * @returns {number} first y that is protected
 */
export function captionSafeTop(width, height) {
  const portrait = height > width;
  return height - Math.max(SAFE_PX.y, height * (portrait ? 0.16 : 0.13));
}

/** @param {Box} box @returns {Rect} */
export function boxToRect(box) {
  return { x: box.x0, y: box.y0, w: Math.max(0, box.x1 - box.x0), h: Math.max(0, box.y1 - box.y0) };
}

/**
 * A normalized rectangle in frame pixels, clamped into the composition.
 * @param {import('./model.js').FocusRect | null | undefined} focus
 * @param {number} width
 * @param {number} height
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function focusRect(focus, width, height) {
  const source = focus ?? { x: 0.24, y: 0.2, width: 0.52, height: 0.5 };
  const x = clamp(source.x, 0.015, 0.985);
  const y = clamp(source.y, 0.015, 0.985);
  const w = clamp(source.width, 0.03, 1 - x - 0.005);
  const h = clamp(source.height, 0.03, 1 - y - 0.005);
  return { x: x * width, y: y * height, w: w * width, h: h * height };
}

/**
 * A free area a visual metaphor may occupy without covering body copy or the
 * caption band. Landscape list/hero/chart use the right column; portrait and
 * title layouts use the free lower/upper band. These are deliberately
 * conservative: the shape is a supporting visual, not a second headline.
 * @param {any} scene
 * @param {number} width
 * @param {number} height
 * @returns {Rect}
 */
export function visualArea(scene, width, height) {
  const aspect = aspectOf(width, height);
  const portrait = aspect === '9:16';
  const bottom = captionSafeTop(width, height);
  const layout = scene?.layout;
  const variant = scene?.variant;
  if (portrait) {
    if (layout === 'hero') {
      const y = height * 0.67;
      return { x: width * 0.14, y, w: width * 0.72, h: Math.max(120, Math.min(height * 0.18, bottom - y)) };
    }
    if (layout === 'title' || layout === 'stat') {
      return { x: width * 0.14, y: height * 0.69, w: width * 0.72, h: Math.max(120, Math.min(height * 0.12, bottom - height * 0.69)) };
    }
    if (layout === 'chart') {
      return { x: width * 0.12, y: height * 0.61, w: width * 0.76, h: Math.max(120, Math.min(height * 0.19, bottom - height * 0.61)) };
    }
    return { x: width * 0.12, y: height * 0.69, w: width * 0.76, h: Math.max(120, Math.min(height * 0.13, bottom - height * 0.69)) };
  }
  if (layout === 'list' || (layout === 'hero' && variant !== 'full-bleed') || layout === 'chart') {
    return { x: width * 0.71, y: height * 0.18, w: width * 0.23, h: Math.max(160, Math.min(height * 0.62, bottom - height * 0.18)) };
  }
  if (layout === 'hero' && variant === 'full-bleed') {
    return { x: width * 0.74, y: height * 0.1, w: width * 0.21, h: Math.max(150, Math.min(height * 0.3, bottom - height * 0.1)) };
  }
  if (layout === 'title') {
    return { x: width * 0.72, y: height * 0.08, w: width * 0.23, h: Math.max(140, Math.min(height * 0.3, bottom - height * 0.08)) };
  }
  if (layout === 'stat') {
    return { x: width * 0.79, y: height * 0.22, w: width * 0.16, h: Math.max(150, Math.min(height * 0.52, bottom - height * 0.22)) };
  }
  // split/compare/code keep their plates and code chrome; a small upper-right
  // motif is the least intrusive useful placement.
  return { x: width * 0.78, y: height * 0.08, w: width * 0.18, h: Math.max(120, Math.min(height * 0.22, bottom - height * 0.08)) };
}

/**
 * A square box centred in an area. Used by the morph recipe so the 100x100
 * shape path is scaled uniformly; scaling x and y by the region's independent
 * sides stretched circles into tall/flat ellipses.
 * @param {Rect} area
 * @param {number} [ratio]
 * @param {number} [minSize]
 * @returns {{x:number,y:number,size:number}}
 */
export function centeredSquare(area, ratio = 0.92, minSize = 60) {
  const size = Math.max(minSize, Math.min(area.w, area.h) * clamp(ratio, 0.1, 1));
  return {
    x: area.x + (area.w - size) / 2,
    y: area.y + (area.h - size) / 2,
    size,
  };
}

/**
 * The list rows as they are drawn by ListLayout: headline first, then a flex
 * column with a 22 px gap. Used by sketch cards and paper cards. Bounded to the
 * list text zone so it works at 16:9, 9:16 and 1:1.
 * @param {{scene:any,width:number,height:number,count:number}} options
 * @returns {Array<{x:number,y:number,w:number,h:number,index:number}>}
 */
export function listRowBoxes({ scene, width, height, count }) {
  const aspect = aspectOf(width, height);
  const [zone] = textZones(scene, aspect);
  const items = Math.max(1, count);
  if (!zone) return [];
  const x0 = zone.x0 * width + SAFE_PX.x * 0.06;
  const x1 = zone.x1 * width - SAFE_PX.x * 0.06;
  // ListLayout's rows are the authored 44 px badge/font row, a 22 px gap and a
  // 60 px headline. Deriving these from the same numbers keeps sketch/paper
  // cards on top of the actual editable row instead of drifting down the list.
  const rowH = 44;
  const gap = 22;
  const headline = typeof scene?.copy?.headline === 'string' ? scene.copy.headline : '';
  const availableW = Math.max(120, (zone.x1 - zone.x0) * width);
  const headlineLines = Math.max(1, Math.min(3, Math.ceil((headline.length * 31) / availableW)));
  const headlineBlock = 60 * 1.2 * headlineLines;
  const listGap = 30;
  const startY = SAFE_PX.y + headlineBlock + listGap;
  return Array.from({ length: items }, (_, index) => ({
    x: x0,
    y: startY + index * (rowH + gap),
    w: Math.max(120, x1 - x0),
    h: rowH,
    index,
  }));
}

/**
 * A point inside a rectangle from two deterministic 0..1 random values.
 * @param {Rect} rect
 * @param {number} u
 * @param {number} v
 * @returns {{x:number,y:number}}
 */
export function pointInRect(rect, u, v) {
  return { x: rect.x + clamp(u) * rect.w, y: rect.y + clamp(v) * rect.h };
}

/** @param {Box[]} zones @param {number} x @param {number} y @param {number} [margin] */
export function pointInAnyBox(zones, x, y, margin = 0) {
  return zones.some(box => x > box.x0 - margin && x < box.x1 + margin && y > box.y0 - margin && y < box.y1 + margin);
}

/**
 * Points along a closed ellipse used by the sketch marker and by tests.
 * @param {{cx:number,cy:number,rx:number,ry:number,count?:number,jitter?:number,random?:()=>number,rotation?:number}} options
 * @returns {Array<[number,number]>}
 */
export function ellipsePoints({ cx, cy, rx, ry, count = 28, jitter = 0, random = () => 0.5, rotation = 0 }) {
  const points = [];
  const safeCount = Math.max(8, Math.round(count));
  for (let index = 0; index < safeCount; index += 1) {
    const angle = rotation + (index / safeCount) * Math.PI * 2;
    const wobble = jitter === 0 ? 0 : (random() - 0.5) * 2 * jitter;
    points.push([cx + Math.cos(angle) * rx * (1 + wobble), cy + Math.sin(angle) * ry * (1 + wobble)]);
  }
  return points;
}

/**
 * Straight arrow points with a small hand-drawn bow so perfect-freehand has
 * pressure variation to work with.
 * @param {{x0:number,y0:number,x1:number,y1:number,bow?:number,count?:number}} options
 * @returns {Array<[number,number]>}
 */
export function arrowPoints({ x0, y0, x1, y1, bow = 0.06, count = 16 }) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const points = [];
  const safeCount = Math.max(4, Math.round(count));
  for (let index = 0; index < safeCount; index += 1) {
    const t = index / (safeCount - 1);
    const offset = Math.sin(t * Math.PI) * bow * length;
    const pressure = Math.sin(t * Math.PI);
    points.push([x0 + dx * t + nx * offset, y0 + dy * t + ny * offset, pressure]);
  }
  return points;
}
