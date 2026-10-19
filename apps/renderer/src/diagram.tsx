import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import type { PackageV1, Scene } from '../../../packages/schema/types';
import { palette, textColors, useFontFamily } from './theme';
import { diagramState } from './diagram-model.js';

/** Speech-cued, frame-deterministic diagram cards. All labels remain package copy. */
export function MotionDiagram({ scene, pkg, frame }: { scene: Scene; pkg: PackageV1; frame: number }) {
  const { width, height, fps } = useVideoConfig();
  const family = useFontFamily();
  const colors = palette(pkg), text = textColors(pkg);
  const items = scene.copy?.items ?? [];
  const sceneFrames = (scene as Scene & { durationInFrames?: number }).durationInFrames ?? scene.preferredFrames ?? fps * 10;
  const state = diagramState({ frame, fps, sceneFrames, count: items.length, cues: scene.motion?.cue_seconds });
  const portrait = height > width;
  const hub = scene.motion?.diagram === 'hub' && !portrait;
  const cardW = portrait ? width * 0.72 : hub ? width * 0.29 : width * 0.82 / Math.max(1, items.length) - 24;
  const cardH = portrait ? height * 0.11 : height * 0.23;
  const points = items.map((_, i) => ({
    x: portrait ? width * 0.5 : hub ? width * (i % 2 ? 0.75 : 0.25) : width * 0.09 + (i + 0.5) * width * 0.82 / items.length,
    y: portrait ? height * 0.28 + i * height * 0.135 : hub ? height * (i < 2 ? 0.40 : 0.69) : height * 0.50,
  }));
  return <AbsoluteFill style={{ fontFamily: family, color: text.primary, zIndex: 8 }}>
    <div style={{ position: 'absolute', left: '8%', right: '8%', top: '10%' }}>
      <div style={{ color: colors[2], fontSize: width * 0.014, letterSpacing: 4, textTransform: 'uppercase', marginBottom: 18 }}>{scene.copy?.kicker ?? 'HOW IT WORKS'}</div>
      <div style={{ fontSize: Math.min(68, width * 0.039), fontWeight: 800, letterSpacing: -1.5 }}>{scene.copy?.headline}</div>
    </div>
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
      {points.map((p, i) => {
        if (!hub && i === 0) return null;
        const a = hub ? { x: width * 0.5, y: height * 0.545 } : points[i - 1];
        const reveal = state.cards[i].reveal;
        const travel = ((frame / fps * 0.22) + i * 0.17) % 1;
        return <g key={i} opacity={0.25 + reveal * 0.75}>
          <path d={`M${a.x},${a.y} L${p.x},${p.y}`} stroke={colors[2]} strokeWidth={3} strokeDasharray="8 10" strokeDashoffset={-frame * 0.7} />
          <circle cx={a.x + (p.x - a.x) * travel} cy={a.y + (p.y - a.y) * travel} r={7} fill={colors[2]} opacity={reveal} />
        </g>;
      })}
      {hub && <><circle cx={width * 0.5} cy={height * 0.545} r={width * 0.045} fill={colors[0]} stroke={colors[2]} strokeWidth={3}/><text x={width * 0.5} y={height * 0.545 + 9} textAnchor="middle" fontSize={26} fill={text.primary} fontWeight="700">{scene.copy?.cta ?? 'HUB'}</text></>}
    </svg>
    {points.map((p, i) => {
      const { reveal } = state.cards[i], active = state.active === i;
      return <div key={i} style={{ position: 'absolute', left: p.x - cardW / 2, top: p.y - cardH / 2 + (1 - reveal) * 28, width: cardW, height: cardH, padding: 28, boxSizing: 'border-box', borderRadius: 24, border: `2px solid ${active ? colors[2] : '#ffffff24'}`, background: `linear-gradient(135deg, ${colors[1]}, ${colors[0]})`, opacity: 0.22 + reveal * 0.78, boxShadow: active ? `0 0 45px ${colors[2]}22` : '0 20px 55px #0005', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 20 }}>
        <div style={{ color: colors[2], fontSize: 24, fontWeight: 700 }}>0{i + 1} {active ? '—' : ''}</div>
        <div style={{ fontSize: Math.min(34, cardW * 0.095), fontWeight: 700, lineHeight: 1.2 }}>{items[i]}</div>
        <div style={{ height: 3, width: `${reveal * 100}%`, background: colors[2], opacity: 0.7 }} />
      </div>;
    })}
    {scene.copy?.sub && <div style={{ position: 'absolute', left: '9%', right: '9%', top: hub ? '84%' : '72%', fontSize: 28, color: text.muted }}>{scene.copy.sub}</div>}
    <div style={{ position: 'absolute', bottom: 0, left: 0, height: 4, width: `${state.progress * 100}%`, background: colors[2] }} />
  </AbsoluteFill>;
}
