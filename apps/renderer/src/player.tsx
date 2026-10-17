import React from 'react';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import type { PackageV1, Scene } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import { SceneView } from './components';

/**
 * Composes the compiled timeline. Each scene is a TransitionSeries sequence; the
 * transition after it uses exactly the compiled `transitionOutFrames`, so the
 * composition duration equals timeline.durationInFrames.
 */
export function TimelinePlayer({ pkg, timeline, scenes }: { pkg: PackageV1; timeline: Timeline; scenes?: Scene[] }) {
  const list = scenes ?? timeline.scenes;
  const children: React.ReactNode[] = [];
  list.forEach((scene, index) => {
    children.push(
      <TransitionSeries.Sequence key={scene.id} durationInFrames={scene.durationInFrames}>
        <SceneView scene={scene} pkg={pkg} />
      </TransitionSeries.Sequence>,
    );
    const transition = scene.transitionOutFrames ?? 0;
    if (index < list.length - 1 && transition > 0) {
      children.push(
        <TransitionSeries.Transition
          key={`${scene.id}-transition`}
          presentation={fade()}
          timing={linearTiming({ durationInFrames: transition })}
        />,
      );
    }
  });
  return <TransitionSeries>{children}</TransitionSeries>;
}

export function sceneById(timeline: Timeline, sceneId: string): Scene | undefined {
  return timeline.scenes.find(scene => scene.id === sceneId);
}
