/**
 * References panel (REFERENCE-ASSETS R11).
 *
 * A small, dependency-free UI component. The state/controller part is pure
 * TypeScript so it can be tested with a fake API and no DOM; the mount helper
 * only touches the DOM when a browser host is supplied.
 */

import { confirmDialog } from '../easy/dialog.ts';

export const ROLES = [
  'style',
  'subject',
  'character',
  'motion',
  'background',
  'logo',
  'product',
  'palette',
  'composition',
  'other',
] as const;

export type ReferenceRole = (typeof ROLES)[number] | 'song';

export const ROLE_LABELS: Record<ReferenceRole, string> = {
  style: 'Style',
  subject: 'Subject',
  character: 'Character',
  motion: 'Motion',
  background: 'Background',
  logo: 'Logo',
  product: 'Product',
  palette: 'Palette',
  composition: 'Composition',
  other: 'Other',
  song: 'Song',
};

/**
 * Client-side mirror of the upload table in REFERENCE-ASSETS R02. The server
 * still sniffs the actual bytes; this table only catches obvious mistakes
 * before a request is made.
 */
export const LIMITS = {
  imageMaxBytes: 20 * 1024 * 1024,
  videoMaxBytes: 200 * 1024 * 1024,
  videoMaxSeconds: 60,
  audioMaxBytes: 100 * 1024 * 1024,
  audioMaxSeconds: 300,
  totalMaxBytes: 1024 * 1024 * 1024,
  maxReferences: 24,
  noteMaxChars: 1000,
  labelMaxChars: 80,
} as const;

export type ReferenceKind = 'image' | 'video' | 'audio';

type AcceptedType = {
  kind: ReferenceKind;
  mime: string;
  extensions: readonly string[];
};

export const ACCEPTED_TYPES: readonly AcceptedType[] = [
  { kind: 'image', mime: 'image/png', extensions: ['png'] },
  { kind: 'image', mime: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  { kind: 'image', mime: 'image/webp', extensions: ['webp'] },
  { kind: 'image', mime: 'image/gif', extensions: ['gif'] },
  { kind: 'video', mime: 'video/mp4', extensions: ['mp4'] },
  { kind: 'video', mime: 'video/quicktime', extensions: ['mov'] },
  { kind: 'video', mime: 'video/webm', extensions: ['webm'] },
  { kind: 'audio', mime: 'audio/wav', extensions: ['wav'] },
  { kind: 'audio', mime: 'audio/mpeg', extensions: ['mp3'] },
];

export const ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.map(type => type.mime).join(',');

const MIME_INDEX = new Map(ACCEPTED_TYPES.map(type => [type.mime, type]));
for (const alias of ['audio/x-wav', 'audio/wave', 'audio/vnd.wave']) {
  MIME_INDEX.set(alias, ACCEPTED_TYPES.find(type => type.mime === 'audio/wav')!);
}
MIME_INDEX.set('audio/mp3', ACCEPTED_TYPES.find(type => type.mime === 'audio/mpeg')!);
const EXTENSION_INDEX = new Map(
  ACCEPTED_TYPES.flatMap(type => type.extensions.map(extension => [extension, type] as const)),
);

const SLOT_LABELS: Record<string, string> = {
  style_reference: 'style reference',
  subject_reference: 'subject reference',
  start_frame: 'start frame',
  background_plate: 'background plate',
  logo_overlay: 'logo overlay',
  motion_reference: 'motion reference',
};

export type Reference = {
  id: string;
  kind: ReferenceKind | string;
  label?: string;
  note?: string;
  role?: string;
  mime?: string;
  ext?: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  thumbUrl?: string;
  thumb?: string;
  posterUrl?: string;
  fileUrl?: string;
  needsAnswer?: boolean;
  question?: string;
  createdAt?: string;
  updatedAt?: string;
  revision?: number;
  /** Reference-only planning context, or explicitly rights-cleared footage. */
  usage?: 'reference' | 'editorial' | string;
  editorialScope?: 'custom' | 'product-walkthrough' | 'music-video';
  /** Persisted evidence that the upload carried X-Rights-Asserted: 1. */
  rightsAsserted?: boolean | 1 | '1';
};

export type ReferenceAssignment = {
  id?: string;
  refId: string;
  sceneId?: string;
  slot: string;
  sceneNumber?: number;
  sceneIndex?: number;
  frameIndex?: number;
  status?: 'proposed' | 'confirmed' | string;
  reason?: string;
  sceneLabel?: string;
};

export type ReferenceUploadFile = {
  readonly name: string;
  readonly type?: string;
  readonly size: number;
  /** Optional browser-probed metadata; the server remains authoritative. */
  readonly durationSec?: number;
};

export type UploadProgress = number | { loaded?: number; total?: number };

export type UploadOptions = {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
};

export type ReferenceMutation = Reference | { reference: Reference };

/**
 * The small surface the panel needs. R12 supplies the fetch implementation;
 * tests supply a fake.
 */
export type ReferenceApi = {
  list(): Promise<{ references: Reference[]; assignments?: ReferenceAssignment[]; questions?: unknown } | Reference[]>;
  upload(file: ReferenceUploadFile, options?: UploadOptions): Promise<ReferenceMutation>;
  patch(id: string, patch: { role?: string; note?: string; label?: string; usage?: 'reference' | 'editorial'; editorialScope?: 'custom' | 'product-walkthrough' | 'music-video' }): Promise<ReferenceMutation>;
  delete(id: string): Promise<void>;
  thumbUrl?(ref: Reference): string | undefined;
  fileUrl?(ref: Reference): string | undefined;
  /** Authed thumb fetch -> object URL, or undefined when it cannot load. */
  loadThumb?(ref: Reference): Promise<string | undefined>;
};

export type ConfirmFn = (message: string) => boolean | Promise<boolean>;

export type PendingStatus = 'queued' | 'uploading' | 'done' | 'error';

export type PendingUpload = {
  key: string;
  name: string;
  file: ReferenceUploadFile;
  kind?: ReferenceKind;
  status: PendingStatus;
  progress: number;
  error?: string;
  warning?: string;
};

export type PanelState = {
  references: Reference[];
  assignments: ReferenceAssignment[];
  pending: PendingUpload[];
  questions: Record<string, string>;
  message: string;
  messageError: boolean;
  loading: boolean;
};

export type QueueResult = {
  name: string;
  ok: boolean;
  code?: string;
  error?: string;
  warning?: string;
  key?: string;
  kind?: ReferenceKind;
};

export type ChangeKind = 'all' | 'pending' | 'references' | 'message' | 'boards' | 'attachments';

export type PrecheckOk = {
  ok: true;
  kind: ReferenceKind;
  mime: string;
  ext: string;
  warning?: string;
};

export type PrecheckError = {
  ok: false;
  code: 'EMPTY' | 'UNSUPPORTED_TYPE' | 'SVG_USE_BRAND' | 'TOO_LARGE' | 'TOO_LONG';
  message: string;
};

export type Precheck = PrecheckOk | PrecheckError;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function extensionOf(name: string): string {
  const clean = String(name ?? '').trim().toLowerCase();
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1) : '';
}

function baseName(name: string): string {
  const clean = String(name ?? 'Reference').trim();
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return (slash >= 0 ? clean.slice(slash + 1) : clean) || 'Reference';
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

export function formatFileSize(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value >= 1024 * 1024 * 1024) return `${trimDecimal(value / (1024 * 1024 * 1024))} GB`;
  if (value >= 1024 * 1024) return `${trimDecimal(value / (1024 * 1024))} MB`;
  if (value >= 1024) return `${trimDecimal(value / 1024)} KB`;
  return `${Math.round(value)} B`;
}

