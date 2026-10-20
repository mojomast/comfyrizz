/**
 * Browser client for the reference routes (REFERENCE-ASSETS R08/R12).
 *
 * The conversation id is supplied by the project chat, which owns the session
 * state. Uploads are a raw body with the file's MIME type, a percent-encoded
 * display filename and the rights assertion header; nothing here is stored.
 */
import type {
  Reference,
  ReferenceApi,
  ReferenceAssignment,
  ReferenceMutation,
  ReferenceUploadFile,
  UploadOptions,
} from './panel.ts';

export type ReferenceApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CreateReferenceApiOptions = {
  apiFetch: ReferenceApiFetch;
  /** Current conversation id, or null before the chat has created one. */
  chatId: () => string | null | undefined;
  /** Called before the first upload so the panel and chat share one id. */
  ensureChatId?: () => string | Promise<string>;
  /** Override for tests; returns the UUID part of a new conversation id. */
  randomId?: () => string;
};

export class ReferenceApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ReferenceApiError';
    this.status = status;
    if (code) this.code = code;
  }
}

const CHAT_ID = /^chat_[A-Za-z0-9_-]{8,80}$/;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export function referencesPath(chatId: string, suffix = ''): string {
  return `/api/chat/${encodeURIComponent(chatId)}/references${suffix}`;
}

function mimeFor(file: ReferenceUploadFile): string {
  const declared = String(file?.type ?? '').split(';')[0].trim().toLowerCase();
  if (declared) return declared;
  const name = String(file?.name ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return (dot >= 0 ? MIME_BY_EXTENSION[name.slice(dot + 1)] : undefined) ?? 'application/octet-stream';
}

function newChatId(randomId?: () => string): string {
  const suffix = randomId?.()
    ?? globalThis.crypto?.randomUUID?.()
    ?? Math.random().toString(36).slice(2, 12);
  return `chat_${suffix}`;
}

async function errorFor(response: Response): Promise<ReferenceApiError> {
  let body: { error?: unknown; code?: unknown } = {};
  try { body = await response.json() as typeof body; } catch { /* non-JSON error page */ }
  const message = typeof body.error === 'string' && body.error ? body.error : `HTTP ${response.status}`;
  const code = typeof body.code === 'string' && body.code ? body.code : undefined;
  return new ReferenceApiError(message, response.status, code);
}

async function jsonBody<T>(response: Response): Promise<T> {
  if (!response.ok) throw await errorFor(response);
  return await response.json() as T;
}

async function rawBody(file: ReferenceUploadFile): Promise<BodyInit> {
  // A real File is already a Blob: hand it to fetch without buffering videos.
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
  const blob = file as ReferenceUploadFile & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof blob.arrayBuffer === 'function') return await blob.arrayBuffer();
  return file as unknown as BodyInit;
}

export function createReferenceApi(options: CreateReferenceApiOptions): ReferenceApi & {
  chatId(): string | null;
  url(refId: string, kind?: 'file' | 'thumb'): string | undefined;
} {
  const current = (): string | null => {
    const value = options.chatId();
    return typeof value === 'string' && value ? value : null;
  };

  function requireChatId(): string {
    const value = current();
    if (!value) throw new ReferenceApiError('No conversation yet', 0, 'NO_CONVERSATION');
    return value;
  }

  async function ensureChatId(): Promise<string> {
    const existing = current();
    if (existing) return existing;
    let created = options.ensureChatId ? await options.ensureChatId() : newChatId(options.randomId);
    if (!created) created = newChatId(options.randomId);
    if (!CHAT_ID.test(created)) throw new ReferenceApiError('The conversation id is invalid', 0, 'INVALID_CHAT_ID');
    return created;
  }

  function urlFor(chatId: string, refId: string, kind: 'file' | 'thumb' = 'file'): string {
    return referencesPath(chatId, `/${encodeURIComponent(refId)}/${kind}`);
  }

  return {
    chatId: current,

    async list() {
      const chatId = current();
      if (!chatId) return { references: [], assignments: [] };
      const response = await options.apiFetch(referencesPath(chatId));
      const body = await jsonBody<{ references?: Reference[]; assignments?: ReferenceAssignment[] }>(response);
      return {
        references: Array.isArray(body?.references) ? body.references : [],
        assignments: Array.isArray(body?.assignments) ? body.assignments : [],
      };
    },

    async upload(file, uploadOptions?: UploadOptions) {
      const chatId = await ensureChatId();
      const total = Number.isFinite(file?.size) ? file.size : 0;
      uploadOptions?.onProgress?.({ loaded: 0, total });
      const body = await rawBody(file);
      const response = await options.apiFetch(referencesPath(chatId), {
        method: 'POST',
        headers: {
          'content-type': mimeFor(file),
          'x-filename': encodeURIComponent(String(file?.name ?? 'upload')),
          'x-rights-asserted': '1',
        },
        body,
        ...(uploadOptions?.signal ? { signal: uploadOptions.signal } : {}),
      });
      const record = await jsonBody<ReferenceMutation>(response);
      uploadOptions?.onProgress?.({ loaded: total, total });
      return record;
    },

    async patch(id, patch) {
      const chatId = requireChatId();
      const response = await options.apiFetch(referencesPath(chatId, `/${encodeURIComponent(id)}`), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      return await jsonBody<ReferenceMutation>(response);
    },

    async delete(id) {
      const chatId = requireChatId();
      const response = await options.apiFetch(referencesPath(chatId, `/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      });
      if (!response.ok) throw await errorFor(response);
    },

    thumbUrl(ref: Reference) {
      const chatId = current();
      return chatId && ref?.id ? urlFor(chatId, ref.id, 'thumb') : undefined;
    },

    fileUrl(ref: Reference) {
      const chatId = current();
      return chatId && ref?.id ? urlFor(chatId, ref.id, 'file') : undefined;
    },

    url(refId: string, kind: 'file' | 'thumb' = 'file') {
      const chatId = current();
      return chatId && refId ? urlFor(chatId, refId, kind) : undefined;
    },
  };
}
