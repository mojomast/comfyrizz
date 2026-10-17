import type { Asset, PackageV1, Scene } from '../../../packages/schema/types';

/**
 * P-fix1 media resolution, kept free of JSX/Remotion so it can be unit-tested.
 * The renderer reads the proposed H-fix1 schema fields when present and falls
 * back to an `examples/<name>/media.json` sidecar so the GPU-test-2 showcase
 * renders before the schema lands.
 */
export interface MediaSidecar {
  /** Per-scene dark overlay opacity 0..1 (sidecar fallback for background.scrim). */
  scrim?: Record<string, number>;
  /** Scenes that should skip their layout (sidecar fallback for scene.media_only). */
  skipLayout?: string[];
  /** Per-scene lower-third overlay (sidecar fallback for scene.lower_third). */
  lowerThird?: Record<string, { kicker?: string; text: string }>;
}

export interface LowerThirdContent {
  kicker?: string;
  text: string;
}

export interface ResolvedSceneMedia {
  background?: Asset;
  scrim: number;
  mediaOnly: boolean;
  lowerThird?: LowerThirdContent;
}

export type SceneWithMedia = Scene & {
  media_only?: boolean;
  lower_third?: LowerThirdContent;
  background?: (NonNullable<Scene['background']> & { scrim?: number }) | null;
};

export function normalizeScrim(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

export function isMediaKind(kind: unknown): boolean {
  return kind === 'image' || kind === 'video';
}

export function resolveSceneMedia(scene: Scene, pkg: PackageV1, media?: MediaSidecar): ResolvedSceneMedia {
  const withMedia = scene as SceneWithMedia;
  const backgroundId = withMedia.background?.asset;
  const background = backgroundId ? pkg.assets?.[backgroundId] : undefined;
  const scrim = normalizeScrim(withMedia.background?.scrim ?? media?.scrim?.[scene.id]);
  const mediaOnly = withMedia.media_only === true || media?.skipLayout?.includes(scene.id) === true;
  const lowerThird = withMedia.lower_third ?? media?.lowerThird?.[scene.id];
  return {
    ...(background ? { background } : {}),
    scrim,
    mediaOnly,
    ...(lowerThird ? { lowerThird } : {}),
  };
}
