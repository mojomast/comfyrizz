/**
 * Merge committed timeline timing with current package content. The committed
 * timeline is the timing source of truth (measured narration durations), but the
 * package owns copy/foreground/background and transition vocabulary, so a
 * content edit must show up in the player (and invalidate a segment) without
 * recompiling a narrated timeline.
 *
 * Pure: no rendering, no filesystem.
 * @param {any} pkg
 * @param {any} timeline
 * @returns {any[]}
 */
export function mergeScenes(pkg, timeline) {
  const scenes = pkg?.scenes;
  const packageSceneById = id => (Array.isArray(scenes) ? scenes.find(scene => scene.id === id) : scenes?.[id]) ?? null;
  return (timeline?.scenes ?? []).map(scene => {
    const raw = packageSceneById(scene.id);
    if (!raw) return scene;
    return {
      ...scene,
      ...raw,
      id: scene.id,
      from: scene.from,
      durationInFrames: scene.durationInFrames,
      transitionInFrames: scene.transitionInFrames,
      transitionOutFrames: scene.transitionOutFrames,
      provisional: scene.provisional,
    };
  });
}
