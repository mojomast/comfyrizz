// RW02: deterministic T0 checks for a generated reference still.
// Pure module: the caller injects pixel statistics and an identity scorer; the
// module never reads an image, touches the network, the clock or the disk.
// Contracts: docs/tasks/RW00_CONTRACTS.md and @comfyrizz/schema/ref-review.

import {
  REF_VERDICT_SCHEMA,
  validateRefVerdict,
} from '../../../../packages/schema/src/ref-review.mjs';
import { DEFAULT_THRESHOLD } from '../characters/identity-qa.mjs';

const FLAT_STDDEV = 4;
const ASPECT_TOLERANCE = 0.01;
const MAX_EVIDENCE = 400;

const formatNumber = value => value.toFixed(2);

function evidenceOf(text) {
  return text.length <= MAX_EVIDENCE ? text : text.slice(0, MAX_EVIDENCE);
}

function check(dimension, pass, severity, evidence) {
  return { dimension, pass, severity, evidence: evidenceOf(evidence) };
}

function dimensionCheck(request) {
  const { width, height, plannedWidth, plannedHeight } = request;
  const pass = width === plannedWidth && height === plannedHeight;
  const evidence = pass
    ? `dimensions ${width}x${height} match planned ${plannedWidth}x${plannedHeight}`
    : `dimensions ${width}x${height} != planned ${plannedWidth}x${plannedHeight}`;
  return check('technical', pass, 'hard', evidence);
}

function aspectCheck(request) {
  const actual = request.width / request.height;
  const planned = request.plannedWidth / request.plannedHeight;
  if (!Number.isFinite(actual) || !Number.isFinite(planned) || planned <= 0) {
    return check('technical', false, 'hard', 'aspect unavailable from the request dimensions');
  }
  const drift = Math.abs(actual - planned) / planned;
  const pass = drift <= ASPECT_TOLERANCE;
  const evidence = pass
    ? `aspect ${formatNumber(actual)} within 1% of planned ${formatNumber(planned)}`
    : `aspect ${formatNumber(actual)} is outside 1% of planned ${formatNumber(planned)} (${formatNumber(drift * 100)}% off)`;
  return check('technical', pass, 'hard', evidence);
}

function flatCheck(stats) {
  const stddev = stats?.stddev;
  if (typeof stddev !== 'number' || !Number.isFinite(stddev)) {
    return check('technical', false, 'hard', 'stats unavailable to rule out a blank or flat still');
  }
  const pass = stddev >= FLAT_STDDEV;
  const evidence = pass
    ? `stddev ${formatNumber(stddev)} >= ${FLAT_STDDEV}`
    : `stddev ${formatNumber(stddev)} < ${FLAT_STDDEV} (blank or flat still)`;
  return check('technical', pass, 'hard', evidence);
}

function identityInput(request) {
  return {
    primary: request.characters.map(({ characterId, identityLock }) => ({ characterId, identityLock })),
    take: request.imagePath,
  };
}

function identityCheck(result) {
  const cosine = result?.cosine;
  const threshold = result?.threshold ?? DEFAULT_THRESHOLD;
  if (typeof cosine !== 'number' || !Number.isFinite(cosine)
    || typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    return check('identity', false, 'hard', 'identity check produced no cosine score');
  }
  const pass = cosine >= threshold;
  const evidence = pass
    ? `cosine ${formatNumber(cosine)} >= ${formatNumber(threshold)}`
    : `cosine ${formatNumber(cosine)} < ${formatNumber(threshold)}`;
  return check('identity', pass, 'hard', evidence);
}

function fixHintFor(failedCheck, request) {
  if (failedCheck.dimension === 'identity') {
    if (failedCheck.evidence === 'identity check produced no cosine score'
      || failedCheck.evidence.startsWith('identity check failed')) {
      return 're-run the identity check on a readable still';
    }
    return "keep each character's face and build consistent with its identity lock";
  }
  if (failedCheck.evidence.startsWith('dimensions ')) {
    return `render the still at exactly ${request.plannedWidth}x${request.plannedHeight} pixels`;
  }
  if (failedCheck.evidence.startsWith('aspect unavailable')) {
    return `use a still with valid ${request.plannedWidth}x${request.plannedHeight} dimensions`;
  }
  if (failedCheck.evidence.startsWith('aspect ')) {
    return `match the planned ${request.plannedWidth}x${request.plannedHeight} frame aspect`;
  }
  if (failedCheck.evidence.startsWith('stats unavailable')) {
    return 'provide pixel statistics for the still';
  }
  return 'show the full scene with clear detail and a wide tonal range';
}

/**
 * Run the cheap deterministic checks for one reference still.
 *
 * @param {object} request comfyrizz.ref-review.request/v1
 * @param {{stats?: {mean: number, stddev: number}, identity?: Function}} [deps]
 *   `stats` are 0-255 pixel statistics; `identity({primary, take})` is an
 *   injected scorer (wrap characters/identity-qa reviewIdentity) resolving to
 *   `{cosine, threshold}`.
 * @returns {Promise<object>} a comfyrizz.ref-review.verdict/v1 with reviewer "t0"
 */
export async function runT0Checks(request, { stats, identity } = {}) {
  const checks = [
    dimensionCheck(request),
    aspectCheck(request),
    flatCheck(stats),
  ];

  if (typeof identity === 'function') {
    let result;
    try {
      result = await identity(identityInput(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push(check('identity', false, 'hard', `identity check failed: ${message}`));
      result = undefined;
    }
    if (result !== undefined) checks.push(identityCheck(result));
  }

  const failedHardChecks = checks.filter(item => item.pass === false && item.severity === 'hard');
  const fixHints = [...new Set(failedHardChecks.map(item => fixHintFor(item, request)))];
  const verdict = {
    schema: REF_VERDICT_SCHEMA,
    jobId: request.jobId,
    keyframeSha256: request.keyframeSha256,
    reviewer: 't0',
    overall: failedHardChecks.length > 0 ? 'fail' : 'pass',
    checks,
    fixHints,
  };

  const validation = validateRefVerdict(verdict);
  if (!validation.ok) {
    throw new Error(`t0 produced an invalid RefVerdict: ${validation.errors.join('; ')}`);
  }
  return verdict;
}
