/**
 * Q03 - beat review verdicts and the pre-assembly gate.
 *
 * Source: docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md sections 3 and 6.
 * A verdict is a human/vision-assisted review record for one story beat. It
 * cites the frame or timestamp it was decided from and the sha256 of the file
 * reviewed. A pass without cited evidence is not a pass. A missing verdict is
 * `not_reviewed`, never `passed`.
 *
 * Pure module: no I/O, no clock, no network, no side effects at import time.
 */

export const VERDICT_STATUSES = Object.freeze([
  'passed',
  'failed',
  'substituted',
  'not_reviewed',
]);

const STATUS_SET = new Set(VERDICT_STATUSES);
const SHA256 = /^[a-f0-9]{64}$/i;
const CLOCK_TIMESTAMP = /^\d{1,4}:\d{2}(?:\.\d+)?$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function addError(errors, path, code, message) {
  errors.push({ path, code, message });
}

function hasLocator(evidence) {
  if (evidence.frame !== undefined) {
    return typeof evidence.frame === 'number' && Number.isFinite(evidence.frame) && evidence.frame >= 0;
  }
  if (evidence.timestamp !== undefined) {
    if (typeof evidence.timestamp === 'number') {
      return Number.isFinite(evidence.timestamp) && evidence.timestamp >= 0;
    }
    return typeof evidence.timestamp === 'string' && CLOCK_TIMESTAMP.test(evidence.timestamp.trim());
  }
  return false;
}

function locatorOf(evidence) {
  if (!isPlainObject(evidence)) return null;
  if (evidence.timestamp !== undefined) {
    return String(evidence.timestamp);
  }
  if (typeof evidence.frame === 'number' && Number.isFinite(evidence.frame)) {
    return `frame ${evidence.frame}`;
  }
  return null;
}

function validateEvidenceItem(evidence, path, errors) {
  if (!isPlainObject(evidence)) {
    addError(errors, path, 'INVALID_EVIDENCE_ITEM', 'evidence must be an object with a frame or timestamp and a sha256');
    return false;
  }

  let ok = true;

  if (!hasLocator(evidence)) {
    addError(
      errors,
      path,
      'EVIDENCE_LOCATOR_REQUIRED',
      'evidence needs a non-negative frame or a timestamp such as 03:46.5',
    );
    ok = false;
  }

  if (!isNonEmptyString(evidence.sha256) || !SHA256.test(evidence.sha256)) {
    addError(errors, `${path}.sha256`, 'INVALID_SHA256', 'evidence needs the 64-character sha256 of the reviewed file');
    ok = false;
  }

  if (evidence.file !== undefined && !isNonEmptyString(evidence.file)) {
    addError(errors, `${path}.file`, 'INVALID_FILE', 'file must be a non-empty string when present');
    ok = false;
  }

  return ok;
}

/**
 * Validate one verdict record.
 *
 * A `passed` verdict must cite at least one valid evidence item and name the
 * reviewer and method. A `substituted` verdict must carry an editorial note.
 * `not_reviewed` needs no evidence; it is the honest default for a missing or
 * abandoned review.
 *
 * @param {unknown} verdict
 * @returns {{ok: boolean, errors: Array<{path: string, code: string, message: string}>}}
 */
export function validateVerdict(verdict) {
  const errors = [];

  if (!isPlainObject(verdict)) {
    addError(errors, '$', 'INVALID_VERDICT', 'verdict must be an object');
    return { ok: false, errors };
  }

  if (!isNonEmptyString(verdict.beat)) {
    addError(errors, '$.beat', 'MISSING_BEAT_ID', 'beat id must be a non-empty string');
  }

  if (!VERDICT_STATUSES.includes(verdict.status)) {
    addError(
      errors,
      '$.status',
      'INVALID_STATUS',
      `status must be one of: ${VERDICT_STATUSES.join(', ')}`,
    );
  }

  const status = verdict.status;

  if (status === 'passed') {
    if (!isNonEmptyString(verdict.reviewer)) {
      addError(errors, '$.reviewer', 'MISSING_REVIEWER', 'a passed verdict must name the reviewer');
    }
    if (!isNonEmptyString(verdict.method)) {
      addError(errors, '$.method', 'MISSING_METHOD', 'a passed verdict must name the review method');
    }
    if (!Array.isArray(verdict.evidence) || verdict.evidence.length === 0) {
      addError(
        errors,
        '$.evidence',
        'EVIDENCE_REQUIRED',
        'a passed verdict must cite at least one reviewed frame or timestamp and its file sha256',
      );
    }
  }

  if (Array.isArray(verdict.evidence)) {
    verdict.evidence.forEach((item, index) => {
      validateEvidenceItem(item, `$.evidence[${index}]`, errors);
    });
  } else if (verdict.evidence !== undefined) {
    addError(errors, '$.evidence', 'INVALID_EVIDENCE', 'evidence must be an array');
  }

  if (status === 'substituted' && !isNonEmptyString(verdict.note)) {
    addError(
      errors,
      '$.note',
      'SUBSTITUTION_NOTE_REQUIRED',
      'a substituted beat must carry an intentional editorial note',
    );
  }

  return { ok: errors.length === 0, errors };
}

function extractBeats(beats) {
  if (Array.isArray(beats)) return { beats, error: null };
  if (isPlainObject(beats) && Array.isArray(beats.beats)) return { beats: beats.beats, error: null };
  return {
    beats: [],
    error: {
      beat: null,
      status: 'not_reviewed',
      code: 'INVALID_BEATS',
      message: 'beats must be an array or an object with a beats array',
      reason: 'beats must be an array or an object with a beats array',
    },
  };
}

