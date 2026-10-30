import { readGalleryAssetDetails } from './gallery-asset.ts';

type RecordValue = Record<string, any>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;

function compositionIds(scene: RecordValue): string[] {
  return [...new Set([scene.background?.asset, scene.presenter_asset,
    ...(Array.isArray(scene.media) ? scene.media.map((entry: RecordValue) => entry?.asset) : []),
    ...(Array.isArray(scene.foreground) ? scene.foreground.map((entry: RecordValue) => entry?.asset) : []),
  ].filter((id): id is string => typeof id === 'string'))];
}

function assetUrl(packageId: string, asset: RecordValue): string | null {
  const file = asset.file;
  if (!['ready', 'candidate'].includes(asset.status) || typeof file !== 'string' || !file
    || /[\\\u0000-\u001f\u007f~]/u.test(file) || file.startsWith('/')
    || file.split('/').some(part => !part || part === '.' || part === '..') || /^[a-z]+:/iu.test(file)) return null;
  return `/api/package/${encodeURIComponent(packageId)}/media?path=${encodeURIComponent(file)}`;
}

/** Normalize the canonical saved-package schema, never provider payload aliases.
 * The caller must bind the package to its authenticated production first. */
export function packageGalleryShots(pkg: RecordValue): RecordValue[] {
  const assets = record(pkg.assets) ?? {};
  if (!Array.isArray(pkg.scenes) || typeof pkg.id !== 'string') return [];
  return pkg.scenes.flatMap((scene: RecordValue, index: number) => {
    if (!record(scene) || typeof scene.id !== 'string') return [];
    // Motion often lives in the background/media slots while only s1 and s8
    // have foreground stills. Resolve composition identity before readiness.
    const ids = compositionIds(scene).filter(id => Boolean(record(assets[id])));
    const primaryId = ids.find(id => assets[id].kind === 'video') ?? ids.find(id => assets[id].kind === 'image');
    if (!primaryId) return [{ id: scene.id, label: `Shot ${index + 1}`, status: 'planned' }];
    const primary = assets[primaryId];
    const conditioningId = primary.gen?.inputs?.image;
    const conditioning = typeof conditioningId === 'string' ? record(assets[conditioningId]) : null;
    const reference = !assetUrl(pkg.id, primary) && conditioning?.kind === 'image' && assetUrl(pkg.id, conditioning);
    const asset = reference ? conditioning! : primary;
    const assetId = reference ? conditioningId : primaryId;
    const gen = record(asset.gen) ?? {}, inputs = record(gen.inputs) ?? {}, media = record(asset.media) ?? {};
    const duration = typeof media.durationInSeconds === 'number' ? media.durationInSeconds
      : typeof media.frames === 'number' && typeof media.fps === 'number' && media.fps > 0 ? media.frames / media.fps
        : typeof inputs.frames === 'number' && typeof inputs.fps === 'number' && inputs.fps > 0 ? inputs.frames / inputs.fps : undefined;
    return [{ id: scene.id, label: `Shot ${index + 1}`, status: primary.status,
      url: assetUrl(pkg.id, asset), details: readGalleryAssetDetails({
        assetId, sceneId: scene.id, role: reference ? 'reference' : 'generated', mediaType: asset.kind,
        status: asset.status, prompt: inputs.prompt, model: gen.model, workflow: gen.workflow,
        width: media.width ?? inputs.width, height: media.height ?? inputs.height,
        durationSeconds: duration, seed: inputs.seed,
      }) }];
  });
}

export function packageGalleryReferences(pkg: RecordValue): RecordValue[] {
  const assets = record(pkg.assets) ?? {};
  if (!Array.isArray(pkg.scenes) || typeof pkg.id !== 'string') return [];
  const placed = new Set(pkg.scenes.filter(record).flatMap(compositionIds));
  return Object.entries(assets).flatMap(([assetId, value]) => {
    const asset = record(value);
    if (!asset || asset.kind !== 'image' || placed.has(assetId)) return [];
    const gen = record(asset.gen) ?? {}, inputs = record(gen.inputs) ?? {}, media = record(asset.media) ?? {};
    const scene = pkg.scenes.find((scene: RecordValue) => record(scene) && compositionIds(scene).some(id => assets[id]?.gen?.inputs?.image === assetId));
    return [{ id: assetId, label: `Visual reference ${assetId}`, status: asset.status, url: assetUrl(pkg.id, asset),
      details: readGalleryAssetDetails({ assetId, sceneId: scene?.id, role: 'reference', mediaType: 'image', status: asset.status,
        prompt: inputs.prompt, model: gen.model, workflow: gen.workflow, width: media.width ?? inputs.width, height: media.height ?? inputs.height, seed: inputs.seed }) }];
  }).map((reference, index) => ({ ...reference, label: `Visual reference ${index + 1}` }));
}

/** Owner run records include an authoritative collected package even when the
 * final render failed. Reject stale/cross-project records before deriving URLs. */
export function normalizedGallerySnapshot(root: RecordValue): RecordValue {
  if (Array.isArray(root.shots) && root.shots.some(shot => record(shot)?.details)) return root;
  const run = record(root.run), production = record(root.production);
  const pkg = record(run?.result?.package);
  if (!run || !production || !pkg || typeof pkg.id !== 'string'
    || production.packageId !== pkg.id || run.packageId !== pkg.id || run.productionId !== production.id) return root;
  const references = packageGalleryReferences(pkg);
  const ids = new Set(references.map(reference => reference.id));
  return { ...root, shots: packageGalleryShots(pkg),
    characters: [...references, ...(Array.isArray(root.characters) ? root.characters.filter(character => !ids.has(character?.id)) : [])] };
}
