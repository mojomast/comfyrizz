import React from 'react';
import {
  TransitionSeries,
  linearTiming,
} from '@remotion/transitions';
import { useVideoConfig } from 'remotion';
import type { PackageV1, Scene } from '../../../packages/schema/types';
import type { Timeline, TimelineCaption } from '../../../packages/planner/dist/src/index.js';
import { GeneratedAssetsProvider, SceneView, type InlineAsset } from './components';
import { PresenterOverlay } from './presenter';
import type { TimelinePresenter } from '../../../packages/planner/dist/src/index.js';
import { mergeScenes } from './timeline-model.js';
import { presentationFor } from './motion/presentations';
import type { MediaSidecar } from './media';
import { MediaDimsProvider, MissingMediaProvider, type MediaDimsMap } from './media';
import { CaptionOverlay } from './captions';
import { FontFamilyContext, brandFontFamily, ensureBrandFonts } from './theme';

/**
 * Composes the compiled timeline. Each scene is a TransitionSeries sequence; the
 * transition after it uses exactly the compiled `transitionOutFrames`, so the
 * composition duration equals timeline.durationInFrames. Transitions push the
 * scenes past each other (U1) instead of cross-fading them: a fade left the
 * outgoing headline ghosted over the incoming one.
 */
export function TimelinePlayer({
  pkg,
  timeline,
  scenes,
  captions,
  presenters,
  generatedAssets,
  media,
  missingMedia,
  mediaDims,
}: {
  pkg: PackageV1;
  timeline: Timeline;
  scenes?: Scene[];
  captions?: TimelineCaption[];
  presenters?: TimelinePresenter[];
  generatedAssets?: Record<string, InlineAsset>;
  media?: MediaSidecar;
  missingMedia?: string[];
  mediaDims?: MediaDimsMap;
}) {
  // Merge the package's copy/transition vocabulary over the committed timing. The
  // timeline alone has overlap frames but no transition types, so without this every
  // export would silently drop its transitions and truncate the tail.
  const list = (scenes ?? mergeScenes(pkg, timeline)) as unknown as Array<
    Scene & { durationInFrames: number; transitionOutFrames: number }
  >;
  const { width, height } = useVideoConfig();
  // B1: load any brand fonts before measuring, and typeset the whole run with
  // the kit's first family (Inter when the kit has none).
  ensureBrandFonts(pkg);
  const fontFamily = brandFontFamily(pkg);
  const children: React.ReactNode[] = [];
  list.forEach((scene, index) => {
    children.push(
      <TransitionSeries.Sequence key={scene.id} durationInFrames={scene.durationInFrames}>
        <SceneView scene={scene} pkg={pkg} media={media} />
      </TransitionSeries.Sequence>,
    );
    const transition = scene.transitionOutFrames ?? 0;
    const presentation = presentationFor(scene.transitionOut, pkg.motion?.direction, width, height);
    if (index < list.length - 1 && transition > 0 && presentation) {
      children.push(
        <TransitionSeries.Transition
          key={`${scene.id}-transition`}
          presentation={presentation}
          timing={linearTiming({ durationInFrames: transition })}
        />,
      );
    }
  });
  const series = (
    <FontFamilyContext.Provider value={fontFamily}>
      <TransitionSeries>{children}</TransitionSeries>
      {/* P-pres: presenter above the scene stack, captions (z 100) above both. */}
      <PresenterOverlay presenters={presenters ?? timeline.presenters} pkg={pkg} />
      {captions && <CaptionOverlay captions={captions} pkg={pkg} />}
    </FontFamilyContext.Provider>
  );
  return generatedAssets ? (
    <GeneratedAssetsProvider assets={generatedAssets}>
      <MediaDimsProvider dims={mediaDims}>
        <MissingMediaProvider files={missingMedia}>{series}</MissingMediaProvider>
      </MediaDimsProvider>
    </GeneratedAssetsProvider>
  ) : (
    <MediaDimsProvider dims={mediaDims}>
      <MissingMediaProvider files={missingMedia}>{series}</MissingMediaProvider>
    </MediaDimsProvider>
  );
}

export function sceneById(timeline: Timeline, sceneId: string): Scene | undefined {
  return timeline.scenes.find(scene => scene.id === sceneId) as unknown as Scene | undefined;
}
