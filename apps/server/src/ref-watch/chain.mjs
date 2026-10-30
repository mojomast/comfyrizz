// RW-W9C: optionally chain the LTX video stage from the previous clip's accepted
// final frame. Pure module: extraction and the ref-watch keyframe review are
// injected, so there is no ffmpeg, network, clock or disk access here.
// Contracts: docs/tasks/RW00_CONTRACTS.md and @comfyrizz/schema/ref-review.

const REQUIRED_STATUS = 'accepted';

// Approved chain strengths. Never 1.0: identity drift is reviewed, not amplified.
export const CHAIN_STRENGTHS = Object.freeze({ strength: 0.7, strength2: 0.7 });

const CHAIN_NOTE = 'Run a ref-watch identity judge check on the chained clip frames before release.';

function refuse(message) {
  throw new Error(message);
}

async function planChained(previousClip, extractLastFrame, reviewKeyframe) {
  if (previousClip?.status !== REQUIRED_STATUS) {
    refuse(`chained shot requires previousClip.status === "${REQUIRED_STATUS}"`);
  }

  const image = await extractLastFrame(previousClip);
  const verdict = await reviewKeyframe({ kind: 'keyframe', image });
  if (verdict?.overall !== 'pass') {
    refuse(`keyframe review did not pass: ${String(verdict?.overall)}`);
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
 * used by LoadImage and LTXVImgToVideoInplace.
 */
export function planChainedShot({
  previousClip,
  chainFromPrevious = false,
  extractLastFrame,
  reviewKeyframe,
} = {}) {
  if (!chainFromPrevious) return null;
  return planChained(previousClip, extractLastFrame, reviewKeyframe);
}
