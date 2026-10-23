// IL06: the iteration estimator.
//
// This is the planning figure a user sees before choosing an iteration level.
// It is pure: no backend, no filesystem, no clock and no network. Every rate
// and duration comes from the Google Colab backend's measured constants, read
// read-only, so the estimate cannot drift from the admission check.
//
// The range is honest about what is not known yet:
//   low      the first round only, plus auditions
//   expected every policy round at the measured minutes
//   high     expected x NEXT_JOB_MARGIN plus the collect-and-stop reserve
//
// D2/D3: an estimate is never an approval. Money is included only when the user
// supplied a price per unit; no currency or price is assumed.
// D8: script drafts cost no GPU, keyframe auditions are stills, and a presenter
// clip is priced per video-second the way the Google Colab backend prices it.

import {
  BOOTSTRAP_OVERHEAD_MINUTES,
  COLLECT_AND_STOP_RESERVE_MINUTES,
  COLAB_RATE_TABLE,
  MEASURED_JOB_MINUTES,
  NEXT_JOB_MARGIN,
  WARN_FRACTION,
  rateForGpu,
} from '../../../../packages/backends/src/index.mjs';
import {
  PRESENTER_GPU_SECONDS_PER_VIDEO_SECOND,
  PRESENTER_MEASURED_JOB_MINUTES,
} from '../../../../packages/backends/src/colab-backend.mjs';
import { ITERATION_PRESETS, effectivePolicyForShot } from './iteration.mjs';

const ESTIMATE_LABEL = 'estimate; other sessions may be running';
const UNMEASURED_LABEL = 'unmeasured estimate';
const PRESET_ORDER = Object.freeze(['director', 'balanced', 'draft']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function gpuKey(gpu) {
  return String(gpu || 'G4').trim().toUpperCase();
}

function unmeasuredGpu(key) {
  const entry = COLAB_RATE_TABLE[key];
  return Boolean(entry && /unmeasured/i.test(entry.source));
}

function unitsForMinutes(minutes, ratePerHour) {
  return round3(((Number(minutes) + BOOTSTRAP_OVERHEAD_MINUTES) / 60) * ratePerHour);
}

function videoTakeMinutes(shot) {
  if (shot.kind === 'presenter') {
    const seconds = Number(shot.durationSeconds);
    const duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    return Math.max(
      PRESENTER_MEASURED_JOB_MINUTES,
      (duration * PRESENTER_GPU_SECONDS_PER_VIDEO_SECOND) / 60,
    );
  }
  if (shot.kind === 'still') return MEASURED_JOB_MINUTES.still;
  if (shot.kind === 'upscale') return MEASURED_JOB_MINUTES.upscale;
  if (shot.kind === 'audio') return MEASURED_JOB_MINUTES.audio;
  return MEASURED_JOB_MINUTES.plate;
}

function shotMinutes(stages, shot) {
  const keyframe = stages.keyframe;
  const video = stages.video;
  const still = MEASURED_JOB_MINUTES.still;
  const videoTake = videoTakeMinutes(shot);

  const keyframeFirst = keyframe.takes * still + keyframe.auditions * still;
  const keyframeAll = keyframe.takes * keyframe.rounds * still + keyframe.auditions * still;
  const videoFirst = video.takes * videoTake;
  const videoAll = video.takes * video.rounds * videoTake;

  return { low: keyframeFirst + videoFirst, expected: keyframeAll + videoAll };
}

function workMinutes(policy, shots) {
  let low = 0;
  let expected = 0;
  for (const shot of shots) {
    if (!isPlainObject(shot)) throw new TypeError('every shot must be an object');
    if (typeof shot.id !== 'string' || shot.id.length === 0) {
      throw new TypeError('every shot must have a non-empty id');
    }
    const resolved = effectivePolicyForShot(policy, shot.id);
    const minutes = shotMinutes(resolved.stages, shot);
    low += minutes.low;
    expected += minutes.expected;
  }
  return { low, expected };
}

function capFor(ceiling, expectedUnits) {
  if (ceiling === null || ceiling === undefined) {
    return { ceiling: null, fraction: null, status: 'no_cap' };
  }
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0) {
    throw new TypeError('ceiling must be a non-negative number or null');
  }

  const fraction = ceiling === 0 ? (expectedUnits === 0 ? 0 : null) : round3(expectedUnits / ceiling);
  let status;
  if (expectedUnits > ceiling) status = 'exceeds';
  else if (expectedUnits > 0 && expectedUnits >= ceiling * WARN_FRACTION) status = 'warn';
  else status = 'fits';

  return { ceiling, fraction, status };
}

