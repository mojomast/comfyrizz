import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import type { PackageV1, Scene } from '../../../../packages/schema/types';
import { palette, textColors } from '../theme';
import { prog } from '../motion/primitives.js';
import { resolveRecipe } from './model.js';
import { cueDiagnostic, sceneCuePlan } from './cues.js';
import { centeredSquare, visualArea } from './geometry.js';
import { sketchAnnotations, sketchPaths } from './sketch.js';
import { paperPlan, paperSettle, polygonPoints, rotatePoints } from './paper.js';
import { morphAt, morphTimeline } from './morph.js';
import { cornerBrackets, focusEntry, focusGeometry } from './focus.js';
import { TechnicalFlow } from './TechnicalFlow';

/**
 * AI2 recipe decor layer. It sits above the scene background and below the
 * layout copy (zIndex 2.5), so text, media panels, the presenter and captions
 * keep their existing stacking. A scene without a known recipe renders nothing.
 */
export function RecipeLayer({ scene, pkg, frame }: { scene: Scene; pkg: PackageV1; frame: number }) {
  const recipe = resolveRecipe(scene);
  if (recipe.recipe === 'sketch') {
    // A list scene owns its aligned text + card geometry in SketchListLayout.
    return scene.layout === 'list' ? null : <SketchLayer scene={scene} pkg={pkg} frame={frame} recipe={recipe} />;
  }
  if (recipe.recipe === 'paper-cut') return <PaperLayer scene={scene} pkg={pkg} frame={frame} recipe={recipe} />;
  if (recipe.recipe === 'morph') return <MorphLayer scene={scene} pkg={pkg} frame={frame} recipe={recipe} />;
  if (recipe.recipe === 'focus') return <FocusLayer scene={scene} pkg={pkg} frame={frame} recipe={recipe} />;
  if (recipe.recipe === 'technical-flow' && scene.layout !== 'list') {
    return <TechnicalFlow scene={scene} pkg={pkg} frame={frame} compact />;
  }
  return null;
}

type Recipe = ReturnType<typeof resolveRecipe>;

function SketchLayer({ scene, pkg, frame, recipe }: { scene: Scene; pkg: PackageV1; frame: number; recipe: Recipe }) {
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const colors = palette(pkg);
  const text = textColors(pkg);
  const items = Array.isArray(scene.copy?.items) ? scene.copy.items : [];
  const cuePlan = sceneCuePlan({ scene, fps, count: items.length, sceneFrames: durationInFrames });
  const diagnostic = cueDiagnostic(scene, cuePlan);
  const annotations = sketchAnnotations(scene, width, height, recipe.seed, recipe.intensity, cuePlan.frames);
  const paths = sketchPaths(annotations, { stroke: text.primary, accent: colors[2], fill: colors[1] });
  return (
    <AbsoluteFill
      style={{ pointerEvents: 'none', zIndex: 2.5 }}
      data-recipe="sketch"
      data-cue-source={cuePlan.source}
      data-cue-fallback={cuePlan.fallback ? 'true' : 'false'}
      data-cue-missing={diagnostic ? diagnostic.missing.join(' | ') : undefined}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: 'absolute', inset: 0 }}>
        {paths.map((path, index) => {
          const start = path.startFrame !== null && path.startFrame !== undefined ? path.startFrame : 3 + path.order * 1.8;
          const draw = prog(frame, start, 24, 'enter');
          const common = {
            d: path.d,
            fill: path.fill,
            stroke: path.stroke,
            strokeWidth: path.strokeWidth,
            strokeLinecap: 'round' as const,
            strokeLinejoin: 'round' as const,
            opacity: draw > 0 ? 1 : 0,
          };
          if (path.draw) {
            return (
              <path
                key={`${path.order}-${index}`}
                {...common}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - draw}
                fillOpacity={path.fill === 'none' ? 0 : draw * 0.35}
              />
            );
          }
          return <path key={`${path.order}-${index}`} {...common} fillOpacity={draw * 0.86} />;
        })}
      </svg>
    </AbsoluteFill>
  );
}

function PaperLayer({ scene, pkg, frame, recipe }: { scene: Scene; pkg: PackageV1; frame: number; recipe: Recipe }) {
  const { width, height } = useVideoConfig();
  const colors = palette(pkg);
  const { sheets, pieces } = paperPlan({ scene, width, height, seed: recipe.seed, intensity: recipe.intensity });
  const settle = prog(frame, 0, 30, 'enter');
  const drawShape = (shape: (typeof sheets)[number], index: number) => {
    const state = paperSettle(settle, shape.order);
    const cx = shape.points.reduce((sum, [x]) => sum + x, 0) / Math.max(1, shape.points.length);
    const cy = shape.points.reduce((sum, [, y]) => sum + y, 0) / Math.max(1, shape.points.length);
    const points = rotatePoints(shape.points, shape.rotate, cx, cy);
    return (
      <g
        key={`${shape.order}-${index}`}
        transform={`translate(${state.dx} ${state.dy})`}
        opacity={state.opacity}
        filter={shape.shadow ? 'url(#comfyrizz-paper-shadow)' : undefined}
      >
        <polygon
          points={polygonPoints(points)}
          fill={colors[shape.tone % colors.length]}
          opacity={shape.opacity}
          stroke="rgba(255,255,255,0.1)"
          strokeWidth={1.5}
        />
        {shape.tape ? (
          <>
            <rect x={shape.x - 4} y={shape.y - 14} width={Math.max(36, shape.points[4][0] - shape.x) * 0.24} height={22} rx={3} fill={colors[2]} opacity={0.55} transform={`rotate(-5 ${shape.x} ${shape.y})`} />
            <rect x={shape.x + Math.max(42, shape.points[5][0] - shape.x) * 0.7} y={shape.y - 12} width={Math.max(34, shape.points[4][0] - shape.x) * 0.2} height={20} rx={3} fill={colors[2]} opacity={0.4} transform={`rotate(4 ${shape.x} ${shape.y})`} />
          </>
        ) : null}
      </g>
    );
  };
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 2.5 }} data-recipe="paper-cut">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <filter id="comfyrizz-paper-shadow" x="-20%" y="-20%" width="140%" height="160%">
            <feDropShadow dx="0" dy="14" stdDeviation="12" floodColor="#000000" floodOpacity="0.38" />
          </filter>
        </defs>
        {pieces.map(drawShape)}
        {sheets.map(drawShape)}
      </svg>
    </AbsoluteFill>
  );
}

