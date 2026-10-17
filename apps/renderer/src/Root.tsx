import React from 'react';
import { Composition } from 'remotion';
import pkgJson from '../../../examples/launch-demo/package.json';
import timelineJson from '../../../examples/launch-demo/timeline.json';
import type { PackageV1 } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import { TimelinePlayer, sceneById } from './player';

const pkg = pkgJson as unknown as PackageV1;
const timeline = timelineJson as unknown as Timeline;

function LaunchDemo() {
  return <TimelinePlayer pkg={pkg} timeline={timeline} />;
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
        durationInFrames={timeline.durationInFrames}
        fps={timeline.fps}
        width={timeline.width}
        height={timeline.height}
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
