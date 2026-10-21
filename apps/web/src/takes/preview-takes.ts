export const MEDIA_TICKET_URL_RE = /^\/api\/media\/[A-Za-z0-9_-]+$/;

export interface PreviewTakeMedia {
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  durationSeconds?: number;
  audio?: string;
  [key: string]: unknown;
}

export interface PreviewTake {
  takeId: string;
  url?: string | null;
  media?: PreviewTakeMedia | null;
}

export interface PreviewClip {
  clipId?: string;
  assetId?: string;
  selected?: string | null;
  takes?: readonly PreviewTake[];
  takeId?: string;
  url?: string | null;
  media?: PreviewTakeMedia | null;
}

export interface PreviewAbTake {
  takeId: string;
  clipId?: string;
  assetId?: string;
}

export type PreviewAbTakeInput = string | PreviewAbTake | null;

export interface PreviewTakeOptions {
  abTake?: PreviewAbTakeInput;
}

export type PreviewClipInput = readonly PreviewClip[] | Record<string, PreviewClip>;

export interface PreviewPackageLike {
  scenes: readonly unknown[];
  assets?: Record<string, unknown> | null;
}

function mediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return MEDIA_TICKET_URL_RE.test(url) ? url : null;
}

function directTake(clip: PreviewClip, takeId: string): PreviewTake | null {
  const directId = typeof clip.takeId === 'string' ? clip.takeId : null;
  if (directId !== null) {
    return directId === takeId ? { takeId, url: clip.url, media: clip.media } : null;
  }
  if (clip.url !== undefined && clip.url !== null && clip.selected === takeId) {
    return { takeId, url: clip.url, media: clip.media };
  }
  return null;
}

function findTake(clip: PreviewClip, takeId: string): PreviewTake | null {
  const takes = Array.isArray(clip.takes) ? clip.takes : [];
  const found = takes.find(take => take && take.takeId === takeId);
  if (found) return found;
  return directTake(clip, takeId);
}

function normalizedClips(clips: PreviewClipInput | null | undefined): PreviewClip[] {
  if (Array.isArray(clips)) return clips as PreviewClip[];
  if (clips && typeof clips === 'object') {
    return Object.entries(clips).map(([assetId, clip]) => ({
      ...clip,
      assetId: clip.assetId ?? assetId,
    }));
  }
  return [];
}

function abTakeId(clip: PreviewClip, abTake: PreviewAbTakeInput | undefined): string | null {
  if (abTake === undefined || abTake === null) return null;
  if (typeof abTake === 'string') return abTake === '' ? null : abTake;
  if (typeof abTake.takeId !== 'string' || abTake.takeId === '') return null;
  if (abTake.clipId !== undefined && clip.clipId !== undefined && abTake.clipId !== clip.clipId) return null;
  if (abTake.assetId !== undefined && abTake.assetId !== clip.assetId) return null;
  return abTake.takeId;
}

function takeForClip(clip: PreviewClip, abTake: PreviewAbTakeInput | undefined): PreviewTake | null {
  const selected = typeof clip.selected === 'string' && clip.selected !== '' ? clip.selected : null;
  const override = abTakeId(clip, abTake);
  if (override !== null) {
    const take = findTake(clip, override);
    if (take) return take;
  }
  return selected === null ? null : findTake(clip, selected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function previewPackage<T extends PreviewPackageLike>(
  pkg: T,
  clips: PreviewClipInput,
  options: PreviewTakeOptions = {},
): T {
  if (!isRecord(pkg)) throw new TypeError('previewPackage requires a package');
  const preview = structuredClone(pkg) as T;
  const assets = preview.assets;
  if (!isRecord(assets)) return preview;

  for (const clip of normalizedClips(clips)) {
    if (typeof clip.assetId !== 'string' || clip.assetId === '') continue;
    const take = takeForClip(clip, options.abTake);
    if (!take) continue;
    const url = mediaUrl(take.url);
    if (url === null) continue;
    if (!Object.hasOwn(assets, clip.assetId)) continue;
    const asset = assets[clip.assetId];
    if (!isRecord(asset)) continue;
    asset.file = url;
    if (isRecord(take.media)) {
      asset.media = structuredClone(take.media) as typeof asset.media;
    }
  }

  return preview;
}
