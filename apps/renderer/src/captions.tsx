import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import type { TimelineCaption } from '../../../packages/planner/dist/src/index.js';
import { FONT_FAMILY, SAFE_AREA } from './theme';

/**
 * Sentence-level captions from the compiled timeline. No word timestamps and
 * no karaoke highlight (SPEC 6.8): exactly one measured sentence at a time.
 */
export function CaptionOverlay({ captions }: { captions: TimelineCaption[] }) {
  const frame = useCurrentFrame();
  const cue = captions.find(item => frame >= item.from && frame < item.to);
  if (!cue) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 100 }}>
      <div
        style={{
          position: 'absolute',
          left: SAFE_AREA.x,
          right: SAFE_AREA.x,
          bottom: SAFE_AREA.y,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            maxWidth: 1400,
            padding: '18px 28px',
            borderRadius: 18,
            background: 'rgba(4, 6, 12, 0.78)',
            border: '1px solid rgba(230, 232, 238, 0.16)',
            color: '#f4f6fb',
            fontFamily: FONT_FAMILY,
            fontSize: 40,
            lineHeight: 1.28,
            fontWeight: 600,
            textAlign: 'center',
            textWrap: 'balance',
          }}
        >
          {cue.text}
        </div>
      </div>
    </AbsoluteFill>
  );
}
