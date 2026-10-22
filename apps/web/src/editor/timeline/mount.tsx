/**
 * Host adapter. The shell constructs one EditorStore and passes it here.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PackageV1 } from '../../../../../packages/schema/types';
import type { CompiledTimeline } from '../../../../../packages/planner/dist/src/browser.js';
import type { EditorExtras, EditorStore } from '../store.ts';
import { SceneTimeline } from './Timeline.tsx';
import type { ClipChip } from './clip-state.ts';
import type { ClipSummary } from '../../takes/api.ts';

export interface SceneTimelineHandle {
  followFrame(frame: number): void;
  destroy(): void;
}

type TimelineStore = EditorStore & EditorExtras;

export function mountSceneTimeline(
  container: HTMLElement,
  store: TimelineStore,
  hooks: {
    onDocument: (pkg: PackageV1, timeline: CompiledTimeline) => void;
    seek: (frame: number) => void;
    togglePlay: () => void;
    /** Shared clips map (TR17); chips re-render when it changes. */
    clips?: { all(): readonly ClipSummary[]; subscribe(listener: () => void): () => void };
    /** Review surface callbacks; chips stay a view of the takes store. */
    onClipSelect?: (chip: ClipChip) => void;
    onClipCycle?: (chip: ClipChip, delta: -1 | 1) => void;
    onClipApprove?: (chip: ClipChip) => void;
  },
): SceneTimelineHandle {
  if (store.getState().session.zoom === 1) store.setSession({ zoom: 2 });
  let seen = store.getState().doc.editSequence;
  const unsubscribe = store.subscribe(() => {
    const { doc, derived, session } = store.getState();
    if (session.previewing) return;
    if (doc.editSequence === seen) return;
    const userEdit = doc.editSequence > seen;
    seen = doc.editSequence;
    if (!userEdit || !derived.timeline) return;
    hooks.onDocument(doc.package as unknown as PackageV1, derived.timeline);
  });
  const root: Root = createRoot(container);
  const render = () => root.render(
    <SceneTimeline
      store={store}
      onSeek={hooks.seek}
      onTogglePlay={hooks.togglePlay}
      clips={hooks.clips?.all()}
      onClipSelect={hooks.onClipSelect}
      onClipCycle={hooks.onClipCycle}
      onClipApprove={hooks.onClipApprove}
    />,
  );
  render();
  const unsubscribeClips = hooks.clips?.subscribe(render);
  return {
    followFrame(frame) {
      store.setSession({ playheadFrame: Math.max(0, Math.floor(frame)) });
    },
    destroy() {
      unsubscribe();
      unsubscribeClips?.();
      root.unmount();
    },
  };
}
