import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Player, type PlayerRef } from '@remotion/player';
import type { PackageV1 } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import { PackageComposition, type MediaSources } from '../../renderer/src/composition';
import type { InlineAsset } from '../../renderer/src/components';
import { previewMediaPlan } from './preview-media.ts';
import './ui/preview.css';

let root: Root | null = null;
let ready: ((player: PlayerRef) => void) | null = null;

// The transport lives in the shell (#transport: #play, #scrub, #time), so the
// Player runs without its own controls bar; exactly one Play control remains.
const Preview = ({ pkg, timeline, generatedAssets, mediaSources, missingMedia }: { pkg: PackageV1; timeline: Timeline; generatedAssets?: Record<string, InlineAsset>; mediaSources?: MediaSources; missingMedia?: string[] }) => {
  // The component boundary is the final guard: even the first mount, before
  // any blob/ticket hydration finishes, cannot fall back to static media 404s.
  const plan = previewMediaPlan(pkg, mediaSources ?? {});
  return <Player
    // PackageComposition is the same narration, caption and mix tree the MP4 renderer uses.
    component={PackageComposition as unknown as React.ComponentType<Record<string, unknown>>}
    inputProps={{ pkg, timeline, ...(generatedAssets ? { generatedAssets } : {}), mediaSources: plan.sources, missingMedia: missingMedia ?? plan.missingMedia }}
    durationInFrames={timeline.durationInFrames}
    compositionWidth={timeline.width}
    compositionHeight={timeline.height}
    fps={timeline.fps}
    // Warm the upcoming scene's real media elements before the cut. Remotion's
    // Player defaults to zero (unlike Studio); keep this preview-only.
    defaultPremountInSeconds={2}
    controls={false}
    loop
    acknowledgeRemotionLicense
    className="preview-player"
    style={{ width: '100%', aspectRatio: `${timeline.width} / ${timeline.height}` }}
    errorFallback={({ error }: { error: Error }) => (
      <pre className="preview-error">{String(error?.stack ?? error)}</pre>
    )}
    ref={(player: PlayerRef | null) => {
      if (player && ready) ready(player);
    }}
  />;
};

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

export function updatePreview(pkg: PackageV1, timeline: Timeline, generatedAssets?: Record<string, InlineAsset>, mediaSources?: MediaSources, missingMedia?: string[]): void {
  root?.render(<Preview pkg={pkg} timeline={timeline} generatedAssets={generatedAssets} mediaSources={mediaSources} missingMedia={missingMedia} />);
}