function totalsFor(policy, shots, ratePerHour) {
  const work = workMinutes(policy, shots);
  if (work.expected <= 0) {
    const zero = { low: 0, expected: 0, high: 0 };
    return { gpuMinutes: zero, units: zero, wallMinutes: zero };
  }

  const high = work.expected * NEXT_JOB_MARGIN + COLLECT_AND_STOP_RESERVE_MINUTES;
  const gpuMinutes = {
    low: round3(work.low),
    expected: round3(work.expected),
    high: round3(high),
  };
  const wallMinutes = {
    low: round3(work.low + BOOTSTRAP_OVERHEAD_MINUTES),
    expected: round3(work.expected + BOOTSTRAP_OVERHEAD_MINUTES),
    high: round3(high + BOOTSTRAP_OVERHEAD_MINUTES),
  };
  const units = {
    low: unitsForMinutes(work.low, ratePerHour),
    expected: unitsForMinutes(work.expected, ratePerHour),
    high: unitsForMinutes(high, ratePerHour),
  };
  return { gpuMinutes, units, wallMinutes };
}

function suggestedLevel(shots, ratePerHour, ceiling) {
  for (const level of PRESET_ORDER) {
    const totals = totalsFor(ITERATION_PRESETS[level], shots, ratePerHour);
    if (totals.units.expected <= ceiling) return level;
  }
  return null;
}

/**
 * Estimate one production's iteration spend from the policy and its shots.
 *
 * `characters` is accepted with the rest of the production summary; local
 * Kokoro voice work is free under D1, so it does not add Google Colab GPU
 * minutes. The returned estimate is a range, never an approval. When the
 * expected units exceed the cap, `suggestedLevel` names the richest preset
 * that still fits (or null when none does).
 *
 * @param {{
 *   policy: object,
 *   shots: Array<{id: string, durationSeconds?: number, kind?: string}>,
 *   characters?: unknown,
 *   gpu?: string,
 *   ceiling?: number|null,
 *   pricePerUnit?: number,
 * }} options
 * @returns {{
 *   gpuMinutes: {low: number, expected: number, high: number},
 *   units: {low: number, expected: number, high: number},
 *   wallMinutes: {low: number, expected: number, high: number},
 *   vsCap: {ceiling: number|null, fraction: number|null, status: 'fits'|'warn'|'exceeds'|'no_cap'},
 *   labels: string[],
 *   money?: {low: number, expected: number, high: number},
 *   suggestedLevel?: 'draft'|'balanced'|'director'|null,
 * }}
 */
export function estimateIteration(options) {
  if (!isPlainObject(options)) throw new TypeError('estimateIteration options must be an object');

  const {
    policy,
    shots = [],
    gpu = 'G4',
    ceiling = null,
    pricePerUnit,
  } = options;
  if (!Array.isArray(shots)) throw new TypeError('shots must be an array');
  if (pricePerUnit !== undefined && pricePerUnit !== null) {
    if (typeof pricePerUnit !== 'number' || !Number.isFinite(pricePerUnit) || pricePerUnit < 0) {
      throw new TypeError('pricePerUnit must be a non-negative number');
    }
  }

  const key = gpuKey(gpu);
  const ratePerHour = rateForGpu(key, { env: {} }).ratePerHour;
  const totals = totalsFor(policy, shots, ratePerHour);
  const vsCap = capFor(ceiling, totals.units.expected);

  const labels = [ESTIMATE_LABEL];
  if (unmeasuredGpu(key)) labels.push(UNMEASURED_LABEL);

  const result = {
    gpuMinutes: totals.gpuMinutes,
    units: totals.units,
    wallMinutes: totals.wallMinutes,
    vsCap,
    labels,
  };

  if (vsCap.status === 'exceeds') {
    result.suggestedLevel = suggestedLevel(shots, ratePerHour, vsCap.ceiling);
  }

  if (pricePerUnit !== undefined && pricePerUnit !== null) {
    result.money = {
      low: round3(totals.units.low * pricePerUnit),
      expected: round3(totals.units.expected * pricePerUnit),
      high: round3(totals.units.high * pricePerUnit),
    };
  }

  return result;
}