/** Duration badge text: `0:08`, `1:05`, `1:02:03`. */
export function formatDuration(seconds: number | null | undefined): string {
  const value = finiteNumber(seconds);
  if (value === null || value < 0) return '0:00';
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function precheckFile(file: ReferenceUploadFile): Precheck {
  const name = String(file?.name ?? 'file');
  const extension = extensionOf(name);
  const size = finiteNumber(file?.size) ?? 0;
  if (size <= 0) return { ok: false, code: 'EMPTY', message: 'empty file' };

  const declaredMime = String(file?.type ?? '').toLowerCase().split(';')[0].trim();
  if (declaredMime === 'image/svg+xml' || extension === 'svg') {
    return {
      ok: false,
      code: 'SVG_USE_BRAND',
      message: 'SVG references use the brand kit, not the reference library',
    };
  }

  const byMime = declaredMime ? MIME_INDEX.get(declaredMime) : undefined;
  const byExtension = extension ? EXTENSION_INDEX.get(extension) : undefined;
  if (!byMime && !byExtension) {
    return {
      ok: false,
      code: 'UNSUPPORTED_TYPE',
      message: 'unsupported type: use PNG, JPEG, WEBP, GIF, MP4, MOV or WEBM; audio: WAV or MP3',
    };
  }

  const audioExtension = byExtension?.kind === 'audio' ? byExtension : undefined;
  const kind = audioExtension?.kind ?? byMime?.kind ?? byExtension!.kind;
  const limit = kind === 'image' ? LIMITS.imageMaxBytes : kind === 'video' ? LIMITS.videoMaxBytes : LIMITS.audioMaxBytes;
  if (size > limit) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      message: `too large: ${formatFileSize(size)}, ${kind === 'image' ? 'images' : kind === 'video' ? 'videos' : 'audio'} max ${formatFileSize(limit)}`,
    };
  }
  const durationSec = finiteNumber(file?.durationSec);
  if (kind === 'audio' && durationSec !== null && durationSec > LIMITS.audioMaxSeconds) {
    return {
      ok: false,
      code: 'TOO_LONG',
      message: `too long: ${formatDuration(durationSec)}, audio max ${formatDuration(LIMITS.audioMaxSeconds)}`,
    };
  }

  const canonicalMime = audioExtension?.mime ?? byMime?.mime ?? byExtension!.mime;
  const ext = byExtension?.extensions[0] ?? byMime!.extensions[0];
  const warning = byMime && byExtension && byMime.kind !== byExtension.kind
    ? 'declared type and file extension disagree; the server checks the actual bytes'
    : undefined;
  return { ok: true, kind, mime: canonicalMime, ext, ...(warning ? { warning } : {}) };
}

export function roleOf(ref: Reference | null | undefined): ReferenceRole {
  if (ref?.kind === 'audio' && ref.role === 'song') return 'song';
  return ROLES.includes(ref?.role as (typeof ROLES)[number]) ? (ref!.role as ReferenceRole) : 'other';
}

export function displayLabel(ref: Reference): string {
  const label = String(ref?.label ?? '').trim();
  return (label || 'Untitled reference').slice(0, LIMITS.labelMaxChars);
}

export function slotLabel(slot: string): string {
  const known = SLOT_LABELS[slot];
  if (known) return known;
  const text = String(slot ?? '').replace(/_/g, ' ').trim();
  return text || 'slot';
}

export function sceneNumberOf(assignment: ReferenceAssignment): number | null {
  const direct = finiteNumber(assignment?.sceneNumber);
  if (direct !== null) return direct;
  const index = finiteNumber(assignment?.sceneIndex);
  if (index !== null) return index + 1;
  const match = /(\d+)\s*$/.exec(String(assignment?.sceneId ?? ''));
  return match ? Number(match[1]) : null;
}

export function assignmentChipText(assignment: ReferenceAssignment): string {
  const scene = assignment?.sceneLabel
    ? String(assignment.sceneLabel)
    : `Scene ${sceneNumberOf(assignment) ?? assignment?.sceneId ?? '—'}`;
  const suffix = assignment?.status === 'proposed' ? ' · proposed' : '';
  return `${scene} / ${slotLabel(assignment?.slot ?? '')}${suffix}`;
}

export function referenceQuestion(
  ref: Reference,
  questions: Record<string, string> = {},
): string | undefined {
  if (typeof ref.question === 'string' && ref.question.trim()) return ref.question;
  if (typeof questions[ref.id] === 'string' && questions[ref.id].trim()) return questions[ref.id];
  return ref.needsAnswer ? '' : undefined;
}

export function renderPendingItems(pending: readonly PendingUpload[]): string {
  return pending.map(entry => {
    const percent = Math.max(0, Math.min(100, Math.round((entry.progress || 0) * 100)));
    const name = escapeHtml(entry.name);
    if (entry.status === 'error') {
      return `<li class="ref-pending ref-pending-error" data-pending-key="${escapeHtml(entry.key)}">
        <div class="ref-pending-name">${name}</div>
        <p class="ref-error" role="alert">${escapeHtml(entry.error ?? 'Upload failed')}</p>
        <button type="button" class="btn btn-secondary btn-sm ref-dismiss" data-dismiss-pending="${escapeHtml(entry.key)}" aria-label="Dismiss upload error for ${name}">Dismiss</button>
      </li>`;
    }
    const status = entry.status === 'queued' ? 'Queued' : entry.status === 'done' ? 'Done' : 'Uploading';
    return `<li class="ref-pending ref-pending-${escapeHtml(entry.status)}" data-pending-key="${escapeHtml(entry.key)}">
      <div class="ref-pending-name">${name}<span class="ref-pending-status">${status}</span></div>
      <progress max="100" value="${percent}" aria-label="${status} ${name}: ${percent}%"></progress>
      <span class="ref-progress-text">${percent}%</span>
      ${entry.warning ? `<p class="ref-warning">${escapeHtml(entry.warning)}</p>` : ''}
    </li>`;
  }).join('');
}

export function renderPendingUploads(pending: readonly PendingUpload[]): string {
  const hidden = pending.length === 0 ? ' hidden' : '';
  return `<ul class="ref-pending-list" data-ref-pending aria-label="Uploads"${hidden}>${renderPendingItems(pending)}</ul>`;
}

export type RenderOptions = {
  thumbUrl?: (ref: Reference) => string | undefined;
};

/**
 * `/api` media sits behind the session token, so the browser cannot load it
 * from an `<img src>`; those thumbnails are rendered as placeholders and
 * hydrated from an authed blob by the mount helper.
 */
export function isAuthedThumbUrl(url: string | undefined | null): boolean {
  return typeof url === 'string' && url.startsWith('/api/');
}

export type ThumbLoadApi = {
  loadThumb?(ref: Reference): Promise<string | undefined>;
};

/** Cache key: one thumb per reference revision. */
export function thumbKey(ref: Reference): string {
  return `${ref.id}\u0000${String(ref.updatedAt ?? '')}`;
}

function revokeObjectUrl(url: string | undefined): void {
  if (!url) return;
  try {
    const objectUrls = globalThis.URL;
    if (typeof objectUrls?.revokeObjectURL === 'function') objectUrls.revokeObjectURL(url);
  } catch { /* nothing to clean up */ }
}

/**
 * Owns the object URLs for reference thumbnails. A URL is cached by
 * `id + updatedAt`, re-used while the same card is on screen, and revoked as
 * soon as that card is replaced, removed or the panel unmounts.
 */
export class ReferenceThumbCache {
  api: ThumbLoadApi;
  entries: Map<string, { refId: string; url: string }>;
  pending: Map<string, Promise<string | undefined>>;
  live: Set<string>;
  destroyed: boolean;

  constructor(api: ThumbLoadApi) {
    this.api = api;
    this.entries = new Map();
    this.pending = new Map();
    this.live = new Set();
    this.destroyed = false;
  }

  current(ref: Reference): string | undefined {
    return this.entries.get(thumbKey(ref))?.url;
  }

  /**
   * Declares which cards are currently rendered and revokes every cached URL
   * whose reference revision is no longer present.
   */
  retain(references: readonly Reference[]): Set<string> {
    if (this.destroyed) return new Set();
    const next = new Set(references.map(ref => thumbKey(ref)));
    for (const [key, entry] of Array.from(this.entries)) {
      if (next.has(key)) continue;
      this.entries.delete(key);
      revokeObjectUrl(entry.url);
    }
    for (const key of Array.from(this.pending.keys())) {
      if (!next.has(key)) this.pending.delete(key);
    }
    this.live = next;
    return next;
  }

  load(ref: Reference): Promise<string | undefined> {
    const key = thumbKey(ref);
    if (this.destroyed || !this.live.has(key)) return Promise.resolve(undefined);
    const cached = this.entries.get(key);
    if (cached) return Promise.resolve(cached.url);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const loadThumb = this.api.loadThumb;
    if (typeof loadThumb !== 'function') return Promise.resolve(undefined);

    const task = (async () => {
      let url: string | undefined;
      try {
        url = await loadThumb.call(this.api, ref);
      } catch {
        url = undefined;
      }
      this.pending.delete(key);
      if (!url) return undefined;
      if (this.destroyed || !this.live.has(key)) {
        revokeObjectUrl(url);
        return undefined;
      }
      const previous = this.entries.get(key);
      if (previous && previous.url !== url) revokeObjectUrl(previous.url);
      this.entries.set(key, { refId: ref.id, url });
      return url;
    })();
    this.pending.set(key, task);
    return task;
  }

