import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TimelineCaption, TimelineWord } from '../../../packages/planner/dist/src/index.js';
import type { PackageV1 } from '../../../packages/schema/types';
import { SAFE_AREA, useFontFamily } from './theme';
import { activeWordIndex, captionWords, resolveCaptionStyle, wordPopProgress, wordPopScale } from './caption-model.js';

/**
 * Sentence-level captions from the compiled timeline (SPEC 6.8). The default
 * `sentence` style is unchanged: exactly one measured sentence at a time.
 *
 * K1 adds `karaoke` (highlight the spoken word), `word-pop` (each word pops in)
 * and `big-word` (one large word at a time, the default for 9:16 when
 * `captions.style` is absent). Word cues come from measured narration; a cue
 * without them falls back to the whole sentence.
 */
export function CaptionOverlay({ captions, pkg }: { captions: TimelineCaption[]; pkg?: PackageV1 }) {
  const family = useFontFamily();
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const cue = captions.find(item => frame >= item.from && frame < item.to);
  if (!cue) return null;
  const style = resolveCaptionStyle(pkg, { width, height });
  const words = captionWords(cue) as TimelineWord[];
  const active = activeWordIndex(words, frame);
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
        {style === 'sentence' ? (
          <div
            style={{
              maxWidth: 1400,
              padding: '18px 28px',
              borderRadius: 18,
              background: 'rgba(4, 6, 12, 0.78)',
              border: '1px solid rgba(230, 232, 238, 0.16)',
              color: '#f4f6fb',
              fontFamily: family,
              fontSize: 40,
              lineHeight: 1.28,
              fontWeight: 600,
              textAlign: 'center',
              textWrap: 'balance',
            }}
          >
            {cue.text}
          </div>
        ) : style === 'big-word' ? (
          <div
            style={{
              maxWidth: 1400,
              padding: '18px 28px',
              borderRadius: 18,
              background: 'rgba(4, 6, 12, 0.78)',
              border: '1px solid rgba(230, 232, 238, 0.16)',
              color: '#f4f6fb',
              fontFamily: family,
              fontSize: 96,
              lineHeight: 1.12,
              fontWeight: 800,
              textAlign: 'center',
              textTransform: 'uppercase',
              letterSpacing: '-0.01em',
            }}
          >
            {active >= 0 ? words[active].text : cue.text}
          </div>
        ) : (
          <div
            style={{
              maxWidth: 1400,
              padding: '18px 28px',
              borderRadius: 18,
              background: 'rgba(4, 6, 12, 0.78)',
              border: '1px solid rgba(230, 232, 238, 0.16)',
              color: '#f4f6fb',
              fontFamily: family,
              fontSize: 44,
              lineHeight: 1.28,
              fontWeight: 700,
              textAlign: 'center',
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              columnGap: '0.32em',
              rowGap: '0.12em',
            }}
          >
            {words.map((word, index) => {
              // word-pop: a word appears and scales up as it is spoken; later words stay hidden.
              if (style === 'word-pop') {
                if (index > active) return null;
                const progress = wordPopProgress(word, frame);
                return (
                  <span
                    key={`${word.text}-${index}`}
                    style={{
                      display: 'inline-block',
                      transform: `scale(${wordPopScale(progress)})`,
                      opacity: Math.min(1, progress + 0.25),
                    }}
                  >
                    {word.text}
                  </span>
                );
              }
              // karaoke: the whole sentence stays up; the spoken word is highlighted.
              return (
                <span
                  key={`${word.text}-${index}`}
                  style={
                    index === active
                      ? { color: '#ffe08a', textShadow: '0 0 18px rgba(255, 224, 138, 0.55)' }
                      : { color: '#f4f6fb' }
                  }
                >
                  {word.text}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}
