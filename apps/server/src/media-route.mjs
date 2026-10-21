import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { serveStaticFile } from './static-file.mjs';

const MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** Package-relative media path. Rejects absolute paths, traversal and empty segments. */
export function safeMediaFile(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) return null;
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0') || rel.includes('~')) return null;
  if (rel.split('/').some(part => part === '' || part === '.' || part === '..')) return null;
  const file = resolve(root, rel);
  const base = resolve(root);
  if (file !== base && !file.startsWith(base + sep)) return null;
  return file;
}

/**
 * Header-authenticated package media. Browser callers fetch a blob with their
 * API headers, or mint a short-lived /api/media-ticket for native playback.
 * The session token must never be placed in the media URL.
 */
export function handleMedia({ request, response, url, sendJson, runtimeDir, store }) {
  const match = /^\/api\/package\/([^/]+)\/media$/.exec(url.pathname);
  if (!match) return false;
  if (!request.headers['x-comfyrizz-token'] && !request.headers.authorization) {
    sendJson(response, 401, { error: 'use header authentication or a media ticket' });
    return true;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'method not allowed' });
    return true;
  }
  let id;
  try {
    id = decodeURIComponent(match[1]);
    store.path(id);
  } catch {
    sendJson(response, 400, { error: 'bad path' });
    return true;
  }
  const file = safeMediaFile(join(runtimeDir, 'media', id), url.searchParams.get('path') ?? '');
  if (!file) {
    sendJson(response, 400, { error: 'bad path' });
    return true;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    sendJson(response, 404, { error: 'not found' });
    return true;
  }
  serveStaticFile(request, response, file, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'private, no-store',
  });
  return true;
}
