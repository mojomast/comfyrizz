
export const VISUAL_ROLES = ['backdrop', 'hero', 'support', 'plate'] as const;
export type VisualRole = (typeof VISUAL_ROLES)[number];

export interface VisualPlacement {
  role: VisualRole;
  x: number;
  y: number;
  w: number;
}

export interface VisualForegroundItem {
  asset: string;
  x: number;
  y: number;
  w: number;
  anim: 'fade-in';
}

export type SceneAssetSlot = 'background' | 'foreground' | 'media' | 'narration' | 'presenter';

export interface SceneAssetRef {
  assetId: string;
  slot: SceneAssetSlot;
  index?: number;
}

export function visualRoleForLayout(layout: unknown): VisualRole {
  if (layout === 'title') return 'backdrop';
  if (layout === 'hero') return 'hero';
  if (layout === 'split' || layout === 'compare') return 'plate';
  return 'support';
}

export function visualPlacementForScene(scene: { layout?: string } | null | undefined): VisualPlacement {
  const role = visualRoleForLayout(scene?.layout);
  if (role === 'backdrop') return { role, x: 0.5, y: 0.5, w: 0.84 };
  if (role === 'hero') return { role, x: 0.73, y: 0.5, w: 0.46 };
  if (role === 'plate') return { role, x: 0.5, y: 0.5, w: 0.5 };
  return { role, x: 0.78, y: 0.5, w: 0.4 };
}

export function visualForegroundItem(scene: { layout?: string }, asset: string): VisualForegroundItem {
  const { x, y, w } = visualPlacementForScene(scene);
  return { asset, x, y, w, anim: 'fade-in' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pushAsset(refs: SceneAssetRef[], seen: Set<string>, value: unknown, slot: SceneAssetSlot, index?: number): void {
  if (typeof value !== 'string' || value === '' || seen.has(value)) return;
  seen.add(value);
  refs.push({ assetId: value, slot, ...(index === undefined ? {} : { index }) });
}

export function sceneAssetRefs(scene: unknown): SceneAssetRef[] {
  if (!isRecord(scene)) return [];
  const refs: SceneAssetRef[] = [];
  const seen = new Set<string>();
  const background = isRecord(scene.background) ? scene.background : null;
  pushAsset(refs, seen, background?.asset, 'background');
  if (Array.isArray(scene.foreground)) {
    scene.foreground.forEach((item, index) => {
      if (isRecord(item)) pushAsset(refs, seen, item.asset, 'foreground', index);
    });
  }
  if (Array.isArray(scene.media)) {
    scene.media.forEach((plate, index) => {
      if (isRecord(plate)) pushAsset(refs, seen, plate.asset, 'media', index);
    });
  }
  pushAsset(refs, seen, scene.narration_asset, 'narration');
  pushAsset(refs, seen, scene.presenter_asset, 'presenter');
  return refs;
}

export function sceneAssetIds(scene: unknown): string[] {
  return sceneAssetRefs(scene).map(ref => ref.assetId);
}