  /** Forget one deleted reference even before the next render. */
  release(refId: string): void {
    for (const [key, entry] of Array.from(this.entries)) {
      if (entry.refId !== refId) continue;
      this.entries.delete(key);
      this.live.delete(key);
      this.pending.delete(key);
      revokeObjectUrl(entry.url);
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const entry of this.entries.values()) revokeObjectUrl(entry.url);
    this.entries.clear();
    this.pending.clear();
    this.live.clear();
  }
}

function renderAssignmentChips(ref: Reference, assignments: readonly ReferenceAssignment[]): string {
  const chips = assignments
    .filter(assignment => assignment.refId === ref.id)
    .map(assignment => {
      const proposed = assignment.status === 'proposed';
      return `<li class="chip ref-chip${proposed ? ' ref-chip-proposed' : ''}">${escapeHtml(assignmentChipText(assignment))}</li>`;
    });
  if (chips.length === 0) return '<p class="ref-unassigned">Not assigned to a scene yet.</p>';
  return `<ul class="ref-chips" aria-label="Assigned to">${chips.join('')}</ul>`;
}

export function renderReferenceCard(
  ref: Reference,
  assignments: readonly ReferenceAssignment[],
  options: RenderOptions & { question?: string } = {},
): string {
  const label = displayLabel(ref);
  const role = roleOf(ref);
  const note = String(ref.note ?? '').slice(0, LIMITS.noteMaxChars);
  const video = ref.kind === 'video';
  const audio = ref.kind === 'audio';
  const id = escapeHtml(ref.id);
  const thumb = options.thumbUrl?.(ref) ?? ref.thumbUrl ?? ref.thumb ?? ref.posterUrl;
  const media = audio
    ? `<span class="ref-thumb-placeholder ref-thumb-audio" role="img" aria-label="${escapeHtml(label)}">Audio</span>`
    : isAuthedThumbUrl(thumb)
      ? `<span class="ref-thumb-placeholder ref-thumb-loading" data-ref-thumb="${escapeHtml(thumb)}" data-ref-id="${id}" data-ref-updated="${escapeHtml(ref.updatedAt ?? '')}" role="img" aria-label="${escapeHtml(label)}">${video ? 'Video' : 'Image'}</span>`
      : thumb
        ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(label)}" loading="lazy" />`
        : `<span class="ref-thumb-placeholder" role="img" aria-label="${escapeHtml(label)}">${video ? 'Video' : 'Image'}</span>`;
  const duration = video || audio
    ? `<span class="ref-duration" data-duration="${escapeHtml(formatDuration(ref.durationSec))}" aria-label="Duration ${escapeHtml(formatDuration(ref.durationSec))}">${escapeHtml(formatDuration(ref.durationSec))}</span>`
    : '';
  const question = options.question !== undefined
    ? options.question
    : typeof ref.question === 'string' && ref.question.trim()
      ? ref.question
      : ref.needsAnswer
        ? ''
        : undefined;
  const badge = question !== undefined
    ? `<button type="button" class="badge badge-warn ref-question" data-question-ref="${id}"${question ? ` title="${escapeHtml(question)}"` : ''} aria-label="Agent has a question about ${escapeHtml(label)}">agent has a question</button>`
    : '';
  const roles: readonly ReferenceRole[] = audio ? [...ROLES, 'song'] : ROLES;
  const roleOptions = roles.map(value =>
    `<option value="${value}"${value === role ? ' selected' : ''}>${escapeHtml(ROLE_LABELS[value])}</option>`).join('');
  return `<article class="ref-card panel" data-ref-id="${id}">
    <div class="ref-thumb${video ? ' ref-thumb-video' : ''}${audio ? ' ref-thumb-audio' : ''}">${media}${duration}</div>
    <div class="ref-body">
      <div class="ref-title-row">
        <label class="field ref-field ref-label-field">Label
          <input type="text" class="field-control" data-label-ref="${id}" value="${escapeHtml(label)}" maxlength="${LIMITS.labelMaxChars}" autocomplete="off" />
        </label>
        ${badge}
      </div>
      <div class="field ref-field ref-role-field">
        <div class="ref-role-label-row">
          <label class="field-label" for="${id}-role">Role</label>
          <select id="${id}-role" class="field-control ref-role-select" data-role-ref="${id}">${roleOptions}</select>
        </div>
      </div>
      <label class="field ref-field">Usage note
        <textarea class="field-control" data-note-ref="${id}" maxlength="${LIMITS.noteMaxChars}" rows="3" placeholder="Tell the agent how to use this reference">${escapeHtml(note)}</textarea>
      </label>
      <div class="ref-note-meta">
        <span class="ref-note-count" data-note-count="${id}" aria-live="polite">${note.length} / ${LIMITS.noteMaxChars}</span>
        <span class="ref-meta">${audio ? 'Audio' : video ? 'Video' : 'Image'}${ref.width && ref.height ? ` · ${ref.width}×${ref.height}` : ''}${(video || audio) && ref.durationSec !== undefined ? ` · ${formatDuration(ref.durationSec)}` : ''}</span>
      </div>
      ${renderAssignmentChips(ref, assignments)}
      <div class="ref-actions">
        <button type="button" class="btn btn-secondary btn-sm ref-delete" data-delete-ref="${id}" aria-label="Delete ${escapeHtml(label)}">Delete</button>
      </div>
    </div>
  </article>`;
}

export function renderReferenceCardList(
  state: Pick<PanelState, 'references' | 'assignments' | 'questions'>,
  options: RenderOptions = {},
): string {
  if (state.references.length === 0) {
    return `<div class="empty-state ref-empty" data-ref-empty>
      <span class="empty-state-icon" aria-hidden="true">🖼</span>
      <h3 class="empty-state-title">No references yet</h3>
      <p class="empty-state-line">Drop an image or a short video to get started.</p>
      <div class="empty-state-cta">
        <button type="button" class="btn btn-secondary btn-sm" data-ref-pick>Browse files</button>
      </div>
    </div>`;
  }
  return `<ul class="ref-list">${state.references.map(ref => {
    const question = referenceQuestion(ref, state.questions);
    return `<li>${renderReferenceCard(ref, state.assignments, { ...options, question })}</li>`;
  }).join('')}</ul>`;
}

export function renderReferenceCards(
  state: Pick<PanelState, 'references' | 'assignments' | 'questions'>,
  options: RenderOptions = {},
): string {
  return `<div class="ref-cards" data-ref-cards>${renderReferenceCardList(state, options)}</div>`;
}

export function renderReferencePanel(
  state: PanelState,
  options: RenderOptions & { idPrefix?: string } = {},
): string {
  const count = state.references.length;
  const prefix = options.idPrefix ?? 'reference-panel';
  const countLabel = `${count} reference${count === 1 ? '' : 's'}`;
  return `<section class="panel reference-panel" aria-labelledby="${escapeHtml(prefix)}-title">
    <header class="panel-header ref-header">
      <h2 class="panel-header-title" id="${escapeHtml(prefix)}-title">References <span class="badge ref-count" data-ref-count aria-label="${countLabel}">${count}</span></h2>
      <p class="ref-hint">Attach images, short videos or WAV/MP3 audio and tell the agent how to use them.</p>
    </header>
    <div class="ref-dropzone-wrap">
      <button type="button" class="ref-dropzone" data-ref-pick aria-describedby="${escapeHtml(prefix)}-drop-hint">
        <span class="ref-dropzone-title">Drop images, videos or audio here</span>
        <span class="btn btn-secondary btn-sm ref-browse-btn">Browse files</span>
      </button>
      <input class="ref-file-input" data-ref-file type="file" multiple hidden accept="${ACCEPT_ATTRIBUTE}" />
      <p class="ref-hint" id="${escapeHtml(prefix)}-drop-hint">Images up to 20 MB; videos up to 200 MB and 60 seconds; WAV/MP3 audio up to 100 MiB and 300 seconds. At most 24 references per conversation.</p>
    </div>
    ${renderPendingUploads(state.pending)}
    <p class="ref-status${state.messageError ? ' error' : ''}" data-ref-status role="status" aria-live="polite">${escapeHtml(state.message)}</p>
    ${renderReferenceCards(state, options)}
  </section>`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 400);
  const text = String(error ?? '').trim();
  return text ? text.slice(0, 400) : 'Unexpected error';
}

function progressFraction(progress: UploadProgress): number {
  if (typeof progress === 'number') {
    return Number.isFinite(progress) ? (progress > 1 ? progress / 100 : progress) : 0;
  }
  if (progress && typeof progress === 'object') {
    const loaded = finiteNumber(progress.loaded);
    const total = finiteNumber(progress.total);
    if (loaded !== null && total !== null && total > 0) return loaded / total;
    if (loaded !== null && loaded <= 1) return loaded;
  }
  return 0;
}

