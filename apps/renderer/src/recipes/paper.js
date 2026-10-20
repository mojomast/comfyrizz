// AI2: editorial paper-collage geometry.
//
// The plan is a set of layered cut-paper polygons and editable content sheets.
// Nothing is rasterised or regenerated per frame; the React layer only applies
// a small deterministic settle transform. Sheet geometry comes from the same
// layout safe zones as the copy, so the text stays on its own paper instead of
// floating over a random collage.

import { textZones } from '../layout-model.js';
import { SAFE_PX, captionSafeTop, listRowBoxes, visualArea } from './geometry.js';
import { clamp, seededRandom } from './model.js';

/** @param {number} value @param {number} lo @param {number} hi */
function clampRange(value, lo, hi) {
  return clamp(value, lo, hi);
}

/**
 * @typedef {{x:number,y:number,points:Array<[number,number]>,tone:number,opacity:number,shadow:boolean,order:number,rotate:number,tape?:boolean}} PaperShape
 */

/**
 * A torn rectangle polygon. The jitter is deterministic and bounded so the
 * shape cannot wander into another layout zone.
 * @param {{x:number,y:number,w:number,h:number,jitter?:number,random:()=>number}} options
 * @returns {Array<[number,number]>}
 */
export function tornRect({ x, y, w, h, jitter = 4, random }) {
  const edge = Math.max(0, jitter);
  const point = (px, py) => [px + (random() - 0.5) * edge, py + (random() - 0.5) * edge];
  return [
    point(x, y),
    point(x + w * 0.24, y),
    point(x + w * 0.5, y),
    point(x + w * 0.76, y),
    point(x + w, y),
    point(x + w, y + h * 0.3),
    point(x + w, y + h * 0.66),
    point(x + w, y + h),
    point(x + w * 0.7, y + h),
    point(x + w * 0.38, y + h),
    point(x, y + h),
    point(x, y + h * 0.62),
    point(x, y + h * 0.34),
  ];
}

/**
 * @param {{scene:any,width:number,height:number,seed:number,intensity:number}} options
 * @returns {{sheets:PaperShape[],pieces:PaperShape[]}}
 */
