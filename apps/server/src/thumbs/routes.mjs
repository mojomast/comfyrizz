/**
 * ASSET-VIEWER AV03: `GET /api/thumbs`.
 *
 * The route resolves a source only through the package or take store, confines
 * the stored relative path with `safeMediaFile`, and asks the AV02 service for
 * a content-addressed thumbnail. The image itself is never served here: a
 * ready response carries a short-lived media ticket URL, so the session token
 * never appears in an image URL. The metadata response is immutable for a
 * content key and answers `If-None-Match` with 304.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';

import { safeMediaFile } from '../media-route.mjs';
import { createThumbService } from './service.mjs';
import { THUMB_KINDS } from './spec.mjs';

export const THUMB_ROUTE_PATH = '/api/thumbs';

const PACKAGE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TAKE_ID_RE = /^tk_[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const IMMUTABLE = 'private, max-age=31536000, immutable';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json']);

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body);
}

function hasHeaderAuth(request) {
  const headers = request?.headers ?? {};
  const token = headers['x-comfyrizz-token'];
  if (typeof token === 'string' && token.length > 0) return true;
  const authorization = headers.authorization;
  return typeof authorization === 'string' && /^Bearer\s+\S+/i.test(authorization);
}

function matchesIfNoneMatch(request, key) {
  const header = request?.headers?.['if-none-match'];
  if (typeof header !== 'string') return false;
  return header.split(',').some((value) => {
    let tag = value.trim();
    if (tag.startsWith('W/')) tag = tag.slice(2);
    if (tag.startsWith('"') && tag.endsWith('"')) tag = tag.slice(1, -1);
    return tag === key || tag === '*';
  });
}

function parseRef(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return null;
  if (/[\u0000-\u001f\u007f\\/]/.test(value)) return null;
  const parts = value.split(':');
  if (parts.length === 2) {
    const [clipId, takeId] = parts;
    if (!ASSET_ID_RE.test(clipId) || !TAKE_ID_RE.test(takeId)) return null;
    return { clipId, takeId };
  }
  if (parts.length !== 1 || !ASSET_ID_RE.test(value)) return null;
  return { assetId: value };
}

function noneReason(value) {
  return value === 'text' ? 'text' : 'no-media';
}

function durationOf(media) {
  if (!media || typeof media !== 'object') return undefined;
  for (const candidate of [media.durationSeconds, media.durationSec, media.duration]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  if (typeof media.frames === 'number' && Number.isFinite(media.frames) && media.frames > 0
    && typeof media.fps === 'number' && Number.isFinite(media.fps) && media.fps > 0) {
    return media.frames / media.fps;
  }
  return undefined;
}

function sourceKindFor(asset, file) {
  const declared = asset?.kind;
  if (declared === 'image' || declared === 'video' || declared === 'audio' || declared === 'text') {
    return declared;
  }
  const extension = extname(file).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  return null;
}

function sha256For(file, recorded) {
  if (typeof recorded === 'string' && SHA256_RE.test(recorded)) return recorded.toLowerCase();
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Resolve one stored relative path inside `root`. A bad path is a client error;
 * a path that is simply absent is a `none` source, not a failure.
 */
