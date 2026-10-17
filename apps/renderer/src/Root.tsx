import React from 'react';
import { Audio, Composition, staticFile } from 'remotion';
import pkgJson from '../../../examples/launch-demo/package.json';
import timelineJson from '../../../examples/launch-demo/timeline.json';
import narratedPkgJson from '../../../examples/narrated-demo/package.json';
import narratedTimelineJson from '../../../examples/narrated-demo/timeline.json';
import type { PackageV1 } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import { TimelinePlayer, sceneById } from './player';
import type { InlineAsset } from './components';
import type { MediaSidecar } from './media';

const pkg = pkgJson as unknown as PackageV1;
const timeline = timelineJson as unknown as Timeline;
const narratedPkg = narratedPkgJson as unknown as PackageV1;
const narratedTimeline = narratedTimelineJson as unknown as Timeline;

type DemoProps = { pkg: PackageV1; timeline: Timeline; generatedAssets?: Record<string, InlineAsset>; media?: MediaSidecar };

function LaunchDemo(props: Partial<DemoProps>) {
  return (
    <TimelinePlayer
      pkg={props.pkg ?? pkg}
      timeline={props.timeline ?? timeline}
      generatedAssets={props.generatedAssets}
      media={props.media}
    />
  );
}

function NarratedDemo() {
  return (
    <>
      <Audio src={staticFile('narration.norm.wav')} />
      <TimelinePlayer pkg={narratedPkg} timeline={narratedTimeline} captions={narratedTimeline.captions} />
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
        component={LaunchDemo}
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
