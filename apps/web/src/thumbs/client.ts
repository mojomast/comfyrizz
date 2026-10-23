/**
 * Browser client for the thumbnail route (ASSET-VIEWER AV05).
 *
 * Every request goes through the injected `fetch`. The response only ever
 * returns a server-minted media ticket (`ticketUrl`); this module never builds
 * an image URL or puts a session token in a query string.
 *
 * Results are cached in a 200-entry LRU. A `failed` result stays cached until
 * `retry(ref)` clears it. Pending (`202`) responses are retried with a 1, 2, 4
 * second backoff, for at most five tries. At most four requests are in flight.
 */

export const THUMB_KINDS = ['poster', 'filmstrip', 'waveform'] as const;

export type ThumbKind = (typeof THUMB_KINDS)[number];

export interface ThumbTile {
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ThumbResult =
  | {
    status: 'ready';
    key: string;
    ticketUrl: string;
    width: number;
    height: number;
    tiles?: ThumbTile[];
    peaks?: number[];
  }
  | { status: 'pending' }
  | { status: 'failed'; reason: string }
  | { status: 'none'; reason: string };

export interface ThumbRequest {
  packageId: string;
  ref: string;
  kind: ThumbKind;
}

export interface CreateThumbsClientOptions {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  headers?: HeadersInit;
}

export interface ThumbsClient {
  load(request: ThumbRequest, signal?: AbortSignal): Promise<ThumbResult>;
  retry(ref: string): void;
}

interface CacheEntry {
  request: ThumbRequest;
  result: ThumbResult;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const THUMBS_PATH = '/api/thumbs';
const MAX_CACHE_ENTRIES = 200;
const MAX_IN_FLIGHT = 4;
const MAX_TRIES = 5;
const PENDING_BACKOFF_MS = [1000, 2000, 4000, 4000] as const;

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRequest(value: ThumbRequest): ThumbRequest {
  if (!isRecord(value)) throw new TypeError('load requires a request object');
  const { packageId, ref, kind } = value;
  if (typeof packageId !== 'string' || packageId.length === 0) {
    throw new TypeError('packageId must be a non-empty string');
  }
  if (typeof ref !== 'string' || ref.length === 0) throw new TypeError('ref must be a non-empty string');
  if (!THUMB_KINDS.includes(kind as ThumbKind)) {
    throw new TypeError(`kind must be one of ${THUMB_KINDS.join(', ')}`);
  }
  return { packageId, ref, kind: kind as ThumbKind };
}

function cacheKey(request: ThumbRequest): string {
  return `${request.packageId}\u0000${request.ref}\u0000${request.kind}`;
}

function reasonText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readyResult(body: Record<string, unknown>): ThumbResult {
  const { key, ticketUrl, width, height } = body;
  if (
    typeof key !== 'string' || key.length === 0
    || typeof ticketUrl !== 'string' || ticketUrl.length === 0
    || typeof width !== 'number' || !Number.isFinite(width) || width <= 0
    || typeof height !== 'number' || !Number.isFinite(height) || height <= 0
  ) {
    return { status: 'failed', reason: 'invalid_response' };
  }

  const result: Extract<ThumbResult, { status: 'ready' }> = { status: 'ready', key, ticketUrl, width, height };
  if (body.tiles !== undefined) {
    if (!Array.isArray(body.tiles)) return { status: 'failed', reason: 'invalid_response' };
    result.tiles = body.tiles as ThumbTile[];
  }
  if (body.peaks !== undefined) {
    if (!Array.isArray(body.peaks)) return { status: 'failed', reason: 'invalid_response' };
    result.peaks = body.peaks as number[];
  }
  return result;
}

async function parseResponse(response: Response): Promise<ThumbResult> {
  if (response.status === 202) {
    await response.text().catch(() => '');
    return { status: 'pending' };
  }

  let body: unknown;
  try {
    const text = await response.text();
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    return { status: 'failed', reason: 'invalid_response' };
  }

  if (isRecord(body)) {
    if (body.status === 'ready') {
      if (!response.ok) return { status: 'failed', reason: `http_${response.status}` };
      return readyResult(body);
    }
    if (body.status === 'pending') return { status: 'pending' };
    if (body.status === 'failed') {
      return { status: 'failed', reason: reasonText(body.reason, 'failed') };
    }
    if (body.status === 'none') {
      return { status: 'none', reason: reasonText(body.reason, 'none') };
    }
  }

  if (!response.ok) return { status: 'failed', reason: `http_${response.status}` };
  return { status: 'failed', reason: 'invalid_response' };
}

export function createThumbsClient(options: CreateThumbsClientOptions): ThumbsClient {
  if (!options || typeof options.fetch !== 'function') {
    throw new TypeError('createThumbsClient requires a fetch function');
  }

  const request = options.fetch;
  const headers = options.headers;
  const cache = new Map<string, CacheEntry>();
  const waiters: Waiter[] = [];
  let inFlight = 0;

  function pump(): void {
    while (inFlight < MAX_IN_FLIGHT && waiters.length > 0) {
      const waiter = waiters.shift() as Waiter;
      if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      inFlight += 1;
      waiter.resolve();
    }
  }

  function release(): void {
    inFlight -= 1;
    pump();
  }

  function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (inFlight < MAX_IN_FLIGHT) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index === -1) return;
          waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
    });
  }

  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function fetchOnce(url: string, signal?: AbortSignal): Promise<Response> {
    await acquire(signal);
    try {
      const init: RequestInit = {};
      if (headers !== undefined) init.headers = headers;
      if (signal !== undefined) init.signal = signal;
      return await request(url, init);
    } finally {
      release();
    }
  }

  async function fetchResult(thumbRequest: ThumbRequest, signal?: AbortSignal): Promise<ThumbResult> {
    const url = `${THUMBS_PATH}?${new URLSearchParams({
      packageId: thumbRequest.packageId,
      ref: thumbRequest.ref,
      kind: thumbRequest.kind,
    }).toString()}`;

    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      if (signal?.aborted) throw abortError();

      let response: Response;
      try {
        response = await fetchOnce(url, signal);
      } catch {
        if (signal?.aborted) throw abortError();
        return { status: 'failed', reason: 'network_error' };
      }
      if (signal?.aborted) throw abortError();

      const result = await parseResponse(response);
      if (signal?.aborted) throw abortError();

      if (result.status === 'pending' && attempt < MAX_TRIES) {
        await sleep(PENDING_BACKOFF_MS[attempt - 1], signal);
        continue;
      }
      return result;
    }

    return { status: 'pending' };
  }

  function store(thumbRequest: ThumbRequest, result: ThumbResult): void {
    if (result.status === 'pending') return;
    const key = cacheKey(thumbRequest);
    cache.delete(key);
    cache.set(key, { request: thumbRequest, result });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function cached(key: string): ThumbResult | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    cache.delete(key);
    cache.set(key, entry);
    return entry.result;
  }

  return {
    async load(value: ThumbRequest, signal?: AbortSignal): Promise<ThumbResult> {
      const thumbRequest = normalizeRequest(value);
      if (signal?.aborted) throw abortError();

      const key = cacheKey(thumbRequest);
      const hit = cached(key);
      if (hit !== undefined) return hit;

      const result = await fetchResult(thumbRequest, signal);
      if (signal?.aborted) throw abortError();
      store(thumbRequest, result);
      return result;
    },

    retry(ref: string): void {
      if (typeof ref !== 'string' || ref.length === 0) {
        throw new TypeError('retry requires a non-empty ref');
      }
      for (const [key, entry] of cache) {
        if (entry.request.ref === ref && entry.result.status === 'failed') cache.delete(key);
      }
    },
  };
}
