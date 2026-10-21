// TR03: the reviewable clips of a package, derived from the compiled timeline.
//
// A clip is one generated asset as the timeline uses it. The compiled timeline is
// the single source of truth (the same one `sceneAssetIds` reads), so a package
// edit never leaves a stale clip list behind. Nothing here touches disk, the
// clock or the network: `measured` is the compiler's narration input and the
// caller supplies it when the package has measured voice-over.

import { compileTimeline } from '../../../../packages/planner/dist/src/index.js';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Only generated media is reviewable. Uploads, references and SVGs have no
// generator and therefore no take list.
function isGenerated(asset) {
  return isObject(asset)
    && isObject(asset.gen)
    && typeof asset.gen.generator === 'string'
    && asset.gen.generator.trim() !== '';
}

// `presenter` is decided by the slot. A background/foreground asset is a plate
// when it is video or carries a frame rate, otherwise it is a still.
function clipKind(asset, slot) {
  if (slot === 'presenter') return 'presenter';
  const fps = asset?.media?.fps;
  if (asset?.kind === 'video' || (Number.isFinite(fps) && fps > 0)) return 'plate';
  return 'still';
}

function normalizeOptions(measured, options) {
  if (typeof measured === 'string') return { measured: {}, sceneId: measured };
  if (isObject(measured) && Object.prototype.hasOwnProperty.call(measured, 'sceneId')) {
    return { measured: {}, sceneId: measured.sceneId };
  }
  if (typeof options === 'string') return { measured: measured ?? {}, sceneId: options };
  return { measured: measured ?? {}, sceneId: options?.sceneId ?? null };
}

/**
 * The reviewable clips of a package, in timeline order.
 *
 * Each clip is `{clipId, sceneId, assetId, slot, kind, from, durationInFrames}`,
 * where `clipId = <sceneId>:<assetId>`, the slot is `background`,
 * `foreground:<index>` or `presenter`, and `kind` is `still`, `plate` or
 * `presenter`. An asset shared by two scenes yields two clips with different
 * clipIds but the same assetId. Assets without `gen.generator` are skipped.
 *
 * Pass an optional scene id (third argument, or `{sceneId}` as the second) to
 * list one scene; an unknown scene returns `[]`.
 *
 * @param {any} pkg
 * @param {object|string} [measured] compile options, or a scene id
 * @param {{sceneId?: string}|string} [options]
 * @returns {Array<{clipId: string, sceneId: string, assetId: string, slot: string, kind: 'still'|'plate'|'presenter', from: number, durationInFrames: number}>}
 */
export function listClips(pkg, measured = {}, options = {}) {
  const normalized = normalizeOptions(measured, options);
  const sceneId = normalized.sceneId ?? null;
  if (!pkg || !Array.isArray(pkg.scenes) || pkg.scenes.length === 0) return [];

  const timeline = compileTimeline(pkg, normalized.measured);
  const assets = isObject(pkg.assets) ? pkg.assets : {};
  const scenes = sceneId === null
    ? timeline.scenes ?? []
    : (timeline.scenes ?? []).filter((scene) => scene.id === sceneId);
  if (sceneId !== null && scenes.length === 0) return [];

  const presenters = Array.isArray(timeline.presenters) ? timeline.presenters : [];
  const seen = new Set();
  const clips = [];

  const add = (scene, assetId, slot) => {
    if (typeof assetId !== 'string' || assetId === '') return;
    const clipId = `${scene.id}:${assetId}`;
    if (seen.has(clipId)) return;
    const asset = assets[assetId];
    if (!isGenerated(asset)) return;
    seen.add(clipId);
    clips.push({
      clipId,
      sceneId: scene.id,
      assetId,
      slot,
      kind: clipKind(asset, slot),
      from: scene.from,
      durationInFrames: scene.durationInFrames,
    });
  };

  for (const scene of scenes) {
    add(scene, scene.background?.asset, 'background');
    const foreground = Array.isArray(scene.foreground) ? scene.foreground : [];
    foreground.forEach((item, index) => add(scene, item?.asset, `foreground:${index}`));
    for (const presenter of presenters) {
      if (presenter?.sceneId === scene.id) add(scene, presenter.assetId, 'presenter');
    }
  }

  return clips;
}
