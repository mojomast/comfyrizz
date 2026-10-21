// AI2: seeded sketch annotations (Rough.js 4.6.6 + perfect-freehand 1.2.3).
//
// The recipe draws editable content's outline, never baked text: annotations
// are positioned from the same safe zones and list rows as the layout, so the
// copy remains the source of truth. Path generation is cached by geometry and
// seed; frame changes only move stroke dash offsets, so stills and out-of-order
// frames are deterministic.

import * as roughModule from 'roughjs';
import { getStroke } from 'perfect-freehand';
import { textZones } from '../layout-model.js';
import { arrowPoints, ellipsePoints, listRowBoxes, pointInAnyBox } from './geometry.js';
import { clamp, seededRandom } from './model.js';

const rough = /** @type {any} */ (roughModule).default ?? roughModule;
const generator = rough.generator();

const PATH_CACHE = new Map();
const MAX_CACHE = 64;

/**
 * @typedef {Object} SketchAnnotation
 * @property {'ellipse'|'rect'|'line'|'marker'|'arrow'|'check'} shape
 * @property {number} order
 * @property {number} seed
 * @property {number} [cx]
 * @property {number} [cy]
 * @property {number} [rx]
 * @property {number} [ry]
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [w]
 * @property {number} [h]
 * @property {number} [x1]
 * @property {number} [y1]
 * @property {number} [x2]
 * @property {number} [y2]
 * @property {Array<[number,number,number?]>} [points]
 * @property {number} [weight]
 * @property {number} [startFrame]
 */

/**
 * @param {any} scene
 * @param {number} width
 * @param {number} height
 * @param {number} seed
 * @param {number} intensity
 * @param {number[]} [cueFrames] planner-resolved scene-local frames for list rows
 * @returns {SketchAnnotation[]}
 */