function MorphLayer({ scene, pkg, frame, recipe }: { scene: Scene; pkg: PackageV1; frame: number; recipe: Recipe }) {
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const colors = palette(pkg);
  const area = visualArea(scene, width, height);
  const timelineCues = (scene as Scene & { motionCues?: Array<{ phrase?: string }> }).motionCues;
  const phrases = recipe.cuePhrases.length > 0
    ? recipe.cuePhrases
    : (timelineCues ?? []).map(cue => cue.phrase).filter((phrase): phrase is string => typeof phrase === 'string');
  const cuePlan = sceneCuePlan({ scene, fps, count: Math.min(2, phrases.length), sceneFrames: durationInFrames });
  cueDiagnostic(scene, cuePlan);
  const timeline = morphTimeline({ frame, fps, sceneFrames: durationInFrames, cues: cuePlan.seconds });
  const shape = morphAt({ from: recipe.morph.from, to: recipe.morph.to, seed: recipe.seed, progress: timeline.progress });
  const enter = prog(frame, 2, 18, 'enter');
  const stroke = colors[2];
  // Keep the 100x100 shape square: scale uniformly to the smaller side and
  // centre it in the available region. Stretching x/y independently made a
  // circle a tall rectangle in landscape and a flat ellipse in portrait.
  const square = centeredSquare(area, 0.92, 60);
  const offsetX = square.x;
  const offsetY = square.y;
  const size = square.size;
  return (
    <AbsoluteFill
      style={{ pointerEvents: 'none', zIndex: 2.5 }}
      data-recipe="morph"
      data-cue-source={cuePlan.source}
      data-cue-fallback={cuePlan.fallback ? 'true' : 'false'}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: 'absolute', inset: 0 }}
      >
        <g transform={`translate(${offsetX} ${offsetY}) scale(${size / 100})`} opacity={enter}>
          <path d={shape.fromPath} fill="none" stroke={colors[3]} strokeWidth={0.7} strokeDasharray="2 3" opacity={0.3} />
          <path d={shape.toPath} fill="none" stroke={colors[2]} strokeWidth={0.7} strokeDasharray="1 4" opacity={0.28} />
          <path
            d={shape.d}
            fill={colors[2]}
            fillOpacity={0.22 + recipe.intensity * 0.18}
            stroke={stroke}
            strokeWidth={1.2 + recipe.intensity * 1.1}
            strokeLinejoin="round"
          />
          <circle cx={50} cy={50} r={1.4} fill={colors[3]} opacity={0.7} />
        </g>
      </svg>
    </AbsoluteFill>
  );
}

function FocusLayer({ scene, pkg, frame, recipe }: { scene: Scene; pkg: PackageV1; frame: number; recipe: Recipe }) {
  const { width, height } = useVideoConfig();
  const colors = palette(pkg);
  const geometry = focusGeometry({ focus: recipe.focus, width, height, intensity: recipe.intensity, seed: recipe.seed });
  const entry = focusEntry({ frame });
  const cx = geometry.rect.x + geometry.rect.w / 2;
  const cy = geometry.rect.y + geometry.rect.h / 2;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 2.5 }} data-recipe="focus">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: 'absolute', inset: 0 }}>
        <path d={geometry.path} fillRule="evenodd" fill="#05070d" opacity={geometry.dim * entry.opacity} />
        <g transform={`translate(${cx} ${cy}) scale(${entry.scale}) translate(${-cx} ${-cy})`}>
          <rect
            x={geometry.rect.x}
            y={geometry.rect.y}
            width={geometry.rect.w}
            height={geometry.rect.h}
            rx={geometry.radius}
            fill="none"
            stroke={colors[2]}
            strokeWidth={geometry.strokeWidth}
            opacity={entry.opacity * 0.9}
          />
          {cornerBrackets(geometry).map((path, index) => (
            <path key={index} d={path} fill="none" stroke={colors[3]} strokeWidth={geometry.strokeWidth} strokeLinecap="round" opacity={entry.opacity} />
          ))}
        </g>
      </svg>
    </AbsoluteFill>
  );
}
