import React from 'react';
import { Composition } from 'remotion';
import pkgJson from '../../../examples/showcase-gpu2/package.json';
import timelineJson from '../../../examples/showcase-gpu2/timeline.json';
import mediaJson from '../../../examples/showcase-gpu2/media.json';
import { Showcase, type MediaSidecar } from './Showcase';

const timeline = timelineJson as unknown as { durationInFrames: number; fps: number; width: number; height: number };

export function ShowcaseRoot() {
  return (
    <Composition
      id="ShowcaseGpu2"
      component={Showcase}
      defaultProps={{ pkg: pkgJson as never, timeline: timelineJson as never, media: mediaJson as MediaSidecar }}
      durationInFrames={timeline.durationInFrames}
      fps={timeline.fps}
      width={timeline.width}
      height={timeline.height}
    />
  );
}
