import React, { useEffect, useState } from 'react';
import { AbsoluteFill, cancelRender, continueRender, delayRender, staticFile, useVideoConfig } from 'remotion';
import { loadFont } from '@remotion/fonts';
import type { PackageV1, Scene } from '../../../packages/schema/types';
import {
  CODE_MIN_FONT_PX,
  DEFAULT_CHARS_PER_SECOND,
  caretVisible,
  codeExitStart,
  codeFontPx,
  codeTextBox,
  measureCode,
  typedCount,
} from '../../../packages/schema/src/code-layout.mjs';
import { highlightTokens, plainTokens } from './code-highlight.mjs';
import { exitDuration, prog } from './motion/primitives.js';
import { palette } from './theme';

/** Pinned OFL monospace. Loaded from the repo, never from a network font host. */
export const CODE_FONT_FAMILY = 'JetBrains Mono';

void loadFont({
  family: CODE_FONT_FAMILY,
  url: staticFile('fonts/JetBrainsMono-Regular.ttf'),
  weight: '400',
  style: 'normal',
  display: 'block',
});

type TokenLine = { content: string; color: string }[];

/**
 * LP2 code/terminal scene. Characters revealed at `frame` are a pure function
 * of the frame, the fps and chars/s, so the same frame is the same pixels.
 * Already-shown characters do not move. The caret blinks at 2.4 Hz by opacity
 * only. Highlighted lines are the one accent. The chrome is on screen at frame 0.
 */
export function CodeLayout({ scene, pkg, frame }: { scene: Scene; pkg: PackageV1; frame: number }) {
  const { width, height, fps } = useVideoConfig();
  const source = scene.code?.code ?? '';
  const language = scene.code?.language ?? 'text';
  const rate = scene.code?.typing?.charsPerSecond ?? DEFAULT_CHARS_PER_SECOND;
  const highlights = new Set(scene.code?.highlights ?? []);
  const [lines, setLines] = useState<TokenLine[] | null>(null);
  const colors = palette(pkg);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const handle = delayRender(`code-highlight-${scene.id}`);
    highlightTokens(source, language)
      .then(tokens => {
        if (cancelled) return;
        setLines(tokens);
        settled = true;
        continueRender(handle);
      })
      .catch(() => {
        if (cancelled) return;
        setLines(plainTokens(source));
        settled = true;
        continueRender(handle);
      });
    return () => {
      cancelled = true;
      if (!settled) cancelRender(handle);
    };
  }, [scene.id, source, language]);

  const font = Math.max(CODE_MIN_FONT_PX, codeFontPx(width));
  const box = codeTextBox(width, height);
  const shown = typedCount(frame, fps, rate, source.length);
  const caretOn = caretVisible(frame, fps);
  const exitAt = codeExitStart(source, fps, rate);
  const exitFrames = exitDuration(Math.min(Math.round(fps * 0.8), 24));
  const opacity = 1 - prog(frame, exitAt, exitFrames, 'exit');
  const fit = measureCode(source, width, height);
  const overflow = fit.lines > fit.maxLines || fit.longest > fit.maxChars;
  const rendered = lines ?? plainTokens(source);
  let cursor = 0;

  return (
    <AbsoluteFill style={{ background: '#243056', opacity }}>
      <div
        style={{
          position: 'absolute',
          left: box.x - 28 * (width / 1080),
          top: box.y - (56 + 28) * (width / 1080),
          width: box.width + 56 * (width / 1080),
          height: box.height + (56 + 56) * (width / 1080),
          borderRadius: 18,
          background: '#161b22',
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ height: 56 * (width / 1080), display: 'flex', alignItems: 'center', gap: 10, padding: '0 22px', background: '#0f141c' }}>
          <span style={{ width: 14, height: 14, borderRadius: 99, background: '#6d8cff' }} />
          <span style={{ width: 14, height: 14, borderRadius: 99, background: '#e6e8ee', opacity: 0.35 }} />
          <span style={{ width: 14, height: 14, borderRadius: 99, background: '#e6e8ee', opacity: 0.2 }} />
          <span style={{ marginLeft: 12, color: '#a9b0c0', fontFamily: CODE_FONT_FAMILY, fontSize: Math.max(16, font * 0.72) }}>{language}</span>
        </div>
        <div
          style={{
            flex: 1,
            padding: `${20 * (width / 1080)}px ${28 * (width / 1080)}px`,
            fontFamily: CODE_FONT_FAMILY,
            fontSize: font,
            lineHeight: 1.45,
            whiteSpace: 'pre',
            color: '#e6e8ee',
          }}
        >
          {rendered.map((line, lineIndex) => {
            const lineStart = cursor;
            const highlight = highlights.has(lineIndex + 1) && shown > lineStart;
            const body: React.ReactNode[] = [];
            if (cursor === shown) body.push(<Caret key="caret" on={caretOn} />);
            for (const token of line) {
              for (const ch of token.content) {
                const visible = cursor < shown;
                body.push(
                  <span key={cursor} style={{ color: visible ? token.color : 'transparent' }}>{ch === ' ' ? '\u00a0' : ch}</span>,
                );
                cursor += 1;
                if (cursor === shown) body.push(<Caret key="caret" on={caretOn} />);
              }
            }
            cursor += 1;
            return (
              <div key={lineIndex} style={{ background: highlight ? `${colors[2]}55` : 'transparent', minHeight: '1.45em' }}>
                {body}
              </div>
            );
          })}
        </div>
      </div>
      {overflow ? (
        <div
          style={{
            position: 'absolute',
            left: 48,
            right: 48,
            bottom: 28,
            padding: '14px 18px',
            borderRadius: 12,
            background: '#b00020',
            color: '#ffffff',
            fontFamily: CODE_FONT_FAMILY,
            fontSize: 22,
            fontWeight: 700,
            zIndex: 8,
          }}
        >
          RENDER FAIL — code does not fit scene {scene.id}: {fit.lines}/{fit.maxLines} lines, longest {fit.longest}/{fit.maxChars}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

function Caret({ on }: { on: boolean }) {
  return (
    <span style={{ display: 'inline-block', width: 0, position: 'relative' }}>
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: '0.12em',
          width: '0.12em',
          height: '1.05em',
          background: '#e6e8ee',
          opacity: on ? 1 : 0,
        }}
      />
    </span>
  );
}
