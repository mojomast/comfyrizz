import {
  ACCEPT_ATTRIBUTE as MEDIA_ACCEPT_ATTRIBUTE,
  LIMITS as REFERENCE_LIMITS,
  formatDuration,
  formatFileSize,
  precheckFile,
  type Reference,
  type ReferenceApi,
  type ReferenceMutation,
  type ReferenceUploadFile,
} from '../../references/panel.ts';
import { createReferenceApi, ReferenceApiError, referencesPath } from '../../references/api.ts';
import { escapeHtml } from '../components.ts';
import type { VideoType } from './video-types.ts';

export const CONTEXT_ATTACHMENT_LIMIT = REFERENCE_LIMITS.maxReferences;
export const CONTEXT_DOCUMENT_LIMIT = 12;
export const CONTEXT_URL_LIMIT = 3;
export const CONTEXT_DOCUMENT_MAX_BYTES = 256 * 1024;
export const CONTEXT_DOCUMENT_TOTAL_MAX_BYTES = 1024 * 1024;
export const CONTEXT_ACCEPT_ATTRIBUTE = [
  MEDIA_ACCEPT_ATTRIBUTE,
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  'text/markdown',
  'text/plain',
  'text/csv',
].join(',');

export type ContextAttachmentSource = 'media' | 'context';
export type ContextAttachmentKind = 'image' | 'video' | 'audio' | 'markdown' | 'text' | 'csv' | 'url';
export type ContextAttachmentUsage = 'reference' | 'editorial';
export type EditorialScope = 'custom' | 'product-walkthrough' | 'music-video';

export interface SuperEasyContextAttachment {
  id: string;
  source: ContextAttachmentSource;
  kind: ContextAttachmentKind;
  label: string;
  mime?: string;
  bytes?: number;
  durationSec?: number;
  role?: string;
  note?: string;
  usage: ContextAttachmentUsage;
  editorialScope?: EditorialScope;
  rightsAsserted: boolean;
  url?: string;
  revision?: number;
  updatedAt?: string;
  /** Server content identity, used only to invalidate stale plans. */
  contentHash?: string;
}

export type ContextPendingStatus = 'queued' | 'uploading' | 'fetching' | 'error';

export interface ContextPendingItem {
  key: string;
  name: string;
  status: ContextPendingStatus;
  error?: string;
}

export interface ContextAttachmentChange {
  attachments: readonly SuperEasyContextAttachment[];
  attachmentSignature: string | null;
  attachmentRevision: number;
}

export interface ContextAttachmentSnapshot extends ContextAttachmentChange {
  pending: readonly ContextPendingItem[];
  message: string;
  messageError: boolean;
}

export interface SuperEasyContextAttachments {
  snapshot(): ContextAttachmentSnapshot;
  attachFiles(files: readonly ReferenceUploadFile[]): Promise<boolean>;
  addUrl(url: string): Promise<boolean>;
  remove(source: ContextAttachmentSource, id: string): Promise<boolean>;
  setUsage(id: string, editorial: boolean): Promise<boolean>;
  setNote(id: string, note: string): Promise<boolean>;
  dismissPending(key: string): void;
  reload(): Promise<boolean>;
  reset(): void;
  destroy(): void;
}

export function contextAttachmentsPath(chatId: string, suffix = ''): string {
  return `/api/chat/${encodeURIComponent(chatId)}/context-attachments${suffix}`;
}

export function validatePublicHttpUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return null;
  if (hostname === '::1' || hostname === '::' || hostname.startsWith('fe80:') || hostname.startsWith('fc') || hostname.startsWith('fd')) return null;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some(part => part > 255)) return null;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
  }
  return parsed.toString();
}

interface ContextFileType {
  kind: 'markdown' | 'text' | 'csv';
  mime: string;
  extensions: readonly string[];
}

const DOCUMENT_TYPES: readonly ContextFileType[] = [
  { kind: 'markdown', mime: 'text/markdown', extensions: ['md', 'markdown'] },
  { kind: 'text', mime: 'text/plain', extensions: ['txt'] },
  { kind: 'csv', mime: 'text/csv', extensions: ['csv'] },
];

function extensionOf(name: string): string {
  const clean = name.trim().toLowerCase();
  const dot = clean.lastIndexOf('.');
  return dot < 0 ? '' : clean.slice(dot + 1);
}

