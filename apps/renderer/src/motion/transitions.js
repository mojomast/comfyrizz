// MS3 step 1: transition maths.
//
// MS2 put a transition vocabulary in the schema (none/cut/fade/blur/slide/push/wipe/zoom/iris,
// plus a direction). This module turns a 0..1 transition progress into transforms that obey the
// research's "vector law" (RESEARCH_MOTION_SKILLS.md 4.4/4.5): a push moves both scenes the same
// distance along one axis with mirrored easing and a mid-motion cut; a zoom keeps d(scale)/dt the
// same sign on both sides; an iris opens a circle that always covers the whole frame.
//
// Pure functions of progress, no React/Remotion, so the tests run on plain Node and a still is a
// valid frame of the transition.

import { clamp, ease } from './index.js';
import { ANIMATION_REVEAL_TRANSITIONS } from '../../../../packages/schema/src/animation.mjs';

/** MS2 transition types, in schema order. AI2 appends the non-directional reveal family. @type {readonly string[]} */
export const TRANSITION_TYPES = ['none', 'cut', 'fade', 'blur', 'slide', 'push', 'wipe', 'zoom', 'iris', ...ANIMATION_REVEAL_TRANSITIONS];

/** AI2: reveal effects. They reveal the incoming scene and never claim shared identity. */
export const REVEAL_TYPES = [...ANIMATION_REVEAL_TRANSITIONS];

/** Types whose `direction` is an axis. @type {readonly string[]} */
export const DIRECTIONAL_TYPES = ['slide', 'push', 'wipe'];

/** Types whose `direction` is in/out. @type {readonly string[]} */
export const SCALE_TYPES = ['zoom', 'iris'];

/** Energy → seconds range (research 4.5). */
export const ENERGY_TRANSITION_SECONDS = {
  calm: [0.5, 0.8],
  medium: [0.3, 0.5],
  high: [0.15, 0.3],
};

/** Direction → the axis and the sign of the film's motion. */
export const DIRECTION_AXIS = {
  left: { axis: 'x', sign: -1 },
  right: { axis: 'x', sign: 1 },
  up: { axis: 'y', sign: -1 },
  down: { axis: 'y', sign: 1 },
};

export const BLUR_MAX_PX = 14;

/** Seconds a transition lasts at this energy, interpolated between the range's ends. */
export function energyTransitionSeconds(energy = 'medium', position = 0.5) {
  const range = ENERGY_TRANSITION_SECONDS[energy] ?? ENERGY_TRANSITION_SECONDS.medium;
  return range[0] + (range[1] - range[0]) * clamp(position);
}

/** Frames for the same, never below one. */
export function energyTransitionFrames(energy = 'medium', fps = 30, position = 0.5) {
  return Math.max(1, Math.round(energyTransitionSeconds(energy, position) * fps));
}

/**
 * The direction a transition should use. Directional types fall back to the package's
 * `motion.direction` (the film's one current), then to `left`; zoom/iris fall back to `in`.
 */
export function resolvedDirection(type, direction, packageDirection = 'left') {
  if (SCALE_TYPES.includes(type)) return direction === 'out' ? 'out' : 'in';
  if (DIRECTIONAL_TYPES.includes(type)) {
    if (DIRECTION_AXIS[direction]) return direction;
    return DIRECTION_AXIS[packageDirection] ? packageDirection : 'left';
  }
  return null;
}

/** Linear 0..1 progress, clamped. */
export function transitionProgress(frame, durationInFrames) {
  if (!(durationInFrames > 0)) return 1;
  return clamp(frame / durationInFrames);
}

/**
 * Push: both scenes travel together along one axis, rigidly attached. Both halves share one ease
 * (`move`), so the seam between them stays a single moving edge and the incoming scene never
 * slides over the outgoing one: `entering - outgoing` is always exactly one frame width.
 * Offsets are in scene widths/heights.
 * @returns {{ outgoing: {x:number,y:number}, entering: {x:number,y:number}, axis: 'x'|'y' }}
 */
export function pushOffset(progress, direction = 'left') {
  const { axis, sign } = DIRECTION_AXIS[direction] ?? DIRECTION_AXIS.left;
  const t = ease('move', clamp(progress));
  const outgoing = (sign * t) || 0;
  const entering = (-sign * (1 - t)) || 0;
  return axis === 'x'
    ? { outgoing: { x: outgoing, y: 0 }, entering: { x: entering, y: 0 }, axis }
    : { outgoing: { x: 0, y: outgoing }, entering: { x: 0, y: entering }, axis };
}

/**
 * Zoom: both scenes change scale in the same direction. `in` (default) deepens — the outgoing
 * grows past 1 and the entering grows up to 1. `out` reverses it.
 * @returns {{ outgoing: number, entering: number, depth: number }}
 */
