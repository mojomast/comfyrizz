// MS1: motion tokens + pure timing helpers.
//
// The numbers (easing control points, spring damping/stiffness/mass, stagger and duration
// guidance) are re-expressed from `whaleyxbt/claude-motion` (MIT, Copyright (c) 2026
// whaleyxbt) and the HyperFrames motion skills (Apache-2.0, Copyright HeyGen), as read in
// research/RESEARCH_MOTION_SKILLS.md sections 4.1, 4.2 and 4.4. No code was copied.
//
// Everything here is a pure function of the frame: the same frame always gives the same
// numbers, so a render is reproducible and a still is a valid preview of it. No React, no
// Remotion import, so the tests run on plain Node.
//
// Remotion's `Easing.bezier(...)` takes the same four control points, and `spring()` takes the
// same damping/stiffness/mass, so the TSX side can use these tokens directly.

/**
 * Named ease tokens. `linear` is only for motion that is genuinely continuous (rotation,
 * background drift, grain) — never for an entrance.
 * @type {Record<'enter'|'exit'|'move'|'land'|'linear', [number, number, number, number]>}
 */
export const EASING_TOKENS = {
  enter: [0.16, 1, 0.3, 1],
  exit: [0.6, 0, 0.9, 0.35],
  move: [0.65, 0, 0.35, 1],
  land: [0.55, 0, 0.2, 1.12],
  linear: [0, 0, 1, 1],
};

/**
 * Spring presets as (damping, stiffness, mass). `elastic` is an accent: at most once per video.
 * @type {Record<'settle'|'heavy'|'snap'|'pop'|'elastic', {damping:number, stiffness:number, mass:number}>}
 */
export const SPRING_PRESETS = {
  settle: { damping: 14, stiffness: 140, mass: 0.8 },
  heavy: { damping: 18, stiffness: 200, mass: 0.8 },
  snap: { damping: 12, stiffness: 190, mass: 0.75 },
  pop: { damping: 10, stiffness: 215, mass: 0.7 },
  elastic: { damping: 8, stiffness: 200, mass: 0.7 },
};

/** Total stagger of a group is capped here (research 4.2): 8+ items tighten instead of crawling. */
export const MAX_STAGGER_SECONDS = 0.5;

/** An exit is fast: 50–75% of its entry's duration (research 4.2). */
export const MIN_EXIT_RATIO = 0.5;
export const MAX_EXIT_RATIO = 0.75;
export const DEFAULT_EXIT_RATIO = 0.6;

/** Per-family cadence (research 4.2). Seconds. */
export const STAGGER_SECONDS = {
  word: 0.09,
  listItem: 0.22,
  dot: 0.06,
};

/**
 * Energy profiles scale entries and stagger without changing the vocabulary. `medium` is the
 * default; MS2 reads a package/scene `motion.energy` into this.
 * @type {Record<'calm'|'medium'|'high', {entryScale:number, staggerScale:number, distanceScale:number}>}
 */
export const ENERGY_PROFILES = {
  calm: { entryScale: 1.2, staggerScale: 1.15, distanceScale: 0.8 },
  medium: { entryScale: 1, staggerScale: 1, distanceScale: 1 },
  high: { entryScale: 0.8, staggerScale: 0.75, distanceScale: 1.2 },
};

/** @param {string} name @returns {{entryScale:number, staggerScale:number, distanceScale:number}} */
export function energyProfile(name = 'medium') {
  return ENERGY_PROFILES[name] ?? ENERGY_PROFILES.medium;
}