function confinedSource(root, relative) {
  const file = safeMediaFile(root, relative);
  if (!file) return { bad: true };
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { missing: true };
    throw error;
  }
  if (!stat.isFile()) return { missing: true };
  try {
    const rootReal = realpathSync(root);
    const fileReal = realpathSync(file);
    if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${sep}`)) return { bad: true };
  } catch {
    return { missing: true };
  }
  return { file };
}

export function createThumbRoutes(options = {}) {
  const { store, takeStore, runtimeDir, mediaTickets = null } = options;
  if (!store || typeof store.read !== 'function' || typeof store.path !== 'function') {
    throw new TypeError('createThumbRoutes needs a package store');
  }
  if (!takeStore || typeof takeStore.read !== 'function' || typeof takeStore.packageRoot !== 'function') {
    throw new TypeError('createThumbRoutes needs a take store');
  }
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
    throw new TypeError('createThumbRoutes needs a runtimeDir');
  }
  const thumbs = options.thumbs ?? createThumbService({ runtimeDir });
  const thumbsRoot = join(runtimeDir, 'thumbs');

  function insideThumbs(file) {
    try {
      const rootReal = realpathSync(thumbsRoot);
      const fileReal = realpathSync(file);
      return fileReal === rootReal || fileReal.startsWith(`${rootReal}${sep}`);
    } catch {
      return false;
    }
  }

  function finishReady(request, response, result, kind) {
    const key = result.key;
    if (typeof key !== 'string' || !SHA256_RE.test(key)) throw new Error('thumbnail service returned an invalid key');
    if (!Number.isSafeInteger(result.width) || result.width <= 0
      || !Number.isSafeInteger(result.height) || result.height <= 0) {
      throw new Error('thumbnail service returned invalid dimensions');
    }

    if (matchesIfNoneMatch(request, key)) {
      response.writeHead(304, {
        etag: key,
        'cache-control': IMMUTABLE,
        'x-content-type-options': 'nosniff',
      });
      response.end();
      return;
    }

    if (typeof result.file !== 'string' || !existsSync(result.file) || !statSync(result.file).isFile()
      || !insideThumbs(result.file)) {
      sendJson(response, 200, { status: 'none', reason: 'no-media' });
      return;
    }
    if (!mediaTickets || typeof mediaTickets.mint !== 'function') {
      sendJson(response, 503, { error: 'media tickets are not available' });
      return;
    }

    const minted = mediaTickets.mint(result.file);
    const body = {
      status: 'ready',
      key,
      ticketUrl: minted.url,
      width: result.width,
      height: result.height,
    };
    if (kind === 'filmstrip' && Array.isArray(result.tiles)) body.tiles = result.tiles;
    if (kind === 'waveform' && Array.isArray(result.peaks)) body.peaks = result.peaks;
    sendJson(response, 200, body, { etag: key, 'cache-control': IMMUTABLE });
  }

  function serveSource(request, response, { pkg, relative, asset, recordedSha, media, kind }) {
    const root = takeStore.packageRoot(pkg.id);
    const located = confinedSource(root, relative);
    if (located.bad) {
      sendJson(response, 400, { error: 'bad path' });
      return;
    }
    if (located.missing) {
      sendJson(response, 200, { status: 'none', reason: 'no-media' });
      return;
    }

    const sourceKind = sourceKindFor(asset, located.file);
    if (sourceKind === null) {
      sendJson(response, 200, { status: 'none', reason: 'no-media' });
      return;
    }
    if (sourceKind === 'text') {
      sendJson(response, 200, { status: 'none', reason: 'text' });
      return;
    }

    const durationSec = durationOf(media);
    if (sourceKind === 'video' && durationSec === undefined && (kind === 'poster' || kind === 'filmstrip')) {
      sendJson(response, 200, { status: 'none', reason: 'no-media' });
      return;
    }

    const source = {
      file: located.file,
      sha256: sha256For(located.file, recordedSha),
      kind: sourceKind,
      ...(durationSec === undefined ? {} : { durationSec }),
    };

    let result;
    try {
      result = thumbs.get(source, kind);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        sendJson(response, 400, { error: 'invalid media source' });
        return;
      }
      throw error;
    }

    if (!result || typeof result.status !== 'string') throw new Error('thumbnail service returned no status');
    if (result.status === 'ready') return finishReady(request, response, result, kind);
    if (result.status === 'pending') {
      sendJson(response, 202, { status: 'pending' });
      return;
    }
    if (result.status === 'failed') {
      sendJson(response, 200, {
        status: 'failed',
        reason: typeof result.reason === 'string' && result.reason ? result.reason : 'thumbnail-failed',
      });
      return;
    }
    if (result.status === 'none') {
      sendJson(response, 200, { status: 'none', reason: noneReason(result.reason) });
      return;
    }
    throw new Error('thumbnail service returned an unknown status');
  }

  async function handle(request, response, url) {
    let pathname;
    try {
      pathname = typeof url === 'string' ? new URL(url, 'http://127.0.0.1').pathname : url?.pathname;
    } catch {
      return false;
    }
    if (pathname !== THUMB_ROUTE_PATH) return false;

    if (!hasHeaderAuth(request)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return true;
    }
    if (String(request.method ?? 'GET').toUpperCase() !== 'GET') {
      sendJson(response, 405, { error: 'method not allowed' });
      return true;
    }

    try {
      const params = url.searchParams;
      const packageId = params.get('packageId');
      const rawRef = params.get('ref');
      const kind = params.get('kind');

      if (typeof packageId !== 'string' || !PACKAGE_ID_RE.test(packageId)) {
        sendJson(response, 400, { error: 'invalid packageId' });
        return true;
      }
      const ref = parseRef(rawRef);
      if (!ref) {
        sendJson(response, 400, { error: 'invalid ref' });
        return true;
      }
      if (typeof kind !== 'string' || !THUMB_KINDS.includes(kind)) {
        sendJson(response, 400, { error: `kind must be one of: ${THUMB_KINDS.join(', ')}` });
        return true;
      }

      let pkg;
      try {
        pkg = store.read(packageId);
      } catch {
        sendJson(response, 400, { error: 'invalid packageId' });
        return true;
      }
      if (!pkg) {
        sendJson(response, 404, { error: 'package not found' });
        return true;
      }

      if (ref.assetId !== undefined) {
        const asset = pkg.assets?.[ref.assetId];
        if (!asset || typeof asset !== 'object' || typeof asset.file !== 'string') {
          sendJson(response, 400, { error: 'invalid ref' });
          return true;
        }
        serveSource(request, response, {
          pkg,
          relative: asset.file,
          asset,
          recordedSha: asset.sha256,
          media: asset.media,
          kind,
        });
        return true;
      }

      const doc = takeStore.read(packageId);
      const entry = doc?.clips?.[ref.clipId];
      const take = Array.isArray(entry?.takes)
        ? entry.takes.find(candidate => candidate?.takeId === ref.takeId && candidate.purged !== true)
        : null;
      if (!take || typeof take.file !== 'string') {
        sendJson(response, 400, { error: 'invalid ref' });
        return true;
      }
      const asset = pkg.assets?.[ref.clipId];
      serveSource(request, response, {
        pkg,
        relative: take.file,
        asset: asset && typeof asset === 'object' ? asset : null,
        recordedSha: take.sha256,
        media: take.media ?? asset?.media,
        kind,
      });
      return true;
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: 'thumbnail unavailable' });
      return true;
    }
  }

  return Object.freeze({ handle });
}
