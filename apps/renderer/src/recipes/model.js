// AI2: shared, pure recipe contract for the renderer.
//
// Six optional, frame-deterministic story recipes extend the existing layouts:
// sketch, paper-cut, morph, technical-flow, focus and kinetic. A scene without
// `motion.recipe` takes exactly the old render path; every helper here returns
// a default that the recipe components ignore unless a known id is present.
//
// No React, Remotion, clock or network. The same scene, seed and frame always
// produce the same geometry, so a still is a truthful preview of a render.

import { ANIMATION_RECIPE_IDS } from '../../../../packages/schema/src/animation.mjs';

// AI2: derive the renderer's ids from the shared capability catalogue so a
// package, planner and renderer cannot disagree about what a recipe is.
/** @type {readonly string[]} */
export const RECIPE_IDS = [...ANIMATION_RECIPE_IDS];

/** @type {readonly string[]} */
export const MORPH_SHAPES = ['circle', 'square', 'triangle', 'blob'];

export const SEED_MIN = 1;
export const SEED_MAX = 2147483647;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isRecipe(value) {
  return typeof value === 'string' && RECIPE_IDS.includes(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isMorphShape(value) {
  return typeof value === 'string' && MORPH_SHAPES.includes(value);
}

/** @param {number} value @param {number} [lo] @param {number} [hi] */
export function clamp(value, lo = 0, hi = 1) {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Stable non-cryptographic hash (FNV-1a 32 bit). Used only to derive a default
 * seed from the scene id/recipe, never for security.
 * @param {string} value
 * @returns {number}
 */
export function hashString(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Normalize a caller seed to the agreed 1..2147483647 integer range. Invalid
 * values become a stable scene-derived seed so a recipe never depends on time.
 * @param {unknown} value
 * @param {string} [key]
 * @returns {number}
 */
export function normalizeSeed(value, key = 'comfyrizz') {
  const integer = typeof value === 'number' ? Math.floor(value) : Number.NaN;
  if (Number.isInteger(integer) && integer >= SEED_MIN && integer <= SEED_MAX) return integer;
  // Keep the result inside the schema's positive int32 range.
  return (hashString(`${key}:${String(value ?? '')}`) % SEED_MAX) + 1;
}

/**
 * Small deterministic LCG. Independent streams can be created with the second
 * argument, so adding an annotation does not reshuffle an earlier one.
 * @param {number} seed
 * @param {number} [stream]
 * @returns {() => number}
 */
export function seededRandom(seed, stream = 0) {
  let state = (normalizeSeed(seed) ^ Math.imul(stream + 1, 0x9e3779b1)) >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * A normalized rectangle. Width/height are clamped so x + width <= 1 and
 * y + height <= 1; malformed input returns null and the recipe uses its own
 * centered default.
 * @typedef {{x:number,y:number,width:number,height:number}} FocusRect
 * @param {unknown} value
 * @returns {FocusRect | null}
 */
export function normalizeFocus(value) {
  if (!value || typeof value !== 'object') return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  const x = Number(input.x);
  const y = Number(input.y);
  const width = Number(input.width);
  const height = Number(input.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  const left = clamp(x, 0, 0.98);
  const top = clamp(y, 0, 0.98);
  return {
    x: left,
    y: top,
    width: clamp(width, 0.02, 1 - left),
    height: clamp(height, 0.02, 1 - top),
  };
}

/**
 * @typedef {{from:string,to:string}} MorphSpec
 * @param {unknown} value
 * @returns {MorphSpec}
 */
export function normalizeMorph(value) {
  const input = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  const from = isMorphShape(input.from) ? input.from : 'circle';
  const to = isMorphShape(input.to) ? input.to : 'blob';
  return { from, to };
}

/**
 * Planner-resolved phrase list. Strings only, trimmed, bounded to keep the
 * headline legible and the per-frame work small.
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeCuePhrases(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map(item => item.slice(0, 120));
}

/**
 * Scene-local seconds, nonnegative and nondecreasing. Invalid entries drop the
 * whole list rather than silently changing the meaning of an index.
 * @param {unknown} value
 * @returns {number[]}
 */
export function normalizeCueSeconds(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const numbers = value.map(Number);
  if (!numbers.every(number => Number.isFinite(number) && number >= 0)) return [];
  for (let index = 1; index < numbers.length; index += 1) {
    if (numbers[index] < numbers[index - 1]) return [];
  }
  return numbers.slice(0, 6);
}

/**
 * @typedef {Object} RecipeOptions
 * @property {string|null} recipe
 * @property {number} seed
 * @property {number} intensity
 * @property {FocusRect|null} focus
 * @property {MorphSpec} morph
 * @property {string[]} cuePhrases
 * @property {number[]} cueSeconds
 */

/**
 * Resolve every recipe parameter once per scene. Unknown/absent recipe means
 * the caller renders the old layout untouched.
 * @param {any} scene
 * @returns {RecipeOptions}
 */
export function resolveRecipe(scene) {
  const motion = scene?.motion ?? {};
  const recipe = isRecipe(motion.recipe) ? motion.recipe : null;
  const seed = normalizeSeed(motion.seed, `${scene?.id ?? 'scene'}:${recipe ?? 'default'}`);
  return {
    recipe,
    seed,
    intensity: clamp(motion.intensity === undefined ? 0.6 : Number(motion.intensity), 0, 1),
    focus: normalizeFocus(motion.focus),
    morph: normalizeMorph(motion.morph),
    cuePhrases: normalizeCuePhrases(motion.cue_phrases),
    cueSeconds: normalizeCueSeconds(motion.cue_seconds),
  };
}

/**
 * Scene progress in frames, clamped. `frame` is the scene-local Remotion frame.
 * @param {number} frame
 * @param {number} sceneFrames
 * @returns {number}
 */
export function sceneProgress(frame, sceneFrames) {
  return clamp(frame / Math.max(1, sceneFrames - 1));
}

/**
 * A bounded frame window inside a scene. When two or more speech cues are
 * present they anchor the start/end; otherwise a deterministic fraction of the
 * scene is used. The result always leaves a readable tail.
 * @param {{frame?:number, fps?:number, sceneFrames?:number, cues?:number[], startFraction?:number, endFraction?:number, holdSeconds?:number}} options
 * @returns {{start:number,end:number,duration:number,frame:number,progress:number}}
 */
export function recipeWindow({
  frame = 0,
  fps = 30,
  sceneFrames = 300,
  cues = [],
  startFraction = 0.08,
  endFraction = 0.62,
  holdSeconds = 0.7,
} = {}) {
  const total = Math.max(1, Math.round(sceneFrames));
  const hold = Math.max(0, Math.round(holdSeconds * fps));
  const latestEnd = Math.max(1, total - hold);
  const fallbackStart = Math.round(total * clamp(startFraction, 0, 0.8));
  const fallbackEnd = Math.round(total * clamp(endFraction, 0.15, 0.94));
  const cueStart = cues.length > 0 ? Math.round(cues[0] * fps) : fallbackStart;
  const cueEnd = cues.length > 1 ? Math.round(cues[1] * fps) : fallbackEnd;
  const start = clamp(cueStart, 0, latestEnd - 1);
  const end = clamp(cueEnd > start ? cueEnd : fallbackEnd, start + 1, latestEnd);
  return {
    start,
    end,
    duration: Math.max(1, end - start),
    frame,
    progress: clamp((frame - start) / Math.max(1, end - start)),
  };
}

/**
 * One of the three non-directional reveal transitions from AI2. Kept separate
 * from directional vocabulary on purpose: these reveal a new scene, they are
 * not a shared-element identity handoff.
 * @type {readonly string[]}
 */
export const REVEAL_TRANSITIONS = ['paper-reveal', 'draw-reveal', 'shape-reveal'];

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isRevealTransition(value) {
  return typeof value === 'string' && REVEAL_TRANSITIONS.includes(value);
}
