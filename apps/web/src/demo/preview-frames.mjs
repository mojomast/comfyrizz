/**
 * Pure frame helpers for the demo preview player (T10).
 *
 * No DOM access at import time; the module only reads a timeline object.
 */

/**
 * Resolve the first frame of a scene.
 *
 * @param {{ scenes?: Array<{ id?: string, from?: number }> } | null | undefined} timeline
 * @param {string} sceneId
 * @returns {number} the scene start in frames, or 0 when the scene is unknown
 */
export function sceneStartFrame(timeline, sceneId) {
  if (!timeline || typeof timeline !== 'object') return 0;
  const scenes = Array.isArray(timeline.scenes) ? timeline.scenes : [];
  const scene = scenes.find(entry => entry && entry.id === sceneId);
  if (!scene) return 0;
  const from = scene.from;
  if (typeof from !== 'number' || !Number.isFinite(from)) return 0;
  return Math.max(0, Math.trunc(from));
}
