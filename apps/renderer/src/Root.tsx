import React, { useState } from 'react';
import { Audio, Composition, staticFile } from 'remotion';
import pkgJson from '../../../examples/launch-demo/package.json';
import timelineJson from '../../../examples/launch-demo/timeline.json';
import narratedPkgJson from '../../../examples/narrated-demo/package.json';
import narratedTimelineJson from '../../../examples/narrated-demo/timeline.json';
import type { PackageV1, Scene } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import { TimelinePlayer, sceneById } from './player';
import type { MediaDimsMap } from './media';
import { narrationAudio } from './audio-model';
import type { InlineAsset } from './components';
import type { MediaSidecar } from './media';

const pkg = pkgJson as unknown as PackageV1;
const timeline = timelineJson as unknown as Timeline;
const narratedPkg = narratedPkgJson as unknown as PackageV1;
const narratedTimeline = narratedTimelineJson as unknown as Timeline;

type DemoProps = { pkg: PackageV1; timeline: Timeline; scenes?: Scene[]; generatedAssets?: Record<string, InlineAsset>; media?: MediaSidecar; missingMedia?: string[]; mediaDims?: MediaDimsMap };

/** Audio that disappears instead of crashing when its file is not in this clone. */
function SafeAudio({ file }: { file: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <Audio src={staticFile(file)} onError={() => setFailed(true)} />;
}

function LaunchDemo(props: Partial<DemoProps>) {
  return (
    <TimelinePlayer
      pkg={props.pkg ?? pkg}
      timeline={props.timeline ?? timeline}
      {...(props.scenes ? { scenes: props.scenes } : {})}
      generatedAssets={props.generatedAssets}
      media={props.media}
      missingMedia={props.missingMedia}
      mediaDims={props.mediaDims}
    />
  );
}

function NarratedDemo() {
  return (
    <>
      <SafeAudio file="narration.norm.wav" />
      <TimelinePlayer pkg={narratedPkg} timeline={narratedTimeline} captions={narratedTimeline.captions} />
    </>
  );
}

/**
 * The export path used by renderPackage and the server. Unlike LaunchDemo it
 * plays the package's measured narration and, when the timeline has measured
 * (non-estimated) captions, burns them in (N7).
 */
function PackageDemo({ pkg: demoPkg, timeline: demoTimeline, generatedAssets, media, missingMedia, mediaDims }: Partial<DemoProps>) {
  const resolvedPkg = demoPkg ?? pkg;
  const resolvedTimeline = demoTimeline ?? timeline;
  const audio = narrationAudio(resolvedPkg);
  const audioMissing = audio ? new Set(missingMedia ?? []).has(audio.file) : false;
  const captions = (resolvedTimeline.captions ?? []).some(cue => !cue.estimated) ? resolvedTimeline.captions : undefined;
  return (
    <>
      {audio && !audioMissing ? <Audio src={staticFile(audio.file)} /> : null}
      <TimelinePlayer
        pkg={resolvedPkg}
        timeline={resolvedTimeline}
        generatedAssets={generatedAssets}
        media={media}
        missingMedia={missingMedia}
        mediaDims={mediaDims}
        {...(captions ? { captions } : {})}
      />
    </>
  );
}

function ScenePreview({ sceneId }: { sceneId: string }) {
  const scene = sceneById(timeline, sceneId);
  if (!scene) return null;
  return <TimelinePlayer pkg={pkg} timeline={timeline} scenes={[scene]} />;
}

const previews = (['title', 'hero', 'stat', 'chart', 'list'] as const).map(layout => {
  const scene = timeline.scenes.find(item => item.layout === layout);
  if (!scene) throw new Error(`launch-demo is missing the ${layout} layout`);
  const label = layout.charAt(0).toUpperCase() + layout.slice(1);
  return { id: `Preview-${label}`, sceneId: scene.id, durationInFrames: scene.durationInFrames };
});

export function RemotionRoot() {
  return (
    <>
      <Composition
        id="LaunchDemo"
        component={LaunchDemo}
        defaultProps={{ pkg, timeline }}
        durationInFrames={timeline.durationInFrames}
        fps={timeline.fps}
        width={timeline.width}
        height={timeline.height}
      />
      <Composition
        id="PackageDemo"
        component={PackageDemo}
        defaultProps={{ pkg, timeline }}
        calculateMetadata={({ props }) => {
          const timeline = (props as DemoProps).timeline;
          return {
            durationInFrames: timeline.durationInFrames,
            fps: timeline.fps,
            width: timeline.width,
            height: timeline.height,
          };
        }}
      />
      <Composition
        id="NarratedDemo"
        component={NarratedDemo}
        durationInFrames={narratedTimeline.durationInFrames}
        fps={narratedTimeline.fps}
        width={narratedTimeline.width}
        height={narratedTimeline.height}
      />
      {previews.map(preview => (
        <Composition
          key={preview.id}
          id={preview.id}
          component={ScenePreview}
          durationInFrames={preview.durationInFrames}
          fps={timeline.fps}
          width={timeline.width}
          height={timeline.height}
          defaultProps={{ sceneId: preview.sceneId }}
        />
      ))}
    </>
  );
}