function normalizeReference(value: Reference, fallback?: Partial<Reference>): Reference {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) {
    throw new Error('reference record is missing its id');
  }
  const kind: ReferenceKind = value.kind === 'video'
    ? 'video'
    : value.kind === 'audio'
      ? 'audio'
      : value.kind === 'image'
        ? 'image'
        : fallback?.kind === 'video'
          ? 'video'
          : fallback?.kind === 'audio'
            ? 'audio'
            : 'image';
  return {
    ...value,
    kind,
    label: String(value.label ?? fallback?.label ?? 'Reference').slice(0, LIMITS.labelMaxChars),
    note: String(value.note ?? '').slice(0, LIMITS.noteMaxChars),
    role: roleOf(value),
  };
}

function mutationRecord(value: ReferenceMutation): Reference {
  if (value && typeof value === 'object') {
    const wrapped = (value as { reference?: Reference }).reference;
    if (wrapped) return wrapped;
  }
  return value as Reference;
}

function mergeMutation(current: Reference, value: ReferenceMutation, fallback: Partial<Reference>): Reference {
  const record = mutationRecord(value);
  return normalizeReference({ ...current, ...record, ...fallback }, current);
}

function questionsFrom(value: unknown): Record<string, string> {
  const questions: Record<string, string> = {};
  if (!value) return questions;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const refId = String((item as { refId?: unknown; id?: unknown }).refId ?? (item as { id?: unknown }).id ?? '');
        const question = String((item as { question?: unknown }).question ?? '');
        if (refId && question) questions[refId] = question;
      }
    }
    return questions;
  }
  if (typeof value === 'object') {
    for (const [refId, question] of Object.entries(value as Record<string, unknown>)) {
      if (typeof question === 'string' && question) questions[refId] = question;
    }
  }
  return questions;
}

export type ControllerOptions = {
  api: ReferenceApi;
  onChange?: (state: PanelState, change?: ChangeKind) => void;
  confirm?: ConfirmFn;
  randomId?: () => string;
};

type Listener = (state: PanelState, change: ChangeKind) => void;

const emptyState = (): PanelState => ({
  references: [],
  assignments: [],
  pending: [],
  questions: {},
  message: '',
  messageError: false,
  loading: false,
});

/**
 * State and actions for the reference panel. Nothing is mounted and no request
 * is made until load()/queueFiles() is called.
 */
export class ReferencePanelController {
  api: ReferenceApi;
  confirm: ConfirmFn;
  onChange?: (state: PanelState, change?: ChangeKind) => void;
  randomId: () => string;
  state: PanelState;
  listeners: Set<Listener>;
  uploads: Set<Promise<void>>;
  noteSaves: Map<string, Promise<unknown>>;
  destroyed: boolean;
  sequence: number;

  constructor(options: ControllerOptions) {
    this.api = options.api;
    this.confirm = options.confirm ?? (async (message: string) => confirmDialog({
      title: 'Delete reference',
      text: message,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
    }));
    this.onChange = options.onChange;
    this.randomId = options.randomId ?? (() => Math.random().toString(36).slice(2, 10));
    this.state = emptyState();
    this.listeners = new Set();
    this.uploads = new Set();
    this.noteSaves = new Map();
    this.destroyed = false;
    this.sequence = 0;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getState(): PanelState {
    return this.snapshot();
  }

  snapshot(): PanelState {
    return {
      references: this.state.references.map(ref => ({ ...ref })),
      assignments: this.state.assignments.map(assignment => ({ ...assignment })),
      pending: this.state.pending.map(entry => ({ ...entry })),
      questions: { ...this.state.questions },
      message: this.state.message,
      messageError: this.state.messageError,
      loading: this.state.loading,
    };
  }

  notify(kind: ChangeKind = 'all'): void {
    if (this.destroyed) return;
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot, kind); } catch { /* a view error must not break an upload */ }
    }
    try { this.onChange?.(snapshot, kind); } catch { /* optional observer */ }
  }

  setMessage(message: string, error = false): void {
    this.state.message = message;
    this.state.messageError = error;
    this.notify('message');
  }

  findReference(id: string): Reference | undefined {
    return this.state.references.find(ref => ref.id === id);
  }

  assignmentsFor(id: string): ReferenceAssignment[] {
    return this.state.assignments.filter(assignment => assignment.refId === id);
  }

  questionFor(id: string): string | undefined {
    const ref = this.findReference(id);
    return ref ? referenceQuestion(ref, this.state.questions) : undefined;
  }

  async load(): Promise<PanelState> {
    this.state.loading = true;
    this.notify('message');
    try {
      const payload = await this.api.list();
      const records = Array.isArray(payload) ? payload : payload?.references ?? [];
      const assignments = Array.isArray(payload) ? [] : payload?.assignments ?? [];
      const questions = Array.isArray(payload) ? {} : questionsFrom(payload?.questions);
      this.state.references = records.map(record => normalizeReference(record));
      this.state.assignments = assignments.map(assignment => ({ ...assignment }));
      this.state.questions = questions;
      this.state.message = '';
      this.state.messageError = false;
    } catch (error) {
      this.state.message = `Could not load references: ${messageOf(error)}`;
      this.state.messageError = true;
    } finally {
      this.state.loading = false;
      this.notify('all');
    }
    return this.snapshot();
  }

  queueFiles(files: ArrayLike<ReferenceUploadFile>): QueueResult[] {
    const list = Array.from(files ?? []);
    const results: QueueResult[] = [];
    const accepted: PendingUpload[] = [];
    let count = this.state.references.length + this.state.pending.filter(entry => entry.status !== 'error').length;
    let bytes = this.state.references.reduce((sum, ref) => sum + (finiteNumber(ref.bytes) ?? 0), 0)
      + this.state.pending.filter(entry => entry.status !== 'error').reduce((sum, entry) => sum + (finiteNumber(entry.file.size) ?? 0), 0);

    const reject = (file: ReferenceUploadFile, code: string, message: string, kind?: ReferenceKind) => {
      const key = this.nextKey();
      this.state.pending.push({
        key,
        name: baseName(file.name),
        file,
        ...(kind ? { kind } : {}),
        status: 'error',
        progress: 0,
        error: `${message}`,
      });
      results.push({ name: baseName(file.name), ok: false, code, error: message, key, ...(kind ? { kind } : {}) });
    };

    for (const file of list) {
      const name = baseName(file?.name);
      const check = precheckFile(file);
      if (!check.ok) {
        reject(file, check.code, check.message);
        continue;
      }
      if (count >= LIMITS.maxReferences) {
        reject(file, 'TOO_MANY', `limit of ${LIMITS.maxReferences} references per conversation reached`, check.kind);
        continue;
      }
      const size = finiteNumber(file.size) ?? 0;
      if (bytes + size > LIMITS.totalMaxBytes) {
        reject(file, 'TOTAL_TOO_LARGE', `conversation storage limit of ${formatFileSize(LIMITS.totalMaxBytes)} reached`, check.kind);
        continue;
      }
      const entry: PendingUpload = {
        key: this.nextKey(),
        name,
        file,
        kind: check.kind,
        status: 'queued',
        progress: 0,
        ...(check.warning ? { warning: check.warning } : {}),
      };
      this.state.pending.push(entry);
      accepted.push(entry);
      count += 1;
      bytes += size;
      results.push({
        name,
        ok: true,
        key: entry.key,
        kind: check.kind,
        ...(check.warning ? { warning: check.warning } : {}),
      });
    }

    if (accepted.length > 0) this.notify('pending');
    for (const entry of accepted) this.startUpload(entry);
    return results;
  }

  dismissPending(key: string): void {
    const entry = this.state.pending.find(item => item.key === key);
    if (!entry || entry.status === 'uploading') return;
    this.state.pending = this.state.pending.filter(item => item.key !== key);
    this.notify('pending');
  }

  clearErrors(): void {
    this.state.pending = this.state.pending.filter(entry => entry.status !== 'error');
    this.notify('pending');
  }

  async settle(): Promise<void> {
    while (this.uploads.size > 0) {
      await Promise.allSettled(Array.from(this.uploads));
    }
    const saves = Array.from(this.noteSaves.values());
    if (saves.length > 0) await Promise.allSettled(saves);
  }

  nextKey(): string {
    this.sequence += 1;
    return `upload_${this.sequence}_${this.randomId()}`;
  }

  startUpload(entry: PendingUpload): void {
    const task = (async () => {
      entry.status = 'uploading';
      entry.progress = 0;
      this.notify('pending');
      try {
        const value = await this.api.upload(entry.file, {
          onProgress: progress => {
            const fraction = Math.max(0, Math.min(1, progressFraction(progress)));
            entry.progress = Math.max(entry.progress, fraction);
            this.notify('pending');
          },
        });
        const fallback: Partial<Reference> = {
          kind: entry.kind,
          label: entry.name,
          mime: undefined,
        };
        const record = normalizeReference(mutationRecord(value), fallback);
        this.state.pending = this.state.pending.filter(item => item.key !== entry.key);
        this.upsertReference(record);
        this.notify('all');
      } catch (error) {
        entry.status = 'error';
        entry.progress = 0;
        entry.error = messageOf(error);
        this.state.message = `${entry.name}: ${entry.error}`;
        this.state.messageError = true;
        this.notify('all');
      }
    })();
    this.uploads.add(task);
    void task.finally(() => { this.uploads.delete(task); });
  }

  upsertReference(ref: Reference): void {
    const index = this.state.references.findIndex(item => item.id === ref.id);
    if (index >= 0) this.state.references[index] = ref;
    else this.state.references.push(ref);
  }

  replaceReference(ref: Reference): void {
    const index = this.state.references.findIndex(item => item.id === ref.id);
    if (index >= 0) this.state.references[index] = ref;
  }

  saveNote(id: string, raw: string): Promise<boolean> {
    const current = this.findReference(id);
    if (!current) return Promise.resolve(false);
    const note = String(raw ?? '').slice(0, LIMITS.noteMaxChars);
    const previous = this.noteSaves.get(id) ?? Promise.resolve();
    let changed = false;
    const task = previous.catch(() => undefined).then(async () => {
      const fresh = this.findReference(id);
      if (!fresh) return;
      if (note === String(fresh.note ?? '')) return;
      try {
        const value = await this.api.patch(id, { note });
        const next = mergeMutation(fresh, value, { note });
        this.replaceReference(next);
        changed = true;
        this.state.message = '';
        this.state.messageError = false;
        this.notify('references');
      } catch (error) {
        this.state.message = `Could not save the note: ${messageOf(error)}`;
        this.state.messageError = true;
        this.notify('message');
      }
    });
    this.noteSaves.set(id, task);
    void task.finally(() => {
      if (this.noteSaves.get(id) === task) this.noteSaves.delete(id);
    });
    return task.then(() => changed);
  }

  async setRole(id: string, role: string): Promise<boolean> {
    const current = this.findReference(id);
    const allowed = ROLES.includes(role as (typeof ROLES)[number]) || (current?.kind === 'audio' && role === 'song');
    if (!current || !allowed) return false;
    if (roleOf(current) === role) return false;
    try {
      const value = await this.api.patch(id, { role });
      this.replaceReference(mergeMutation(current, value, { role }));
      this.state.message = '';
      this.state.messageError = false;
      this.notify('references');
      return true;
    } catch (error) {
      this.state.message = `Could not change the role: ${messageOf(error)}`;
      this.state.messageError = true;
      this.notify('message');
      return false;
    }
  }

  async saveLabel(id: string, raw: string): Promise<boolean> {
    const current = this.findReference(id);
    if (!current) return false;
    const label = String(raw ?? '').trim().slice(0, LIMITS.labelMaxChars);
    if (!label || label === displayLabel(current)) return false;
    try {
      const value = await this.api.patch(id, { label });
      this.replaceReference(mergeMutation(current, value, { label }));
      this.state.message = '';
      this.state.messageError = false;
      this.notify('references');
      return true;
    } catch (error) {
      this.state.message = `Could not save the label: ${messageOf(error)}`;
      this.state.messageError = true;
      this.notify('message');
      return false;
    }
  }

  async deleteReference(id: string): Promise<boolean> {
    const current = this.findReference(id);
    if (!current) return false;
    const label = displayLabel(current);
    let confirmed = false;
    try {
      confirmed = await this.confirm(`Delete “${label}”? This removes it and its assignments from this conversation.`);
    } catch {
      confirmed = false;
    }
    if (!confirmed) return false;
    try {
      await this.api.delete(id);
      this.state.references = this.state.references.filter(ref => ref.id !== id);
      this.state.assignments = this.state.assignments.filter(assignment => assignment.refId !== id);
      delete this.state.questions[id];
      this.state.message = `Deleted ${label}.`;
      this.state.messageError = false;
      this.notify('all');
      return true;
    } catch (error) {
      this.state.message = `Could not delete ${label}: ${messageOf(error)}`;
      this.state.messageError = true;
      this.notify('message');
      return false;
    }
  }

  remove(id: string): Promise<boolean> {
    return this.deleteReference(id);
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }
}

