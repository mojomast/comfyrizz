// Exercise the production preview and composition, not a substitute video player.
import { mountPreview } from '../src/preview';
import { compileTimeline } from '../../../packages/planner/dist/src/browser.js';
import type { PackageV1 } from '../../../packages/schema/types';
import base from '../test/fixtures/editor/short/package.json';

const pkg = structuredClone(base) as PackageV1;
pkg.voice = { enabled: false };
pkg.audio = { ambience: { enabled: false } };
pkg.assets = {};
pkg.scenes = [1, 2, 3].map(index => {
  const id = `a_clip_${index}`;
  pkg.assets[id] = {
    kind: 'video', origin: 'upload', status: 'ready', file: `/playback-media/${index}.mp4`,
    media: { frames: 180, fps: 30, width: 320, height: 180, audio: 'present' },
  };
  return {
    id: `s_clip_${index}`, layout: 'hero', preferredFrames: 150, media_only: true,
    background: { asset: id, loop: false, speed: 1, muted: false, trim: { startSeconds: 0.5 } },
    transitionOut: { type: 'cut', frames: 0 },
  };
});
const timeline = compileTimeline({ package: pkg });
mountPreview(document.getElementById('player')!, pkg, timeline, player => {
  const state = window as any;
  if (state.testPlayer) return;
  state.testPlayer = player;
  state.playbackEvents = [];
  for (const type of ['waiting', 'resume']) {
    player.addEventListener(type, () => state.playbackEvents.push({ type, frame: player.getCurrentFrame() }));
  }
  player.mute();
});
