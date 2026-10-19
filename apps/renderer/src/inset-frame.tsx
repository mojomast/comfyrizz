import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import type { ForegroundItem } from '../../../packages/schema/types';
import { fadeUp } from './motion/primitives.js';
import { presenterBox } from './presenter-model.js';

/**
 * LP2 inset / picture-in-picture frame.
 *
 * Placement, size and mask come from the same `presenterBox` the presenter
 * overlay already uses (pip-br, pip-bl, pip-bc, split-left; 18-32% of the
 * short side; circle or rounded-rect). The ring is 3 px and the shadow is
 * soft, so a presenter overlay can wrap its clip in this component later
 * without a second geometry. This file does not edit the presenter overlay.
 */
export function InsetFrame({
  placement = 'pip-br',
  mask = 'rounded-rect',
  size = 0.24,
  ringColor = '#6d8cff',
  children,
}: {
  placement?: ForegroundItem['placement'];
  mask?: ForegroundItem['mask'];
  size?: number;
  ringColor?: string;
  children: React.ReactNode;
}) {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const box = presenterBox({
    placement: placement ?? 'pip-br',
    shape: mask === 'circle' ? 'circle' : 'rounded-rect',
    size: size ?? 0.24,
    width,
    height,
  });
  // Short enter, never longer than 0.8 s. The plate behind this frame is
  // already on screen at frame 0, so the scene is never an empty frame.
  const enter = fadeUp({ frame, fps, delay: 0, duration: Math.min(14, Math.round(0.45 * fps)), distance: 18 });
  return (
    <div
      style={{
        position: 'absolute',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        opacity: enter.opacity,
        transform: `translateY(${enter.translateY}px)`,
        borderRadius: box.radius,
        overflow: 'hidden',
        zIndex: 12,
        boxShadow: `0 0 0 3px ${ringColor}, 0 24px 60px rgba(0,0,0,0.45)`,
      }}
    >
      {children}
    </div>
  );
}
