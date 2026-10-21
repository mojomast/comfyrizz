/**
 * Q06 - multi-axis quality receipt.
 *
 * Source: docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md section 5A and
 * docs/specs/QUALITY_FIXES.md Q06.
 *
 * The receipt separates the axes a technically valid render can still fail:
 *
 *   technical           container, frames, audio, subtitle presence
 *   semantic            story beats (Q03 verdicts)
 *   temporal            motion artifacts (Q05 take reviews)
 *   continuity          costumes, recurring artwork, prop ownership
 *   captionReadability  caption rate and length (Q13/Q14 results)
 *   listeningReview     a human playback/listening pass
 *
 * A missing axis is `not_reviewed`, never `passed`. Model scores and pixel
 * differences can be triage signals, but they are not a listening review.
 *
 * An axis may carry an `exception` (or `acceptedException`) with a non-empty
 * `reason`. An exception without a reason is rejected and does not excuse the
 * axis. An accepted exception records which axis it excuses and why.
 *
 * Pure module: no I/O, no clock, no network, no side effects at import time.
 * Inputs are never mutated.
 */

import { gateBeats, validateVerdict } from './beat-verdicts.mjs';
import { reviewTake } from './temporal-review.mjs';
import { captionMetrics } from './caption-metrics.mjs';

export const RECEIPT_SCHEMA = 'comfyrizz.quality-receipt/v1';

export const AXES = Object.freeze([
  'technical',
  'semantic',
  'temporal',
  'continuity',
  'captionReadability',
  'listeningReview',
]);

export const RECEIPT_STATES = Object.freeze(['passed', 'failed', 'not_reviewed']);

