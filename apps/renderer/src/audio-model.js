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
const H3_SILENT_CONDITIONING_SOURCE = 'comfyrizz/deterministic-silence-500ms-24k-mono';

function isPlayableNarrationAsset(asset) {
  return asset?.kind === 'audio'
    && asset.status === 'ready'
    && typeof asset.file === 'string'
    && asset.file.length > 0
    && !(asset.gen?.generator === 'kokoro' && typeof asset.gen?.inputs?.character === 'string')
    && asset.source?.id !== H3_SILENT_CONDITIONING_SOURCE;
}

export function narrationAudio(pkg) {
  if (pkg?.voice?.enabled === false) return null;
  const assets = pkg?.assets ?? {};
  const referenced = [];
  for (const scene of pkg?.scenes ?? []) {
    if (scene?.narration_asset && !referenced.includes(scene.narration_asset)) referenced.push(scene.narration_asset);
  }
  const candidates = pkg?.audio ? referenced : [...referenced, ...Object.keys(assets)];
  for (const assetId of candidates) {
    const asset = assets[assetId];
    if (isPlayableNarrationAsset(asset)) return { assetId, file: asset.file };
  }
  return null;
}

/**
 * Ready audio assets that no scene references as narration and that the mix does
 * not use as a bus. With an `audio` block present, `narrationAudio` only accepts
 * scene-referenced assets, so a stray file here is the silent-voice case: the
 * package carries a narration but never points a scene at it (G6-13).
 *
 * @param {PackageV1} pkg
 * @returns {string[]} asset ids
 */
export function unreferencedNarrationAssets(pkg) {
  const assets = pkg?.assets ?? {};
  const referenced = new Set();
  for (const scene of pkg?.scenes ?? []) {
    if (scene?.narration_asset) referenced.add(scene.narration_asset);
  }
  const audio = pkg?.audio ?? {};
  const buses = new Set();
  if (audio.music?.asset) buses.add(audio.music.asset);
  // Ambience configures the videos' embedded audio; it is an object, not
  // a list of standalone audio assets (packageAudio in the schema).
  for (const sfx of audio.sfx ?? []) if (sfx?.asset) buses.add(sfx.asset);
  return Object.keys(assets).filter(assetId => {
    const asset = assets[assetId];
    return isPlayableNarrationAsset(asset) && !referenced.has(assetId) && !buses.has(assetId);
  });
}

/**
 * A one-line warning for a package whose voice will not be mixed, or null. It is
 * deliberately quiet for a package with no `audio` block (the fallback finds a
 * ready asset) and for one that already resolves a narration.
 *
 * @param {PackageV1} pkg
 * @returns {string | null}
 */
export function narrationWarning(pkg) {
  if (pkg?.voice?.enabled === false || narrationAudio(pkg) || !pkg?.audio) return null;
  const stray = unreferencedNarrationAssets(pkg);
  if (stray.length === 0) return null;
  return `no scene sets narration_asset, so the ready audio ${stray.join(', ')} is not mixed as voice; point a scene's narration_asset at it`;
}
