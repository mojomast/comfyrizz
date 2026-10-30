import { isDeepStrictEqual } from 'node:util';

const STILL_INPUT_FIELDS = Object.freeze(['prompt', 'refs', 'characters', 'wardrobe', 'seed']);
const STALE_CODE = 'KEYFRAME_STALE';
const STALE_REASON = 'keyframe_stale';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function requireStillInputs(value, name) {
  if (!isPlainObject(value)) {
    throw new TypeError(`keyframeStaleness requires ${name} to be a still-input object`);
  }
}

function requireSha(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function stalenessIndex(staleness) {
  const entries = new Map();

  if (staleness instanceof Map) {
    for (const [shotId, value] of staleness) entries.set(shotId, value);
  } else if (Array.isArray(staleness)) {
    for (const entry of staleness) {
      if (!isPlainObject(entry)) throw new TypeError('staleness entries must be objects');
      entries.set(entry.shotId, entry);
    }
  } else if (isPlainObject(staleness)) {
    if (typeof staleness.stale === 'boolean') {
      entries.set(staleness.shotId, staleness);
    } else {
      for (const [shotId, value] of Object.entries(staleness)) entries.set(shotId, value);
    }
  } else {
    throw new TypeError('staleness must be an object, a Map, or an array of entries');
  }

  for (const [shotId, entry] of entries) {
    if (typeof shotId !== 'string' || shotId.length === 0) {
      throw new TypeError('every staleness entry needs a non-empty shotId');
    }
    if (!isPlainObject(entry) || typeof entry.stale !== 'boolean') {
      throw new TypeError(`staleness for ${shotId} must have a boolean stale`);
    }
    if (!Array.isArray(entry.reasons) || entry.reasons.some((reason) => typeof reason !== 'string')) {
      throw new TypeError(`staleness for ${shotId} must have string reasons`);
    }
  }

  return entries;
}

function resolveEstimator(plan, options) {
  if (typeof options === 'function') return options;
  if (isPlainObject(options) && typeof options.estimateStep === 'function') return options.estimateStep;
  if (typeof plan.estimateStep === 'function') return plan.estimateStep;
  return null;
}

function numericUnits(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!isPlainObject(value)) return null;
  if (typeof value.units === 'number' && Number.isFinite(value.units)) return value.units;
  if (typeof value.expected === 'number' && Number.isFinite(value.expected)) return value.expected;
  if (isPlainObject(value.units) && typeof value.units.expected === 'number' && Number.isFinite(value.units.expected)) {
    return value.units.expected;
  }
  return null;
}

function estimateUnits(value, kind) {
  const units = numericUnits(value);
  if (units === null || units < 0) {
    throw new TypeError(`estimateStep must return non-negative units for the ${kind} step`);
  }
  return round3(units);
}

function existingStep(steps, shotId, predicate) {
  return steps.some((step) => step?.shotId === shotId && predicate(step));
}

function planBaseUnits(plan) {
  const planUnits = numericUnits(plan.estimate);
  if (planUnits !== null) return planUnits;
  return plan.steps.reduce((total, step) => {
    const stepUnits = numericUnits(step?.estimate);
    return stepUnits === null ? total : total + stepUnits;
  }, 0);
}

export function keyframeStaleness({ before, after } = {}) {
  requireStillInputs(before, 'before');
  requireStillInputs(after, 'after');

  const reasons = STILL_INPUT_FIELDS.filter((field) => !isDeepStrictEqual(before[field], after[field]));
  return { stale: reasons.length > 0, reasons };
}

export function planWithKeyframes(plan, staleness, options = {}) {
  if (!isPlainObject(plan)) throw new TypeError('planWithKeyframes requires a plan object');
  if (!Array.isArray(plan.steps)) throw new TypeError('planWithKeyframes requires plan.steps to be an array');

  const index = stalenessIndex(staleness);
  const steps = plan.steps.map((step) => (isPlainObject(step) ? { ...step } : step));
  const next = [];
  let addedUnits = 0;

  for (const step of steps) {
    if (isPlainObject(step) && step.kind === 'video' && typeof step.shotId === 'string') {
      const stale = index.get(step.shotId);
      if (stale?.stale) {
        const hasStill = existingStep(next, step.shotId, (entry) => entry.kind === 'still' && entry.action === 'regen');
        const hasReview = existingStep(next, step.shotId, (entry) => entry.kind === 'review');
        const additions = [];

        if (!hasStill) {
          additions.push({
            id: `regen_still_${step.shotId}`,
            kind: 'still',
            action: 'regen',
            label: 'regen still',
            shotId: step.shotId,
            reason: STALE_REASON,
            reasons: [...stale.reasons],
          });
        }
        if (!hasReview) {
          additions.push({
            id: `review_still_${step.shotId}`,
            kind: 'review',
            action: 'review',
            label: 'review',
            shotId: step.shotId,
            reason: STALE_REASON,
            reasons: [...stale.reasons],
          });
        }

        if (additions.length > 0) {
          const estimateStep = resolveEstimator(plan, options);
          if (!estimateStep) {
            throw new TypeError('planWithKeyframes requires an estimateStep function when a keyframe is stale');
          }
          for (const addition of additions) {
            const estimate = estimateUnits(estimateStep({ ...addition }), addition.kind);
            addedUnits += estimate;
            next.push({ ...addition, estimate });
          }
        }
      }
    }

    next.push(step);
  }

  const result = { ...plan, steps: next };
  if (next.length === plan.steps.length) return result;

  result.estimate = {
    units: round3(planBaseUnits(plan) + addedUnits),
    label: 'estimate',
  };
  return result;
}

export function refuseStaleVideo({ videoJob, keyframeSha256, currentKeyframeSha256 } = {}) {
  if (!isPlainObject(videoJob)) throw new TypeError('refuseStaleVideo requires a videoJob object');
  requireSha(keyframeSha256, 'keyframeSha256');
  requireSha(currentKeyframeSha256, 'currentKeyframeSha256');

  if (keyframeSha256 === currentKeyframeSha256) return null;

  return {
    refused: true,
    code: STALE_CODE,
    jobId: typeof videoJob.id === 'string' && videoJob.id.length > 0 ? videoJob.id : null,
    keyframeSha256,
    currentKeyframeSha256,
    message: 'The video job keyframe belongs to a stale revision; regenerate the still and review it before video.',
  };
}