function extractVerdicts(verdicts) {
  if (Array.isArray(verdicts)) return verdicts;
  if (isPlainObject(verdicts) && Array.isArray(verdicts.verdicts)) return verdicts.verdicts;
  if (isPlainObject(verdicts) && (verdicts.status !== undefined || verdicts.beat !== undefined)) {
    return [verdicts];
  }
  return [];
}

function beatIdOf(beat) {
  if (typeof beat === 'string') return beat;
  if (isPlainObject(beat) && isNonEmptyString(beat.beat)) return beat.beat;
  return null;
}

function isStoryCritical(beat) {
  if (!isPlainObject(beat)) return true;
  if (beat.critical === false) return false;
  if (beat.storyCritical === false) return false;
  return true;
}

function blockingForInvalidVerdict(beat, verdict, errors) {
  const primary =
    errors.find((error) => error.code === 'EVIDENCE_REQUIRED') ??
    errors.find((error) => error.code === 'SUBSTITUTION_NOTE_REQUIRED') ??
    errors[0];

  return {
    beat,
    status: isPlainObject(verdict) ? verdict.status ?? 'not_reviewed' : 'not_reviewed',
    code: primary.code,
    message: primary.message,
    reason: primary.message,
    errors,
  };
}

function gateErrors(errors) {
  return errors.filter(
    (error) => error.code !== 'MISSING_REVIEWER' && error.code !== 'MISSING_METHOD',
  );
}

/**
 * Gate assembly on beat review verdicts.
 *
 * Every story-critical beat needs a `passed` verdict with cited evidence, or a
 * `substituted` verdict with an editorial note. Failed, unreviewed, missing and
 * malformed verdicts block assembly. A beat opts out only with `critical:false`
 * or `storyCritical:false`; by default every beat is story-critical.
 *
 * @param {Array<object|string>|{beats: Array<object|string>}} beats
 * @param {Array<object>|{verdicts: Array<object>}|object} verdicts
 * @returns {{ok: boolean, blocking: Array<object>}}
 */
export function gateBeats(beats, verdicts) {
  const extracted = extractBeats(beats);
  if (extracted.error) {
    return { ok: false, blocking: [extracted.error] };
  }

  const list = extractVerdicts(verdicts);
  const byBeat = new Map();
  const blocking = [];

  list.forEach((verdict) => {
    if (!isPlainObject(verdict) || !isNonEmptyString(verdict.beat)) return;
    const beat = verdict.beat;
    if (byBeat.has(beat)) {
      blocking.push({
        beat,
        status: 'not_reviewed',
        code: 'DUPLICATE_VERDICT',
        message: `Beat "${beat}" has more than one verdict; assembly needs one unambiguous review record`,
        reason: `Beat "${beat}" has more than one verdict; assembly needs one unambiguous review record`,
      });
      byBeat.set(beat, null);
      return;
    }
    byBeat.set(beat, verdict);
  });

  const seenBeats = new Set();
  extracted.beats.forEach((beat) => {
    const beatId = beatIdOf(beat);

    if (beatId === null) {
      blocking.push({
        beat: null,
        status: 'not_reviewed',
        code: 'INVALID_BEAT',
        message: 'beat entry needs a non-empty beat id',
        reason: 'beat entry needs a non-empty beat id',
      });
      return;
    }

    if (seenBeats.has(beatId)) {
      blocking.push({
        beat: beatId,
        status: 'not_reviewed',
        code: 'DUPLICATE_BEAT',
        message: `Beat "${beatId}" appears more than once in the beat plan`,
        reason: `Beat "${beatId}" appears more than once in the beat plan`,
      });
      return;
    }
    seenBeats.add(beatId);

    if (!isStoryCritical(beat)) return;

    if (!byBeat.has(beatId)) {
      blocking.push({
        beat: beatId,
        status: 'not_reviewed',
        code: 'NOT_REVIEWED',
        message: `Beat "${beatId}" has no review verdict; recorded as not_reviewed and blocks assembly`,
        reason: `Beat "${beatId}" has no review verdict; recorded as not_reviewed and blocks assembly`,
      });
      return;
    }

    const verdict = byBeat.get(beatId);
    if (verdict === null) return;

    if (verdict.status === 'failed') {
      const at = Array.isArray(verdict.evidence)
        ? verdict.evidence.map(locatorOf).filter(Boolean)
        : [];
      const where = at.length > 0 ? ` at ${at.join(', ')}` : '';
      const note = isNonEmptyString(verdict.note) ? `: ${verdict.note.trim()}` : '';
      blocking.push({
        beat: beatId,
        status: 'failed',
        code: 'BEAT_FAILED',
        message: `Beat "${beatId}" failed review${where}${note}`,
        reason: `Beat "${beatId}" failed review${where}${note}`,
      });
      return;
    }

    const validation = validateVerdict(verdict);
    const errors = gateErrors(validation.errors);
    if (errors.length > 0) {
      blocking.push(blockingForInvalidVerdict(beatId, verdict, errors));
      return;
    }

    if (verdict.status === 'not_reviewed') {
      blocking.push({
        beat: beatId,
        status: 'not_reviewed',
        code: 'NOT_REVIEWED',
        message: `Beat "${beatId}" is not_reviewed and blocks assembly`,
        reason: `Beat "${beatId}" is not_reviewed and blocks assembly`,
      });
    }
  });

  return { ok: blocking.length === 0, blocking };
}

export default gateBeats;
