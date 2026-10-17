import React from 'react';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import type { PackageV1, Scene } from '../../../packages/schema/types';
import type { Timeline, TimelineCaption } from '../../../packages/planner/dist/src/index.js';
import { GeneratedAssetsProvider, SceneView, type InlineAsset } from './components';
import { CaptionOverlay } from './captions';

/**
 * Composes the compiled timeline. Each scene is a TransitionSeries sequence; the
 * transition after it uses exactly the compiled `transitionOutFrames`, so the
 * composition duration equals timeline.durationInFrames.
 */
export function TimelinePlayer({
  pkg,
  timeline,
  scenes,
  captions,
  generatedAssets,
}: {
  pkg: PackageV1;
  timeline: Timeline;
  scenes?: Scene[];
  captions?: TimelineCaption[];
  generatedAssets?: Record<string, InlineAsset>;
}) {
  const list = (scenes ?? timeline.scenes) as unknown as Array<
    Scene & { durationInFrames: number; transitionOutFrames: number }
  >;
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
  const series = (
    <>
      <TransitionSeries>{children}</TransitionSeries>
      {captions && <CaptionOverlay captions={captions} />}
    </>
  );
  return generatedAssets ? <GeneratedAssetsProvider assets={generatedAssets}>{series}</GeneratedAssetsProvider> : series;
}

export function sceneById(timeline: Timeline, sceneId: string): Scene | undefined {
  return timeline.scenes.find(scene => scene.id === sceneId) as unknown as Scene | undefined;
}
