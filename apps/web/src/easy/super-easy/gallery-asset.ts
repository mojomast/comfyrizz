/** Allowlisted, normalized snapshot metadata. Never inspect provider payloads. */
export interface GalleryAssetDetails {
  assetId?: string;
  sceneId?: string;
  takeId?: string;
  role?: 'reference' | 'generated' | 'final';
  mediaType?: 'image' | 'video' | 'audio';
  status?: string;
  prompt?: string;
  model?: string;
  workflow?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  seed?: number;
}

export function publicAssetText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value
    .replace(/\b(?:https?:\/\/)[^\s<>"']+/giu, '[URL redacted]')
    .replace(/(?:\bBearer\s+)[\w.+/=-]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/giu, '[credential redacted]')
    .replace(/(?:\/(?:home|Users|tmp|content|root|var|etc|mnt|private)\/|[A-Za-z]:\\)[^\s"'<>]+/gu, '[private path redacted]');
}

export function readGalleryAssetDetails(value: unknown): GalleryAssetDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const details: GalleryAssetDetails = {};
  for (const key of ['assetId', 'sceneId', 'takeId', 'status', 'prompt', 'model', 'workflow'] as const) {
    const text = publicAssetText(raw[key]);
    if (text !== undefined) details[key] = text;
  }
  if (raw.role === 'reference' || raw.role === 'generated' || raw.role === 'final') details.role = raw.role;
  if (raw.mediaType === 'image' || raw.mediaType === 'video' || raw.mediaType === 'audio') details.mediaType = raw.mediaType;
  for (const key of ['width', 'height', 'durationSeconds', 'seed'] as const) {
    const number = raw[key];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) details[key] = number;
  }
  return Object.keys(details).length ? details : undefined;
}

export function safeGalleryUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url || /[\u0000-\u0020\u007f\\]/u.test(url) || url.startsWith('//')) return null;
  if (/^\/(?:home|Users|tmp|content|root|var|etc|mnt|private)\//u.test(url)) return null;
  if (/[?&](?:token|api[_-]?key|access[_-]?token|authorization|secret|password)=/iu.test(url)) return null;
  if (/^data:(?:image\/(?:png|jpeg|webp|gif)|audio\/[\w.+-]+|video\/[\w.+-]+);base64,/iu.test(url)) return url;
  if (/^blob:/iu.test(url)) return url;
  if (/^https?:\/\//iu.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some(key => /^(?:token|api[_-]?key|access[_-]?token|authorization|secret|password)$/iu.test(key))) return null;
      return url;
    } catch { return null; }
  }
  if (!/^\/(?!\/)/u.test(url)) return null;
  const parsed = new URL(url, 'https://gallery.invalid');
  return [...parsed.searchParams.keys()].some(key => /^(?:token|api[_-]?key|access[_-]?token|authorization|secret|password)$/iu.test(key)) ? null : url;
}
