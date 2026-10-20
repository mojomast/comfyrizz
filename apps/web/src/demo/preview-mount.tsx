import type { PlayerRef } from '@remotion/player';
import type { PackageV1 } from '../../../../packages/schema/types';
import type { Timeline } from '../../../../packages/planner/dist/src/index.js';
import { mountPreview as mountPlayer, updatePreview as updatePlayer } from '../preview';
import { sceneStartFrame } from './preview-frames.mjs';

export interface PreviewMountOptions {
  timeline: Timeline;
  pkg: PackageV1;
}

export interface PreviewHandle {
  update(timeline: Timeline, pkg: PackageV1): void;
  seekToScene(sceneId: string): number;
  destroy(): void;
}

export function mountPreview(root: HTMLElement, options: PreviewMountOptions): PreviewHandle {
  const doc = root.ownerDocument ?? document;
  const mountPoint = doc.createElement('div');
  mountPoint.style.width = '100%';
  root.append(mountPoint);

  let timeline = options.timeline;
  let player: PlayerRef | null = null;
  let destroyed = false;

  mountPlayer(mountPoint, options.pkg, options.timeline, next => {
    if (!destroyed) player = next;
  });

  return {
    update(nextTimeline, nextPkg) {
      if (destroyed) return;
      timeline = nextTimeline;
      updatePlayer(nextPkg, nextTimeline);
    },
    seekToScene(sceneId) {
      const frame = sceneStartFrame(timeline, sceneId);
      if (!destroyed && player) player.seekTo(frame);
      return frame;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      player = null;
      mountPoint.remove();
    },
  };
}
