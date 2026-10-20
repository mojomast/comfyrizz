/**
 * Host adapter. The shell constructs one EditorStore and passes it here.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PackageV1 } from '../../../../../packages/schema/types';
import type { CompiledTimeline } from '../../../../../packages/planner/dist/src/browser.js';
import type { EditorExtras, EditorStore } from '../store.ts';
import { SceneTimeline } from './Timeline.tsx';

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
  root.render(<SceneTimeline store={store} onSeek={hooks.seek} onTogglePlay={hooks.togglePlay} />);
  return {
    followFrame(frame) {
      store.setSession({ playheadFrame: Math.max(0, Math.floor(frame)) });
    },
    destroy() {
      unsubscribe();
      root.unmount();
    },
  };
}
