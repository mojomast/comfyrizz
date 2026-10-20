import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Player, type PlayerRef } from '@remotion/player';
import type { PackageV1 } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import { PackageComposition } from '../../renderer/src/composition';
import type { InlineAsset } from '../../renderer/src/components';

let root: Root | null = null;
let ready: ((player: PlayerRef) => void) | null = null;

const Preview = ({ pkg, timeline, generatedAssets }: { pkg: PackageV1; timeline: Timeline; generatedAssets?: Record<string, InlineAsset> }) => (
  <Player
    // PackageComposition is the same narration, caption and mix tree the MP4 renderer uses.
    component={PackageComposition as unknown as React.ComponentType<Record<string, unknown>>}
    inputProps={{ pkg, timeline, ...(generatedAssets ? { generatedAssets } : {}) }}
    durationInFrames={timeline.durationInFrames}
    compositionWidth={timeline.width}
    compositionHeight={timeline.height}
    fps={timeline.fps}
    controls
    loop
    acknowledgeRemotionLicense
    style={{ width: '100%', aspectRatio: `${timeline.width} / ${timeline.height}` }}
    errorFallback={({ error }: { error: Error }) => (
      <pre style={{ whiteSpace: 'pre-wrap', color: '#ff9d9d', padding: 24, fontSize: 13 }}>{String(error?.stack ?? error)}</pre>
    )}
    ref={(player: PlayerRef | null) => {
      if (player && ready) ready(player);
    }}
  />
);

export function mountPreview(
  container: HTMLElement,
  pkg: PackageV1,
  timeline: Timeline,
  onReady: (player: PlayerRef) => void,
  generatedAssets?: Record<string, InlineAsset>,
): void {
  ready = onReady;
  root = createRoot(container);
  root.render(<Preview pkg={pkg} timeline={timeline} generatedAssets={generatedAssets} />);
}

export function updatePreview(pkg: PackageV1, timeline: Timeline, generatedAssets?: Record<string, InlineAsset>): void {
  root?.render(<Preview pkg={pkg} timeline={timeline} generatedAssets={generatedAssets} />);
}