export const REFERENCE_BOARD_LIMITS = {
  maxBoards: 24,
  nameMaxChars: 80,
  maxReferences: LIMITS.maxReferences,
} as const;

export type ReferenceBoardEntry = {
  refId: string;
  role: ReferenceRole;
  label?: string;
  note?: string;
};

export type ReferenceBoard = {
  id: string;
  name: string;
  role: ReferenceRole;
  entries: ReferenceBoardEntry[];
  revision?: number;
};

export type ReferenceBoardMode = 'attach' | 'replace';

export type ReferenceBoardAttachment = {
  shotId: string;
  boardId: string;
  role: ReferenceRole;
  revision?: number;
  commandId?: string;
};

export type ReferenceBoardCommand = {
  kind: 'artifact.attach';
  productionId: string;
  commandId: string;
  idempotencyKey: string;
  expected: { productionRevision: number };
  payload: {
    artifactKind: 'conditioning';
    shotId: string;
    boardId: string;
    role: ReferenceRole;
    mode: ReferenceBoardMode;
    references: Array<{ refId: string; role: ReferenceRole }>;
    replaces: string[];
  };
};

export type ReferenceBoardState = {
  productionId: string;
  revision: number;
  boards: ReferenceBoard[];
  attachments: ReferenceBoardAttachment[];
  shots: string[];
  pending: string[];
  loading: boolean;
  stale: boolean;
  message: string;
  messageError: boolean;
};

export type ReferenceBoardCommandResult = {
  ok: boolean;
  code?: string;
  error?: string;
  commandId?: string;
  idempotencyKey?: string;
  command?: ReferenceBoardCommand;
};

export type ReferenceBoardSendCommand = (
  command: ReferenceBoardCommand,
) => Promise<unknown> | unknown;

export type ReferenceBoardControllerOptions = {
  productionId: string;
  revision?: number;
  boards?: readonly unknown[];
  attachments?: readonly ReferenceBoardAttachment[];
  shots?: readonly string[];
  loading?: boolean;
  stale?: boolean;
  sendCommand: ReferenceBoardSendCommand;
  randomId?: () => string;
  onChange?: (state: ReferenceBoardState, change: ChangeKind) => void;
};

function boardRole(value: unknown, fallback: ReferenceRole = 'other'): ReferenceRole {
  if (value === undefined || value === null || value === '') return fallback;
  return ROLES.includes(value as (typeof ROLES)[number]) ? (value as ReferenceRole) : 'other';
}

function boardText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeReferenceBoard(value: unknown): ReferenceBoard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('a reference board must be an object');
  }
  const source = value as Record<string, unknown>;
  const id = boardText(source.id);
  if (!id) throw new TypeError('a reference board id is required');
  const name = boardText(source.name);
  if (!name) throw new TypeError('a reference board name is required');
  const role = boardRole(source.role);
  const rawEntries = Array.isArray(source.entries)
    ? source.entries
    : Array.isArray(source.references)
      ? source.references
      : [];
  const entries = new Map<string, ReferenceBoardEntry>();

  for (const raw of rawEntries) {
    const item = typeof raw === 'string'
      ? { refId: raw }
      : raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
    if (!item) continue;
    const refId = boardText(item.refId ?? item.id);
    if (!refId) continue;
    const entryRole = item.role === undefined || item.role === null || item.role === ''
      ? role
      : boardRole(item.role);
    const entry: ReferenceBoardEntry = { refId, role: entryRole };
    const label = boardText(item.label);
    if (label) entry.label = label.slice(0, LIMITS.labelMaxChars);
    const note = typeof item.note === 'string' ? item.note.trim() : '';
    if (note) entry.note = note.slice(0, LIMITS.noteMaxChars);
    entries.set(refId, entry);
  }

  const board: ReferenceBoard = {
    id,
    name: name.slice(0, REFERENCE_BOARD_LIMITS.nameMaxChars),
    role,
    entries: Array.from(entries.values()).slice(0, REFERENCE_BOARD_LIMITS.maxReferences),
  };
  const revision = finiteNumber(source.revision);
  if (revision !== null && revision >= 0 && Number.isSafeInteger(revision)) {
    board.revision = revision;
  }
  return board;
}