export function sketchAnnotations(scene, width, height, seed, intensity, cueFrames = []) {
  const amount = clamp(intensity);
  const baseSeed = Math.floor(seed) % 2147483000;
  const random = seededRandom(seed, 11);
  const aspect = height > width ? '9:16' : Math.abs(width / height - 1) < 0.02 ? '1:1' : '16:9';
  const zones = textZones(scene, aspect);
  const [zone] = zones;
  if (!zone) return [];
  const annotations = [];
  let order = 0;
  const push = (/** @type {Partial<SketchAnnotation>} */ annotation) => {
    annotations.push({ shape: 'line', order: order++, seed: (baseSeed + order * 7919) % 2147483647, ...annotation });
  };
  const style = { weight: 2.4 + amount * 2.2 };
  const headline = typeof scene?.copy?.headline === 'string' ? scene.copy.headline : '';

  if (scene?.layout === 'list') {
    const items = Array.isArray(scene?.copy?.items) ? scene.copy.items : [];
    const rows = listRowBoxes({ scene, width, height, count: items.length });
    rows.forEach((row, index) => {
      push({ shape: 'rect', x: row.x - 16, y: row.y - 8, w: row.w + 24, h: row.h + 12, ...style, startFrame: cueFrames[index] ?? 0 });
      // Perfect-freehand tick beside the editable row.
      const tickX = row.x - 46;
      const tickY = row.y + row.h / 2;
      push({
        shape: 'check',
        points: [
          [tickX - 13, tickY],
          [tickX - 3, tickY + 11],
          [tickX + 17, tickY - 14],
        ],
        weight: 4 + amount * 2,
        seed: (baseSeed + index * 131) % 2147483647,
        startFrame: cueFrames[index] ?? 0,
      });
    });
    if (rows.length > 0) {
      push({
        shape: 'arrow',
        points: arrowPoints({
          x0: rows[0].x + rows[0].w * 0.58,
          y0: rows[0].y - Math.max(22, height * 0.022),
          x1: rows[0].x + rows[0].w * 0.12,
          y1: rows[0].y + 4,
          bow: 0.04,
          count: 10,
        }),
        weight: 3 + amount * 1.6,
        startFrame: cueFrames[0] ?? 0,
      });
    }
    return annotations;
  }

  // A hand-drawn emphasis ring around the headline's actual safe zone. The
  // ring is wide and shallow so it reads as annotation, not a second card.
  if (scene?.layout === 'title' || scene?.layout === 'hero' || scene?.layout === 'stat') {
    const isStat = scene?.layout === 'stat';
    const boxW = zone.x1 - zone.x0;
    const boxH = zone.y1 - zone.y0;
    const rx = width * (isStat ? boxW * 0.25 : boxW * 0.33);
    const ry = height * (isStat ? boxH * 0.22 : boxH * 0.24);
    const cx = width * (isStat ? zone.x0 + boxW * 0.31 : (zone.x0 + zone.x1) / 2);
    const cy = height * (isStat ? zone.y0 + boxH * 0.45 : zone.y0 + boxH * 0.43);
    push({ shape: 'ellipse', cx, cy, rx, ry, ...style, seed: (baseSeed + 17) % 2147483647, startFrame: cueFrames[0] ?? 0 });
    if (headline.length > 0) {
      push({
        shape: 'arrow',
        points: arrowPoints({
          x0: Math.max(SAFE_LEFT(width), cx - rx - width * 0.16),
          y0: cy - ry - height * 0.045,
          x1: cx - rx * 0.86,
          y1: cy - ry * 0.42,
          bow: 0.09,
          count: 12,
        }),
        weight: 3.2 + amount * 1.4,
      });
    }
  } else if (scene?.layout === 'chart') {
    const baseline = height * Math.min(0.2, zone.y0 + 0.13);
    push({
      shape: 'line',
      x1: width * 0.08,
      y1: baseline,
      x2: width * 0.5,
      y2: baseline + height * 0.006,
      ...style,
      seed: (baseSeed + 31) % 2147483647,
    });
    push({
      shape: 'arrow',
      points: arrowPoints({
        x0: width * 0.11,
        y0: height * 0.3,
        x1: width * 0.24,
        y1: height * 0.42,
        bow: 0.05,
        count: 10,
      }),
      weight: 3 + amount * 1.4,
    });
  } else if (scene?.layout === 'split' || scene?.layout === 'compare') {
    push({
      shape: 'line',
      x1: width * 0.2,
      y1: height * 0.2,
      x2: width * 0.8,
      y2: height * 0.205,
      ...style,
      seed: (baseSeed + 43) % 2147483647,
    });
  } else if (scene?.layout === 'code') {
    // Outline the code card from outside its own border; never draw over the
    // monospace lines, which are already the focal point.
    const boxW = (zone.x1 - zone.x0) * width;
    const boxH = (zone.y1 - zone.y0) * height;
    push({
      shape: 'rect',
      x: zone.x0 * width - 10,
      y: zone.y0 * height - 10,
      w: boxW + 20,
      h: boxH + 20,
      ...style,
      seed: (baseSeed + 53) % 2147483647,
    });
  }

  // A few small margin marks keep the sketch language present even when the
  // main layout is mostly media. They avoid every text zone.
  const marks = 2 + Math.round(amount * 3);
  const normalizedZones = zones;
  for (let index = 0; index < marks; index += 1) {
    let x = 0;
    let y = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      x = 0.03 + random() * 0.94;
      y = 0.05 + random() * 0.8;
      if (!pointInAnyBox(normalizedZones, x, y, 0.03)) break;
    }
    if (pointInAnyBox(normalizedZones, x, y, 0.01)) continue;
    push({
      shape: 'marker',
      points: ellipsePoints({
        cx: x * width,
        cy: y * height,
        rx: 12 + random() * 16,
        ry: 8 + random() * 10,
        count: 18,
        jitter: 0.22,
        random,
        rotation: random() * Math.PI,
      }),
      weight: 2 + amount * 1.2,
      seed: (baseSeed + 101 + index * 37) % 2147483647,
    });
  }
  return annotations;
}

/** @param {number} width */
function SAFE_LEFT(width) {
  return width * 0.04;
}

/**
 * Convert perfect-freehand outline points to an SVG path.
 * @param {Array<[number,number]>} points
 * @returns {string}
 */
