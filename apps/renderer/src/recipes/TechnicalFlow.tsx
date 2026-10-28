import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import type { PackageV1, Scene } from '../../../../packages/schema/types';
import { palette, textColors, useFontFamily } from '../theme';
import { SAFE_PX, visualArea } from './geometry';
import { resolveRecipe } from './model.js';
import { cueDiagnostic, sceneCuePlan } from './cues.js';
import { flowState, packetProgress, pointOnPolyline, technicalFlowPlan } from './technical-flow.js';

/**
 * AI2 technical-flow layout for a list scene. Replaces the bullet list, not the
 * headline contract: `copy.items` are the editable graph nodes and the headline
 * stays at the top. Dagre computes the graph once; packets are analytic.
 *
 * `compact` renders the same graph inside the recipe's free visual area for a
 * hero/chart/code scene, leaving that scene's own layout/copy intact.
 */
export function TechnicalFlow({ scene, pkg, frame, compact = false }: { scene: Scene; pkg: PackageV1; frame: number; compact?: boolean }) {
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const family = useFontFamily();
  const colors = palette(pkg);
  const text = textColors(pkg);
  const recipe = resolveRecipe(scene);
  const items = (scene.copy?.items ?? []).map(item => String(item));
  if (items.length < 2) return null;
  const cuePlan = sceneCuePlan({ scene, fps, count: items.length, sceneFrames: durationInFrames });
  const diagnostic = cueDiagnostic(scene, cuePlan);
  const compactArea = compact ? visualArea(scene, width, height) : null;
  const plan = technicalFlowPlan({
    items,
    width,
    height,
    scene,
    seed: recipe.seed,
    cues: cuePlan.seconds,
    fps,
    area: compactArea,
    rankdir: compactArea ? (compactArea.h > compactArea.w ? 'TB' : 'LR') : null,
  });
  const state = flowState({ frame, fps, sceneFrames: durationInFrames, count: items.length, cues: cuePlan.seconds });
  const kicker = scene.copy?.kicker ?? 'HOW IT WORKS';
  const headline = scene.copy?.headline;
  const headlinePx = Math.max(38, Math.min(width * 0.038, 68));
  return (
    <AbsoluteFill
      style={{ fontFamily: family, color: text.primary, zIndex: compact ? 2.5 : 7 }}
      data-recipe="technical-flow"
      data-cue-source={cuePlan.source}
      data-cue-fallback={cuePlan.fallback ? 'true' : 'false'}
      data-cue-missing={diagnostic ? diagnostic.missing.join(' | ') : undefined}
    >
      {!compact ? (
        <div style={{ position: 'absolute', left: SAFE_PX.x, right: SAFE_PX.x, top: Math.max(SAFE_PX.y * 0.7, height * 0.055) }}>
          <div style={{ color: colors[2], fontSize: Math.max(18, width * 0.013), letterSpacing: 3, textTransform: 'uppercase', fontWeight: 700, marginBottom: 10 }}>
            {kicker}
          </div>
          {headline ? (
            <div style={{ fontSize: headlinePx, fontWeight: 800, letterSpacing: -1.2, lineHeight: 1.05, maxWidth: width * 0.82 }}>{headline}</div>
          ) : null}
        </div>
      ) : null}
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: 'absolute', inset: 0 }}>
        {plan.edges.map((edge, index) => {
          const fromReveal = state.cards[index]?.reveal ?? 0;
          const reveal = Math.min(1, fromReveal * 1.15);
          const packet = packetProgress({ frame, start: edge.start, duration: edge.duration, offset: edge.offset });
          const secondPacket = packetProgress({ frame, start: edge.start, duration: edge.duration, offset: (edge.offset + 0.47) % 1 });
          const stroke = index === state.active - 1 ? colors[2] : text.primary;
          return (
            <g key={edge.key} opacity={0.24 + reveal * 0.7}>
              <path
                d={edge.path}
                fill="none"
                stroke={stroke}
                strokeWidth={index === state.active - 1 ? Math.max(4, width * 0.0028) : Math.max(2.4, width * 0.0018)}
                strokeLinecap="round"
                strokeDasharray={index === state.active - 1 ? undefined : '10 12'}
                pathLength={1}
                strokeDashoffset={1 - reveal}
              />
              <polygon
                points="0,0 -12,-5.5 -12,5.5"
                fill={stroke}
                opacity={reveal}
                transform={`translate(${edge.arrow.x} ${edge.arrow.y}) rotate(${(edge.arrow.angle * 180) / Math.PI})`}
              />
              {packet !== null ? (
                <>
                  <circle cx={pointOnPolyline(edge.points, packet).x} cy={pointOnPolyline(edge.points, packet).y} r={Math.max(5, width * 0.004)} fill={colors[2]} opacity={0.9} />
                  {secondPacket !== null ? (
                    <circle cx={pointOnPolyline(edge.points, secondPacket).x} cy={pointOnPolyline(edge.points, secondPacket).y} r={Math.max(3, width * 0.0027)} fill={colors[3]} opacity={0.55} />
                  ) : null}
                </>
              ) : null}
            </g>
          );
        })}
      </svg>
      {plan.nodes.map((node, index) => {
        const reveal = state.cards[index]?.reveal ?? 0;
        const active = state.active === index;
        const compactNode = compact === true;
        return (
          <div
            key={node.id}
            style={{
              position: 'absolute',
              left: node.x,
              top: node.y,
              width: node.w,
              height: node.h,
              boxSizing: 'border-box',
              padding: `${Math.max(compactNode ? 7 : 12, node.h * (compactNode ? 0.1 : 0.12))}px ${Math.max(compactNode ? 9 : 14, node.w * 0.06)}px`,
              borderRadius: Math.max(compactNode ? 9 : 14, Math.min(24, node.h * 0.16)),
              border: `${active ? 3 : 2}px solid ${active ? colors[2] : 'rgba(255,255,255,0.18)'}`,
              background: `linear-gradient(135deg, ${colors[1]}f2, ${colors[0]}f2)`,
              boxShadow: active ? `0 0 42px ${colors[2]}33, 0 18px 44px rgba(0,0,0,0.32)` : '0 14px 36px rgba(0,0,0,0.28)',
              opacity: 0.38 + reveal * 0.62,
              transform: `translateY(${(1 - reveal) * 20}px)`,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: Math.max(compactNode ? 2 : 5, node.h * 0.055),
              overflow: 'hidden',
            }}
          >
            <div style={{ color: colors[2], fontSize: Math.max(compactNode ? 9 : 13, node.h * 0.13), fontWeight: 800, letterSpacing: 1.4 }}>
              0{index + 1}
              {active ? ' · ACTIVE' : ''}
            </div>
            <div style={{ fontSize: Math.max(compactNode ? 11 : 16, Math.min(node.w * 0.105, node.h * 0.23)), fontWeight: 700, lineHeight: 1.18, overflowWrap: 'anywhere' }}>
              {node.label}
            </div>
            <div style={{ height: Math.max(2, node.h * 0.018), width: `${Math.round(reveal * 100)}%`, background: colors[2], opacity: 0.72 }} />
          </div>
        );
      })}
    </AbsoluteFill>
  );
}