export function paperPlan({ scene, width, height, seed, intensity }) {
  const amount = clamp(intensity);
  const random = seededRandom(seed, 23);
  const aspect = height > width ? '9:16' : Math.abs(width / height - 1) < 0.02 ? '1:1' : '16:9';
  const zones = textZones(scene, aspect);
  const [zone] = zones;
  const sheets = [];
  let order = 0;

  /** @param {{x:number,y:number,w:number,h:number,tone:number,opacity:number,rotate:number,tape?:boolean}} spec */
  const sheet = (spec) => {
    sheets.push({
      x: spec.x,
      y: spec.y,
      points: tornRect({ x: spec.x, y: spec.y, w: spec.w, h: spec.h, jitter: 2 + amount * 4, random }),
      tone: spec.tone,
      opacity: spec.opacity,
      shadow: true,
      order: order++,
      rotate: spec.rotate,
      ...(spec.tape ? { tape: true } : {}),
    });
  };

  if (zone) {
    const zw = (zone.x1 - zone.x0) * width;
    const zh = (zone.y1 - zone.y0) * height;
    const zx = zone.x0 * width;
    const zy = zone.y0 * height;
    if (scene?.layout === 'list') {
      const items = Array.isArray(scene?.copy?.items) ? scene.copy.items : [];
      const rows = listRowBoxes({ scene, width, height, count: items.length });
      rows.forEach((row, index) => {
        const inset = 18;
        sheet({
          x: row.x - inset,
          y: row.y - 10,
          w: Math.min(row.w + inset * 2, width - row.x - 20),
          h: row.h + 18,
          tone: index % 2 === 0 ? 1 : 0,
          opacity: 0.86,
          rotate: (index % 2 === 0 ? -1 : 1) * (0.25 + amount * 0.35),
        });
      });
    } else if (scene?.layout === 'title') {
      const w = zw * (0.58 + amount * 0.12);
      const h = Math.max(180, zh * 0.36);
      sheet({
        x: zx + (zw - w) / 2 + 6,
        y: zy + zh * 0.27 + 8,
        w,
        h,
        tone: 0,
        opacity: 0.9,
        rotate: 0.8,
      });
      sheet({ x: zx + (zw - w) / 2, y: zy + zh * 0.27, w, h, tone: 1, opacity: 0.94, rotate: -1.1, tape: true });
    } else if (scene?.layout === 'stat') {
      const w = zw * 0.58;
      const h = Math.max(190, zh * 0.38);
      sheet({ x: zx + zw * 0.03 + 8, y: zy + zh * 0.33 + 7, w, h, tone: 0, opacity: 0.85, rotate: 0.7 });
      sheet({ x: zx + zw * 0.03, y: zy + zh * 0.33, w, h, tone: 1, opacity: 0.92, rotate: -0.6, tape: true });
    } else if (scene?.layout === 'hero' || scene?.layout === 'chart') {
      const portrait = height > width;
      if (portrait && scene?.layout === 'hero') {
        // The portrait hero stacks copy at the top. Put the sheet behind that
        // copy block (headline + sub + body), not in the empty media band below.
        const w = zw * 0.86;
        const h = Math.max(220, Math.min(zh * 0.56, height * 0.32));
        const x = zx + (zw - w) / 2 + 8;
        const y = Math.max(SAFE_PX.y, zy + zh * 0.06) + 8;
        sheet({ x, y, w, h, tone: 0, opacity: 0.82, rotate: 0.9 });
        sheet({ x: x - 10, y: y - 6, w, h, tone: 1, opacity: 0.9, rotate: -0.7, tape: true });
      } else {
        const split = scene?.layout === 'hero' && scene?.variant !== 'full-bleed';
        const w = zw * (split ? 0.7 : 0.62);
        const h = Math.max(170, zh * 0.3);
        const x = split ? zx + 10 : zx + (zw - w) / 2 + 10;
        const y = zy + zh * 0.28 + 6;
        sheet({ x, y, w, h, tone: 0, opacity: 0.82, rotate: 0.9 });
        sheet({ x: x - 10, y: y - 6, w, h, tone: 1, opacity: 0.9, rotate: -0.7, tape: true });
      }
    } else if (scene?.layout === 'split' || scene?.layout === 'compare') {
      // Top headline sits on a short paper strip; each plate label gets a small
      // torn paper tab. The plate media itself stays fully visible.
      const topW = zw * 0.52;
      const topH = Math.max(110, zh * 0.42);
      sheet({ x: zx + (zw - topW) / 2 + 8, y: zy + zh * 0.1 + 7, w: topW, h: topH, tone: 0, opacity: 0.8, rotate: 0.7 });
      sheet({ x: zx + (zw - topW) / 2, y: zy + zh * 0.1, w: topW, h: topH, tone: 1, opacity: 0.86, rotate: -0.5, tape: true });
      zones.slice(1).forEach((labelZone, index) => {
        const lw = (labelZone.x1 - labelZone.x0) * width * 0.7;
        const lh = Math.max(84, (labelZone.y1 - labelZone.y0) * height * 0.34);
        sheet({
          x: labelZone.x0 * width + lw * 0.12,
          y: labelZone.y0 * height + (labelZone.y1 - labelZone.y0) * height * 0.28,
          w: lw,
          h: lh,
          tone: index % 2 === 0 ? 1 : 0,
          opacity: 0.72,
          rotate: index % 2 === 0 ? -0.5 : 0.5,
        });
      });
    }
  }

  // Margin pieces: choose bands that do not intersect a text zone. The center
  // of a piece is tested rather than all vertices, then the band is small
  // enough that the remaining edge cannot reach a headline.
  const bottom = captionSafeTop(width, height);
  const bands = [
    { x: width * 0.005, y: height * 0.01, w: width * 0.105, h: height * 0.09 },
    { x: width * 0.885, y: height * 0.02, w: width * 0.11, h: height * 0.1 },
    { x: width * 0.01, y: bottom - height * 0.09, w: width * 0.12, h: height * 0.075 },
    { x: width * 0.875, y: bottom - height * 0.11, w: width * 0.12, h: height * 0.09 },
    { x: width * 0.055, y: height * 0.015, w: width * 0.13, h: height * 0.06 },
    { x: width * 0.82, y: bottom - height * 0.075, w: width * 0.16, h: height * 0.06 },
  ];
  const pieces = [];
  const count = 3 + Math.round(amount * 5);
  for (let index = 0; index < count; index += 1) {
    const band = bands[index % bands.length];
    const cx = (band.x + band.w / 2) / width;
    const cy = (band.y + band.h / 2) / height;
    const collides = zones.some(zoneBox => cx > zoneBox.x0 - 0.02 && cx < zoneBox.x1 + 0.02 && cy > zoneBox.y0 - 0.02 && cy < zoneBox.y1 + 0.02);
    if (collides) continue;
    const jitter = 5 + amount * 9;
    const points = tornRect({ x: band.x, y: band.y, w: band.w, h: band.h, jitter, random });
    const rotated = rotatePoints(points, (random() - 0.5) * 12, band.x + band.w / 2, band.y + band.h / 2);
    pieces.push({
      x: band.x,
      y: band.y,
      points: rotated,
      tone: 1 + (index % 3),
      opacity: 0.38 + amount * 0.3,
      shadow: true,
      order: order++,
      rotate: (random() - 0.5) * 4,
    });
  }
  return { sheets, pieces };
}

/**
 * @param {Array<[number,number]>} points
 * @param {number} degrees
 * @param {number} cx
 * @param {number} cy
 * @returns {Array<[number,number]>}
 */
export function rotatePoints(points, degrees, cx, cy) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return points.map(([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]);
}

/** A polygon `points` attribute for SVG. */
export function polygonPoints(points) {
  return points.map(([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`).join(' ');
}

/** Deterministic settle target for one sheet/piece: no frame clock. */
export function paperSettle(progress, order) {
  const t = clampRange((progress - order * 0.035) / 0.82, 0, 1);
  const eased = 1 - (1 - t) ** 3;
  return {
    opacity: 0.72 + eased * 0.28,
    dx: (1 - eased) * (order % 2 === 0 ? -18 : 18),
    dy: (1 - eased) * 12,
  };
}

export { visualArea };
