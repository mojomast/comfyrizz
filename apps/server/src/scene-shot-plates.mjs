/** Primary picture slots actually rendered by SceneView/Background/SplitCompareLayout.
 * scene.media is a two-panel layout input, not a sequential clip playlist.
 */
export function sceneShotPlates(scene) {
  if (scene?.drawing || scene?.composition) return [];
  if (scene?.media_only !== true && ['split', 'compare'].includes(scene?.layout)) {
    return (Array.isArray(scene.media) ? scene.media : []).slice(0, 2)
      .filter(plate => typeof plate?.asset === 'string' && !plate.procedural);
  }
  const background = scene?.background;
  return typeof background?.asset === 'string' && !background.procedural ? [background] : [];
}

/** A completion repair must not silently downgrade a shot it planned to a still. */
export function plannedShotProblems(pkg, plannedShots) {
  const assets = pkg?.assets ?? {};
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  return [...plannedShots].flatMap(([sceneId, assetId]) => {
    const scene = scenes.find(item => item.id === sceneId);
    const visible = sceneShotPlates(scene).some(plate => assets[plate.asset]?.kind === 'video'
      && ['fasth3-omni', 'ltx25'].includes(assets[plate.asset]?.gen?.generator));
    return visible ? [] : [{ code: 'PLANNED_SHOT_NOT_VISIBLE', message: `${sceneId}: a generated action clip (${assetId}) was planned but no generated video occupies the rendered shot slot. Restore that existing clip through background.asset (or its split/compare media plate), preserving copy and timing. Do not replace the action with its conditioning still or create a duplicate clip merely to fix placement.` }];
  });
}
