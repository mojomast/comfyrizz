// AI2: bounded shape morphing with Flubber 0.4.2.
//
// Shape pairs are cached outside React. Flubber is given a bounded
// `maxSegmentLength`, so a complex blob cannot explode the path budget or the
// per-frame work. Every path lives in a 100x100 local viewBox; the React layer
// scales it to the recipe's free area. No axis direction is involved: this is a
// visual metaphor, not a shared-element transition.

import * as flubberModule from 'flubber';
import { ease } from '../motion/index.js';
import { clamp, MORPH_SHAPES, normalizeMorph, recipeWindow, seededRandom } from './model.js';

// Flubber's package is CommonJS-first (Node) but exposes an ESM module entry for
// bundlers. Resolve both shapes without a static default-export import, which
// would warn/fail when the browser bundle picks the ESM entry.
const flubberModuleRecord = flubberModule;
const flubberDefault = Reflect.get(flubberModuleRecord, 'default');
const flubber = flubberDefault && typeof flubberDefault === 'object' ? flubberDefault : flubberModuleRecord;
const interpolate = flubber.interpolate ?? Reflect.get(flubberModuleRecord, 'interpolate');
if (typeof interpolate !== 'function') {
  throw new Error('flubber: interpolate is unavailable; expected the ESM named export or the CommonJS default');
}

const INTERPOLATOR_CACHE = new Map();
const MAX_CACHE = 48;
/** Bounded subdivision; a smaller value means more segments (and more work). */
export const MORPH_MAX_SEGMENT_LENGTH = 2.5;

/**
 * Closed Catmull-Rom spline through points, expressed as cubic Béziers.
 * @param {Array<[number,number]>} points
 * @returns {string}
 */
export function smoothClosedPath(points) {
  const count = points.length;
  if (count < 3) return '';
  const point = (index) => points[((index % count) + count) % count];
  let d = `M${round(point(0)[0])},${round(point(0)[1])}`;
  for (let index = 0; index < count; index += 1) {
    const p0 = point(index - 1);
    const p1 = point(index);
    const p2 = point(index + 1);
    const p3 = point(index + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${round(c1[0])},${round(c1[1])} ${round(c2[0])},${round(c2[1])} ${round(p2[0])},${round(p2[1])}`;
  }
  return `${d} Z`;
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * A normalized shape path in a 100x100 box. `blob` is seeded, so the same scene
 * always gets the same organic target; other shapes are canonical.
 * @param {string} shape
 * @param {number} [seed]
 * @returns {string}
 */
export function shapePath(shape, seed = 1) {
  if (shape === 'square') return 'M8,8 L92,8 L92,92 L8,92 Z';
  if (shape === 'triangle') return 'M50,6 L94,92 L6,92 Z';
  if (shape === 'blob') {
    const random = seededRandom(seed, 71);
    const points = Array.from({ length: 9 }, (_, index) => {
      const angle = (index / 9) * Math.PI * 2 - Math.PI / 2;
      const radius = 32 + random() * 13;
      return [50 + Math.cos(angle) * radius, 50 + Math.sin(angle) * radius];
    });
    return smoothClosedPath(points);
  }
  // A smooth 12-point circle. Explicit Bézier/curve points are friendlier to
  // Flubber than SVG arc shorthand, which some path parsers reject.
  const random = seededRandom(seed, 3);
  const points = Array.from({ length: 12 }, (_, index) => {
    const angle = (index / 12) * Math.PI * 2;
    return [50 + Math.cos(angle) * (44 + (random() - 0.5) * 0.2), 50 + Math.sin(angle) * (44 + (random() - 0.5) * 0.2)];
  });
  return smoothClosedPath(points);
}

/**
 * @param {{from:string,to:string,seed?:number,maxSegmentLength?:number}} options
 * @returns {(t:number) => string}
 */
export function morphInterpolator({ from, to, seed = 1, maxSegmentLength = MORPH_MAX_SEGMENT_LENGTH }) {
  const spec = normalizeMorph({ from, to });
  const segment = clamp(maxSegmentLength, 0.8, 8);
  const key = `${spec.from}>${spec.to}:${seed}:${segment}`;
  const cached = INTERPOLATOR_CACHE.get(key);
  if (cached) return cached;
  const fromPath = shapePath(spec.from, seed);
  const toPath = shapePath(spec.to, seed + 977);
  let fn;
  try {
    fn = interpolate(fromPath, toPath, { maxSegmentLength: segment });
  } catch {
    // A degenerate path (same colour/shape, parser edge case) falls back to a
    // clean crossfade of the two canonical paths rather than throwing a frame.
    fn = (t) => (t < 0.5 ? fromPath : toPath);
  }
  if (INTERPOLATOR_CACHE.size >= MAX_CACHE) INTERPOLATOR_CACHE.clear();
  INTERPOLATOR_CACHE.set(key, fn);
  return fn;
}

/**
 * The shape path at a frame's progress. `progress` is eased (`move`), so the
 * transformation has an arrival and a hold rather than a linear crawl.
 * @param {{from:string,to:string,seed?:number,progress?:number,maxSegmentLength?:number}} options
 * @returns {{d:string,fromPath:string,toPath:string,progress:number}}
 */
export function morphAt({ from, to, seed = 1, progress = 0, maxSegmentLength = MORPH_MAX_SEGMENT_LENGTH }) {
  const spec = normalizeMorph({ from, to });
  const t = clamp(progress);
  const fn = morphInterpolator({ ...spec, seed, maxSegmentLength });
  return {
    d: fn(ease('move', t)),
    fromPath: shapePath(spec.from, seed),
    toPath: shapePath(spec.to, seed + 977),
    progress: t,
  };
}

/**
 * The speech-anchored morph window. Two cues mark start and end; one cue marks
 * the start; none uses a bounded fraction of the scene.
 * @param {{frame:number,fps:number,sceneFrames:number,cues?:number[]}} options
 */
export function morphTimeline({ frame, fps, sceneFrames, cues = [] }) {
  const window = recipeWindow({ frame, fps, sceneFrames, cues, startFraction: 0.1, endFraction: 0.68, holdSeconds: 0.8 });
  return { ...window, progress: ease('move', window.progress) };
}

/** Test/diagnostic hook: number of cached Flubber interpolators. */
export function morphCacheSize() {
  return INTERPOLATOR_CACHE.size;
}

export { MORPH_SHAPES };

/**
 * The local 100x100 path string is scaled by the renderer. This helper gives a
 * quick bound for tests and for choosing a stroke width in native pixels.
 * @param {string} path
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}}
 */
export function pathBounds(path) {
  const numbers = String(path).match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const xs = [];
  const ys = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    xs.push(numbers[index]);
    ys.push(numbers[index + 1]);
  }
  if (xs.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
