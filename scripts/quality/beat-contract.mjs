/**
 * Q01 - comfyrizz.beat/v1 story-beat contract.
 *
 * Source: docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md section 3 (P0):
 * validate the story beat, not just the presence of the right objects.
 *
 * A beat records who speaks, who is in the shot, the exact dialogue line that
 * licenses the action, the versioned props that must be present, the state
 * before the line and while it is spoken, phrases that must never appear in a
 * prompt, and the frames a reviewer must cite.
 *
 * The review's s08_unreachable_sandwich example is a valid beat as written; the
 * `schema` field is optional on a single beat and may be `comfyrizz.beat/v1`.
 *
 * Pure module: no I/O, no clock, no network, no side effects at import time.
 */

export const BEAT_SCHEMA = 'comfyrizz.beat/v1';

/** Evidence kinds a reviewer may cite for a beat. Order is the review's order. */
export const REVIEW_EVIDENCE_KINDS = Object.freeze([
  'approved first frame',
  'action midpoint',
  'end frame',
]);

const REVIEW_EVIDENCE_SET = new Set(REVIEW_EVIDENCE_KINDS);

// Versioned prop ids: sandwich_01, pose_frame_01 (also accepts id@1 form).
const VERSIONED_PROP_ID = /^(?:[A-Za-z0-9][A-Za-z0-9_]*_\d+|[A-Za-z0-9][A-Za-z0-9_]*@\d+)$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function addError(errors, path, code, message) {
  errors.push({ path, code, message });
}

function requireObject(errors, value, path, label) {
  if (!isPlainObject(value)) {
    addError(errors, path, 'INVALID_TYPE', `${label} must be an object`);
    return false;
  }
  return true;
}

function requireStringArray(errors, value, path, label, { minItems = 0 } = {}) {
  if (!Array.isArray(value)) {
    addError(errors, path, 'INVALID_TYPE', `${label} must be an array of strings`);
    return false;
  }
  if (value.length < minItems) {
    addError(errors, path, 'EMPTY_ARRAY', `${label} must contain at least ${minItems} item(s)`);
  }
  let ok = value.length >= minItems;
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) {
      addError(errors, `${path}[${index}]`, 'INVALID_STRING', `${label}[${index}] must be a non-empty string`);
      ok = false;
    }
  });
  return ok;
}

function validateBeatAt(obj, basePath, errors) {
  if (!requireObject(errors, obj, basePath, 'beat')) {
    return false;
  }

  if (obj.schema !== undefined && obj.schema !== BEAT_SCHEMA) {
    addError(
      errors,
      `${basePath}.schema`,
      'INVALID_SCHEMA',
      `schema must be "${BEAT_SCHEMA}" when present`,
    );
  }

  if (!isNonEmptyString(obj.beat)) {
    addError(errors, `${basePath}.beat`, 'MISSING_BEAT_ID', 'beat id must be a non-empty string');
  }

  if (!isNonEmptyString(obj.speaker)) {
    addError(errors, `${basePath}.speaker`, 'MISSING_SPEAKER', 'speaker must be a non-empty string');
  }

  if (requireStringArray(errors, obj.participants, `${basePath}.participants`, 'participants', { minItems: 1 })) {
    const seen = new Set();
    obj.participants.forEach((participant, index) => {
      if (seen.has(participant)) {
        addError(
          errors,
          `${basePath}.participants[${index}]`,
          'DUPLICATE_PARTICIPANT',
          `participant "${participant}" appears more than once`,
        );
      }
      seen.add(participant);
    });
  }

  if (!isNonEmptyString(obj.dialogueAnchor)) {
    addError(
      errors,
      `${basePath}.dialogueAnchor`,
      'MISSING_DIALOGUE_ANCHOR',
      'dialogueAnchor must be a non-empty string quoted from the speaker\'s line',
    );
  }

  if (!Array.isArray(obj.requiredProps)) {
    addError(errors, `${basePath}.requiredProps`, 'INVALID_TYPE', 'requiredProps must be an array of versioned ids');
  } else {
    obj.requiredProps.forEach((prop, index) => {
      const propPath = `${basePath}.requiredProps[${index}]`;
      if (!isNonEmptyString(prop)) {
        addError(errors, propPath, 'INVALID_STRING', 'required prop id must be a non-empty string');
      } else if (!VERSIONED_PROP_ID.test(prop)) {
        addError(
          errors,
          propPath,
          'UNVERSIONED_PROP_ID',
          `required prop "${prop}" must be a versioned id such as sandwich_01`,
        );
      }
    });
  }

  requireObject(errors, obj.before, `${basePath}.before`, 'before');
  requireObject(errors, obj.duringLine, `${basePath}.duringLine`, 'duringLine');

  if (obj.after !== undefined) {
    requireObject(errors, obj.after, `${basePath}.after`, 'after');
  }

  requireStringArray(errors, obj.rejectIf, `${basePath}.rejectIf`, 'rejectIf');

  if (!Array.isArray(obj.reviewEvidence)) {
    addError(
      errors,
      `${basePath}.reviewEvidence`,
      'INVALID_TYPE',
      'reviewEvidence must be an array of approved evidence kinds',
    );
  } else {
    const seen = new Set();
    obj.reviewEvidence.forEach((kind, index) => {
      const kindPath = `${basePath}.reviewEvidence[${index}]`;
      if (typeof kind !== 'string' || !REVIEW_EVIDENCE_SET.has(kind)) {
        addError(
          errors,
          kindPath,
          'INVALID_REVIEW_EVIDENCE',
          `reviewEvidence must be one of: ${REVIEW_EVIDENCE_KINDS.join(', ')}`,
        );
      } else if (seen.has(kind)) {
        addError(
          errors,
          kindPath,
          'DUPLICATE_REVIEW_EVIDENCE',
          `reviewEvidence "${kind}" appears more than once`,
        );
      }
      seen.add(kind);
    });
  }

  return true;
}