export function normalizeReferenceBoards(values: unknown): ReferenceBoard[] {
  const boards = new Map<string, ReferenceBoard>();
  for (const value of Array.isArray(values) ? values : []) {
    let board: ReferenceBoard;
    try {
      board = normalizeReferenceBoard(value);
    } catch {
      continue;
    }
    boards.set(board.id, board);
  }
  return Array.from(boards.values()).slice(0, REFERENCE_BOARD_LIMITS.maxBoards);
}

function uniqueIds(values: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    const id = boardText(value);
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

export function buildReferenceBoardCommand(input: {
  productionId: string;
  productionRevision: number;
  shotId: string;
  board: unknown;
  mode: ReferenceBoardMode;
  commandId: string;
  idempotencyKey: string;
  replaces?: readonly string[];
}): ReferenceBoardCommand {
  const productionId = boardText(input?.productionId);
  if (!productionId) throw new TypeError('a production id is required');
  const shotId = boardText(input?.shotId);
  if (!shotId) throw new TypeError('a shot id is required');
  if (input?.mode !== 'attach' && input?.mode !== 'replace') {
    throw new TypeError('the board mode must be attach or replace');
  }
  const commandId = boardText(input?.commandId);
  if (!commandId) throw new TypeError('a command id is required');
  const idempotencyKey = boardText(input?.idempotencyKey);
  if (!idempotencyKey) throw new TypeError('an idempotency key is required');
  const revision = finiteNumber(input?.productionRevision);
  if (revision === null || revision < 0 || !Number.isSafeInteger(revision)) {
    throw new TypeError('the production revision must be a non-negative integer');
  }
  const board = normalizeReferenceBoard(input.board);

  return {
    kind: 'artifact.attach',
    productionId,
    commandId,
    idempotencyKey,
    expected: { productionRevision: revision },
    payload: {
      artifactKind: 'conditioning',
      shotId,
      boardId: board.id,
      role: board.role,
      mode: input.mode,
      references: board.entries.map(entry => ({ refId: entry.refId, role: entry.role })),
      replaces: uniqueIds(Array.isArray(input.replaces) ? input.replaces : []),
    },
  };
}

function normalizeBoardAttachment(
  value: unknown,
  boards: readonly ReferenceBoard[],
): ReferenceBoardAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const shotId = boardText(source.shotId);
  const boardId = boardText(source.boardId);
  if (!shotId || !boardId) return null;
  const board = boards.find(item => item.id === boardId);
  const attachment: ReferenceBoardAttachment = {
    shotId,
    boardId,
    role: boardRole(source.role, board?.role ?? 'other'),
  };
  const revision = finiteNumber(source.revision);
  if (revision !== null) attachment.revision = revision;
  const commandId = boardText(source.commandId);
  if (commandId) attachment.commandId = commandId;
  return attachment;
}

function boardCommandError(error: unknown): {
  code?: string;
  message: string;
  stale: boolean;
  currentRevision: number | null;
} {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const body = source?.body && typeof source.body === 'object'
    ? source.body as Record<string, unknown>
    : null;
  const code = boardText(source?.code) || boardText(body?.code) || undefined;
  const currentRevision = finiteNumber(source?.currentRevision) ?? finiteNumber(body?.currentRevision);
  return {
    ...(code ? { code } : {}),
    message: messageOf(error),
    stale: code === 'REVISION_CONFLICT' || finiteNumber(source?.status) === 409,
    currentRevision,
  };
}

function revisionOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const direct = finiteNumber(source.revision) ?? finiteNumber(source.productionRevision);
  if (direct !== null && direct >= 0 && Number.isSafeInteger(direct)) return direct;
  const production = source.production;
  if (production && typeof production === 'object' && !Array.isArray(production)) {
    const nested = finiteNumber((production as Record<string, unknown>).revision);
    if (nested !== null && nested >= 0 && Number.isSafeInteger(nested)) return nested;
  }
  return null;
}

type BoardListener = (state: ReferenceBoardState, change: ChangeKind) => void;

export class ReferenceBoardController {
  productionId: string;
  sendCommand: ReferenceBoardSendCommand;
  randomId: () => string;
  onChange?: (state: ReferenceBoardState, change: ChangeKind) => void;
  state: ReferenceBoardState;
  listeners: Set<BoardListener>;
  pendingKeys: Set<string>;
  destroyed: boolean;

  constructor(options: ReferenceBoardControllerOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('ReferenceBoardController requires options');
    }
    const productionId = boardText(options.productionId);
    if (!productionId) throw new TypeError('ReferenceBoardController requires a productionId');
    if (typeof options.sendCommand !== 'function') {
      throw new TypeError('ReferenceBoardController requires sendCommand');
    }
    const boards = normalizeReferenceBoards(options.boards ?? []);
    const attachments: ReferenceBoardAttachment[] = [];
    const seen = new Set<string>();
    for (const value of Array.isArray(options.attachments) ? options.attachments : []) {
      const attachment = normalizeBoardAttachment(value, boards);
      if (!attachment) continue;
      const key = `${attachment.shotId}\u0000${attachment.boardId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attachments.push(attachment);
    }
    this.productionId = productionId;
    this.sendCommand = options.sendCommand;
    this.randomId = options.randomId ?? (() => Math.random().toString(36).slice(2, 10));
    this.onChange = options.onChange;
    this.listeners = new Set();
    this.pendingKeys = new Set();
    this.destroyed = false;
    const revision = finiteNumber(options.revision);
    this.state = {
      productionId,
      revision: revision !== null && revision >= 0 ? revision : 0,
      boards,
      attachments,
      shots: uniqueIds(Array.isArray(options.shots) ? options.shots : []),
      pending: [],
      loading: options.loading === true,
      stale: options.stale === true,
      message: '',
      messageError: false,
    };
  }

  subscribe(listener: BoardListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getState(): ReferenceBoardState {
    return this.snapshot();
  }

  snapshot(): ReferenceBoardState {
    return {
      productionId: this.state.productionId,
      revision: this.state.revision,
      boards: this.state.boards.map(board => ({
        ...board,
        entries: board.entries.map(entry => ({ ...entry })),
      })),
      attachments: this.state.attachments.map(attachment => ({ ...attachment })),
      shots: [...this.state.shots],
      pending: [...this.state.pending],
      loading: this.state.loading,
      stale: this.state.stale,
      message: this.state.message,
      messageError: this.state.messageError,
    };
  }

  notify(kind: ChangeKind = 'all'): void {
    if (this.destroyed) return;
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot, kind); } catch { /* a view error must not break a command */ }
    }
    try { this.onChange?.(snapshot, kind); } catch { /* optional observer */ }
  }

  setBoards(values: readonly unknown[]): void {
    const boards = normalizeReferenceBoards(values);
    const ids = new Set(boards.map(board => board.id));
    this.state.boards = boards;
    this.state.attachments = this.state.attachments.filter(attachment => ids.has(attachment.boardId));
    this.notify('boards');
  }

  setShots(values: readonly unknown[]): void {
    this.state.shots = uniqueIds(values);
    this.notify('boards');
  }

  setAttachments(values: readonly unknown[]): void {
    const attachments: ReferenceBoardAttachment[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const attachment = normalizeBoardAttachment(value, this.state.boards);
      if (!attachment) continue;
      const key = `${attachment.shotId}\u0000${attachment.boardId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attachments.push(attachment);
    }
    this.state.attachments = attachments;
    this.notify('attachments');
  }

  setRevision(revision: unknown): void {
    const value = finiteNumber(revision);
    if (value === null || value < 0 || !Number.isSafeInteger(value)) return;
    this.state.revision = value;
    this.state.stale = false;
    this.notify('boards');
  }

  setLoading(loading: boolean): void {
    this.state.loading = loading === true;
    this.notify('boards');
  }

  board(boardId: string): ReferenceBoard | undefined {
    return this.state.boards.find(board => board.id === boardId);
  }

  attachmentsFor(shotId: string): ReferenceBoardAttachment[] {
    const shot = boardText(shotId);
    return this.state.attachments.filter(attachment => attachment.shotId === shot);
  }

  attach(shotId: string, boardId: string): Promise<ReferenceBoardCommandResult> {
    return this.dispatch(shotId, boardId, 'attach');
  }

  attachBoard(shotId: string, boardId: string): Promise<ReferenceBoardCommandResult> {
    return this.dispatch(shotId, boardId, 'attach');
  }

  replace(shotId: string, boardId: string): Promise<ReferenceBoardCommandResult> {
    return this.dispatch(shotId, boardId, 'replace');
  }

