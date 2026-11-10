import React from 'react';
import {
  TransitionSeries,
  linearTiming,
} from '@remotion/transitions';
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { PackageV1, Scene } from '../../../packages/schema/types';
import type { Timeline, TimelineCaption } from '../../../packages/planner/dist/src/index.js';
import { GeneratedAssetsProvider, SceneView, type InlineAsset } from './components';
import { PresenterOverlay } from './presenter';
import type { TimelinePresenter } from '../../../packages/planner/dist/src/index.js';
import { mergeScenes } from './timeline-model.js';
import { selectMoneyShot } from './money-shot.js';
import { presentationFor } from './motion/presentations';
import type { MediaSidecar } from './media';
import { MediaDimsProvider, MissingMediaProvider, type MediaDimsMap } from './media';
import { CaptionOverlay } from './captions';
import { LyricsOverlay, type ResolvedLyrics } from './lyrics';
import { FontFamilyContext, brandFontFamily, ensureBrandFonts } from './theme';
import { ProceduralDrawing } from './procedural-drawing';
import { SceneFrameProvider } from './scene-frame';

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
  lyrics,
  reducedMotion = false,
  moneyShot,
  presenters,
  generatedAssets,
  media,
  missingMedia,
  mediaDims,
  fontSources,
}: {
  pkg: PackageV1;
  timeline: Timeline;
  scenes?: Scene[];
  captions?: TimelineCaption[];
  lyrics?: ResolvedLyrics | null;
  reducedMotion?: boolean;
  /** Default on. Pass false to keep entrances starting from an empty frame. */
  moneyShot?: boolean;
  presenters?: TimelinePresenter[];
  generatedAssets?: Record<string, InlineAsset>;
  media?: MediaSidecar;
  missingMedia?: string[];
  mediaDims?: MediaDimsMap;
  fontSources?: Record<string, string> | null;
}) {
  // Merge the package's copy/transition vocabulary over the committed timing. The
  // timeline alone has overlap frames but no transition types, so without this every
  // export would silently drop its transitions and truncate the tail.
  const list = (scenes ?? mergeScenes(pkg, timeline)) as unknown as Array<
    Scene & { durationInFrames: number; transitionOutFrames: number }
  >;
  const shot = selectMoneyShot(pkg, { ...timeline, scenes: list }, { moneyShot });
  const hero = shot.coldOpen ? list.find(scene => scene.id === shot.sceneId) : undefined;
  const { width, height } = useVideoConfig();
  // B1: load any brand fonts before measuring, and typeset the whole run with
  // the kit's first family (Inter when the kit has none).
  ensureBrandFonts(pkg, fontSources);
  const fontFamily = brandFontFamily(pkg);
  const children: React.ReactNode[] = [];
  list.forEach((scene, index) => {
    children.push(
      <TransitionSeries.Sequence key={scene.id} durationInFrames={scene.durationInFrames}>
        <OpenedScene scene={scene} pkg={pkg} media={media} settleFrame={index === 0 ? shot.openingSettle : 0} />
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
      {hero && shot.holdFrames > 0 ? <ColdOpen scene={hero} pkg={pkg} media={media} settleFrame={shot.settleFrame} holdFrames={shot.holdFrames} /> : null}
      {/* P-pres: presenter above the scene stack, captions (z 100) above both. */}
      <PresenterOverlay presenters={presenters ?? timeline.presenters} pkg={pkg} />
      {captions && <CaptionOverlay captions={captions} pkg={pkg} />}
      {lyrics && <LyricsOverlay lyrics={lyrics} reducedMotion={reducedMotion} />}
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

function SceneBody({ scene, pkg, media }: { scene: Scene; pkg: PackageV1; media?: MediaSidecar }) {
  return scene.drawing ? <ProceduralDrawing drawing={scene.drawing} /> : <SceneView scene={scene} pkg={pkg} media={media} />;
}

/** Hold the opening scene on its settled frame until the real clock arrives. */
function OpenedScene({ scene, pkg, media, settleFrame }: { scene: Scene; pkg: PackageV1; media?: MediaSidecar; settleFrame: number }) {
  const frame = useCurrentFrame();
  const body = <SceneBody scene={scene} pkg={pkg} media={media} />;
  if (settleFrame <= 0 || frame >= settleFrame) return body;
  return <SceneFrameProvider frame={settleFrame}>{body}</SceneFrameProvider>;
}

/**
 * Picture-only cold open of a later hero. The composition frame does not move,
 * so narration that starts at frame 0 is still at frame 0 when the hold ends.
 */
function ColdOpen({ scene, pkg, media, settleFrame, holdFrames }: { scene: Scene & { durationInFrames?: number }; pkg: PackageV1; media?: MediaSidecar; settleFrame: number; holdFrames: number }) {
  const frame = useCurrentFrame();
  if (frame >= holdFrames) return null;
  // A sequence gives the hero its own duration, so kinetic and chart timing
  // match the shot instead of the whole film. The provider then holds the
  // settled local frame. The composition clock is unchanged.
  return (
    <AbsoluteFill style={{ zIndex: 48 }}>
      <Sequence durationInFrames={Math.max(1, scene.durationInFrames ?? settleFrame + 1)} layout="none">
        <SceneFrameProvider frame={settleFrame}>
          <SceneBody scene={scene} pkg={pkg} media={media} />
        </SceneFrameProvider>
      </Sequence>
    </AbsoluteFill>
  );
}

export function sceneById(timeline: Timeline, sceneId: string): Scene | undefined {
  return timeline.scenes.find(scene => scene.id === sceneId) as unknown as Scene | undefined;
}
