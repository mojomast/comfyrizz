import React from 'react';
import { Composition } from 'remotion';
import pkgJson from '../../../examples/willem-birthday/package.json';
import timelineJson from '../../../examples/willem-birthday/timeline.json';
import mediaJson from '../../../examples/willem-birthday/media.json';
import { Birthday, type MediaSidecar } from './Birthday';

const timeline = timelineJson as unknown as { durationInFrames: number; fps: number; width: number; height: number };

export function WillemRoot() {
  return (
    <Composition
      id="WillemBirthday"
      component={Birthday}
      defaultProps={{ pkg: pkgJson as never, timeline: timelineJson as never, media: mediaJson as MediaSidecar }}
      durationInFrames={timeline.durationInFrames}
      fps={timeline.fps}
      width={timeline.width}
      height={timeline.height}
    />
  );
}