export function zoomScales(progress, direction = 'in', depth = 0.12) {
  const t = clamp(progress);
  const amount = depth * ease('move', t);
  if (direction === 'out') {
    return { outgoing: 1 + depth - amount, entering: 1 + depth - amount, depth };
  }
  return { outgoing: 1 + amount, entering: 1 - depth + amount, depth };
}

/**
 * The radius an iris must reach to cover all four corners from its focal point, times `scale`
 * (research 4.5 recommends x1.05). Focal point is in frame fractions.
 */
export function irisRadius(width, height, { focal = { x: 0.5, y: 0.5 }, scale = 1.05 } = {}) {
  const cx = focal.x * width;
  const cy = focal.y * height;
  const corners = [[0, 0], [width, 0], [0, height], [width, height]];
  return Math.max(...corners.map(([x, y]) => Math.hypot(x - cx, y - cy))) * scale;
}

/** A blur peaks at the middle of the transition and is zero at both ends. */
export function blurAmount(progress, max = BLUR_MAX_PX) {
  return max * Math.sin(Math.PI * clamp(progress));
}

/**
 * AI2 paper-reveal: stacked paper strips alternate from the left and right.
 * The path is a union of axis-aligned rectangles; at p=0 every strip has zero
 * width, at p=1 they overlap and cover the whole frame. There is deliberately no
 * `direction` input: a reveal is not a directional push.
 * @param {number} progress
 * @param {number} width
 * @param {number} height
 * @param {{strips?:number,seed?:number}} [options]
 * @returns {{path:string,coverage:number,strips:number}}
 */
export function paperRevealGeometry(progress, width, height, { strips = 7, seed = 7 } = {}) {
  const p = clamp(progress);
  const count = Math.max(3, Math.min(12, Math.round(strips)));
  const stripHeight = height / count;
  const stagger = 0.055;
  const travel = Math.max(0.01, 1 - stagger * (count - 1));
  let total = 0;
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const local = clamp((p - index * stagger) / travel);
    total += local;
    if (local <= 0) continue;
    const x0 = index % 2 === 0 ? 0 : width * (1 - local);
    const x1 = index % 2 === 0 ? width * local : width;
    const y0 = index * stripHeight;
    const y1 = Math.min(height, y0 + stripHeight + 2);
    parts.push(`M${round(x0)},${round(y0)} L${round(x1)},${round(y0)} L${round(x1)},${round(y1)} L${round(x0)},${round(y1)} Z`);
  }
  return { path: parts.join(' ') || 'M0,0 Z', coverage: total / count, strips: count, seed };
}

/**
 * AI2 draw-reveal: a deterministic pencil-edge wipe. The boundary is a jagged
 * diagonal with no axis direction; p=0 starts outside the frame and p=1 finishes
 * beyond it, so both endpoints are exact.
 * @param {number} progress
 * @param {number} width
 * @param {number} height
 * @returns {{path:string,frontTop:number,frontBottom:number,coverage:number}}
 */
export function drawRevealGeometry(progress, width, height) {
  const p = clamp(progress);
  // p=0 -> the whole boundary is left of 0; p=1 -> below/right of the frame.
  const frontTop = -height + p * (width + height * 1.45);
  const frontBottom = frontTop + height * 0.45;
  const steps = 9;
  const amplitude = Math.max(4, width * 0.012);
  const points = [`M0,0`, `L${round(frontTop)},0`];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const y = height * t;
    const baseline = frontTop + (frontBottom - frontTop) * t;
    const tooth = Math.sin(index * 2.17 + 0.8) * amplitude * (index === steps ? 0.3 : 1);
    points.push(`L${round(baseline + tooth)},${round(y)}`);
  }
  points.push(`L0,${round(height)} Z`);
  return { path: points.join(' '), frontTop, frontBottom, coverage: p };
}

/**
 * AI2 shape-reveal: a seeded, gently lobed circle grows from the focal point
 * until it covers every corner. No direction, no shared-element matching.
 * @param {number} progress
 * @param {number} width
 * @param {number} height
 * @param {{focal?:{x:number,y:number},seed?:number}} [options]
 */
