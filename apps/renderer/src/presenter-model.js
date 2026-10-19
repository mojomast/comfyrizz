/**
 * P-pres: pure geometry/opacity for the AI presenter overlay (research 2.2).
 *
 * No React and no Remotion here so the maths is testable on plain Node, exactly
 * like the motion modules. `PresenterOverlay` (presenter.tsx) turns these into
 * nodes. The presenter clip is a 768x768 square that serves every aspect ratio;
 * only its box and the seam cross-dissolve change.
 */

/** The default disclosure chip text (research 2.2: on by default). */
export const PRESENTER_LABEL_DEFAULT = 'AI presenter';
/** The presenter's width as a fraction of the frame's short side, when unset. */
export const PRESENTER_SIZE_DEFAULT = 0.24;
/** The longest seam cross-dissolve, in frames. */
export const PRESENTER_DISSOLVE_FRAMES = 5;

/**
 * Resolve the clip asset for a scene: the scene's own a2v clip when it has one,
 * else the package portrait still (a valid stand-in until the a2v jobs run).
 */
export function presenterAssetId(scene, pkg) {
  return scene?.presenter_asset ?? pkg?.presenter?.portrait ?? null;
}

/**
 * The presenter's box in frame pixels. `size` is a fraction of the short side.
 * pip-br / pip-bl sit in a bottom corner; pip-bc sits bottom-centre (the 9:16
 * default, above captions). The caption clearance keeps the PiP off the caption
 * band that sits at SAFE_AREA.y.
 */
export function presenterBox({ placement = 'pip-br', shape = 'circle', size = PRESENTER_SIZE_DEFAULT, width, height }) {
  const short = Math.min(width, height);
  const box = Math.round(size * short);
  const margin = Math.round(short * 0.035);
  const captionClearance = Math.round(height * 0.15);
  const radius = shape === 'rounded-rect' ? Math.round(box * 0.14) : Math.round(box / 2);
  const bottom = height - captionClearance - box;
  if (placement === 'split-left') {
    return { left: 0, top: 0, width: Math.round(width * 0.4), height, radius: 0 };
  }
  if (placement === 'pip-bl') return { left: margin, top: bottom, width: box, height: box, radius };
  if (placement === 'pip-bc') return { left: Math.round((width - box) / 2), top: bottom, width: box, height: box, radius };
  return { left: width - margin - box, top: bottom, width: box, height: box, radius };
}

/**
 * Opacity of one presenter clip at its local frame. The dissolve windows line up
 * with the scene transition overlap, so the outgoing clip (1 -> 0) and the
 * incoming clip (0 -> 1) sum to 1 across the seam and the pose jump is hidden.
 */
export function presenterOpacity(local, durationInFrames, dissolveInFrames = 0, dissolveOutFrames = 0) {
  let opacity = 1;
  // The dissolve window is the scene-transition overlap. Spanning it inclusively
  // (local/(L-1)) means the outgoing clip is fully opaque on its first overlapped
  // frame and fully transparent on its last, and the incoming mirrors it, so the
  // two opacities sum to exactly 1 across the seam and neither pops at the edge.
  if (dissolveInFrames > 1 && local < dissolveInFrames) {
    opacity = Math.min(opacity, local / (dissolveInFrames - 1));
  }
  const remaining = durationInFrames - 1 - local;
  if (dissolveOutFrames > 1 && remaining < dissolveOutFrames) {
    opacity = Math.min(opacity, Math.max(0, remaining) / (dissolveOutFrames - 1));
  }
  return Math.max(0, Math.min(1, opacity));
}

/** Whether this track entry is drawn by the overlay (split-left is the scene's own layout). */
export function isOverlayPlacement(placement) {
  return placement !== 'split-left';
}

/**
 * The disclosure chip's geometry (G6-11). On a circular mask a full-width chip
 * is cut by the arc at its bottom corners, so the chip is inset and lifted until
 * it sits inside a chord; 17% insets keep the default "AI presenter" label
 * inside the circle at every legal size. A rounded-rect card keeps it flush.
 */
export function presenterLabelStyle(shape = 'circle', fontSize = 24) {
  if (shape !== 'circle') {
    return { left: 0, right: 0, bottom: 0, padding: '8px 0', fontSize, letterSpacing: 1.5, borderRadius: 0 };
  }
  return {
    left: '17%',
    right: '17%',
    bottom: '10%',
    padding: '4px 0',
    fontSize: Math.max(13, Math.round(fontSize * 0.75)),
    letterSpacing: 1,
    borderRadius: 999,
  };
}
