import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { useFontFamily } from './theme';
import {
  lyricAtFrame,
  lyricTextSegments,
  lyricWordPopProgress,
  lyricWordPopScale,
  lyricsLayout,
} from './lyrics-model.js';

export type LyricWord = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  sourceStartSeconds?: number;
};

export type LyricCue = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  sourceStartSeconds?: number;
  sourceEndSeconds?: number;
  words?: LyricWord[];
};

export type ResolvedLyrics = {
  style: 'off' | 'caption' | 'reel';
  cues: LyricCue[];
  trim: { startSeconds: number; endSeconds: number } | null;
  avoidReactiveCard?: boolean;
};

type TextProps = {
  cue: LyricCue;
  activeWordIndex: number;
  songTime: number;
  reducedMotion: boolean;
  accent: string;
  pop: boolean;
};

/** React text children only: markup, whitespace and bidi text remain literal. */
function LyricText({ cue, activeWordIndex, songTime, reducedMotion, accent, pop }: TextProps) {
  return (
    <>
      {lyricTextSegments(cue).map((segment, index) => {
        const active = segment.wordIndex >= 0 && segment.wordIndex === activeWordIndex;
        const word = active ? cue.words?.[segment.wordIndex] : null;
        const progress = word ? lyricWordPopProgress(word, songTime, reducedMotion) : 1;
        const transform = pop && word && !reducedMotion ? `scale(${lyricWordPopScale(progress)})` : undefined;
        return (
          <span
            key={`${segment.wordIndex}-${index}`}
            data-lyric-word={segment.wordIndex >= 0 ? segment.wordIndex : undefined}
            data-active={active ? 'true' : undefined}
            style={{
              color: active ? accent : undefined,
              textShadow: active ? `0 0 22px ${accent}66` : undefined,
              display: pop && segment.wordIndex >= 0 ? 'inline-block' : undefined,
              transform,
              transformOrigin: transform ? 'center' : undefined,
            }}
          >
            {segment.text}
          </span>
        );
      })}
    </>
  );
}

const literalTextStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'normal',
  textAlign: 'center',
  boxSizing: 'border-box',
  maxWidth: '100%',
};

export function LyricCaption({
  cue,
  activeWordIndex,
  songTime,
  width,
  height,
  reducedMotion = false,
  avoidReactiveCard = false,
  accent = '#ffe08a',
}: Omit<TextProps, 'pop'> & { width: number; height: number; avoidReactiveCard?: boolean }) {
  const family = useFontFamily();
  const layout = lyricsLayout({ width, height, reducedMotion, avoidReactiveCard });
  return (
    <div
      data-lyrics-style="caption"
      style={{
        position: 'absolute',
        left: layout.safeArea.x,
        right: layout.safeArea.x,
        bottom: layout.caption.bottom,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        dir="auto"
        style={{
          ...literalTextStyle,
          width: 'fit-content',
          padding: `${layout.caption.paddingY}px ${layout.caption.paddingX}px`,
          borderRadius: Math.max(12, Math.round(layout.caption.fontSize * 0.42)),
          background: 'rgba(4, 6, 12, 0.86)',
          border: '1px solid rgba(230, 232, 238, 0.2)',
          boxShadow: '0 10px 34px rgba(0,0,0,0.36)',
          color: '#f7f8fc',
          fontFamily: family,
          fontSize: layout.caption.fontSize,
          lineHeight: layout.caption.lineHeight,
          fontWeight: 650,
        }}
      >
        <LyricText cue={cue} activeWordIndex={activeWordIndex} songTime={songTime} reducedMotion={reducedMotion} accent={accent} pop={false} />
      </div>
    </div>
  );
}

export function LyricReel({
  cue,
  activeWordIndex,
  songTime,
  width,
  height,
  reducedMotion = false,
  accent = '#ffe08a',
}: Omit<TextProps, 'pop'> & { width: number; height: number }) {
  const family = useFontFamily();
  const layout = lyricsLayout({ width, height, reducedMotion });
  return (
    <div
      data-lyrics-style="reel"
      style={{
        position: 'absolute',
        left: layout.safeArea.x,
        right: layout.safeArea.x,
        top: layout.reel.top,
        bottom: layout.reel.bottom,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        dir="auto"
        style={{
          ...literalTextStyle,
          color: '#ffffff',
          fontFamily: family,
          fontSize: layout.reel.fontSize,
          lineHeight: layout.reel.lineHeight,
          fontWeight: 850,
          letterSpacing: '-0.025em',
          textShadow: '0 3px 0 rgba(0,0,0,0.42), 0 8px 30px rgba(0,0,0,0.88), 0 0 3px rgba(0,0,0,0.9)',
        }}
      >
        <LyricText cue={cue} activeWordIndex={activeWordIndex} songTime={songTime} reducedMotion={reducedMotion} accent={accent} pop />
      </div>
    </div>
  );
}

/** One frame-driven implementation shared by Player, still, remote and MP4 export. */
export function LyricsOverlay({
  lyrics,
  reducedMotion = false,
  accent = '#ffe08a',
}: {
  lyrics: ResolvedLyrics | null;
  reducedMotion?: boolean;
  accent?: string;
}) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  if (!lyrics || lyrics.style === 'off') return null;
  const active = lyricAtFrame({ cues: lyrics.cues, trim: lyrics.trim, frame, fps });
  if (!active.cue) return null;
  return (
    <AbsoluteFill
      aria-live="off"
      data-lyrics-frame={frame}
      data-lyrics-cue={active.cueIndex}
      data-lyrics-word={active.wordIndex}
      style={{ pointerEvents: 'none', zIndex: 110 }}
    >
      {lyrics.style === 'caption' ? (
        <LyricCaption
          cue={active.cue}
          activeWordIndex={active.wordIndex}
          songTime={active.songTime}
          width={width}
          height={height}
          reducedMotion={reducedMotion}
          avoidReactiveCard={lyrics.avoidReactiveCard}
          accent={accent}
        />
      ) : (
        <LyricReel
          cue={active.cue}
          activeWordIndex={active.wordIndex}
          songTime={active.songTime}
          width={width}
          height={height}
          reducedMotion={reducedMotion}
          accent={accent}
        />
      )}
    </AbsoluteFill>
  );
}
