/**
 * UX11 shared media ticket resolver.
 *
 * A ticket is a short-lived bearer URL. The durable identity is the
 * `MediaSource`; this module caches tickets by that identity, deduplicates
 * concurrent requests, renews before `expiresAt`, and bounds repeated renewal
 * failures. It never persists a ticket, never adds an API token to a URL, and
 * never invents a second media identity.
 *
 * Minting is injected so the takes route, thumbnails and audition routes keep
 * their existing endpoints. `takeTicketMinter` adapts the take API.
 */
import {
  MEDIA_RENEWAL_LIMIT,
  MEDIA_RENEW_BEFORE_MS,
  mediaSourceKey,
  ticketExpiryState,
} from '../../../server/src/productions/contract.mjs';

export type MediaSource =
  | { kind: 'take'; packageId: string; clipId: string; takeId: string }
  | { kind: 'artifact'; artifactId?: string; mediaId?: string }
  | { kind: 'package_media'; packageId: string; path: string }
  | { kind: 'thumb'; key: string };

export interface MediaTicket {
  kind: 'ticket';
  ticket: string;
  url: string;
  expiresAt: string | null;
  mediaId?: string;
  artifactId?: string | null;
  takeId?: string;
}

export interface MintOptions {
  signal?: AbortSignal;
}

export type MediaTicketMint = (source: MediaSource, options: MintOptions) => Promise<MediaTicket>;

export interface CreateTicketResolverOptions {
  mint: MediaTicketMint;
  now?: () => number;
  renewBeforeMs?: number;
  renewalLimit?: number;
  maxEntries?: number;
}

export interface TicketResolver {
  resolve(source: MediaSource, options?: MintOptions): Promise<MediaTicket>;
  invalidate(source: MediaSource): void;
  peek(source: MediaSource): MediaTicket | undefined;
  dispose(): void;
}

export type MediaTicketErrorCode =
  | 'INVALID_SOURCE'
  | 'INVALID_TICKET'
  | 'MEDIA_UNAVAILABLE'
  | 'DISPOSED';

export class MediaTicketError extends Error {
  code: MediaTicketErrorCode;
  attempts: number;

  constructor(message: string, code: MediaTicketErrorCode, attempts = 0) {
    super(message);
    this.name = 'MediaTicketError';
    this.code = code;
    this.attempts = attempts;
  }
}

const MEDIA_URL_RE = /^\/api\/media\/[A-Za-z0-9_-]+$/;
const SOURCE_KINDS = new Set(['take', 'artifact', 'package_media', 'thumb']);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

function validateSource(value: unknown): MediaSource {
  if (!isObject(value)) throw new MediaTicketError('a media source is required', 'INVALID_SOURCE');
  const kind = text(value.kind);
  if (!SOURCE_KINDS.has(kind)) {
    throw new MediaTicketError(`unknown media source kind: ${kind || '(empty)'}`, 'INVALID_SOURCE');
  }
  const requireText = (key: string): string => {
    const part = text(value[key]);
    if (!part) throw new MediaTicketError(`media source ${kind} requires ${key}`, 'INVALID_SOURCE');
    return part;
  };

  if (kind === 'take') {
    return {
      kind,
      packageId: requireText('packageId'),
      clipId: requireText('clipId'),
      takeId: requireText('takeId'),
    };
  }
  if (kind === 'artifact') {
    const artifactId = text(value.artifactId);
    const mediaId = text(value.mediaId);
    if (!artifactId && !mediaId) {
      throw new MediaTicketError('an artifact media source names artifactId or mediaId', 'INVALID_SOURCE');
    }
    return {
      kind,
      ...(artifactId ? { artifactId } : {}),
      ...(mediaId ? { mediaId } : {}),
    };
  }
  if (kind === 'package_media') {
    return { kind, packageId: requireText('packageId'), path: requireText('path') };
  }
  return { kind: 'thumb', key: requireText('key') };
}

function normalizeTicket(value: unknown): MediaTicket {
  if (!isObject(value)) throw new MediaTicketError('the media ticket is not an object', 'INVALID_TICKET');
  const ticket = text(value.ticket);
  const url = text(value.url) || (ticket ? `/api/media/${encodeURIComponent(ticket)}` : '');
  if (!MEDIA_URL_RE.test(url)) {
    throw new MediaTicketError('the media ticket did not return a media URL', 'INVALID_TICKET');
  }
  const expiresAt = text(value.expiresAt);
  const normalized: MediaTicket = {
    kind: 'ticket',
    ticket: ticket || url.slice(url.lastIndexOf('/') + 1),
    url,
    expiresAt: expiresAt || null,
  };
  const mediaId = text(value.mediaId);
  if (mediaId) normalized.mediaId = mediaId;
  if (typeof value.artifactId === 'string') normalized.artifactId = value.artifactId;
  else if (value.artifactId === null) normalized.artifactId = null;
  const takeId = text(value.takeId);
  if (takeId) normalized.takeId = takeId;
  return normalized;
}