  replaceBoard(shotId: string, boardId: string): Promise<ReferenceBoardCommandResult> {
    return this.dispatch(shotId, boardId, 'replace');
  }

  async dispatch(
    rawShotId: string,
    rawBoardId: string,
    mode: ReferenceBoardMode,
  ): Promise<ReferenceBoardCommandResult> {
    if (this.destroyed) return { ok: false, code: 'DESTROYED', error: 'The board panel is closed.' };
    const shotId = boardText(rawShotId);
    if (!shotId) return this.refuse('INVALID_SHOT', 'Choose a shot before attaching a board.');
    const boardId = boardText(rawBoardId);
    const board = boardId ? this.board(boardId) : undefined;
    if (!board) return this.refuse('UNKNOWN_BOARD', 'That reference board is no longer available.');
    const pendingKey = `${shotId}\u0000${board.id}`;
    if (this.pendingKeys.has(pendingKey)) {
      return { ok: false, code: 'IN_PROGRESS', error: 'That board change is already in progress.' };
    }
    if (mode === 'attach' && this.state.attachments.some(attachment =>
      attachment.shotId === shotId && attachment.boardId === board.id)) {
      return this.refuse('ALREADY_ATTACHED', `${board.name} is already attached to ${shotId}.`);
    }

    const random = boardText(this.randomId()) || Math.random().toString(36).slice(2, 10);
    const commandId = `cmd_${random}`;
    const idempotencyKey = `idem_${random}`;
    const replaces = mode === 'replace'
      ? this.state.attachments
        .filter(attachment => attachment.shotId === shotId
          && attachment.role === board.role
          && attachment.boardId !== board.id)
        .map(attachment => attachment.boardId)
      : [];
    const command = buildReferenceBoardCommand({
      productionId: this.productionId,
      productionRevision: this.state.revision,
      shotId,
      board,
      mode,
      commandId,
      idempotencyKey,
      replaces,
    });

    this.pendingKeys.add(pendingKey);
    this.state.pending.push(pendingKey);
    this.notify('pending');

    try {
      const response = await this.sendCommand(command);
      const revision = revisionOf(response);
      if (revision !== null) this.state.revision = Math.max(this.state.revision, revision);
      if (mode === 'replace') {
        this.state.attachments = this.state.attachments.filter(attachment =>
          !(attachment.shotId === shotId && attachment.role === board.role));
      }
      this.state.attachments.push({
        shotId,
        boardId: board.id,
        role: board.role,
        revision: this.state.revision,
        commandId,
      });
      this.state.message = mode === 'replace'
        ? `Replaced the ${ROLE_LABELS[board.role].toLowerCase()} board on ${shotId} with ${board.name}.`
        : `Attached ${board.name} to ${shotId}.`;
      this.state.messageError = false;
      this.state.stale = false;
      this.notify('attachments');
      return { ok: true, commandId, idempotencyKey, command };
    } catch (error) {
      const details = boardCommandError(error);
      if (details.currentRevision !== null) {
        this.state.revision = Math.max(this.state.revision, details.currentRevision);
      }
      if (details.stale) this.state.stale = true;
      this.state.message = mode === 'replace'
        ? `Could not replace the board on ${shotId}: ${details.message}`
        : `Could not attach ${board.name} to ${shotId}: ${details.message}`;
      this.state.messageError = true;
      this.notify('attachments');
      return {
        ok: false,
        ...(details.code ? { code: details.code } : {}),
        error: details.message,
        commandId,
        idempotencyKey,
        command,
      };
    } finally {
      this.pendingKeys.delete(pendingKey);
      this.state.pending = this.state.pending.filter(key => key !== pendingKey);
      this.notify('pending');
    }
  }

  refuse(code: string, message: string): ReferenceBoardCommandResult {
    this.state.message = message;
    this.state.messageError = true;
    this.notify('attachments');
    return { ok: false, code, error: message };
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }
}

export function renderReferenceBoard(board: unknown): string {
  let normalized: ReferenceBoard;
  try {
    normalized = normalizeReferenceBoard(board);
  } catch {
    return '';
  }
  const roleLabel = ROLE_LABELS[normalized.role];
  const entries = normalized.entries.length === 0
    ? '<li class="ref-board-empty-line">No references on this board.</li>'
    : normalized.entries.map(entry => {
      const label = entry.label || entry.refId;
      return `<li class="ref-board-ref" data-board-ref="${escapeHtml(entry.refId)}" data-board-ref-role="${entry.role}">
        <span class="ref-board-ref-label">${escapeHtml(label)}</span>
        <span class="chip ref-board-ref-role">${escapeHtml(ROLE_LABELS[entry.role])}</span>
        ${entry.note ? `<span class="ref-board-ref-note">${escapeHtml(entry.note)}</span>` : ''}
      </li>`;
    }).join('');
  return `<article class="ref-board panel" data-reference-board="${escapeHtml(normalized.id)}" data-board-role="${normalized.role}">
    <header class="ref-board-header">
      <h3 class="ref-board-name">${escapeHtml(normalized.name)}</h3>
      <span class="chip ref-board-role" data-board-role-label>${escapeHtml(roleLabel)}</span>
      <span class="ref-board-count">${normalized.entries.length} reference${normalized.entries.length === 1 ? '' : 's'}</span>
    </header>
    <ul class="ref-board-refs">${entries}</ul>
  </article>`;
}

export type ReferenceBoardsView = {
  boards?: readonly unknown[];
  attachments?: readonly ReferenceBoardAttachment[];
  shots?: readonly string[];
  loading?: boolean;
  stale?: boolean;
  message?: string;
  messageError?: boolean;
};

export function renderReferenceBoards(
  state: ReferenceBoardsView,
  options: { shots?: readonly string[] } = {},
): string {
  if (state?.loading === true) {
    return '<section class="ref-boards panel" data-reference-boards data-board-state="loading" role="status" aria-live="polite">Loading reference boards…</section>';
  }

  const boards = normalizeReferenceBoards(state?.boards ?? []);
  const attachments = (Array.isArray(state?.attachments) ? state.attachments : [])
    .filter((attachment): attachment is ReferenceBoardAttachment =>
      Boolean(attachment) && typeof attachment === 'object');
  const shots = uniqueIds(options.shots ?? state?.shots ?? []);
  const message = String(state?.message ?? '');
  const error = state?.messageError === true
    ? `<p class="ref-board-error" role="alert">${escapeHtml(message || 'Reference boards could not be loaded.')}</p>`
    : '';

  if (boards.length === 0) {
    if (error) {
      return `<section class="ref-boards panel" data-reference-boards data-board-state="error">${error}</section>`;
    }
    return `<section class="ref-boards panel" data-reference-boards data-board-state="empty">
      <div class="empty-state ref-board-empty" data-board-empty>
        <h3 class="empty-state-title">No reference boards yet</h3>
        <p class="empty-state-line">Group references by role, then attach a board to each shot.</p>
      </div>
    </section>`;
  }

  const stale = state?.stale === true
    ? '<p class="ref-board-stale" data-board-stale="true" role="status">Boards are stale. Refresh before changing them.</p>'
    : '';
  const shotMarkup = shots.map(shotId => {
    const rows = attachments.filter(attachment => attachment.shotId === shotId);
    const attached = rows.length === 0
      ? '<li class="ref-board-none">No boards attached.</li>'
      : rows.map(attachment => {
        const attachedBoard = boards.find(board => board.id === attachment.boardId);
        const name = attachedBoard?.name ?? attachment.boardId;
        return `<li class="ref-board-attachment" data-board-attached="${escapeHtml(attachment.boardId)}" data-board-attachment-role="${attachment.role}">
          <span class="ref-board-attachment-name">${escapeHtml(name)}</span>
          <span class="chip ref-board-attachment-role">${escapeHtml(ROLE_LABELS[attachment.role])}</span>
        </li>`;
      }).join('');
    const actions = boards.map(board => {
      const isAttached = rows.some(attachment => attachment.boardId === board.id);
      const roleWord = ROLE_LABELS[board.role].toLowerCase();
      return `<button type="button" class="btn btn-secondary btn-sm ref-board-attach" data-board-attach data-shot-id="${escapeHtml(shotId)}" data-board-id="${escapeHtml(board.id)}" aria-label="Attach ${escapeHtml(board.name)} to ${escapeHtml(shotId)}"${isAttached ? ' disabled aria-disabled="true"' : ''}>Attach</button>
        <button type="button" class="btn btn-ghost btn-sm ref-board-replace" data-board-replace data-shot-id="${escapeHtml(shotId)}" data-board-id="${escapeHtml(board.id)}" aria-label="Replace the ${escapeHtml(roleWord)} board on ${escapeHtml(shotId)} with ${escapeHtml(board.name)}">Replace</button>`;
    }).join('');
    return `<div class="ref-board-shot" data-board-shot="${escapeHtml(shotId)}">
      <h4 class="ref-board-shot-name">${escapeHtml(shotId)}</h4>
      <ul class="ref-board-attachments">${attached}</ul>
      <div class="ref-board-actions">${actions}</div>
    </div>`;
  }).join('');

  return `<section class="ref-boards panel" data-reference-boards data-board-state="${error ? 'error' : 'ready'}">
    <header class="ref-boards-header">
      <h3 class="ref-boards-title">Reference boards</h3>
      <span class="ref-boards-count">${boards.length} board${boards.length === 1 ? '' : 's'}</span>
    </header>
    ${stale}
    ${error}
    ${shotMarkup}
    <div class="ref-board-list">${boards.map(renderReferenceBoard).join('')}</div>
  </section>`;
}

