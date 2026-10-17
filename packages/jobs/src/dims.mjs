// B2: dimension and frame resolution for the generation jobs.
//
// LTX-2.5 (SPEC.md 6.4, model card): width and height must be divisible by 32 and the
// frame count must satisfy frames % 8 == 1 (97 frames = 4.0 s at 24 fps, 121 = 5.0 s).
// A requested length is resolved to a valid count *before* submission, so the number
// that reaches the workflow is the number the plate will actually have.

export const DIM_MULTIPLE = 32;
export const FRAME_MODULUS = 8;

/** Round one dimension to the nearest multiple of 32 (ties round up), minimum 32. */
export function resolveDimension(value, multiple = DIM_MULTIPLE) {
  const rounded = Math.round(value / multiple) * multiple;
  return Math.max(multiple, rounded);
}

export function isDimensionValid(value, multiple = DIM_MULTIPLE) {
  return Number.isInteger(value) && value >= multiple && value % multiple === 0;
}

/**
 * Resolve (width, height) to a valid pair. Returns the resolved pair plus whether
 * anything moved, so the caller can record the adjustment in the job and in the asset.
 */
export function resolveDimensions(width, height, multiple = DIM_MULTIPLE) {
  const w = resolveDimension(width, multiple);
  const h = resolveDimension(height, multiple);
  return {
    width: w,
    height: h,
    adjusted: w !== width || h !== height,
    requested: { width, height },
  };
}

/** Nearest 8n+1 count (ties round up); 1 is the floor, and 0/negative input is an error. */
export function resolveFrames(requested, modulus = FRAME_MODULUS) {
  if (!Number.isFinite(requested) || requested < 1) {
    throw new RangeError(`frame count must be a positive number, got ${requested}`);
  }
  if ((requested - 1) % modulus === 0) {
    return Math.max(1, requested);
  }
  const n = Math.floor((requested - 1) / modulus + 0.5); // nearest, ties round up
  return Math.max(1, n * modulus + 1);
}

export function isFrameCountValid(value, modulus = FRAME_MODULUS) {
  return Number.isInteger(value) && value >= 1 && (value - 1) % modulus === 0;
}

/** Seconds at a frame rate → a valid 8n+1 count. Used when a caller thinks in seconds. */
export function resolveFramesFromSeconds(seconds, fps, modulus = FRAME_MODULUS) {
  return resolveFrames(Math.ceil(seconds * fps), modulus);
}

/**
 * The geometry a reference/edit graph produces: it takes its size from the reference image at a
 * megapixel budget, not from the package format (GPU test 3, N4 — the plan said 1920x1080 while the
 * graph returned 1360x768 for a 1.0 MP reference-edit). Aspect preserving, rounded onto the lattice
 * the graph rounds to. Pure, so the plan can state a number and the i2v aspect check can compare
 * like with like; the file the run produced is still measured and wins at apply time.
 */
export function dimsForMegapixels(referenceWidth, referenceHeight, megapixels, multiple = DIM_MULTIPLE) {
  const w = Number(referenceWidth);
  const h = Number(referenceHeight);
  const target = Number(megapixels);
  if (!(w > 0) || !(h > 0) || !(target > 0)) return null;
  const scale = Math.sqrt((target * 1e6) / (w * h));
  const dims = resolveDimensions(w * scale, h * scale, multiple);
  return { ...dims, megapixels: target, reference: { width: w, height: h } };
}
