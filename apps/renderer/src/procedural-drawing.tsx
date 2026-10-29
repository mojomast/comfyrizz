import React from 'react';
import { useCurrentFrame } from 'remotion';
import type { Scene } from '../../../packages/schema/types';
import { drawingProgress, pointAlong } from './procedural-drawing-model.js';
import { useFontFamily } from './theme';

type DrawingElement = { color: string; start: number; end: number; opacity?: number } & (
  | { type: 'path'; points: number[][]; width: number; marker?: boolean; erase?: boolean }
  | { type: 'polygon'; points: number[][] }
  | { type: 'text'; x: number; y: number; text: string; size: number }
  | { type: 'rect'; x: number; y: number; width: number; height: number }
  | { type: 'circle'; x: number; y: number; radius: number }
);

export function ProceduralDrawing({ drawing }: { drawing: NonNullable<Scene['drawing']> }) {
  const frame = useCurrentFrame();
  const family = useFontFamily();
  return <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{ position: 'absolute', width: '100%', height: '100%', background: drawing.background }}>
    {(drawing.elements as DrawingElement[]).map((element, i) => {
      const progress = drawingProgress(element, frame);
      if (element.type === 'path') {
        const points = element.points.map(p => p.join(',')).join(' ');
        const marker = pointAlong(element.points, progress);
        return <g key={i} opacity={element.opacity ?? 1}>
          <polyline points={points} fill="none" stroke={element.color} strokeWidth={element.width} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={element.erase ? -progress : 1 - progress} />
          {element.marker && frame >= element.start && frame <= element.end && <circle cx={marker[0]} cy={marker[1]} r={Math.max(4, element.width * 1.5)} fill={element.color} />}
        </g>;
      }
      const opacity = progress * (element.opacity ?? 1);
      if (element.type === 'polygon') return <polygon key={i} points={element.points.map(p => p.join(',')).join(' ')} fill={element.color} opacity={opacity} />;
      if (element.type === 'text') return <text key={i} x={element.x} y={element.y} fontFamily={family} fontSize={element.size} fill={element.color} opacity={opacity}>{element.text}</text>;
      if (element.type === 'rect') return <rect key={i} x={element.x} y={element.y} width={element.width} height={element.height} fill={element.color} opacity={opacity} />;
      return <circle key={i} cx={element.x} cy={element.y} r={element.radius} fill={element.color} opacity={opacity} />;
    })}
  </svg>;
}