export function strokeOutlinePath(points) {
  if (!Array.isArray(points) || points.length === 0) return '';
  return points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${round(x)},${round(y)}`)
    .join(' ') + ' Z';
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Build concrete SVG paths for the annotations. Cached because Rough.js path
 * generation is the only expensive part and the geometry is frame-independent.
 * @param {SketchAnnotation[]} annotations
 * @param {{stroke:string, accent:string, fill:string}} colors
 * @returns {Array<{d:string, stroke:string, strokeWidth:number, fill:string, order:number, startFrame:number|null, shape:string, draw:boolean}>}
 */
export function sketchPaths(annotations, colors) {
  const key = JSON.stringify({
    annotations: annotations.map(item => [item.shape, item.cx, item.cy, item.rx, item.ry, item.x, item.y, item.w, item.h, item.x1, item.y1, item.x2, item.y2, item.weight, item.seed, item.startFrame, item.points]),
    colors,
  });
  const cached = PATH_CACHE.get(key);
  if (cached) return cached;
  const paths = [];
  const quantity = 0.8;
  for (const annotation of annotations) {
    const options = {
      seed: annotation.seed % 2147483647,
      stroke: colors.stroke,
      strokeWidth: annotation.weight ?? 3,
      roughness: quantity * 1.7,
      bowing: quantity * 1.2,
      preserveVertices: false,
    };
    if (annotation.shape === 'ellipse' && annotation.cx !== undefined) {
      const drawable = generator.ellipse(annotation.cx, annotation.cy, (annotation.rx ?? 0) * 2, (annotation.ry ?? 0) * 2, options);
      for (const path of generator.toPaths(drawable)) {
        paths.push({ d: path.d, stroke: path.stroke || colors.stroke, strokeWidth: path.strokeWidth || options.strokeWidth, fill: path.fill ?? 'none', order: annotation.order, startFrame: annotation.startFrame ?? null, shape: 'ellipse', draw: true });
      }
    } else if (annotation.shape === 'rect') {
      const drawable = generator.rectangle(annotation.x ?? 0, annotation.y ?? 0, annotation.w ?? 0, annotation.h ?? 0, { ...options, roughness: quantity * 1.2 });
      for (const path of generator.toPaths(drawable)) {
        paths.push({ d: path.d, stroke: path.stroke || colors.stroke, strokeWidth: path.strokeWidth || options.strokeWidth, fill: path.fill ?? 'none', order: annotation.order, startFrame: annotation.startFrame ?? null, shape: 'rect', draw: true });
      }
    } else if (annotation.shape === 'line') {
      const drawable = generator.line(annotation.x1 ?? 0, annotation.y1 ?? 0, annotation.x2 ?? 0, annotation.y2 ?? 0, options);
      for (const path of generator.toPaths(drawable)) {
        paths.push({ d: path.d, stroke: path.stroke || colors.stroke, strokeWidth: path.strokeWidth || options.strokeWidth, fill: path.fill ?? 'none', order: annotation.order, startFrame: annotation.startFrame ?? null, shape: 'line', draw: true });
      }
    } else if (annotation.shape === 'marker' || annotation.shape === 'arrow' || annotation.shape === 'check') {
      const points = annotation.points ?? [];
      const outline = getStroke(points, {
        size: annotation.weight ?? 3,
        thinning: 0.55,
        smoothing: 0.55,
        streamline: 0.42,
        simulatePressure: false,
        last: true,
      });
      paths.push({
        d: strokeOutlinePath(outline.map(([x, y]) => [x, y])),
        stroke: colors.accent,
        strokeWidth: 1,
        fill: colors.accent,
        order: annotation.order,
        startFrame: annotation.startFrame ?? null,
        shape: annotation.shape,
        draw: false,
      });
      if (annotation.shape === 'arrow' && points.length >= 2) {
        const tip = points[points.length - 1];
        const previous = points[Math.max(0, points.length - 3)];
        const angle = Math.atan2(tip[1] - previous[1], tip[0] - previous[0]);
        const size = 14 + amountOf(annotation) * 8;
        for (const turn of [-1, 1]) {
          const x = tip[0] - Math.cos(angle + turn * 0.55) * size;
          const y = tip[1] - Math.sin(angle + turn * 0.55) * size;
          const drawable = generator.line(tip[0], tip[1], x, y, { ...options, stroke: colors.accent, seed: (annotation.seed + turn + 17) % 2147483647 });
          for (const path of generator.toPaths(drawable)) {
            paths.push({ d: path.d, stroke: path.stroke || colors.accent, strokeWidth: path.strokeWidth || 3, fill: path.fill ?? 'none', order: annotation.order, startFrame: annotation.startFrame ?? null, shape: 'arrow', draw: true });
          }
        }
      }
    }
  }
  paths.sort((a, b) => a.order - b.order);
  if (PATH_CACHE.size >= MAX_CACHE) PATH_CACHE.clear();
  PATH_CACHE.set(key, paths);
  return paths;
}

/** @param {SketchAnnotation} annotation */
function amountOf(annotation) {
  return clamp(((annotation.weight ?? 2) - 2) / 4);
}

/** Test/diagnostic hook: number of cached sketch path sets. */
export function sketchCacheSize() {
  return PATH_CACHE.size;
}