/** @param {number} value @param {number} [lo] @param {number} [hi] */
export function clamp(value, lo = 0, hi = 1) {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * A cubic Bézier easing curve, solved for y at a given x. Same shape as CSS
 * `cubic-bezier(x1, y1, x2, y2)` and Remotion's `Easing.bezier(x1, y1, x2, y2)`.
 * @returns {(x: number) => number}
 */
export function cubicBezier(x1, y1, x2, y2) {
  const curveX = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t ** 2 * (1 - t) + t ** 3;
  const curveY = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t ** 2 * (1 - t) + t ** 3;
  const slopeX = (t) => 3 * x1 * (1 - 4 * t + 3 * t * t) + 3 * x2 * (2 * t - 3 * t * t) + 3 * t * t;

  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton first (fast near the ends), then bisection so a flat slope can never diverge.
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const dx = curveX(t) - x;
      if (Math.abs(dx) < 1e-6) return curveY(t);
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i += 1) {
      const value = curveX(t);
      if (Math.abs(value - x) < 1e-7) break;
      if (value < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return curveY(t);
  };
}

const EASING_FNS = Object.fromEntries(Object.entries(EASING_TOKENS).map(([name, points]) => [name, cubicBezier(...points)]));

/** @param {keyof typeof EASING_TOKENS} name @param {number} t */
export function ease(name, t) {
  const fn = EASING_FNS[name] ?? EASING_FNS.linear;
  return fn(t);
}

/**
 * Progress of `frame` across a window `[start, start+duration]`, with an ease token applied.
 * `prog(t, t0, t1, easeName)` in the board spec: frames in, 0..1 out, clamped at both ends.
 * @param {number} frame @param {number} start @param {number} duration @param {keyof typeof EASING_TOKENS} [easeName]
 */
export function prog(frame, start, duration, easeName = 'linear') {
  if (duration <= 0) return frame >= start ? 1 : 0;
  return ease(easeName, clamp((frame - start) / duration));
}

/**
 * Delay in frames for the `index`-th element of a staggered group. The total is capped at
 * `maxTotalSeconds` (default 0.5 s) so a long list never crawls.
 * @param {number} index @param {number} stepSeconds @param {number} fps @param {number} [maxTotalSeconds]
 */
export function staggerFrames(index, stepSeconds, fps, maxTotalSeconds = MAX_STAGGER_SECONDS) {
  const step = Math.max(0, stepSeconds) * fps;
  const cap = Math.max(0, maxTotalSeconds) * fps;
  return Math.min(Math.max(0, index) * step, cap);
}

/** Index of the last element whose stagger delay is below the cap (for tests and tightening). */
export function staggerWithinCap(count, stepSeconds, fps, maxTotalSeconds = MAX_STAGGER_SECONDS) {
  const cap = maxTotalSeconds * fps;
  const step = Math.max(0, stepSeconds) * fps;
  if (step === 0) return Math.max(0, count);
  return Math.min(Math.max(0, count), Math.floor(cap / step) + 1);
}

/**
 * Exit duration for a given entry duration, clamped to 50–75% (research 4.2).
 * @param {number} entryDuration @param {number} [ratio]
 */
export function exitDuration(entryDuration, ratio = DEFAULT_EXIT_RATIO) {
  return Math.max(1, entryDuration * clamp(ratio, MIN_EXIT_RATIO, MAX_EXIT_RATIO));
}

/**
 * A deterministically integrated damped spring, the same model Remotion's `spring()` uses.
 * Returns displacement from 0 toward 1; `t` is seconds after `delay`. Fixed 1/240 s steps so
 * the same frame always gives the same value.
 * @param {number} seconds @param {keyof typeof SPRING_PRESETS} [preset]
 */
export function springValue(seconds, preset = 'settle') {
  const { damping, stiffness, mass } = SPRING_PRESETS[preset] ?? SPRING_PRESETS.settle;
  if (seconds <= 0) return 0;
  const dt = 1 / 240;
  let x = 0;
  let v = 0;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) {
    const a = (-stiffness * (x - 1) - damping * v) / mass;
    v += a * dt;
    x += v * dt;
  }
  return x;
}

/** Deterministic 0..1 noise from a seed, used for seeded randomness (grain, jitter). */
export function seededRandom(seed = 1) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}