let panelSequence = 0;

export type MountOptions = {
  api: ReferenceApi;
  onChange?: (state: PanelState, change?: ChangeKind) => void;
  confirm?: ConfirmFn;
  idPrefix?: string;
};

export type ReferencePanelHandle = {
  controller: ReferencePanelController;
  refresh(): Promise<PanelState>;
  queueFiles(files: ArrayLike<ReferenceUploadFile>): QueueResult[];
  destroy(): void;
};

let stylesRequested = false;

function ensureStyles(): void {
  if (stylesRequested || typeof document === 'undefined') return;
  stylesRequested = true;
  void import('./panel.css').catch(() => undefined);
}

function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === 'Files') return true;
  }
  return false;
}

export function mountReferencePanel(el: HTMLElement, options: MountOptions): ReferencePanelHandle {
  ensureStyles();
  const prefix = options.idPrefix ?? `reference-panel-${++panelSequence}`;
  const controller = new ReferencePanelController({
    api: options.api,
    onChange: options.onChange,
    confirm: options.confirm,
  });
  const renderOptions: RenderOptions = {
    thumbUrl: ref => {
      const direct = ref.thumbUrl ?? ref.thumb ?? ref.posterUrl;
      if (direct && !isAuthedThumbUrl(direct)) return direct;
      return options.api.thumbUrl?.(ref) ?? direct;
    },
  };
  const thumbs = new ReferenceThumbCache(options.api);
  let thumbGeneration = 0;
  const applyThumb = (slot: Element, url: string) => {
    const document = slot.ownerDocument;
    if (!document) return;
    const image = document.createElement('img');
    image.src = url;
    image.alt = slot.getAttribute('aria-label') ?? '';
    image.loading = 'lazy';
    slot.replaceWith(image);
  };
  const hydrateThumbs = (state: PanelState) => {
    const generation = ++thumbGeneration;
    thumbs.retain(state.references);
    const slots = Array.from(el.querySelectorAll<HTMLElement>('[data-ref-thumb]'));
    for (const slot of slots) {
      const refId = slot.getAttribute('data-ref-id') ?? '';
      const ref = state.references.find(item => item.id === refId);
      if (!ref) continue;
      const cached = thumbs.current(ref);
      if (cached) {
        applyThumb(slot, cached);
        continue;
      }
      void thumbs.load(ref).then(url => {
        if (!url || generation !== thumbGeneration) return;
        const current = thumbs.current(ref);
        if (current !== url) return;
        const still = Array.from(el.querySelectorAll<HTMLElement>('[data-ref-thumb]')).find(node =>
          node.getAttribute('data-ref-id') === ref.id
          && node.getAttribute('data-ref-updated') === String(ref.updatedAt ?? ''));
        if (still) applyThumb(still, url);
      });
    }
  };
  el.innerHTML = renderReferencePanel(controller.getState(), { ...renderOptions, idPrefix: prefix });
  const input = el.querySelector<HTMLInputElement>('[data-ref-file]');
  let dragDepth = 0;

  const updateStatus = (state: PanelState) => {
    const status = el.querySelector<HTMLElement>('[data-ref-status]');
    if (!status) return;
    status.textContent = state.message;
    status.classList.toggle('error', state.messageError);
  };
  const updatePending = (state: PanelState) => {
    const pending = el.querySelector<HTMLElement>('[data-ref-pending]');
    if (!pending) return;
    pending.innerHTML = renderPendingItems(state.pending);
    pending.hidden = state.pending.length === 0;
  };
  const updateCards = (state: PanelState) => {
    const cards = el.querySelector<HTMLElement>('[data-ref-cards]');
    if (cards) {
      cards.innerHTML = renderReferenceCardList(state, renderOptions);
      hydrateThumbs(state);
    }
    const count = el.querySelector<HTMLElement>('[data-ref-count]');
    if (count) {
      const size = state.references.length;
      count.textContent = String(size);
      count.setAttribute('aria-label', `${size} reference${size === 1 ? '' : 's'}`);
    }
  };
  const updateAll = (state: PanelState) => {
    updateStatus(state);
    updatePending(state);
    updateCards(state);
  };
  const unsubscribe = controller.subscribe((state, change) => {
    if (change === 'pending') updatePending(state);
    else if (change === 'references') updateCards(state);
    else if (change === 'message') updateStatus(state);
    else updateAll(state);
  });

  const onClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const action = target.closest<HTMLElement>('[data-ref-pick], [data-delete-ref], [data-dismiss-pending], [data-question-ref]');
    if (!action || !el.contains(action)) return;
    if (action.hasAttribute('data-ref-pick')) {
      input?.click();
      return;
    }
    const deleteId = action.getAttribute('data-delete-ref');
    if (deleteId) {
      void controller.deleteReference(deleteId);
      return;
    }
    const pendingKey = action.getAttribute('data-dismiss-pending');
    if (pendingKey) {
      controller.dismissPending(pendingKey);
      return;
    }
    const questionId = action.getAttribute('data-question-ref');
    if (questionId) {
      el.dispatchEvent(new CustomEvent('reference-question', {
        bubbles: true,
        detail: { refId: questionId, question: controller.questionFor(questionId) },
      }));
    }
  };

  const onChange = (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target) return;
    if (target === input) {
      const files = input?.files ? Array.from(input.files) : [];
      if (files.length > 0) controller.queueFiles(files);
      if (input) input.value = '';
      return;
    }
    const roleId = target.getAttribute('data-role-ref');
    if (roleId) void controller.setRole(roleId, target.value);
  };

  const onFocusOut = (event: Event) => {
    const target = event.target as HTMLTextAreaElement | HTMLInputElement | null;
    if (!target) return;
    const noteId = target.getAttribute('data-note-ref');
    if (noteId) {
      void controller.saveNote(noteId, target.value);
      return;
    }
    const labelId = target.getAttribute('data-label-ref');
    if (labelId) void controller.saveLabel(labelId, target.value);
  };

  const onInput = (event: Event) => {
    const target = event.target as HTMLTextAreaElement | null;
    if (!target) return;
    const noteId = target.getAttribute('data-note-ref');
    if (!noteId) return;
    const length = Math.min(LIMITS.noteMaxChars, target.value.length);
    const counts = el.querySelectorAll<HTMLElement>('[data-note-count]');
    for (const count of counts) {
      if (count.dataset.noteCount === noteId) count.textContent = `${length} / ${LIMITS.noteMaxChars}`;
    }
  };

  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    el.classList.add('is-dragging');
  };
  const onDragOver = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) el.classList.remove('is-dragging');
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    el.classList.remove('is-dragging');
    const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
    if (files.length > 0) controller.queueFiles(files);
  };

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('focusout', onFocusOut);
  // `blur` does not bubble, so capture it for hosts/tests that dispatch blur
  // directly. saveNote() serialises and skips an unchanged value, so the
  // focusout that follows never sends a second patch.
  el.addEventListener('blur', onFocusOut, true);
  el.addEventListener('input', onInput);
  el.addEventListener('dragenter', onDragEnter);
  el.addEventListener('dragover', onDragOver);
  el.addEventListener('dragleave', onDragLeave);
  el.addEventListener('drop', onDrop);

  void controller.load();

  return {
    controller,
    refresh: () => controller.load(),
    queueFiles: files => controller.queueFiles(files),
    destroy() {
      unsubscribe();
      controller.destroy();
      thumbs.destroy();
      el.removeEventListener('click', onClick);
      el.removeEventListener('change', onChange);
      el.removeEventListener('focusout', onFocusOut);
      el.removeEventListener('blur', onFocusOut, true);
      el.removeEventListener('input', onInput);
      el.removeEventListener('dragenter', onDragEnter);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDrop);
      el.classList.remove('is-dragging');
      el.innerHTML = '';
    },
  };
}