/**
 * Validate one comfyrizz.beat/v1 beat.
 *
 * @param {unknown} obj
 * @returns {{ok: boolean, errors: Array<{path: string, code: string, message: string}>}}
 */
export function validateBeat(obj) {
  const errors = [];
  validateBeatAt(obj, '$', errors);
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a beat plan. A plan is either an array of beats or an object with a
 * `beats` array (its `schema`, when present, is passed through as a string).
 * Every beat is validated, beat ids must be unique, and every speaker must be
 * listed in that beat's participants.
 *
 * @param {unknown} plan
 * @returns {{ok: boolean, errors: Array<{path: string, code: string, message: string}>, count: number}}
 */
export function validateBeatPlan(plan) {
  const errors = [];
  let beats;
  let basePath;

  if (Array.isArray(plan)) {
    beats = plan;
    basePath = '$';
  } else if (isPlainObject(plan)) {
    if (plan.schema !== undefined && typeof plan.schema !== 'string') {
      addError(errors, '$.schema', 'INVALID_TYPE', 'schema must be a string when present');
    }
    if (!Array.isArray(plan.beats)) {
      addError(errors, '$.beats', 'MISSING_BEATS', 'plan must contain a beats array');
      return { ok: false, errors, count: 0 };
    }
    beats = plan.beats;
    basePath = '$.beats';
  } else {
    addError(errors, '$', 'INVALID_PLAN', 'plan must be an array of beats or an object with a beats array');
    return { ok: false, errors, count: 0 };
  }

  const seenIds = new Map();

  beats.forEach((beat, index) => {
    const beatPath = `${basePath}[${index}]`;
    validateBeatAt(beat, beatPath, errors);

    if (!isPlainObject(beat)) return;

    if (isNonEmptyString(beat.beat)) {
      if (seenIds.has(beat.beat)) {
        addError(
          errors,
          `${beatPath}.beat`,
          'DUPLICATE_BEAT_ID',
          `beat id "${beat.beat}" is already used at ${seenIds.get(beat.beat)}`,
        );
      } else {
        seenIds.set(beat.beat, `${beatPath}.beat`);
      }
    }

    if (isNonEmptyString(beat.speaker) && Array.isArray(beat.participants)) {
      const participants = beat.participants.filter(isNonEmptyString);
      if (!participants.includes(beat.speaker)) {
        addError(
          errors,
          `${beatPath}.speaker`,
          'SPEAKER_NOT_PARTICIPANT',
          `speaker "${beat.speaker}" is not listed in participants`,
        );
      }
    }
  });

  return { ok: errors.length === 0, errors, count: beats.length };
}

export default validateBeatPlan;
