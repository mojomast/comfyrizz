// AI2: evidence-led focus geometry.
//
// The spotlight is a reveal frame, not a crop: the source image stays fully
// visible inside the focus rect while the surrounding frame receives a bounded
// scrim. The rect is normalized and clamped to the native composition, with a
// corner bracket size derived from the short side so portrait and square frames
// do not inherit a 1080-only value.

import { clamp } from './model.js';
import { focusRect } from './geometry.js';

/**
 * @param {{focus?:import('./model.js').FocusRect|null,width:number,height:number,intensity?:number,seed?:number}} options
 */
export function focusGeometry({ focus, width, height, intensity = 0.6, seed = 1 }) {
  const rect = focusRect(focus, width, height);
  const short = Math.min(width, height);
  const amount = clamp(intensity);
  const corner = Math.max(18, Math.round(short * (0.035 + amount * 0.025)));
  const margin = Math.max(2, Math.round(short * 0.003));
  const x = Math.max(margin, rect.x);
  const y = Math.max(margin, rect.y);
  const w = Math.max(24, Math.min(rect.w, width - margin - x));
  const h = Math.max(24, Math.min(rect.h, height - margin - y));
  const dim = 0.2 + amount * 0.28;
  return {
    rect: { x, y, w, h },
    corner,
    strokeWidth: Math.max(2, Math.round(short * 0.0045)),
    radius: Math.round(short * 0.018),
    dim,
    seed,
    /** A donut path: the frame is filled around, the focus rectangle is a hole. */
    path: `M0,0 H${round(width)} V${round(height)} H0 Z M${round(x)},${round(y)} H${round(x + w)} V${round(y + h)} H${round(x)} Z`,
    innerPath: `M${round(x)},${round(y)} H${round(x + w)} V${round(y + h)} H${round(x)} Z`,
  };
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Corner brackets (not a closed card) so the evidence inside remains readable
 * and the frame reads as an annotation rather than a new panel.
 * @param {ReturnType<typeof focusGeometry>} geometry
 * @returns {string[]}
 */
export function cornerBrackets(geometry) {
  const { rect, corner } = geometry;
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  return [
    `M${round(x0)},${round(y0 + corner)} L${round(x0)},${round(y0)} L${round(x0 + corner)},${round(y0)}`,
    `M${round(x1 - corner)},${round(y0)} L${round(x1)},${round(y0)} L${round(x1)},${round(y0 + corner)}`,
    `M${round(x0)},${round(y1 - corner)} L${round(x0)},${round(y1)} L${round(x0 + corner)},${round(y1)}`,
    `M${round(x1 - corner)},${round(y1)} L${round(x1)},${round(y1)} L${round(x1)},${round(y1 - corner)}`,
  ];
}

/**
 * Deterministic entry progress: the frame expands from 1.12 to 1 and the scrim
 * fades in. No pulsing wall-clock animation.
 * @param {{frame:number,fps?:number}} options
 */
export function focusEntry({ frame, fps = 30 }) {
  const duration = Math.max(8, Math.round(fps * 0.55));
  const t = clamp(frame / duration);
  const eased = 1 - (1 - t) ** 3;
  return { opacity: eased, scale: 1.12 - eased * 0.12 };
}
