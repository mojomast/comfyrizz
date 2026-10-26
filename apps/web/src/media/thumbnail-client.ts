/**
 * UX11 thumbnail client with ticket expiry.
 *
 * The network request is injected (`load`, usually `ThumbsClient.load`); this
 * module owns the expiry-aware cache, concurrent-request deduplication and
 * explicit retry. A ready result keeps the server's `expiresAt`, so a timeline
 * seeks can renew a poster before the bearer URL expires. A legacy result
 * without `expiresAt` is used once and fetched again next time; it is never
 * treated as durable.
 */
import type {
  ThumbKind,
  ThumbRequest,
  ThumbResult,
  ThumbTile,
} from '../thumbs/client.ts';
import {
  MEDIA_RENEW_BEFORE_MS,
  ticketExpiryState,
} from '../../../server/src/productions/contract.mjs';

export type MediaThumbnailResult =
  | {
    status: 'ready';
    key: string;
    ticketUrl: string;
    width: number;
    height: number;
    expiresAt: string | null;
    tiles?: ThumbTile[];
    peaks?: number[];
  }
  | { status: 'pending' }
  | { status: 'failed'; reason: string }
  | { status: 'none'; reason: string };

export interface MediaThumbnailLoad {
  (request: ThumbRequest, signal?: AbortSignal): Promise<ThumbResult | MediaThumbnailResult>;
}

export interface CreateMediaThumbnailClientOptions {
  load: MediaThumbnailLoad;
  now?: () => number;
  renewBeforeMs?: number;
  maxEntries?: number;
}

export interface MediaThumbnailClient {
  load(request: ThumbRequest, options?: { signal?: AbortSignal }): Promise<MediaThumbnailResult>;
  retry(ref: string): void;
  invalidate(request: ThumbRequest): void;
  clear(): void;
}

interface CacheEntry {
  request: ThumbRequest;
  result: MediaThumbnailResult;
}

const THUMB_KINDS: readonly ThumbKind[] = ['poster', 'filmstrip', 'waveform'];

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function normalizeRequest(value: ThumbRequest): ThumbRequest {
  if (!isObject(value)) throw new TypeError('load requires a request object');
  const packageId = typeof value.packageId === 'string' ? value.packageId.trim() : '';
  const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
  const kind = String(value.kind ?? '') as ThumbKind;
  if (!packageId) throw new TypeError('packageId must be a non-empty string');
  if (!ref) throw new TypeError('ref must be a non-empty string');
  if (!THUMB_KINDS.includes(kind)) {
    throw new TypeError(`kind must be one of ${THUMB_KINDS.join(', ')}`);
  }
  return { packageId, ref, kind };
}

function cacheKey(request: ThumbRequest): string {
  return `${request.packageId}\u0000${request.ref}\u0000${request.kind}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeResult(value: unknown): MediaThumbnailResult {
  if (!isObject(value)) return { status: 'failed', reason: 'invalid_response' };
  if (value.status === 'ready') {
    const key = text(value.key);
    const ticketUrl = text(value.ticketUrl);
    const width = Number(value.width);
    const height = Number(value.height);
    if (!key || !ticketUrl || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      return { status: 'failed', reason: 'invalid_response' };
    }
    const ready: Extract<MediaThumbnailResult, { status: 'ready' }> = {
      status: 'ready',
      key,
      ticketUrl,
      width,
      height,
      expiresAt: text(value.expiresAt) || null,
    };
    if (Array.isArray(value.tiles)) ready.tiles = value.tiles as ThumbTile[];
    if (Array.isArray(value.peaks)) ready.peaks = value.peaks as number[];
    return ready;
  }
  if (value.status === 'pending') return { status: 'pending' };
  if (value.status === 'failed') {
    return { status: 'failed', reason: text(value.reason) || 'failed' };
  }
  if (value.status === 'none') {
    return { status: 'none', reason: text(value.reason) || 'none' };
  }
  return { status: 'failed', reason: 'invalid_response' };
}

export function createMediaThumbnailClient(
  options: CreateMediaThumbnailClientOptions,
): MediaThumbnailClient {
  if (!options || typeof options.load !== 'function') {
    throw new TypeError('createMediaThumbnailClient requires a load function');
  }
  const load = options.load;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const renewBeforeMs = typeof options.renewBeforeMs === 'number' && options.renewBeforeMs >= 0
    ? options.renewBeforeMs
    : MEDIA_RENEW_BEFORE_MS;
  const maxEntries = typeof options.maxEntries === 'number' && options.maxEntries > 0
    ? Math.floor(options.maxEntries)
    : 200;

  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<MediaThumbnailResult>>();

  function remember(request: ThumbRequest, result: MediaThumbnailResult): void {
    if (result.status === 'pending') return;
    const key = cacheKey(request);
    cache.delete(key);
    cache.set(key, { request, result });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function cached(request: ThumbRequest): MediaThumbnailResult | undefined {
    const key = cacheKey(request);
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.result.status === 'ready') {
      const state = ticketExpiryState(entry.result, now(), renewBeforeMs);
      if (state !== 'fresh') {
        cache.delete(key);
        return undefined;
      }
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.result;
  }

  function request(value: ThumbRequest): Promise<MediaThumbnailResult> {
    const key = cacheKey(value);
    const existing = pending.get(key);
    if (existing) return existing;
    let task: Promise<MediaThumbnailResult> | undefined;
    const tracked = (async () => {
      try {
        return normalizeResult(await load(value));
      } catch {
        return { status: 'failed' as const, reason: 'network_error' };
      }
    })().then(result => {
      remember(value, result);
      return result;
    }).finally(() => {
      if (task && pending.get(key) === task) pending.delete(key);
    });
    task = tracked;
    pending.set(key, tracked);
    return tracked;
  }

  return {
    async load(value, loadOptions = {}) {
      const thumbRequest = normalizeRequest(value);
      const signal = loadOptions?.signal;
      if (signal?.aborted) throw abortError();
      const hit = cached(thumbRequest);
      if (hit) {
        if (hit.status !== 'ready') return hit;
        return hit;
      }
      return withSignal(request(thumbRequest), signal);
    },

    retry(ref) {
      const wanted = text(ref);
      if (!wanted) throw new TypeError('retry requires a non-empty ref');
      for (const [key, entry] of cache) {
        if (entry.request.ref === wanted && entry.result.status !== 'ready') cache.delete(key);
      }
    },

    invalidate(value) {
      const thumbRequest = normalizeRequest(value);
      cache.delete(cacheKey(thumbRequest));
    },

    clear() {
      cache.clear();
    },
  };
}