export function shapeRevealGeometry(progress, width, height, { focal = { x: 0.5, y: 0.5 }, seed = 3 } = {}) {
  const p = clamp(progress);
  const cx = clamp(focal.x, 0, 1) * width;
  const cy = clamp(focal.y, 0, 1) * height;
  const corners = [[0, 0], [width, 0], [0, height], [width, height]];
  const maxRadius = Math.max(...corners.map(([x, y]) => Math.hypot(x - cx, y - cy))) * 1.06;
  const radius = p * maxRadius;
  const count = 24;
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const wobble = 1 + Math.sin(angle * 5 + seed * 0.37) * 0.025 + Math.sin(angle * 3 - seed * 0.11) * 0.018;
    points.push(`${index === 0 ? 'M' : 'L'}${round(cx + Math.cos(angle) * radius * wobble)},${round(cy + Math.sin(angle) * radius * wobble)}`);
  }
  return { path: `${points.join(' ')} Z`, radius, maxRadius, coverage: p };
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * The pure geometry of one reveal transition, so tests can check endpoints
 * without a browser. `coverage` is 0 at the start and 1 at the end for every
 * type; the path remains finite and bounded.
 * @param {'paper-reveal'|'draw-reveal'|'shape-reveal'|string} type
 * @param {number} progress
 * @param {number} width
 * @param {number} height
 * @param {{seed?:number,focal?:{x:number,y:number}}} [options]
 */
export function revealGeometry(type, progress, width, height, options = {}) {
  if (type === 'paper-reveal') return paperRevealGeometry(progress, width, height, options);
  if (type === 'draw-reveal') return drawRevealGeometry(progress, width, height);
  return shapeRevealGeometry(progress, width, height, options);
}

/** `path()` is supported by the pinned Chromium render target and keeps exact endpoints. */
function revealClipPath(path) {
  return `path('${path}')`;
}

/** Opacity for a crossfade: the outgoing fades out as the entering fades in. */
export function fadeOpacity(progress) {
  const t = clamp(progress);
  return { outgoing: 1 - t, entering: t };
}

/**
 * The whole transition as plain numbers/styles. `kind` names the family so the presentation
 * component only maps numbers to CSS.
 */
export function transitionStyle(type, progress, options = {}) {
  const { width = 1920, height = 1080, packageDirection = 'left', focal, scale } = options;
  const direction = resolvedDirection(type, options.direction, packageDirection);
  switch (type) {
    case 'push':
    case 'slide': {
      const push = pushOffset(progress, direction);
      const distance = push.axis === 'x' ? width : height;
      // slide keeps the outgoing scene still; push moves both (vector law).
      const outgoing = type === 'slide' ? { x: 0, y: 0 } : { x: push.outgoing.x * distance, y: push.outgoing.y * distance };
      return { kind: type, direction, outgoing: { transform: `translate(${outgoing.x}px, ${outgoing.y}px)` }, entering: { transform: `translate(${push.entering.x * distance}px, ${push.entering.y * distance}px)` } };
    }
    case 'zoom': {
      const { outgoing, entering } = zoomScales(progress, direction);
      return { kind: 'zoom', direction, outgoing: { transform: `scale(${outgoing})` }, entering: { transform: `scale(${entering})` } };
    }
    case 'iris': {
      const radius = irisRadius(width, height, { focal, scale }) * clamp(progress);
      return { kind: 'iris', direction, radius, outgoing: {}, entering: { clipPath: `circle(${radius}px at ${(focal?.x ?? 0.5) * 100}% ${(focal?.y ?? 0.5) * 100}%)` } };
    }
    case 'wipe': {
      const t = clamp(progress);
      const rest = (1 - t) * 100;
      const clip = direction === 'right' ? `inset(0 ${rest}% 0 0)`
        : direction === 'up' ? `inset(${rest}% 0 0 0)`
          : direction === 'down' ? `inset(0 0 ${rest}% 0)`
            : `inset(0 0 0 ${rest}%)`;
      return { kind: 'wipe', direction, outgoing: {}, entering: { clipPath: clip } };
    }
    case 'blur': {
      const { outgoing, entering } = fadeOpacity(progress);
      const blur = blurAmount(progress);
      return { kind: 'blur', direction: null, outgoing: { opacity: outgoing, filter: `blur(${blur}px)` }, entering: { opacity: entering, filter: `blur(${blur}px)` } };
    }
    case 'paper-reveal':
    case 'draw-reveal':
    case 'shape-reveal': {
      const geometry = revealGeometry(type, progress, width, height, {
        seed: typeof options.seed === 'number' ? options.seed : 7,
        ...(focal ? { focal } : {}),
      });
      // A reveal owns the incoming side only; the outgoing scene is already
      // covered by the growing incoming mask. No direction field is emitted.
      return {
        kind: type,
        direction: null,
        coverage: geometry.coverage,
        outgoing: {},
        entering: { clipPath: revealClipPath(geometry.path) },
      };
    }
    case 'fade': {
      const { outgoing, entering } = fadeOpacity(progress);
      return { kind: 'fade', direction: null, outgoing: { opacity: outgoing }, entering: { opacity: entering } };
    }
    case 'none':
    case 'cut':
    default:
      return { kind: 'cut', direction: null, outgoing: {}, entering: {} };
  }
}
