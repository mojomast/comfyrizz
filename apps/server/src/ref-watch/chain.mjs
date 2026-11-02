// RW-W9C: optionally chain the LTX video stage from the previous clip's accepted
// final frame. Pure module: extraction and the ref-watch keyframe review are
// injected, so there is no ffmpeg, network, clock or disk access here.
// Contracts: docs/tasks/RW00_CONTRACTS.md and @comfyrizz/schema/ref-review.

const REQUIRED_STATUS = 'accepted';
const IDENTITY_DIMENSION = 'identity';
const IDENTITY_DIMENSIONS = Object.freeze([IDENTITY_DIMENSION]);

// Approved chain strengths. Never 1.0: identity drift is reviewed, not amplified.
export const CHAIN_STRENGTHS = Object.freeze({ strength: 0.7, strength2: 0.7 });

const CHAIN_NOTE = 'Run a ref-watch identity judge check on the chained clip frames before release.';

function refuse(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shotIndex(shot) {
  return Number.isSafeInteger(shot?.index) ? shot.index : null;
}

function isHardBoundary(shot) {
  if (!isObject(shot)) return false;
  return shot.cut === true || shot.transition === 'hard';
}

/**
 * Default last-frame chaining for one shot.
 *
 * On only when both shots are in the same scene, `previousShot` is the shot
 * immediately before `shot`, and neither side marks a cut or hard transition.
 * `override === true` forces chaining on and `override === false` forces it off;
 * a first shot, a missing previous shot, or a cross-scene pair stays off.
 */
export function chainDefaultFor({ shot, previousShot, override } = {}) {
  if (override === true) return true;
  if (override === false) return false;
  if (!isObject(shot) || !isObject(previousShot)) return false;
  if (typeof shot.sceneId !== 'string' || shot.sceneId === '') return false;
  if (shot.sceneId !== previousShot.sceneId) return false;

  const index = shotIndex(shot);
  const previousIndex = shotIndex(previousShot);
  if (index === null || previousIndex === null || previousIndex !== index - 1) return false;

  return !isHardBoundary(shot) && !isHardBoundary(previousShot);
}

function identityFailure(verdict) {
  const checks = Array.isArray(verdict?.checks) ? verdict.checks : [];
  const identityChecks = checks.filter((check) => check?.dimension === IDENTITY_DIMENSION);
  if (identityChecks.length === 0) return 'identity check missing from the keyframe review';
  const failed = identityChecks.find((check) => check.pass !== true);
  if (!failed) return null;
  const evidence = typeof failed.evidence === 'string' ? failed.evidence.trim() : '';
  return evidence ? `identity check failed: ${evidence}` : 'identity check failed';
}

async function planChained(previousClip, extractLastFrame, reviewKeyframe, characters) {
  if (previousClip?.status !== REQUIRED_STATUS) {
    refuse(`chained shot requires previousClip.status === "${REQUIRED_STATUS}"`);
  }

  const image = await extractLastFrame(previousClip);
  const identityRequired = characters !== undefined;
  const reviewInput = identityRequired
    ? { kind: 'keyframe', image, characters, dimensions: [...IDENTITY_DIMENSIONS] }
    : { kind: 'keyframe', image };
  const verdict = await reviewKeyframe(reviewInput);
  if (verdict?.overall !== 'pass') {
    refuse(`keyframe review did not pass: ${String(verdict?.overall)}`);
  }

  if (identityRequired) {
    const reason = identityFailure(verdict);
    if (reason !== null) return { fallback: 'keyframe', reason };
  }

  return {
    loadImage: image,
    imgToVideoInplace: {
      strength: CHAIN_STRENGTHS.strength,
      strength2: CHAIN_STRENGTHS.strength2,
    },
    note: CHAIN_NOTE,
  };
}

/**
 * Plan a shot chained from the previous clip.
 *
 * Chaining is off by default and returns null without touching either injected
 * dependency. When on, the previous clip must be accepted, its last frame is
 * extracted and must pass the ref-watch keyframe review before the frame can be
 * used by LoadImage and LTXVImgToVideoInplace. When `characters` is supplied the
 * review also asks for the identity dimension; a failed or missing identity
 * verdict returns `{ fallback: "keyframe", reason }` so the caller keeps the
 * shot's own reviewed keyframe instead of using the chained frame.
 */
export function planChainedShot({
  previousClip,
  chainFromPrevious = false,
  characters,
  extractLastFrame,
  reviewKeyframe,
} = {}) {
  if (!chainFromPrevious) return null;
  return planChained(previousClip, extractLastFrame, reviewKeyframe, characters);
}
