/**
 * Narration audio resolution (N7), kept free of JSX/Remotion so it can be
 * unit-tested on plain Node (see test/audio.test.mjs). The compiled package
 * references its narration audio from each scene's `narration_asset`; scenes
 * that lack one fall back to the first ready audio asset. M2: a package that
 * declares an `audio` mix owns its music/ambience/SFX assets, so only a
 * scene-referenced asset can be narration.
 *
 * @typedef {import('../../../packages/schema/types').PackageV1} PackageV1
 *
 * @param {PackageV1} pkg
 * @returns {{ assetId: string, file: string } | null}
 */
export function narrationAudio(pkg) {
  const assets = pkg?.assets ?? {};
  const referenced = [];
  for (const scene of pkg?.scenes ?? []) {
    if (scene?.narration_asset && !referenced.includes(scene.narration_asset)) referenced.push(scene.narration_asset);
  }
  const candidates = pkg?.audio ? referenced : [...referenced, ...Object.keys(assets)];
  for (const assetId of candidates) {
    const asset = assets[assetId];
    if (asset?.kind === 'audio' && asset.status === 'ready' && typeof asset.file === 'string' && asset.file.length > 0) {
      return { assetId, file: asset.file };
    }
  }
  return null;
}