const STATE_SET = new Set(RECEIPT_STATES);
const AXIS_SET = new Set(AXES);
const SHA256 = /^[a-f0-9]{64}$/i;
const GATE_IGNORED_CODES = new Set(['MISSING_REVIEWER', 'MISSING_METHOD']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeText(value, maxLength = 200) {
  if (!isNonEmptyString(value)) return null;
  const text = value.trim().replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ');
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function portablePath(value) {
  if (!isNonEmptyString(value)) return null;
  let path = value.trim().replace(/\\/g, '/');
  path = path.replace(/^[a-z]+:\/\/[^/]+\//i, '');
  path = path.replace(/^[a-z]:/i, '');
  path = path.replace(/[?#].*$/, '');
  path = path.replace(/^\/+/, '');
  path = path.replace(/^(\.\/)+/, '');
  return path.length > 0 ? path : null;
}

function statusOf(value) {
  if (!isPlainObject(value)) return null;
  for (const field of ['status', 'state', 'reviewStatus']) {
    const status = value[field];
    if (STATE_SET.has(status)) return status;
  }
  for (const field of ['passed', 'ok']) {
    if (typeof value[field] === 'boolean') return value[field] ? 'passed' : 'failed';
  }
  if (typeof value.reviewed === 'boolean') {
    if (value.reviewed !== true) return 'not_reviewed';
    return value.failed === true ? 'failed' : 'passed';
  }
  return null;
}

function compareStrings(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function combineStatuses(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) return 'not_reviewed';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.some((status) => status !== 'passed')) return 'not_reviewed';
  return 'passed';
}

function pushFailure(failures, axis, code, message, extra = {}) {
  failures.push({ axis, code, message, ...extra });
}

function addReviewedFile(target, seen, entry, axis, failures) {
  if (!isPlainObject(entry)) {
    pushFailure(failures, axis, 'REVIEWED_FILE_INVALID', `A reviewed file entry on ${axis} must be an object`);
    return;
  }

  const path = portablePath(entry.path ?? entry.file);
  if (path === null) {
    pushFailure(failures, axis, 'REVIEWED_FILE_PATH_REQUIRED', `A reviewed file on ${axis} needs a path`);
    return;
  }

  const sha256 = isNonEmptyString(entry.sha256) ? entry.sha256.trim().toLowerCase() : '';
  if (!SHA256.test(sha256)) {
    pushFailure(
      failures,
      axis,
      'REVIEWED_FILE_HASH_INVALID',
      `Reviewed file "${path}" needs a 64-character sha256`,
    );
    return;
  }

  const key = `${path}\u0000${sha256}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({ path, sha256 });
}

function candidatesFrom(input) {
  const out = [];
  if (Array.isArray(input)) {
    input.forEach((entry) => out.push(...candidatesFrom(entry)));
    return out;
  }
  if (!isPlainObject(input)) return out;

  if (Array.isArray(input.reviewedFiles)) out.push(...input.reviewedFiles);
  if (Array.isArray(input.evidence)) out.push(...input.evidence);
  if (isPlainObject(input.review) && Array.isArray(input.review.reviewedFiles)) {
    out.push(...input.review.reviewedFiles);
  }
  if (Array.isArray(input.verdicts)) {
    input.verdicts.forEach((verdict) => {
      if (isPlainObject(verdict) && Array.isArray(verdict.evidence)) out.push(...verdict.evidence);
    });
  }
  if (Array.isArray(input.takes)) {
    input.takes.forEach((take) => out.push(...candidatesFrom(take)));
  }
  return out;
}

function explicitTakeId(entry) {
  if (!isPlainObject(entry)) return null;
  const id = entry.id ?? entry.takeId ?? entry.take_id ?? entry.take?.id;
  return safeText(id, 120);
}

function takeReviewOf(entry) {
  if (!isPlainObject(entry)) return null;
  if (STATE_SET.has(entry.status)) {
    return { status: entry.status, failures: Array.isArray(entry.failures) ? entry.failures : [] };
  }
  if (isPlainObject(entry.review)) {
    const status = statusOf(entry.review);
    if (status !== null) {
      return {
        status,
        failures: Array.isArray(entry.review.failures) ? entry.review.failures : [],
      };
    }
  }
  if (Array.isArray(entry.observations)) {
    return reviewTake(entry.take ?? entry, entry.observations);
  }
  return null;
}

function technicalReview(input, failures) {
  if (input === undefined || input === null) return 'not_reviewed';

  if (Array.isArray(input)) {
    if (input.length === 0) return 'not_reviewed';
    const statuses = input.map((check) => {
      const status = statusOf(check);
      if (status === 'failed') {
        pushFailure(
          failures,
          'technical',
          safeText(check?.code, 80) ?? 'TECHNICAL_CHECK_FAILED',
          safeText(check?.message, 200) ?? 'A technical check failed',
        );
      }
      return status ?? 'not_reviewed';
    });
    return combineStatuses(statuses);
  }

  if (!isPlainObject(input)) return 'not_reviewed';

  const status = statusOf(input);
  const checksFailed = Array.isArray(input.failures) && input.failures.length > 0;
  if (checksFailed) {
    input.failures.forEach((failure) => {
      const code = isPlainObject(failure) ? safeText(failure.code, 80) : null;
      const message = isPlainObject(failure) ? safeText(failure.message, 200) : null;
      pushFailure(
        failures,
        'technical',
        code ?? 'TECHNICAL_CHECK_FAILED',
        message ?? 'A technical check failed',
      );
    });
    return 'failed';
  }
  if (status !== null) return status;
  if (Array.isArray(input.checks)) {
    return combineStatuses(input.checks.map((check) => statusOf(check) ?? 'not_reviewed'));
  }
  return 'not_reviewed';
}

function looksLikeVerdict(value) {
  return isPlainObject(value)
    && ('status' in value || 'state' in value || 'reviewStatus' in value);
}

function extractVerdicts(input) {
  if (Array.isArray(input)) {
    return input.length === 0 || input.some(looksLikeVerdict) ? input : null;
  }
  if (!isPlainObject(input)) return null;
  if (Array.isArray(input.verdicts)) return input.verdicts;
  if (Array.isArray(input.reviews)) return input.reviews;
  if (isNonEmptyString(input.beat) && looksLikeVerdict(input)) return [input];
  return null;
}

function blockingState(blocking) {
  if (blocking.length === 0) return 'passed';
  const onlyUnreviewed = blocking.every((entry) => {
    if (!isPlainObject(entry)) return false;
    if (entry.code !== undefined) return entry.code === 'NOT_REVIEWED';
    return entry.status === 'not_reviewed';
  });
  return onlyUnreviewed ? 'not_reviewed' : 'failed';
}

function classifyVerdicts(verdicts, failures) {
  const statuses = [];
  for (const verdict of verdicts) {
    if (!isPlainObject(verdict)) {
      statuses.push('failed');
      pushFailure(failures, 'semantic', 'INVALID_VERDICT', 'A beat verdict must be an object');
      continue;
    }

    const validation = validateVerdict(verdict);
    const errors = validation.errors.filter((error) => !GATE_IGNORED_CODES.has(error.code));
    if (errors.length > 0) {
      statuses.push('failed');
      errors.forEach((error) => {
        pushFailure(failures, 'semantic', error.code, error.message, {
          beat: safeText(verdict.beat, 120),
        });
      });
      continue;
    }

    statuses.push(verdict.status === 'substituted' ? 'passed' : verdict.status);
  }
  return combineStatuses(statuses);
}

function semanticReview(input, failures) {
  if (input === undefined || input === null) return 'not_reviewed';
  if (!Array.isArray(input) && !isPlainObject(input)) return 'not_reviewed';

  const verdicts = extractVerdicts(input);
  const beatPlan = isPlainObject(input) && Array.isArray(input.beats) ? input.beats : null;

  if (verdicts !== null && verdicts.length > 0) {
    if (beatPlan !== null) {
      const gate = gateBeats(beatPlan, verdicts);
      gate.blocking.forEach((entry) => {
        pushFailure(
          failures,
          'semantic',
          safeText(entry.code, 80) ?? 'BEAT_BLOCKED',
          safeText(entry.message, 240) ?? 'A story beat blocks assembly',
          { beat: safeText(entry.beat, 120) },
        );
      });
      return blockingState(gate.blocking);
    }
    return classifyVerdicts(verdicts, failures);
  }

  if (beatPlan !== null) return 'not_reviewed';

  if (isPlainObject(input) && Array.isArray(input.blocking)) {
    input.blocking.forEach((entry) => {
      const code = isPlainObject(entry) ? safeText(entry.code, 80) : null;
      const message = isPlainObject(entry) ? safeText(entry.message, 240) : null;
      pushFailure(
        failures,
        'semantic',
        code ?? 'BEAT_BLOCKED',
        message ?? 'A story beat blocks assembly',
        { beat: isPlainObject(entry) ? safeText(entry.beat, 120) : null },
      );
    });
    return blockingState(input.blocking);
  }

  const status = statusOf(input);
  if (status !== null) {
    if (status === 'failed') {
      pushFailure(failures, 'semantic', 'BEAT_REVIEW_FAILED', 'The story-beat review failed');
    }
    return status;
  }
  return 'not_reviewed';
}

function temporalReview(input, failures, selectedTakes) {
  if (input === undefined || input === null) return 'not_reviewed';

  if (isPlainObject(input)) {
    for (const field of ['selectedTakes', 'selected']) {
      if (Array.isArray(input[field])) {
        input[field].forEach((entry) => {
          const id = typeof entry === 'string' ? safeText(entry, 120) : explicitTakeId(entry);
          if (id !== null) selectedTakes.add(id);
        });
      }
    }
  }

  const takes = Array.isArray(input)
    ? input
    : isPlainObject(input) && Array.isArray(input.takes)
      ? input.takes
      : null;

  if (takes !== null) {
    if (takes.length === 0) return 'not_reviewed';
    const declared = statusOf(input);
    const statuses = [];

    takes.forEach((entry) => {
      const id = explicitTakeId(entry);
      if (isPlainObject(entry) && entry.selected === true && id !== null) {
        selectedTakes.add(id);
      }

      const review = takeReviewOf(entry);
      if (review === null) {
        statuses.push('not_reviewed');
        return;
      }

      statuses.push(review.status);
      if (review.status === 'failed') {
        (review.failures ?? []).forEach((failure) => {
          const code = isPlainObject(failure) ? safeText(failure.code, 80) : null;
          const message = isPlainObject(failure) ? safeText(failure.message, 240) : null;
          pushFailure(
            failures,
            'temporal',
            code ?? 'TAKE_REVIEW_FAILED',
            message ?? 'A take failed temporal review',
            { take: id },
          );
        });
        if (!Array.isArray(review.failures) || review.failures.length === 0) {
          pushFailure(failures, 'temporal', 'TAKE_REVIEW_FAILED', 'A take failed temporal review', {
            take: id,
          });
        }
      }
    });

    const combined = combineStatuses(statuses);
    if (declared === 'failed' && combined !== 'failed') {
      pushFailure(failures, 'temporal', 'TAKE_REVIEW_FAILED', 'The temporal review failed');
      return 'failed';
    }
    return combined;
  }

  const status = statusOf(input);
  if (status !== null) {
    if (status === 'failed') {
      pushFailure(failures, 'temporal', 'TAKE_REVIEW_FAILED', 'The temporal review failed');
    }
    return status;
  }
  return 'not_reviewed';
}

function continuityReview(input, failures) {
  if (input === undefined || input === null) return 'not_reviewed';
  if (!Array.isArray(input) && !isPlainObject(input)) return 'not_reviewed';

  const findings = Array.isArray(input)
    ? input
    : Array.isArray(input.findings)
      ? input.findings
      : Array.isArray(input.blocking)
        ? input.blocking
        : null;

  if (findings !== null) {
    findings.forEach((finding) => {
      const code = isPlainObject(finding) ? safeText(finding.code, 80) : null;
      const message = isPlainObject(finding) ? safeText(finding.message, 240) : null;
      pushFailure(
        failures,
        'continuity',
        code ?? 'CONTINUITY_FINDING',
        message ?? 'A continuity finding blocks assembly',
      );
    });
    if (findings.length > 0) return 'failed';
    if (statusOf(input) === 'failed') {
      pushFailure(failures, 'continuity', 'CONTINUITY_REVIEW_FAILED', 'The continuity review failed');
      return 'failed';
    }
    return 'passed';
  }

  const status = statusOf(input);
  if (status !== null) {
    if (status === 'failed') {
      pushFailure(failures, 'continuity', 'CONTINUITY_REVIEW_FAILED', 'The continuity review failed');
    }
    return status;
  }
  return 'not_reviewed';
}

function captionsReview(input, failures) {
  if (input === undefined || input === null) return 'not_reviewed';
  if (!isPlainObject(input)) return 'not_reviewed';

  let metrics = null;
  if (Array.isArray(input.overCps) || Array.isArray(input.overLength)) {
    metrics = input;
  } else if (Array.isArray(input.cues)) {
    metrics = captionMetrics(input.cues, isPlainObject(input.options) ? input.options : {});
  }

  if (metrics !== null) {
    const overCps = Array.isArray(metrics.overCps) ? metrics.overCps : [];
    const overLength = Array.isArray(metrics.overLength) ? metrics.overLength : [];

    overCps.forEach((cue) => {
      const index = isPlainObject(cue) && Number.isInteger(cue.index) ? cue.index : null;
      pushFailure(
        failures,
        'captionReadability',
        'CAPTION_OVER_CPS',
        index === null ? 'A caption exceeds the reading-rate limit' : `Caption ${index} exceeds the reading-rate limit`,
        index === null ? {} : { cue: index },
      );
    });
    overLength.forEach((cue) => {
      const index = isPlainObject(cue) && Number.isInteger(cue.index) ? cue.index : null;
      pushFailure(
        failures,
        'captionReadability',
        'CAPTION_OVER_LENGTH',
        index === null ? 'A caption exceeds the length limit' : `Caption ${index} exceeds the length limit`,
        index === null ? {} : { cue: index },
      );
    });

    if (overCps.length > 0 || overLength.length > 0) return 'failed';
    if (statusOf(input) === 'failed') {
      pushFailure(
        failures,
        'captionReadability',
        'CAPTION_REVIEW_FAILED',
        'The caption readability review failed',
      );
      return 'failed';
    }
    return 'passed';
  }

  const status = statusOf(input);
  if (status !== null) {
    if (status === 'failed') {
      pushFailure(
        failures,
        'captionReadability',
        'CAPTION_REVIEW_FAILED',
        'The caption readability review failed',
      );
    }
    return status;
  }
  return 'not_reviewed';
}

function listeningReview(input, failures) {
  if (input === undefined || input === null) return 'not_reviewed';
  if (!isPlainObject(input)) return 'not_reviewed';

  const status = statusOf(input);
  if (status !== null) {
    if (status === 'failed') {
      pushFailure(failures, 'listeningReview', 'LISTENING_REVIEW_FAILED', 'The listening review failed');
    }
    return status;
  }

  return 'not_reviewed';
}

function collectExceptions(axis, input, failures) {
  const accepted = [];
  if (!isPlainObject(input)) return accepted;

  const raw = [];
  if (input.exception !== undefined) raw.push(input.exception);
  if (input.acceptedException !== undefined) raw.push(input.acceptedException);
  if (Array.isArray(input.exceptions)) raw.push(...input.exceptions);
  else if (isPlainObject(input.exceptions)) raw.push(input.exceptions);

  raw.forEach((entry) => {
    if (entry === undefined || entry === null) return;

    const reason = isNonEmptyString(entry)
      ? entry
      : isPlainObject(entry) && isNonEmptyString(entry.reason)
        ? entry.reason
        : null;

    if (reason === null) {
      pushFailure(
        failures,
        axis,
        'EXCEPTION_REASON_REQUIRED',
        `An accepted exception for ${axis} needs a reason`,
      );
      return;
    }

    const exception = { axis, reason: safeText(reason, 240) };
    const acceptedBy = isPlainObject(entry) ? safeText(entry.acceptedBy, 120) : null;
    if (acceptedBy !== null) exception.acceptedBy = acceptedBy;
    accepted.push(exception);
  });

  return accepted;
}

function collectTopLevelExceptions(inputs, failures) {
  const accepted = [];
  const raw = [];

  if (Array.isArray(inputs.acceptedExceptions)) raw.push(...inputs.acceptedExceptions);
  if (Array.isArray(inputs.exceptions)) raw.push(...inputs.exceptions);

  raw.forEach((entry) => {
    if (!isPlainObject(entry) || !AXIS_SET.has(entry.axis)) {
      pushFailure(
        failures,
        'receipt',
        'EXCEPTION_AXIS_REQUIRED',
        'A top-level exception needs one of the receipt axes',
      );
      return;
    }

    if (!isNonEmptyString(entry.reason)) {
      pushFailure(
        failures,
        entry.axis,
        'EXCEPTION_REASON_REQUIRED',
        `An accepted exception for ${entry.axis} needs a reason`,
      );
      return;
    }

    const exception = { axis: entry.axis, reason: safeText(entry.reason, 240) };
    const acceptedBy = safeText(entry.acceptedBy, 120);
    if (acceptedBy !== null) exception.acceptedBy = acceptedBy;
    accepted.push(exception);
  });

  return accepted;
}

/**
 * Build a multi-axis quality receipt.
 *
 * Inputs are the axis reviews, not raw media:
 *   technical           {status|ok, failures[], reviewedFiles[]}
 *   beats               {beats[], verdicts[]} (Q03), a verdict array, or {status}
 *   takes               array of Q05 results / {takes[], selectedTakes[], status}
 *   continuity          {findings[]} (Q08) or {status}
 *   captions            Q13 metrics, {cues[]}, or {status}
 *   listening           {status, reviewer?, method?}
 *
 * @param {object} inputs
 * @returns {{
 *   schema: string,
 *   states: Record<string, 'passed'|'failed'|'not_reviewed'>,
 *   reviewedFiles: Array<{path: string, sha256: string}>,
 *   failures: Array<object>,
 *   acceptedExceptions: Array<object>,
 *   selectedTakes: string[]
 * }}
 */
export function buildReceipt(inputs = {}) {
  const source = isPlainObject(inputs) ? inputs : {};
  const failures = [];
  const reviewedFiles = [];
  const seenFiles = new Set();
  const selectedTakes = new Set();

  const axisInputs = {
    technical: source.technical,
    semantic: source.beats,
    temporal: source.takes,
    continuity: source.continuity,
    captionReadability: source.captions,
    listeningReview: source.listening,
  };

  for (const axis of AXES) {
    candidatesFrom(axisInputs[axis]).forEach((entry) => {
      addReviewedFile(reviewedFiles, seenFiles, entry, axis, failures);
    });
  }
  if (Array.isArray(source.reviewedFiles)) {
    source.reviewedFiles.forEach((entry) => {
      addReviewedFile(reviewedFiles, seenFiles, entry, 'receipt', failures);
    });
  }

  const states = {
    technical: technicalReview(source.technical, failures),
    semantic: semanticReview(source.beats, failures),
    temporal: temporalReview(source.takes, failures, selectedTakes),
    continuity: continuityReview(source.continuity, failures),
    captionReadability: captionsReview(source.captions, failures),
    listeningReview: listeningReview(source.listening, failures),
  };

  for (const field of ['selectedTakes', 'selected']) {
    if (!Array.isArray(source[field])) continue;
    source[field].forEach((entry) => {
      const id = typeof entry === 'string' ? safeText(entry, 120) : explicitTakeId(entry);
      if (id !== null) selectedTakes.add(id);
    });
  }

  const acceptedExceptions = collectTopLevelExceptions(source, failures);
  for (const axis of AXES) {
    acceptedExceptions.push(...collectExceptions(axis, axisInputs[axis], failures));
  }

  reviewedFiles.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.sha256, b.sha256));

  return {
    schema: RECEIPT_SCHEMA,
    states,
    reviewedFiles,
    failures,
    acceptedExceptions,
    selectedTakes: [...selectedTakes].sort(compareStrings),
  };
}

/**
 * Approval requires every axis to be `passed` or covered by an accepted
 * exception. A missing review is never inferred as a pass.
 *
 * @param {object} receipt
 * @returns {boolean}
 */
export function approved(receipt) {
  if (!isPlainObject(receipt) || !isPlainObject(receipt.states)) return false;
  if (receipt.schema !== undefined && receipt.schema !== RECEIPT_SCHEMA) return false;

  const excused = new Set();
  if (Array.isArray(receipt.acceptedExceptions)) {
    receipt.acceptedExceptions.forEach((exception) => {
      if (!isPlainObject(exception) || !AXIS_SET.has(exception.axis)) return;
      if (!isNonEmptyString(exception.reason)) return;
      excused.add(exception.axis);
    });
  }

  return AXES.every((axis) => receipt.states[axis] === 'passed' || excused.has(axis));
}

export default buildReceipt;
