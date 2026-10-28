// Shared asset reachability for package planning.
//
// Pending work is payable only when a scene (or a package-level render input)
// can reach it. Generated assets bring their own visual/audio dependencies with
// them; an orphaned restyle is therefore not a job merely because it is pending.

const DEPENDENCY_INPUT = /^(?:image|reference|audio|mask|video|motion_reference|motion_reference_original|_?reference_\d+)$/;

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function add(out, id) {
  if (typeof id === 'string' && id.length > 0) out.add(id);
}

/** Asset ids directly used by one scene, including the two-plate media slot. */
export function sceneAssetIds(scene) {
  const out = new Set();
  if (!object(scene)) return [];
  add(out, scene.background?.asset);
  for (const item of Array.isArray(scene.foreground) ? scene.foreground : []) add(out, item?.asset);
  for (const plate of Array.isArray(scene.media) ? scene.media : []) add(out, plate?.asset);
  add(out, scene.narration_asset);
  add(out, scene.presenter_asset);
  return [...out];
}

/** The actual scene placements of an asset, used by native-AV timing checks. */
export function sceneAssetPlacements(scene, assetId) {
  if (!object(scene)) return [];
  const placements = [];
  if (scene.background?.asset === assetId) placements.push({ slot: 'background', value: scene.background });
  for (const [index, item] of (Array.isArray(scene.foreground) ? scene.foreground : []).entries()) {
    if (item?.asset === assetId) placements.push({ slot: 'foreground', index, value: item });
  }
  for (const [index, plate] of (Array.isArray(scene.media) ? scene.media : []).entries()) {
    if (plate?.asset === assetId) placements.push({ slot: 'media', index, value: plate });
  }
  if (scene.narration_asset === assetId) placements.push({ slot: 'narration', value: scene });
  if (scene.presenter_asset === assetId) placements.push({ slot: 'presenter', value: scene });
  return placements;
}

function rootsFor(pkg, explicitAssets) {
  const roots = new Set();
  if (explicitAssets) {
    for (const id of explicitAssets) add(roots, id);
    return roots;
  }

  const scenes = Array.isArray(pkg.scenes) ? pkg.scenes : [];
  // Low-level planner fixtures and single-asset packages can predate scenes.
  // With no reachability graph to restrict, retain the legacy whole-package
  // behaviour; normal scene-bearing packages always take the strict path.
  if (scenes.length === 0) {
    for (const id of Object.keys(object(pkg.assets) ? pkg.assets : {})) roots.add(id);
    return roots;
  }
  const assets = object(pkg.assets) ? pkg.assets : {};
  const cast = new Map((Array.isArray(pkg.cast) ? pkg.cast : []).map(member => [member?.id, member]));
  for (const scene of scenes) {
    const ids = sceneAssetIds(scene);
    for (const id of ids) roots.add(id);
    // The Klein planner adds scene cast refs implicitly only to Klein stills.
    // An unused cast member (or an H3-only scene) must not create a paid still.
    if (ids.some(id => assets[id]?.gen?.generator === 'flux3-klein')) {
      for (const castId of Array.isArray(scene.cast) ? scene.cast : []) add(roots, cast.get(castId)?.ref_asset);
    }
  }

  // Package-level render inputs are reachable too.
  add(roots, pkg.theme?.logo_asset);
  add(roots, pkg.voice?.ref_asset);
  add(roots, pkg.audio?.music?.asset);
  for (const sfx of Array.isArray(pkg.audio?.sfx) ? pkg.audio.sfx : []) add(roots, sfx?.asset);
  if (typeof pkg.presenter?.portrait === 'string') {
    add(roots, cast.get(pkg.presenter.portrait)?.ref_asset ?? pkg.presenter.portrait);
  }
  return roots;
}

/**
 * Return scene-reachable assets plus the full dependency closure. With
 * `opts.assets`, those explicit ids are the roots (the existing single-asset
 * planning API), and their dependencies are still retained.
 */
export function reachableAssetIds(pkg, opts = {}) {
  const assets = object(pkg?.assets) ? pkg.assets : {};
  const reachable = rootsFor(pkg ?? {}, opts.assets ? new Set(opts.assets) : null);
  const queue = [...reachable];
  const cast = new Map((Array.isArray(pkg?.cast) ? pkg.cast : []).map(member => [member?.id, member]));

  while (queue.length > 0) {
    const id = queue.shift();
    const asset = assets[id];
    if (!object(asset)) continue;
    const inputs = object(asset.gen?.inputs) ? asset.gen.inputs : {};
    for (const [name, value] of Object.entries(inputs)) {
      if (!DEPENDENCY_INPUT.test(name) || typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(assets, value)) continue;
      if (!reachable.has(value)) {
        reachable.add(value);
        queue.push(value);
      }
    }
    const member = cast.get(asset.cast);
    if (member && typeof member.ref_asset === 'string' && !reachable.has(member.ref_asset)) {
      reachable.add(member.ref_asset);
      queue.push(member.ref_asset);
    }
  }
  return reachable;
}

/** Ids a whole-package plan should consider, in deterministic order. */
export function planningAssetIds(pkg, opts = {}) {
  const assets = object(pkg?.assets) ? pkg.assets : {};
  const reachable = reachableAssetIds(pkg, opts);
  return Object.keys(assets)
    .filter(id => reachable.has(id))
    .sort();
}