export function documentTypeFor(file: Pick<ReferenceUploadFile, 'name' | 'type'>): ContextFileType | null {
  const extension = extensionOf(file.name);
  const byExtension = DOCUMENT_TYPES.find(type => type.extensions.includes(extension));
  // The server requires one of these extensions even when the MIME is text.
  if (!byExtension) return null;
  const declared = String(file.type ?? '').split(';')[0].trim().toLowerCase();
  // A missing browser MIME is canonicalized from the extension before upload.
  // Otherwise mirror the server's three accepted upload MIME values exactly.
  if (declared && declared !== 'text/plain' && declared !== 'text/markdown' && declared !== 'text/csv') return null;
  return byExtension;
}

export function contextFileError(file: ReferenceUploadFile): string | null {
  const document = documentTypeFor(file);
  if (document) {
    if (file.size <= 0) return `${file.name}: empty file`;
    if (file.size > CONTEXT_DOCUMENT_MAX_BYTES) return `${file.name}: documents max ${formatFileSize(CONTEXT_DOCUMENT_MAX_BYTES)}`;
    return null;
  }
  const checked = precheckFile(file);
  return checked.ok ? null : `${file.name}: ${checked.message}`;
}

function contentTypeFor(file: ReferenceUploadFile): string {
  const document = documentTypeFor(file);
  if (document) return document.mime;
  const declared = String(file.type ?? '').split(';')[0].trim();
  if (declared) return declared;
  const extension = extensionOf(file.name);
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

async function rawBody(file: ReferenceUploadFile): Promise<BodyInit> {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
  const candidate = file as ReferenceUploadFile & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof candidate.arrayBuffer === 'function') return await candidate.arrayBuffer();
  return file as unknown as BodyInit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mutationRecord(body: unknown, key: 'reference' | 'attachment'): Record<string, unknown> {
  if (isRecord(body) && isRecord(body[key])) return body[key] as Record<string, unknown>;
  if (isRecord(body) && isRecord(body.record)) return body.record;
  return isRecord(body) ? body : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rightsAsserted(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

export function mediaAttachmentOf(body: ReferenceMutation | Reference | unknown, uploadedWithRights = false): SuperEasyContextAttachment | null {
  const record = mutationRecord(body, 'reference');
  const id = text(record.id);
  if (!id) return null;
  const kind = record.kind === 'video' ? 'video' : record.kind === 'audio' ? 'audio' : 'image';
  const durationSec = numberOrUndefined(record.durationSec) ?? numberOrUndefined(record.durationSeconds);
  return {
    id,
    source: 'media',
    kind,
    label: text(record.label) || text(record.filename) || text(record.name) || 'Untitled reference',
    ...(text(record.mime) ? { mime: text(record.mime) } : {}),
    ...(numberOrUndefined(record.bytes) === undefined ? {} : { bytes: numberOrUndefined(record.bytes) }),
    ...(durationSec === undefined || durationSec < 0 ? {} : { durationSec }),
    ...(text(record.role) ? { role: text(record.role) } : {}),
    ...(text(record.note) ? { note: text(record.note) } : {}),
    usage: record.usage === 'editorial' ? 'editorial' : 'reference',
    ...(['custom', 'product-walkthrough', 'music-video'].includes(text(record.editorialScope)) ? { editorialScope: record.editorialScope as EditorialScope } : {}),
    rightsAsserted: rightsAsserted(record.rightsAsserted) || uploadedWithRights,
    ...(numberOrUndefined(record.revision) === undefined ? {} : { revision: numberOrUndefined(record.revision) }),
    ...(text(record.updatedAt) ? { updatedAt: text(record.updatedAt) } : {}),
  };
}

export function contextAttachmentOf(body: unknown): SuperEasyContextAttachment | null {
  const record = mutationRecord(body, 'attachment');
  const id = text(record.id);
  if (!id) return null;
  const rawKind = text(record.kind) || text(record.type);
  const mime = text(record.mime) || text(record.contentType);
  const url = text(record.url) || text(record.sourceUrl);
  const kind: ContextAttachmentKind = url || rawKind === 'url'
    ? 'url'
    : rawKind === 'markdown' || mime.includes('markdown')
      ? 'markdown'
      : rawKind === 'csv' || mime.includes('csv')
        ? 'csv'
        : 'text';
  return {
    id,
    source: 'context',
    kind,
    label: text(record.label) || text(record.title) || text(record.filename) || text(record.name) || url || 'Attached context',
    ...(mime ? { mime } : {}),
    ...(numberOrUndefined(record.bytes) === undefined ? {} : { bytes: numberOrUndefined(record.bytes) }),
    ...(text(record.note) ? { note: text(record.note) } : {}),
    usage: 'reference',
    rightsAsserted: false,
    ...(url ? { url } : {}),
    ...(numberOrUndefined(record.revision) === undefined ? {} : { revision: numberOrUndefined(record.revision) }),
    ...(text(record.updatedAt) ? { updatedAt: text(record.updatedAt) } : {}),
    ...(text(record.contentHash) ? { contentHash: text(record.contentHash) } : {}),
  };
}

function stableSource(attachments: readonly SuperEasyContextAttachment[]): string {
  return attachments
    .map(item => [
      item.source, item.id, item.kind, item.label, item.mime ?? '', item.bytes ?? '', item.durationSec ?? '',
      item.role ?? '', item.note ?? '', item.usage, item.editorialScope ?? '', item.rightsAsserted ? '1' : '0', item.url ?? '',
      item.revision ?? '', item.updatedAt ?? '', item.contentHash ?? '',
    ])
    .sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`))
    .map(row => JSON.stringify(row))
    .join('|');
}

/** A small persisted cache key, never the attached text or media itself. */
export function attachmentSignatureFor(attachments: readonly SuperEasyContextAttachment[]): string | null {
  if (attachments.length === 0) return null;
  const source = stableSource(attachments);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `ctx_${(hash >>> 0).toString(16).padStart(8, '0')}_${attachments.length}`;
}

export interface ContextDocumentApi {
  list(): Promise<unknown>;
  upload(file: ReferenceUploadFile): Promise<unknown>;
  addUrl(url: string): Promise<unknown>;
  delete(id: string): Promise<void>;
}

export function createContextDocumentApi(options: {
  apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  chatId(): string | null | undefined;
  ensureChatId(): string | Promise<string>;
}): ContextDocumentApi {
  function current(): string {
    const chatId = options.chatId();
    if (!chatId) throw new ReferenceApiError('No conversation yet', 0, 'NO_CONVERSATION');
    return chatId;
  }

  async function parse(response: Response): Promise<unknown> {
    if (response.ok) {
      try { return await response.json(); } catch { return {}; }
    }
    let body: { error?: unknown; message?: unknown; code?: unknown } = {};
    try { body = await response.json() as typeof body; } catch { /* non-JSON response */ }
    const message = text(body.error) || text(body.message) || `HTTP ${response.status}`;
    throw new ReferenceApiError(message, response.status, text(body.code) || undefined);
  }

  return {
    async list() {
      const response = await options.apiFetch(contextAttachmentsPath(current()));
      return await parse(response);
    },
    async upload(file) {
      const chatId = await options.ensureChatId();
      const response = await options.apiFetch(contextAttachmentsPath(chatId, '/file'), {
        method: 'POST',
        headers: {
          'content-type': contentTypeFor(file),
          'x-filename': encodeURIComponent(file.name || 'context.txt'),
        },
        body: await rawBody(file),
      });
      return await parse(response);
    },
    async addUrl(url) {
      const chatId = await options.ensureChatId();
      const response = await options.apiFetch(contextAttachmentsPath(chatId, '/url'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      return await parse(response);
    },
    async delete(id) {
      const response = await options.apiFetch(contextAttachmentsPath(current(), `/${encodeURIComponent(id)}`), { method: 'DELETE' });
      await parse(response);
    },
  };
}

function contextRows(body: unknown): SuperEasyContextAttachment[] {
  const rows = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.attachments)
      ? body.attachments
      : isRecord(body) && Array.isArray(body.contextAttachments)
        ? body.contextAttachments
        : isRecord(body) && Array.isArray(body.documents)
          ? body.documents
          : [];
  return rows.map(contextAttachmentOf).filter((item): item is SuperEasyContextAttachment => item !== null);
}

function referenceRows(body: Awaited<ReturnType<ReferenceApi['list']>>): SuperEasyContextAttachment[] {
  const rows = Array.isArray(body) ? body : Array.isArray(body.references) ? body.references : [];
  return rows.map(item => mediaAttachmentOf(item)).filter((item): item is SuperEasyContextAttachment => item !== null);
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'The attachment could not be saved.');
}

let pendingSequence = 0;

export interface CreateSuperEasyContextAttachmentsOptions {
  apiFetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  chatId(): string | null | undefined;
  /** Called only by an explicit file or URL attach, never by render or type selection. */
  ensureChatId(): string | Promise<string>;
  videoType(): VideoType | null | undefined;
  attachmentRevision?(): number;
  /** Invalidates every pending operation when the Easy project/session changes. */
  generation?(): number;
  referenceApi?: ReferenceApi;
  contextApi?: ContextDocumentApi;
  onChange?(change: ContextAttachmentChange): void;
  onStatus?(snapshot: ContextAttachmentSnapshot): void;
}

export function createSuperEasyContextAttachments(options: CreateSuperEasyContextAttachmentsOptions): SuperEasyContextAttachments {
  if (!options.referenceApi && !options.apiFetch) throw new Error('apiFetch is required for reference attachments');
  if (!options.contextApi && !options.apiFetch) throw new Error('apiFetch is required for context attachments');
  const references = options.referenceApi ?? createReferenceApi({
    apiFetch: options.apiFetch!,
    chatId: options.chatId,
    ensureChatId: options.ensureChatId,
  });
  const documents = options.contextApi ?? createContextDocumentApi({
    apiFetch: options.apiFetch!,
    chatId: options.chatId,
    ensureChatId: options.ensureChatId,
  });
  let items: SuperEasyContextAttachment[] = [];
  let pending: ContextPendingItem[] = [];
  let revision = Math.max(0, options.attachmentRevision?.() ?? 0);
  let message = '';
  let messageError = false;
  let destroyed = false;
  let changeVersion = 0;
  let operationEpoch = 0;

  interface OperationToken {
    epoch: number;
    generation: number | null;
  }

  function token(): OperationToken {
    return { epoch: operationEpoch, generation: options.generation?.() ?? null };
  }

  function active(check: OperationToken): boolean {
    return !destroyed
      && check.epoch === operationEpoch
      && (check.generation === null || options.generation?.() === check.generation);
  }

  function signature(): string | null {
    return attachmentSignatureFor(items);
  }

  function snapshot(): ContextAttachmentSnapshot {
    return {
      attachments: [...items],
      attachmentSignature: signature(),
      attachmentRevision: revision,
      pending: [...pending],
      message,
      messageError,
    };
  }

  function publishStatus(text: string, error = false): void {
    if (destroyed) return;
    message = text;
    messageError = error;
    options.onStatus?.(snapshot());
  }

  function publishPending(): void {
    if (!destroyed) options.onStatus?.(snapshot());
  }

  function commit(next: SuperEasyContextAttachment[], bumpRevision: boolean, check?: OperationToken): boolean {
    if (destroyed || (check && !active(check))) return false;
    const unique = new Map<string, SuperEasyContextAttachment>();
    for (const item of next) unique.set(`${item.source}:${item.id}`, item);
    items = [...unique.values()];
    if (bumpRevision) revision += 1;
    changeVersion += 1;
    options.onChange?.({ attachments: [...items], attachmentSignature: signature(), attachmentRevision: revision });
    return true;
  }

  function setPending(key: string, patch: Partial<ContextPendingItem>): void {
    pending = pending.map(item => item.key === key ? { ...item, ...patch } : item);
    publishPending();
  }

  async function attachFiles(files: readonly ReferenceUploadFile[]): Promise<boolean> {
    const check = token();
    if (!active(check) || files.length === 0) return false;
    let mediaCount = items.filter(item => item.source === 'media').length;
    let documentCount = items.filter(item => item.source === 'context').length;
    let documentBytes = items
      .filter(item => item.source === 'context')
      .reduce((total, item) => total + Math.max(0, item.bytes ?? 0), 0);
    let acceptedCount = 0;
    const queued = files.map(file => {
      const key = `context_${++pendingSequence}`;
      let error = contextFileError(file);
      if (!error) {
        if (documentTypeFor(file)) {
          documentCount += 1;
          if (documentCount > CONTEXT_DOCUMENT_LIMIT) {
            error = `${file.name}: the ${CONTEXT_DOCUMENT_LIMIT}-document limit has been reached`;
          } else if (documentBytes + file.size > CONTEXT_DOCUMENT_TOTAL_MAX_BYTES) {
            error = `${file.name}: documents and URL snapshots total max 1 MiB`;
          } else {
            documentBytes += file.size;
          }
        } else {
          mediaCount += 1;
          if (mediaCount > CONTEXT_ATTACHMENT_LIMIT) error = `${file.name}: the ${CONTEXT_ATTACHMENT_LIMIT}-media-reference limit has been reached`;
        }
      }
      if (!error) acceptedCount += 1;
      return { key, file, error };
    });
    pending = [...pending, ...queued.map(entry => ({ key: entry.key, name: entry.file.name, status: entry.error ? 'error' as const : 'queued' as const, ...(entry.error ? { error: entry.error } : {}) }))];
    publishStatus(acceptedCount ? `${acceptedCount} attachment${acceptedCount === 1 ? '' : 's'} queued.` : 'No supported attachments were queued.', acceptedCount === 0);
    if (acceptedCount === 0) return false;

    try {
      await options.ensureChatId();
      if (!active(check)) return false;
    } catch (error) {
      if (!active(check)) return false;
      for (const entry of queued.filter(item => !item.error)) setPending(entry.key, { status: 'error', error: messageOf(error) });
      publishStatus(`The conversation could not be prepared: ${messageOf(error)}`, true);
      return false;
    }

    let succeeded = 0;
    for (const entry of queued) {
      if (!active(check)) return false;
      if (entry.error) continue;
      const document = documentTypeFor(entry.file);
      setPending(entry.key, { status: 'uploading' });
      publishStatus(`Uploading ${entry.file.name}…`);
      try {
        if (document) {
          const body = await documents.upload(entry.file);
          if (!active(check)) return false;
          const item = contextAttachmentOf(body);
          if (!item) throw new Error('The server did not return the document label.');
          if (!commit([...items, item], true, check)) return false;
        } else {
          const uploaded = await references.upload(entry.file);
          if (!active(check)) return false;
          let item = mediaAttachmentOf(uploaded, true);
          if (!item) throw new Error('The server did not return the uploaded reference.');
          if (options.videoType() === 'product-walkthrough') {
            const patched = await references.patch(item.id, { role: 'product', usage: 'reference' });
            if (!active(check)) return false;
            item = mediaAttachmentOf(patched, true) ?? { ...item, role: 'product', usage: 'reference', rightsAsserted: true };
          } else if (String(options.videoType()) === 'music-video' && (item.kind === 'audio' || item.kind === 'image')) {
            const role = item.kind === 'audio' ? 'song' : 'subject';
            const patched = await references.patch(item.id, { role, usage: 'reference' });
            if (!active(check)) return false;
            item = mediaAttachmentOf(patched, true) ?? { ...item, role, usage: 'reference', rightsAsserted: true };
          }
          if (!commit([...items, item], true, check)) return false;
        }
        pending = pending.filter(item => item.key !== entry.key);
        succeeded += 1;
        publishStatus(`${entry.file.name} attached as planning context. Reference-only media is not output footage.`);
      } catch (error) {
        if (!active(check)) return false;
        setPending(entry.key, { status: 'error', error: messageOf(error) });
        publishStatus(`${entry.file.name}: ${messageOf(error)}`, true);
      }
    }
    return active(check) && succeeded > 0;
  }

  async function addUrl(value: string): Promise<boolean> {
    const check = token();
    if (!active(check)) return false;
    const url = validatePublicHttpUrl(value);
    const key = `context_${++pendingSequence}`;
    const name = value.trim() || 'URL';
    if (!url) {
      pending = [...pending, { key, name, status: 'error', error: 'Enter a public HTTP or HTTPS URL.' }];
      publishStatus('Enter a public HTTP or HTTPS URL. Local, private and credential-bearing URLs are not allowed.', true);
      return false;
    }
    const contextItems = items.filter(item => item.source === 'context');
    const contextBytes = contextItems.reduce((total, item) => total + Math.max(0, item.bytes ?? 0), 0);
    const capacityError = contextItems.length >= CONTEXT_DOCUMENT_LIMIT
      ? `The ${CONTEXT_DOCUMENT_LIMIT}-document limit has been reached.`
      : contextItems.filter(item => item.kind === 'url').length >= CONTEXT_URL_LIMIT
        ? `The ${CONTEXT_URL_LIMIT}-URL-snapshot limit has been reached.`
        : contextBytes >= CONTEXT_DOCUMENT_TOTAL_MAX_BYTES
          ? 'Documents and URL snapshots total max 1 MiB.'
          : null;
    if (capacityError) {
      pending = [...pending, { key, name, status: 'error', error: capacityError }];
      publishStatus(capacityError, true);
      return false;
    }
    pending = [...pending, { key, name, status: 'fetching' }];
    publishStatus(`Fetching ${url}…`);
    try {
      await options.ensureChatId();
      if (!active(check)) return false;
      const body = await documents.addUrl(url);
      if (!active(check)) return false;
      const item = contextAttachmentOf(body);
      if (!item) throw new Error('The server did not return the fetched page label.');
      if (!commit([...items, item], true, check)) return false;
      pending = pending.filter(entry => entry.key !== key);
      publishStatus(`${item.label} attached. Its text is planning context only.`);
      return true;
    } catch (error) {
      if (!active(check)) return false;
      setPending(key, { status: 'error', error: messageOf(error) });
      publishStatus(`${url}: ${messageOf(error)}`, true);
      return false;
    }
  }

  async function remove(source: ContextAttachmentSource, id: string): Promise<boolean> {
    const check = token();
    const existing = items.find(item => item.source === source && item.id === id);
    if (!existing || !active(check)) return false;
    publishStatus(`Removing ${existing.label}…`);
    try {
      if (source === 'media') await references.delete(id);
      else await documents.delete(id);
      if (!active(check)) return false;
      if (!commit(items.filter(item => !(item.source === source && item.id === id)), true, check)) return false;
      publishStatus(`${existing.label} removed.`);
      return true;
    } catch (error) {
      if (!active(check)) return false;
      publishStatus(`${existing.label} could not be removed: ${messageOf(error)}`, true);
      return false;
    }
  }

  async function setUsage(id: string, editorial: boolean): Promise<boolean> {
    const check = token();
    const existing = items.find(item => item.source === 'media' && item.id === id);
    if (!existing || !active(check)) return false;
    const product = options.videoType() === 'product-walkthrough';
    const musicVideo = String(options.videoType()) === 'music-video';
    const customImage = !options.videoType() && existing.kind === 'image';
    if (!product && !musicVideo && !customImage) {
      publishStatus('Editorial use is unavailable for this attachment and video type.', true);
      return false;
    }
    if (musicVideo && existing.kind === 'video') {
      publishStatus('Videos stay reference-only for Music Video.', true);
      return false;
    }
    if (editorial && !existing.rightsAsserted) {
      publishStatus('This media has no recorded rights assertion, so it must stay reference-only.', true);
      return false;
    }
    if (musicVideo && editorial && existing.kind === 'audio') {
      const otherSong = items.find(item => item.id !== id && item.source === 'media' && item.kind === 'audio' && item.usage === 'editorial');
      if (otherSong) {
        publishStatus(`Only one song master can be used at a time. Turn off “${otherSong.label}” first; it was not replaced.`, true);
        return false;
      }
    }
    const usage: ContextAttachmentUsage = editorial ? 'editorial' : 'reference';
    const editorialScope: EditorialScope | undefined = existing.kind === 'image' && editorial
      ? product ? 'product-walkthrough' : musicVideo ? 'music-video' : 'custom'
      : undefined;
    publishStatus(`${editorial ? 'Allowing' : 'Removing'} ${existing.label} ${editorial ? 'in the video' : 'from output footage'}…`);
    try {
      const body = await references.patch(id, { usage, ...(editorialScope ? { editorialScope } : {}) });
      if (!active(check)) return false;
      const updated = mediaAttachmentOf(body, existing.rightsAsserted) ?? { ...existing, usage, editorialScope };
      if (!commit(items.map(item => item.source === 'media' && item.id === id ? { ...updated, rightsAsserted: existing.rightsAsserted } : item), true, check)) return false;
      publishStatus(editorial ? `${existing.label} can be used in the video.` : `${existing.label} is reference-only.`);
      return true;
    } catch (error) {
      if (!active(check)) return false;
      publishStatus(`Usage could not be changed: ${messageOf(error)}`, true);
      return false;
    }
  }

  async function setNote(id: string, note: string): Promise<boolean> {
    const check = token();
    const existing = items.find(item => item.source === 'media' && item.id === id);
    if (!existing || !active(check)) return false;
    const trimmed = note.trim().slice(0, REFERENCE_LIMITS.noteMaxChars);
    publishStatus(`Saving the planning note for ${existing.label}…`);
    try {
      const body = await references.patch(id, { note: trimmed });
      if (!active(check)) return false;
      const updated = mediaAttachmentOf(body, existing.rightsAsserted) ?? { ...existing, note: trimmed };
      if (!commit(items.map(item => item.source === 'media' && item.id === id ? { ...updated, rightsAsserted: existing.rightsAsserted } : item), true, check)) return false;
      publishStatus(`Planning note saved for ${existing.label}.`);
      return true;
    } catch (error) {
      if (!active(check)) return false;
      publishStatus(`The planning note could not be saved: ${messageOf(error)}`, true);
      return false;
    }
  }

  async function reload(): Promise<boolean> {
    const check = token();
    if (!active(check) || !options.chatId()) return false;
    const startedChange = changeVersion;
    publishStatus('Loading attached context…');
    try {
      const [mediaBody, contextBody] = await Promise.all([references.list(), documents.list()]);
      if (!active(check) || startedChange !== changeVersion) return false;
      const media = referenceRows(mediaBody);
      const context = contextRows(contextBody);
      // The server is authoritative after a reload, including product usage and
      // the rights-assertion evidence that gates editorial opt-in.
      if (!commit([...media, ...context], false, check)) return false;
      publishStatus(items.length ? `${items.length} attached context item${items.length === 1 ? '' : 's'} loaded.` : 'No attached context yet.');
      return true;
    } catch (error) {
      if (!active(check)) return false;
      publishStatus(`Attached context could not be loaded: ${messageOf(error)}`, true);
      return false;
    }
  }

  return {
    snapshot,
    attachFiles,
    addUrl,
    remove,
    setUsage,
    setNote,
    dismissPending(key) {
      if (destroyed) return;
      pending = pending.filter(item => item.key !== key);
      publishPending();
    },
    reload,
    reset() {
      if (destroyed) return;
      operationEpoch += 1;
      items = [];
      pending = [];
      revision = 0;
      changeVersion += 1;
      message = '';
      messageError = false;
      options.onChange?.(snapshot());
      options.onStatus?.(snapshot());
    },
    destroy() {
      operationEpoch += 1;
      changeVersion += 1;
      destroyed = true;
    },
  };
}

function pendingMarkup(pending: readonly ContextPendingItem[]): string {
  if (pending.length === 0) return '';
  return pending.map(item => {
    const label = item.status === 'queued' ? 'Queued' : item.status === 'uploading' ? 'Uploading' : item.status === 'fetching' ? 'Fetching' : 'Error';
    return `<li class="super-easy-context-pending is-${item.status}"><span>${escapeHtml(label)} · ${escapeHtml(item.name)}</span>${item.error ? `<span class="super-easy-context-error">${escapeHtml(item.error)}</span>` : ''}<button type="button" class="btn btn-ghost btn-sm" data-super-easy-context-dismiss="${escapeHtml(item.key)}" aria-label="Dismiss ${escapeHtml(item.name)} status">Dismiss</button></li>`;
  }).join('');
}

function kindLabel(item: SuperEasyContextAttachment): string {
  return ({ image: 'Image', video: 'Video', audio: 'Audio', markdown: 'Markdown', text: 'Text', csv: 'CSV', url: 'URL' } as const)[item.kind];
}

export function renderContextAttachmentItems(items: readonly SuperEasyContextAttachment[], videoType: VideoType | null | undefined): string {
  if (items.length === 0) return '<li class="super-easy-context-empty">Nothing attached yet.</li>';
  const product = videoType === 'product-walkthrough';
  const musicVideo = String(videoType) === 'music-video';
  const custom = !videoType;
  return items.map(item => {
    const media = item.source === 'media';
    const size = item.bytes === undefined ? '' : ` · ${formatFileSize(item.bytes)}`;
    const duration = item.durationSec === undefined ? '' : ` · ${formatDuration(item.durationSec)}`;
    const scope = product ? 'product-walkthrough' : musicVideo ? 'music-video' : custom ? 'custom' : null;
    const editorial = media && item.usage === 'editorial' && (item.kind !== 'image' || item.editorialScope === scope);
    const musicToggle = item.kind === 'audio' ? 'Use as song master' : 'Use as performer reference';
    const musicHelp = !item.rightsAsserted
      ? 'Reference only · no recorded rights assertion'
      : item.kind === 'audio'
        ? 'Rights asserted at upload. Only one editorial song can be the master; reference-only is the default.'
        : editorial
          ? 'Rights asserted at upload. Performance is an experimental reviewed audition, not a synchronization guarantee.'
          : 'Rights asserted at upload. Reference-only is the default; opt in only for a performer image you may use.';
    const usage = (product && media) || (custom && media && item.kind === 'image')
      ? `<label class="super-easy-context-usage"><input type="checkbox" data-super-easy-context-usage="${escapeHtml(item.id)}" aria-label="Use ${escapeHtml(item.label)} in video" aria-describedby="super-easy-context-usage-help-${escapeHtml(item.id)}"${editorial ? ' checked' : ''}${item.rightsAsserted ? '' : ' disabled'} /> Use in video</label><span class="super-easy-context-usage-help" id="super-easy-context-usage-help-${escapeHtml(item.id)}">${item.rightsAsserted ? 'Rights asserted at upload. Only turn this on for media you have permission to use.' : 'Reference only · no recorded rights assertion'}</span>`
      : musicVideo && media && (item.kind === 'audio' || item.kind === 'image')
        ? `<label class="super-easy-context-usage"><input type="checkbox" data-super-easy-context-usage="${escapeHtml(item.id)}" aria-label="${musicToggle}: ${escapeHtml(item.label)}" aria-describedby="super-easy-context-usage-help-${escapeHtml(item.id)}"${editorial ? ' checked' : ''}${item.rightsAsserted ? '' : ' disabled'} /> ${musicToggle}</label><span class="super-easy-context-usage-help" id="super-easy-context-usage-help-${escapeHtml(item.id)}">${musicHelp}</span>`
        : `<span class="super-easy-context-reference">Reference only</span>`;
    const note = media
      ? `<label class="super-easy-context-note">Planning note for ${escapeHtml(item.label)}<input type="text" maxlength="${REFERENCE_LIMITS.noteMaxChars}" value="${escapeHtml(item.note ?? '')}" data-super-easy-context-note="${escapeHtml(item.id)}" placeholder="What should the planner know?" /></label>`
      : '';
    return `<li class="super-easy-context-item" data-context-source="${item.source}" data-context-id="${escapeHtml(item.id)}"><div class="super-easy-context-item-heading"><strong>${escapeHtml(item.label)}</strong><span>${kindLabel(item)}${duration}${size}</span></div>${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(item.url)}</a>` : ''}${usage}${note}<button type="button" class="btn btn-secondary btn-sm" data-super-easy-context-remove="${escapeHtml(item.id)}" data-context-source="${item.source}" aria-label="Remove ${escapeHtml(item.label)}">Remove</button></li>`;
  }).join('');
}

export function renderContextAttachmentStatus(snapshot: ContextAttachmentSnapshot): string {
  return pendingMarkup(snapshot.pending);
}

export function renderSuperEasyContextAttachments(): string {
  return `<section class="super-easy-context" aria-labelledby="super-easy-context-title" data-super-easy-attachments>
<h2 id="super-easy-context-title">Attach context <span class="super-easy-context-optional">(optional)</span></h2>
<p id="super-easy-context-help">PNG, JPEG, WEBP or GIF images (20 MiB each); MP4, MOV or WEBM videos (200 MiB, up to 60 seconds); WAV or MP3 audio (100 MiB, up to 300 seconds), up to ${CONTEXT_ATTACHMENT_LIMIT} media references. .md, .markdown, .txt or .csv documents up to 256 KiB each and 1 MiB total across documents/URL snapshots, with up to ${CONTEXT_DOCUMENT_LIMIT} document/URL attachments and ${CONTEXT_URL_LIMIT} URL snapshots.</p>
<label for="super-easy-context-files">Choose images, videos, audio or documents</label>
<input id="super-easy-context-files" type="file" multiple accept="${CONTEXT_ACCEPT_ATTRIBUTE}" data-super-easy-context-files aria-describedby="super-easy-context-help super-easy-context-planning-help" />
<div class="super-easy-context-url-row"><label for="super-easy-context-url">Public web page or document URL</label><div><input id="super-easy-context-url" type="url" inputmode="url" placeholder="https://example.com/brief" data-super-easy-context-url aria-describedby="super-easy-context-url-help" /><button type="button" class="btn btn-secondary" data-super-easy-context-add-url>Add URL</button></div></div>
<p class="super-easy-context-help" id="super-easy-context-url-help">Fetching starts only when you choose Add URL. Public HTTP/S only; links written in your prompt are never fetched automatically.</p>
<p class="super-easy-context-help" id="super-easy-context-planning-help">Documents and reference-only media are planning context, not output footage. Planning excerpts may omit content; uploaded CSV rows can be read in pages by the planner. Charts hold at most 64 values, so larger tables require a selection or aggregation. Review the proposal and its source values. A text-only planner may not visually understand media, so add a useful planning note. Choosing files asserts that you have the necessary rights; every editorial toggle is off by default and requires that recorded rights assertion. Image selections apply only to the selected video type; when switching types, opt in again for the new use. Older unscoped selections also need a fresh opt-in. In Custom, opt an image in to place the original still in the video; this does not animate it or use it for generation conditioning. Product Walkthrough keeps its existing Use in video control. For Music Video, explicitly opt a song in as the only master or an image in as a performer reference; videos stay reference-only.</p>
<ul class="super-easy-context-pending-list" data-super-easy-context-pending aria-label="Attachment activity"></ul>
<ul class="super-easy-context-list" data-super-easy-context-list aria-label="Attached context"><li class="super-easy-context-empty">Nothing attached yet.</li></ul>
<p class="super-easy-context-status" data-super-easy-context-status role="status" aria-live="polite" aria-atomic="true"></p>
</section>`;
}

/** Used by API-focused tests without depending on the UI controller. */
export { referencesPath };
