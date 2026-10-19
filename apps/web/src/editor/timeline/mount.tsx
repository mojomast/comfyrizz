/**
 * Host adapter. The timeline component only sees EditorStore.
 * TEMPORARY: this constructs CA-1's stand-in. When CA-1 lands, build that
 * store (or accept one) and pass it to SceneTimeline — the view does not change.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PackageV1 } from '../../../../../packages/schema/types';
import type { Timeline } from '../types.ts';
import { createEditorStore, projectDocFromPackage } from '../store.ts';
import { SceneTimeline } from './Timeline.tsx';

export interface SceneTimelineHandle {
  load(pkg: PackageV1): void;
  followFrame(frame: number): void;
  destroy(): void;
}

export function mountSceneTimeline(
  container: HTMLElement,
  pkg: PackageV1,
  hooks: {
    onDocument: (pkg: PackageV1, timeline: Timeline) => void;
    seek: (frame: number) => void;
    togglePlay: () => void;
  },
): SceneTimelineHandle {
  const store = createEditorStore(projectDocFromPackage(pkg));
  let revision = store.getState().doc.revision;
  const unsubscribe = store.subscribe(() => {
    const { doc, derived } = store.getState();
    if (doc.revision === revision || !derived.compiled) return;
    revision = doc.revision;
    hooks.onDocument(doc.package, derived.compiled);
  });
  const root: Root = createRoot(container);
  root.render(<SceneTimeline store={store} onSeek={hooks.seek} onTogglePlay={hooks.togglePlay} />);
  return {
    load(next) {
      const doc = projectDocFromPackage(next);
      revision = doc.revision;
      store.load(doc);
    },
    followFrame(frame) {
      store.setSession({ playhead: Math.max(0, Math.floor(frame)) });
    },
    destroy() {
      unsubscribe();
      root.unmount();
    },
  };
}
