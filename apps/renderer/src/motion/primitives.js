// MS1: entry/exit primitives built on the motion tokens.
//
// Same licence note as `./index.js`: the shapes are re-expressed from
// `whaleyxbt/claude-motion` (MIT, Copyright (c) 2026 whaleyxbt) and the HyperFrames motion
// skills (Apache-2.0, Copyright HeyGen); no code was copied. Pure functions of the local
// frame, so a still is a truthful preview and a render is reproducible.
import { clamp, ease, exitDuration, prog, springValue, STAGGER_SECONDS } from './index.js';

/** Wrap a group of `count` entries: their stagger delays and the index that still fits the cap. */
export { STAGGER_SECONDS };

/**
 * Shared entry/exit window. `exit` is `{ at, duration? }` in frames; when `duration` is omitted
 * it is `exitDuration(duration)` (50–75% of the entry).
 * @returns {{in: number, out: number}}
 */
export function enterExit(frame, { delay = 0, duration = 18, ease: easeName = 'enter', exit = null } = {}) {
  const enter = prog(frame, delay, duration, easeName);
  if (!exit) return { in: enter, out: 0 };
  const outDuration = exit.duration ?? exitDuration(duration);
  const at = exit.at ?? delay + duration;
  const out = prog(frame, at, outDuration, exit.ease ?? 'exit');
  // An exit can be scheduled before the entry finishes (overlapping scenes); cap the entry at
  // the exit so an element never jumps back up.
  return { in: Math.min(enter, 1 - out), out };
}

/**
 * Arrive from below with a fade. The old `reveal()` started at 0.18 opacity and never left; this
 * starts at a clean 0 and settles exactly at rest.
 * @returns {{opacity: number, translateY: number}}
 */
export function fadeUp({ frame, fps = 30, delay = 0, duration = 18, distance = 42, exit = null }) {
  const { in: enter, out } = enterExit(frame, { delay, duration, ease: 'enter', exit });
  return {
    opacity: clamp(enter),
    translateY: (1 - enter) * distance - out * distance * 0.6,
  };
}

/**
 * Slide up inside an `overflow: hidden` mask with a small tilt that settles. The mask itself is
 * the caller's job (a wrapper with `overflow: hidden`); this returns the inner transform.
 * @returns {{opacity: number, translateYPercent: number, rotate: number}}
 */
export function maskRise({ frame, fps = 30, delay = 0, duration = 24, distancePercent = 112, tilt = 4, exit = null }) {
  const rise = clamp(distancePercent, 105, 118);
  const angle = clamp(tilt, 3, 5);
  const { in: enter, out } = enterExit(frame, { delay, duration, ease: 'enter', exit });
  return {
    opacity: clamp(enter),
    translateYPercent: (1 - enter) * rise - out * rise * 0.9,
    rotate: (1 - enter) * angle - out * angle,
  };
}

/**
 * Spring in. `pop` is the accent preset; use `elastic` at most once per video.
 * @returns {{scale: number, opacity: number}}
 */
export function pop({ frame, fps = 30, delay = 0, preset = 'pop', exit = null, duration = 24 }) {
  const { out } = enterExit(frame, { delay, duration, exit });
  const seconds = (frame - delay) / fps;
  const scale = springValue(seconds, preset);
  return { scale: Math.max(0, scale * (1 - out)), opacity: clamp(1 - out) };
}

/**
 * Count up to `to` (or down to `from`) with `Math.round`, for `font-variant-numeric: tabular-nums`.
 * A count-down uses `from > to`.
 * @returns {{value: number, progress: number}}
 */
export function countUp({ frame, fps = 30, delay = 0, duration = 30, from = 0, to = 0, ease: easeName = 'move', exit = null }) {
  const enter = prog(frame, delay, duration, easeName);
  let progress = enter;
  if (exit) {
    const outDuration = exit.duration ?? exitDuration(duration);
    const at = exit.at ?? delay + duration;
    progress = enter * (1 - prog(frame, at, outDuration, exit.ease ?? 'exit'));
  }
  const value = from + (to - from) * progress;
  return { value: Math.round(value), progress: clamp(progress) };
}

/**
 * Delay in frames for the `index`-th item of a group, with the cap applied. Thin wrapper so
 * layouts do not each re-import the token.
 */
export { staggerFrames } from './index.js';

/** Convenience: the eased opacity of an exit only (for elements that just leave). */
export function exitFade(frame, { at, duration = 12, ease: easeName = 'exit' } = {}) {
  return clamp(1 - prog(frame, at, duration, easeName));
}

export { ease };
export { exitDuration };
export { prog } from './index.js';
