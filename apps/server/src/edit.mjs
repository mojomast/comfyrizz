// C13: decide which compiled scenes an agent edit must re-render.
//
// An edit that only changes scene content (copy, data, background, foreground, referenced
// media, palette overrides) invalidates the segments whose A6 content hash changed; the rest
// come straight from the per-package segment cache. An edit that shifts timing (scene
// durations, order, fps, narration, caption cues) moves every segment's frame range, so the
// endpoint falls back to a full render and says why instead of stitching mismatched cached
// segments.
//
// Nothing here renders or talks to a backend; the live render is injected by the server.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../../../packages/planner/dist/src/index.js';
import { compilePackage } from './compile-package.mjs';

/**
 * The timeline the renderer reads: a committed `timeline.json` next to the package when
 * present (measured narration durations), otherwise a fresh compile. Mirrors
 * `renderPackageIncremental` so the diff compares the same timing the renderer used.
 * @param {string} packagePath
 * @param {any} pkg
 */
export function packageTimeline(packagePath, pkg) {
  const timelinePath = join(dirname(packagePath), 'timeline.json');
  if (existsSync(timelinePath)) return JSON.parse(readFileSync(timelinePath, 'utf8'));
  return compilePackage(pkg, dirname(packagePath));
}

/**
 * Everything that moves frames of *other* scenes. Scene copy, datasets, backgrounds and
 * referenced assets are deliberately excluded: those invalidate one segment through A6's
 * content hash, not the frame grid.
 * @param {any} timeline
 */
export function timingFingerprint(timeline) {
  return {
    width: timeline.width ?? null,
    height: timeline.height ?? null,
    fps: timeline.fps ?? null,
    durationInFrames: timeline.durationInFrames ?? null,
    scenes: (timeline.scenes ?? []).map(scene => ({
      id: scene.id,
      from: scene.from,
      durationInFrames: scene.durationInFrames,
      transitionInFrames: scene.transitionInFrames ?? 0,
      transitionOutFrames: scene.transitionOutFrames ?? 0,
      narrationAsset: scene.narration_asset ?? scene.narrationAsset ?? null,
    })),
    captions: (timeline.captions ?? []).map(cue => ({
      sceneId: cue.scene_id ?? cue.sceneId ?? null,
      from: cue.from,
      to: cue.to,
    })),
  };
}

function fingerprint(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** True when the frame grid moved, so the incremental segment cache can no longer be reused. */
export function timingChanged(previousTimeline, nextTimeline) {
  if (!previousTimeline) return false;
  return fingerprint(timingFingerprint(previousTimeline)) !== fingerprint(timingFingerprint(nextTimeline));
}

/**
 * A short reason for the full-render fallback, or null when the edit is scene-local.
 * @returns {string | null}
 */
export function timingChangeReason(previousTimeline, nextTimeline) {
  if (!previousTimeline) return null;
  const before = timingFingerprint(previousTimeline);
  const after = timingFingerprint(nextTimeline);
  if (fingerprint(before) === fingerprint(after)) return null;
  if (before.fps !== after.fps) return 'frame rate changed';
  if (before.width !== after.width || before.height !== after.height) return 'format changed';
  const beforeScenes = new Map(before.scenes.map(scene => [scene.id, scene]));
  const afterScenes = new Map(after.scenes.map(scene => [scene.id, scene]));
  if (beforeScenes.size !== afterScenes.size || [...beforeScenes.keys()].some(id => !afterScenes.has(id))) {
    return 'scenes added or removed';
  }
  for (const [id, scene] of beforeScenes) {
    const next = afterScenes.get(id);
    if (!next || scene.durationInFrames !== next.durationInFrames) return 'scene durations changed';
  }
  if (before.durationInFrames !== after.durationInFrames) return 'timeline duration changed';
  return 'timing changed';
}
