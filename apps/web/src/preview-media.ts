export interface PreviewAudioRequest {
  assetId: string;
  file: string;
  cacheKey: string;
  kind?: 'font';
}

export interface PreviewMediaPlan {
  sources: Record<string, string>;
  requests: PreviewAudioRequest[];
  missingMedia: string[];
}

const DIRECT_BLOB = /^blob:[^?#]+$/u;
const DIRECT_TICKET = /^\/api\/media\/[a-f0-9]{32}$/u;
const H3_SILENT_CONDITIONING_SOURCE = 'comfyrizz/deterministic-silence-500ms-24k-mono';

function directUrl(file: string): boolean {
  return DIRECT_BLOB.test(file) || DIRECT_TICKET.test(file);
}

/**
 * Resolve only media the browser can actually play. Static package paths are
 * never handed to native audio elements: they need an authenticated blob first.
 */
export function previewMediaPlan(pkg: any, cachedSources: Record<string, string> = {}): PreviewMediaPlan {
  const sources = { ...cachedSources };
  const requests: PreviewAudioRequest[] = [];
  const missingMedia: string[] = [];
  const assets = pkg?.assets && typeof pkg.assets === 'object' ? pkg.assets : {};
  for (const font of Array.isArray(pkg?.theme?.fonts) ? pkg.theme.fonts : []) {
    const file = typeof font?.file === 'string' ? font.file : '';
    if (file && !sources[file]) requests.push({ assetId: '', file, cacheKey: `font:${pkg?.revision ?? 0}:${file}`, kind: 'font' });
  }
  for (const [assetId, asset] of Object.entries<any>(assets)) {
    const file = typeof asset?.file === 'string' ? asset.file : '';
    if (!file) continue;
    if (directUrl(file)) {
      sources[file] = file;
      continue;
    }
    if (!['audio', 'video', 'image'].includes(asset?.kind) || asset?.status !== 'ready' || asset?.source?.id === H3_SILENT_CONDITIONING_SOURCE) continue;
    if (sources[file]) continue;
    // Video and image takes resolve through their own ticket hydrator. Until
    // then, show the existing missing-media state rather than a static 404.
    missingMedia.push(file);
    if (asset.kind === 'audio') requests.push({ assetId, file, cacheKey: typeof asset?.sha256 === 'string' ? asset.sha256 : file });
  }
  return { sources, requests, missingMedia };
}