interface PendingEntry {
  promise: Promise<MediaTicket>;
  controller: AbortController;
}

export function createTicketResolver(options: CreateTicketResolverOptions): TicketResolver {
  if (!isObject(options) || typeof options.mint !== 'function') {
    throw new TypeError('createTicketResolver requires a mint function');
  }
  const mint = options.mint;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const renewBeforeMs = typeof options.renewBeforeMs === 'number' && options.renewBeforeMs >= 0
    ? options.renewBeforeMs
    : MEDIA_RENEW_BEFORE_MS;
  const renewalLimit = typeof options.renewalLimit === 'number' && Number.isFinite(options.renewalLimit)
    ? Math.max(0, Math.floor(options.renewalLimit))
    : MEDIA_RENEWAL_LIMIT;
  const maxEntries = typeof options.maxEntries === 'number' && options.maxEntries > 0
    ? Math.floor(options.maxEntries)
    : 256;

  const cache = new Map<string, MediaTicket>();
  const pending = new Map<string, PendingEntry>();
  let disposed = false;

  function remember(key: string, value: MediaTicket): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function mintWithRenewals(
    source: MediaSource,
    key: string,
    signal: AbortSignal,
  ): Promise<MediaTicket> {
    const maxAttempts = renewalLimit + 1;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (disposed) throw new MediaTicketError('the ticket resolver is disposed', 'DISPOSED');
      if (signal.aborted) throw abortError();
      try {
        const minted = normalizeTicket(await mint(source, { signal }));
        if (disposed) throw new MediaTicketError('the ticket resolver is disposed', 'DISPOSED');
        if (signal.aborted) throw abortError();
        remember(key, minted);
        return minted;
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof MediaTicketError && (error.code === 'INVALID_SOURCE' || error.code === 'INVALID_TICKET')) {
          throw error;
        }
        lastError = error;
      }
    }
    const detail = lastError instanceof Error && lastError.message ? `: ${lastError.message}` : '';
    throw new MediaTicketError(
      `media is unavailable after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}${detail}`,
      'MEDIA_UNAVAILABLE',
      maxAttempts,
    );
  }

  function start(source: MediaSource, key: string): Promise<MediaTicket> {
    const existing = pending.get(key);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const promise = mintWithRenewals(source, key, controller.signal)
      .finally(() => {
        if (pending.get(key)?.controller === controller) pending.delete(key);
      });
    pending.set(key, { promise, controller });
    return promise;
  }

  return {
    async resolve(value, resolveOptions = {}) {
      if (disposed) throw new MediaTicketError('the ticket resolver is disposed', 'DISPOSED');
      const source = validateSource(value);
      const key = mediaSourceKey(source);
      const cached = cache.get(key);
      if (cached && ticketExpiryState(cached, now(), renewBeforeMs) === 'fresh') {
        return cached;
      }
      if (cached) cache.delete(key);
      const callerSignal = resolveOptions?.signal;
      if (callerSignal?.aborted) throw abortError();
      return withSignal(start(source, key), callerSignal);
    },

    invalidate(value) {
      const source = validateSource(value);
      const key = mediaSourceKey(source);
      cache.delete(key);
      const inFlight = pending.get(key);
      if (inFlight) {
        pending.delete(key);
        inFlight.controller.abort();
      }
    },

    peek(value) {
      const source = validateSource(value);
      return cache.get(mediaSourceKey(source));
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of pending.values()) entry.controller.abort();
      pending.clear();
      cache.clear();
    },
  };
}

export interface TakeTicketApi {
  takeTicket(
    packageId: string,
    clipId: string,
    takeId: string,
  ): Promise<{ ticket: string; url: string; expiresAt?: string | null; takeId?: string | null }>;
}

/** Adapt the take API's ticket route to the shared resolver mint contract. */
export function takeTicketMinter(api: TakeTicketApi): MediaTicketMint {
  if (!api || typeof api.takeTicket !== 'function') {
    throw new TypeError('takeTicketMinter requires a takeTicket function');
  }
  return async (value, mintOptions = {}) => {
    const source = validateSource(value);
    if (source.kind !== 'take') {
      throw new MediaTicketError('the take ticket minter only resolves take sources', 'INVALID_SOURCE');
    }
    if (mintOptions.signal?.aborted) throw abortError();
    const ticket = await api.takeTicket(source.packageId, source.clipId, source.takeId);
    return normalizeTicket(ticket);
  };
}
