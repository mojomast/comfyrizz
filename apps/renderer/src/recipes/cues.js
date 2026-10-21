// AI2: resolve recipe timing from the planner's motionCues contract.
//
// `packages/planner` resolves `scene.motion.cue_phrases` into
// `timeline.scenes[].motionCues` (absolute timeline frames, see
// TimelineCueResolution). The renderer must not treat cue_phrases as
// decoration: technical-flow nodes and list sketch cards use these resolved
// beats. Per-index `motion.cue_seconds` still wins, then a resolved cue, then a
// bounded deterministic fallback that is surfaced in the plan/diagnostics.

import { normalizeCuePhrases, normalizeCueSeconds } from './model.js';

const WARNED = new Set();

/**
 * @typedef {Object} CuePlan
 * @property {number[]} seconds Scene-local seconds, one per requested item.
 * @property {number[]} frames Scene-local frames, one per requested item.
 * @property {string[]} sources Per-index source id.
 * @property {string[]} phrases Planner-resolved phrases when available.
 * @property {string[]} missing Unresolved phrases, surfaced rather than hidden.
 * @property {number[]} unresolved Indexes that used the fallback.
 * @property {string} source Aggregate source: explicit-seconds | planner-word-cues |
 *   planner-measured-caption | planner-estimated-caption | fallback | mixed.
 * @property {boolean} fallback True when at least one item had no usable cue.
 */

/**
 * @param {{scene:any,fps?:number,count:number,sceneFrames:number}} options
 * @returns {CuePlan}
 */
export function sceneCuePlan({ scene, fps = 30, count, sceneFrames }) {
  const total = Math.max(1, Math.round(sceneFrames));
  const requested = Math.max(0, Math.round(count));
  const motion = scene?.motion ?? {};
  const explicit = normalizeCueSeconds(motion.cue_seconds);
  const resolved = Array.isArray(scene?.motionCues) ? scene.motionCues : [];
  const sceneFrom = Number.isFinite(scene?.from) ? Number(scene.from) : 0;
  const cuePhrases = normalizeCuePhrases(motion.cue_phrases);
  const secondLimit = Math.max(0, (total - 1) / Math.max(1, fps));
  const start = Math.min(0.7, secondLimit);
  const end = Math.max(start, secondLimit * 0.82);
  const fallbackStep = requested > 1 ? (end - start) / requested : 0;
  const fallbackSeconds = index => Math.min(secondLimit, start + index * fallbackStep);

  const seconds = [];
  const sources = [];
  const missing = [];
  const unresolved = [];
  for (let index = 0; index < requested; index += 1) {
    const explicitValue = explicit[index];
    if (Number.isFinite(explicitValue)) {
      seconds.push(clampSeconds(explicitValue, secondLimit));
      sources.push('explicit-seconds');
      continue;
    }
    const cue = resolved[index];
    if (cue) {
      const fromFrame = Number.isFinite(cue.frame) ? (Number(cue.frame) - sceneFrom) / Math.max(1, fps) : Number.NaN;
      const fromSeconds = Number.isFinite(cue.seconds) ? Number(cue.seconds) : Number.NaN;
      if (Number.isFinite(fromFrame) && fromFrame >= 0) {
        seconds.push(clampSeconds(fromFrame, secondLimit));
        sources.push(cue.source ?? 'planner');
        continue;
      }
      if (Number.isFinite(fromSeconds) && fromSeconds >= 0) {
        seconds.push(clampSeconds(fromSeconds, secondLimit));
        sources.push(cue.source ?? 'planner');
        continue;
      }
      if (typeof cue.phrase === 'string' && cue.phrase.trim()) missing.push(cue.phrase.trim());
    } else if (cuePhrases[index]) {
      // Raw scene (not compiled) or planner omitted motionCues: surface the
      // phrase as unresolved and fall back rather than quietly dropping it.
      missing.push(cuePhrases[index]);
    }
    unresolved.push(index);
    seconds.push(fallbackSeconds(index));
    sources.push('fallback');
  }

  const aggregate = aggregateSource(sources, unresolved.length > 0);
  const phrases = resolved.length > 0
    ? resolved.map(cue => (typeof cue?.phrase === 'string' ? cue.phrase : '')).filter(Boolean)
    : cuePhrases;
  return {
    seconds,
    frames: seconds.map(value => Math.max(0, Math.min(total - 1, Math.round(value * fps)))),
    sources,
    phrases,
    missing,
    unresolved,
    source: aggregate,
    fallback: unresolved.length > 0,
  };
}

/** @param {number} value @param {number} max */
function clampSeconds(value, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, value));
}

/** @param {string[]} sources @param {boolean} fallback */
function aggregateSource(sources, fallback) {
  if (sources.length === 0) return 'fallback';
  const unique = [...new Set(sources)];
  if (fallback) return unique.length === 1 && unique[0] === 'fallback' ? 'fallback' : 'mixed';
  if (unique.length === 1) return unique[0];
  if (unique.includes('word-cues')) return 'planner-word-cues';
  if (unique.includes('measured-caption')) return 'planner-measured-caption';
  if (unique.includes('estimated-caption')) return 'planner-estimated-caption';
  if (unique.includes('explicit-seconds')) return 'explicit-seconds';
  return 'mixed';
}

/**
 * A stable, data-attribute friendly summary for the React layer. The same scene
 * id with a missing cue warns once per render process, never once per frame.
 * @param {any} scene
 * @param {CuePlan} plan
 */
export function cueDiagnostic(scene, plan) {
  if (plan.missing.length === 0) return null;
  const key = `${scene?.id ?? 'scene'}:${plan.missing.join('|')}`;
  if (!WARNED.has(key)) {
    WARNED.add(key);
    // eslint-disable-next-line no-console
    console.warn(`[recipes] ${scene?.id ?? 'scene'}: ${plan.missing.length} unresolved cue phrase(s); using deterministic fallback (${plan.missing.join(', ')})`);
  }
  return {
    source: plan.source,
    fallback: true,
    missing: [...plan.missing],
    unresolved: [...plan.unresolved],
  };
}

/** Test hook: clear the once-per-scene warning set. */
export function resetCueWarnings() {
  WARNED.clear();
}
