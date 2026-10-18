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

/** MS2 transition types, in schema order. @type {readonly string[]} */
export const TRANSITION_TYPES = ['none', 'cut', 'fade', 'blur', 'slide', 'push', 'wipe', 'zoom', 'iris'];

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
 * Push: both scenes travel the same distance along one axis. The outgoing scene accelerates
 * away (`exit` ease) and the entering scene decelerates in (`enter` ease), so the two halves are
 * mirrors and the cross-over lands mid-motion. Offsets are in scene widths/heights.
 * @returns {{ outgoing: {x:number,y:number}, entering: {x:number,y:number}, axis: 'x'|'y' }}
 */
export function pushOffset(progress, direction = 'left') {
  const { axis, sign } = DIRECTION_AXIS[direction] ?? DIRECTION_AXIS.left;
  const t = clamp(progress);
  const outgoing = (sign * ease('exit', t)) || 0;
  const entering = (-sign * (1 - ease('enter', t))) || 0;
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
