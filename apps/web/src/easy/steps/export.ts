// UR32: step 7, export.
//
// The export itself runs when the step is entered. The server reports no progress,
// so the bar advances on a timer and stops at 90 percent until the render resolves.
// Every render helper below is pure so the step can be checked without a DOM.

import { COPY, fill } from '../copy.ts';
import { narrationPending } from '../narration-status.ts';
import { escapeHtml, renderProgressBar } from '../components.ts';
import { loadSyncnetBanner } from '../syncnet-notice.ts';
import { defaultEasyState, planInputsHash } from '../store.ts';
import { recoverProductionIdentity } from '../resume.ts';
import {
  corruptExportArtifactNotice,
  createExportArtifactRecord,
  exportStorageWarning,
  loadExportArtifact,
  renderDeliveryFacts,
  renderExportArtifactRecovery,
  renderExportArtifactWarning,
  resolveSavedExport,
  saveExportArtifact,
} from '../export-artifacts.ts';
import type {
  ExportArtifactRecord,
  ExportArtifactState,
  ExportArtifactStorage,
  ResolveExportArtifact,
} from '../export-artifacts.ts';
import type { EasyState, EasyStepContext, EasyStepModule, StepFacts } from '../types.ts';

const WORKING_STEP = 10;
const WORKING_LIMIT = 90;
const WORKING_EVERY_MS = 9000;
const DEFAULT_ASPECT = '16:9';
const DEFAULT_REASON = 'Something went wrong.';
export const EXPORT_CHANGE_ACTION = 'Change anything';
export const EXPORT_CHANGE_HINT = 'Describe any change. Paid regeneration still asks first.';

export interface ExportQa {
  passed?: boolean;
  notes?: number;
  items?: string[];
}

export interface ExportArtifactView {
  record?: ExportArtifactRecord | null;
  warning?: string;
  recovery?: { state: ExportArtifactState; message: string } | null;
}

export interface ExportDoneOptions {
  artifact?: ExportArtifactView | null;
  name?: string;
  title?: string;
  videoName?: string;
  blob?: Blob | null;
  blobUrl?: string;
  url?: string;
  duration?: string;
  durationS?: number;
  durationSeconds?: number;
  aspect?: string;
  size?: string;
  sizeBytes?: number;
  fileName?: string;
  downloadName?: string;
  qa?: ExportQa | null;
  qaNotes?: number;
  qaFindings?: number;
  narration?: boolean;
  captions?: string | null;
  captionsUrl?: string | null;
  captionsSrc?: string | null;
  colabStopped?: boolean;
  sessionExisted?: boolean;
  sessionId?: string | null;
  teardown?: string | null;
  colabStatus?: unknown;
  colab?: unknown;
  stale?: boolean;
  revision?: number;
  exportedRevision?: number | null;
  exported?: { revision?: number | null } | null;
  pkg?: unknown;
  package?: unknown;
  state?: EasyState;
}

export interface ExportStateOptions extends ExportDoneOptions {
  status?: 'working' | 'done' | 'error' | 'stale';
  phase?: 'working' | 'done' | 'error' | 'stale';
  progress?: number;
  reason?: string;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, any> | null {
  return isRecord(value) ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function exportFileName(name: unknown): string {
  const source = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.mp4$/, '')
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${source || 'video'}.mp4`;
}

export const slugifyName = exportFileName;
export const slugify = exportFileName;
export const videoFileName = exportFileName;

export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(Math.round(a));
  let right = Math.abs(Math.round(b));
  while (right) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

export function aspectFrom(pkg: unknown): string | null {
  const record = recordOf(pkg);
  if (!record) return null;
  const direct = firstString(record.aspect);
  if (direct) return direct;
  const format = recordOf(record.format);
  const width = numberOrNull(format?.width);
  const height = numberOrNull(format?.height);
  if (width && height && width > 0 && height > 0) {
    const divisor = greatestCommonDivisor(width, height);
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
  }
  return null;
}

export function durationSecondsFrom(pkg: unknown, state?: EasyState): number {
  const record = recordOf(pkg);
  if (record) {
    const direct = numberOrNull(record.durationSeconds ?? record.durationS ?? record.seconds);
    if (direct !== null) return direct;
    const duration = recordOf(record.duration);
    const measured = numberOrNull(duration?.durationSeconds ?? duration?.seconds);
    if (measured !== null) return measured;
    const frames = numberOrNull(duration?.targetFrames);
    const fps = numberOrNull(recordOf(record.format)?.fps);
    if (frames !== null && fps) return frames / fps;
  }
  const fallback = numberOrNull(state?.idea?.lengthS);
  return fallback ?? 0;
}

export function hasNarration(pkg: unknown, state?: EasyState): boolean {
  const record = recordOf(pkg);
  if (record) {
    if (record.narration === false) return false;
    const voice = recordOf(record.voice);
    if (voice && voice.enabled === false) return false;
    if (voice && firstString(voice.engine) === 'none') return false;
    if (Array.isArray(record.scenes) && record.scenes.some((scene: any) => firstString(scene?.narration))) return true;
    if (voice && (voice.enabled === true || firstString(voice.voice))) return true;
  }
  return Boolean(state?.narration?.on);
}

export function captionsFrom(pkg: unknown): string | null {
  const record = recordOf(pkg);
  if (!record) return null;
  const direct = firstString(record.captionsUrl, record.captionsSrc, record.captionsFile);
  if (direct) return direct;
  const assets = recordOf(record.assets);
  if (!assets) return null;
  for (const [key, value] of Object.entries(assets)) {
    const asset = recordOf(value);
    if (!asset) continue;
    const url = firstString(asset.url, asset.href, asset.src);
    const file = firstString(asset.file);
    const kind = firstString(asset.kind, asset.type).toLowerCase();
    const looksLikeCaptions = /caption|subtitle|vtt|srt/.test(`${key} ${kind} ${file}`.toLowerCase());
    if (url && (looksLikeCaptions || /\.(vtt|srt)$/i.test(url))) return url;
    if (file && /\.(vtt|srt)$/i.test(file)) {
      return file.startsWith('/') ? file : `/${file.replace(/^\.?\//, '')}`;
    }
  }
  return null;
}

export function qaFrom(value: unknown): ExportQa | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return { passed: value, notes: value ? 0 : 1 };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { passed: value === 0, notes: Math.max(0, Math.round(value)) };
  }
  if (Array.isArray(value)) {
    return { passed: value.length === 0, notes: value.length, items: value.map(String) };
  }
  const record = recordOf(value);
  if (!record) return null;
  const rawNotes = record.notes ?? record.findings ?? record.problems ?? record.issues;
  let notes = 0;
  let items: string[] = [];
  if (Array.isArray(rawNotes)) {
    notes = rawNotes.length;
    items = rawNotes.map((item) => (typeof item === 'string' ? item : String(item?.text ?? item?.message ?? ''))).filter(Boolean);
  } else if (Number.isFinite(Number(rawNotes))) {
    notes = Math.max(0, Math.round(Number(rawNotes)));
  } else if (Array.isArray(record.items)) {
    notes = record.items.length;
    items = record.items.map(String);
  }
  const explicit = record.passed ?? record.ok ?? record.clean;
  const passed = typeof explicit === 'boolean' ? explicit : notes === 0;
  return { passed, notes, items };
}

export function isExportStale(pkg: unknown, exportedRevision: number | null | undefined): boolean {
  const revision = numberOrNull(recordOf(pkg)?.revision);
  const exported = numberOrNull(exportedRevision);
  return revision !== null && exported !== null && revision > exported;
}

export function isExportCurrent(pkg: unknown, exportedRevision: number | null | undefined): boolean {
  const revision = numberOrNull(recordOf(pkg)?.revision);
  const exported = numberOrNull(exportedRevision);
  return revision !== null && exported !== null && revision === exported;
}

export const isStale = isExportStale;

function normalizeProgress(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return WORKING_STEP;
  return Math.max(0, Math.min(WORKING_LIMIT, Math.round(numeric)));
}

export function renderExportWorking(progress: number | { progress?: number } = WORKING_STEP): string {
  const value = normalizeProgress(typeof progress === 'object' ? progress?.progress : progress);
  return `<div class="easy-export-working" data-easy-export-working>
<div class="easy-export-player" data-easy-player></div>
<p class="easy-export-status">${escapeHtml(COPY.export.working)}</p>
${renderProgressBar({ label: COPY.export.working, value })}
</div>`;
}

function normalizeDone(input: ExportDoneOptions | string | null | undefined): ExportDoneOptions {
  if (typeof input === 'string') return { name: input };
  return isRecord(input) ? input : {};
}

function doneParts(options: ExportDoneOptions) {
  const pkg = options.pkg ?? options.package;
  const state = options.state;
  const name = firstString(options.name, options.title, options.videoName, recordOf(pkg)?.title) || COPY.shell.untitled;
  const durationS = numberOrNull(options.durationS) ?? numberOrNull(options.durationSeconds);
  const duration = firstString(options.duration) || (durationS !== null && durationS > 0 ? formatDuration(durationS) : 'Duration unavailable');
  const aspect = firstString(options.aspect, aspectFrom(pkg), state?.idea?.aspect) || DEFAULT_ASPECT;
  const sizeValue = numberOrNull(options.sizeBytes);
  const size = firstString(options.size) || (sizeValue !== null ? formatSize(sizeValue) : '');
  let blobUrl = firstString(options.blobUrl, options.url, recordOf(pkg)?.blobUrl);
  if (!blobUrl && options.blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    blobUrl = URL.createObjectURL(options.blob);
  }
  const fileName = firstString(options.fileName, options.downloadName) || exportFileName(name);
  const narration = typeof options.narration === 'boolean' ? options.narration : hasNarration(pkg, state);
  const captionsUrl = firstString(options.captions, options.captionsUrl, options.captionsSrc) || captionsFrom(pkg);
  const qa = options.qa !== undefined
    ? qaFrom(options.qa)
    : (options.qaNotes !== undefined
      ? qaFrom(options.qaNotes)
      : (options.qaFindings !== undefined ? qaFrom(options.qaFindings) : null));
  const exportedRevision = options.exportedRevision ?? options.exported?.revision;
  const stale = typeof options.stale === 'boolean'
    ? options.stale
    : isExportStale(pkg ?? { revision: options.revision }, exportedRevision);
  const session = recordOf(options.colabStatus ?? options.colab) ?? {};
  const sessionExisted = typeof options.sessionExisted === 'boolean'
    ? options.sessionExisted
    : Boolean(options.sessionId || session.session || session.sessionId || session.exists);
  const teardownValue = options.teardown
    ?? session.teardown?.state
    ?? session.teardown
    ?? session.state;
  const colabStopped = typeof options.colabStopped === 'boolean'
    ? options.colabStopped
    : sessionExisted && firstString(teardownValue) === 'stopped';
  return { name, duration, aspect, size, blobUrl, fileName, narration, captionsUrl, qa, stale, colabStopped };
}

function renderQa(qa: ExportQa | null): string {
  if (!qa) return '';
  const notes = Math.max(0, Math.round(Number(qa.notes) || 0));
  if (qa.passed === true && notes === 0) {
    return `<p class="easy-export-qa" data-easy-export-qa>${escapeHtml(COPY.export.qaPass)}</p>`;
  }
  const summary = fill(COPY.export.qaNotes, { n: notes });
  const items = (qa.items ?? []).filter(Boolean);
  const list = items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '';
  return `<details class="easy-export-qa" data-easy-export-qa><summary>${escapeHtml(summary)}</summary>${list}</details>`;
}

export function renderExportStale(options: { message?: string } = {}): string {
  const message = firstString(options.message) || COPY.export.stale;
  return `<div class="easy-export-stale" data-easy-export-stale role="status">
<p>${escapeHtml(message)}</p>
<button type="button" class="btn btn-secondary" data-easy-export-again>${escapeHtml(COPY.export.again)}</button>
</div>`;
}

export function renderExportDone(input: ExportDoneOptions | string | null = {}): string {
  const options = normalizeDone(input);
  const parts = doneParts(options);
  const source = parts.blobUrl ? ` src="${escapeHtml(parts.blobUrl)}"` : '';
  const track = parts.narration
    ? `<track kind="captions"${parts.captionsUrl ? ` src="${escapeHtml(parts.captionsUrl)}"` : ''} srclang="en" label="English" default />`
    : '';
  const artifact = options.artifact ?? {};
  const savedRecord = artifact.record ?? null;
  const download = parts.blobUrl
    ? `<a class="btn btn-primary" download="${escapeHtml(parts.fileName)}" href="${escapeHtml(parts.blobUrl)}" data-easy-export-download>${escapeHtml(COPY.export.download)}</a>`
    : (savedRecord
      ? `<button type="button" class="btn btn-primary" data-easy-export-download>${escapeHtml(COPY.export.download)}</button>`
      : `<button type="button" class="btn btn-primary" data-easy-export-again>${escapeHtml(COPY.export.again)}</button>`);
  const colab = parts.colabStopped
    ? `<p class="easy-export-colab" data-easy-export-colab>${escapeHtml(COPY.colab.stopped)}</p>`
    : '';
  const stale = parts.stale ? renderExportStale() : '';
  const warning = artifact.warning ? renderExportArtifactWarning(artifact.warning) : '';
  const recovery = artifact.recovery
    ? renderExportArtifactRecovery(artifact.recovery.state, artifact.recovery.message)
    : '';
  const facts = renderDeliveryFacts(savedRecord);
  const pendingNarration = narrationPending(options.pkg ?? options.package);
  return `<section class="easy-export-done" data-easy-export-done>
<h2 class="easy-export-heading" tabindex="-1">${escapeHtml(pendingNarration ? 'Preview' : COPY.export.doneHeading)}</h2>
${pendingNarration ? '<p role="status">Narration is planned but not yet available. This preview may be silent.</p>' : ''}
<figure class="easy-export-player">
<video data-easy-player controls preload="metadata"${source}>${track}</video>
<figcaption class="easy-export-meta" data-easy-export-meta>${escapeHtml(parts.name)} · <span data-easy-export-duration>${escapeHtml(parts.duration)}</span> · ${escapeHtml(parts.aspect)}${parts.size ? ` · ${escapeHtml(parts.size)}` : ''}</figcaption>
</figure>
<div class="easy-export-actions">
${download}
<button type="button" class="btn btn-secondary" data-easy-export-change>${escapeHtml(EXPORT_CHANGE_ACTION)}</button>
<button type="button" class="btn btn-secondary" data-easy-export-editor>${escapeHtml(COPY.shell.openEditor)}</button>
<button type="button" class="btn btn-secondary" data-easy-export-extras>${escapeHtml(COPY.export.extras)}</button>
</div>
<p class="hint easy-export-change-hint" data-easy-export-change-hint>${escapeHtml(EXPORT_CHANGE_HINT)}</p>
${warning}
${recovery}
${facts}
${renderQa(parts.qa)}
${colab}
${stale}
<nav class="easy-export-links" aria-label="${escapeHtml(COPY.export.heading)}">
<a href="?step=review" data-easy-export-another>${escapeHtml(COPY.export.another)}</a>
<button type="button" class="btn btn-ghost" data-easy-export-new>${escapeHtml(COPY.export.newVideo)}</button>
</nav>
</section>`;
}

export function renderExportError(reason: string | { reason?: string; message?: string } = DEFAULT_REASON): string {
  const detail = typeof reason === 'string' ? reason : firstString(reason?.reason, reason?.message);
  const text = fill(COPY.export.failed, { reason: detail || DEFAULT_REASON });
  return `<div class="easy-export-failure">
<div class="easy-export-player" data-easy-player></div>
<div class="easy-export-error" data-easy-export-error role="alert">
<p>${escapeHtml(text)}</p>
<div class="easy-export-error-actions">
<button type="button" class="btn btn-primary" data-easy-export-retry>${escapeHtml(COPY.export.retry)}</button>
<button type="button" class="btn btn-secondary" data-easy-export-editor>${escapeHtml(COPY.shell.openEditor)}</button>
</div>
</div>
</div>`;
}

export const renderExportFailed = renderExportError;
export const renderExportFailure = renderExportError;

export function renderExportState(input: ExportStateOptions = {}): string {
  const status = input.status ?? input.phase ?? (input.reason || input.message ? 'error' : 'working');
  if (status === 'error') return renderExportError(input.reason ?? input.message ?? DEFAULT_REASON);
  if (status === 'stale') return renderExportStale();
  if (status === 'done') return renderExportDone(input);
  return renderExportWorking(input.progress ?? WORKING_STEP);
}

export const renderWorking = renderExportWorking;
export const renderDone = renderExportDone;
export const renderError = renderExportError;
export const renderStale = renderExportStale;
export const renderExport = renderExportState;
export const slugifyFileName = exportFileName;
export const exportFileNameFor = exportFileName;

function setHeading(el: HTMLElement, text: string, focus: boolean): void {
  const doc = el.ownerDocument;
  const heading = doc?.querySelector<HTMLElement>('[data-easy-heading]');
  if (!heading) return;
  heading.textContent = text;
  if (focus && typeof heading.focus === 'function') heading.focus();
}

function triggerDownload(doc: Document, href: string, name: string): void {
  const link = doc.createElement('a');
  link.href = href;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  doc.body.append(link);
  link.click();
  link.remove();
}

function zipNameFor(name: string): string {
  return exportFileName(name).replace(/\.mp4$/, '.zip');
}

function downloadUrlFrom(result: unknown): string | null {
  if (typeof result === 'string' && result) return result;
  const record = recordOf(result);
  if (!record) return null;
  const blobValue = record.blob ?? record.zip ?? record.bundle;
  if (typeof Blob !== 'undefined' && blobValue instanceof Blob) return URL.createObjectURL(blobValue);
  const direct = firstString(record.url, record.downloadUrl, record.zipUrl, record.bundleUrl, record.href);
  if (direct) return direct;
  const files = Array.isArray(record.files) ? record.files : [];
  for (const item of files) {
    const file = recordOf(item);
    if (!file) continue;
    const name = firstString(file.name, file.file);
    const url = firstString(file.url, file.href, file.src, file.downloadUrl);
    if (url && /\.zip$/i.test(name || url)) return url;
  }
  const exportUrl = firstString(record.exportUrl);
  if (exportUrl) return exportUrl.replace(/\/$/, '') + '/package.zip';
  return null;
}

function captionUrlFrom(result: unknown): string | null {
  const record = recordOf(result);
  if (!record) return null;
  const direct = firstString(record.captionsUrl, record.captionsSrc);
  if (direct) return direct;
  const files = Array.isArray(record.files) ? record.files : [];
  for (const item of files) {
    const file = recordOf(item);
    if (!file) continue;
    const name = firstString(file.name, file.file);
    const url = firstString(file.url, file.href, file.src, file.downloadUrl);
    if (url && /\.vtt$/i.test(name || url)) return url;
  }
  return null;
}

interface ExportController {
  destroy(): void;
  primary(): void;
}

let activeController: ExportController | null = null;

interface CachedExport {
  key: string;
  blob: Blob;
  qa: ExportQa | null;
  captions: string | null;
}

let lastExport: CachedExport | null = null;

function exportCacheKey(pkg: unknown, revision: unknown): string {
  return [recordOf(pkg)?.id ?? '', revision ?? ''].map(String).join(':');
}

function mountExport(el: HTMLElement, ctx: EasyStepContext): ExportController {
  const doc = el.ownerDocument;
  let destroyed = false;
  let phase: 'working' | 'done' | 'error' = 'working';
  let syncnetNotice = '';
  let errorReason = DEFAULT_REASON;
  let progress = WORKING_STEP;
  let timer: ReturnType<typeof setInterval> | null = null;
  let blob: Blob | null = null;
  let blobUrl: string | null = null;
  let currentQa: ExportQa | null = null;
  let bundleCaptions: string | null = null;
  let currentRun = 0;
  let artifactRecord: ExportArtifactRecord | null = null;
  let artifactWarning = '';
  let recovery: { state: ExportArtifactState; message: string } | null = null;

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function revoke(): void {
    if (blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(blobUrl);
    }
    blobUrl = null;
  }

  function currentPackage(): any {
    try {
      return ctx.host.getPackage();
    } catch {
      return null;
    }
  }

  function artifactStorage(): ExportArtifactStorage | undefined {
    const host = ctx.host as unknown as { exportArtifactStorage?: ExportArtifactStorage };
    return host.exportArtifactStorage;
  }

  function artifactResolver(): ResolveExportArtifact | undefined {
    const host = ctx.host as unknown as { resolveExportArtifact?: ResolveExportArtifact };
    return host.resolveExportArtifact;
  }

  function cachedExportForCurrent(): CachedExport | null {
    const state = ctx.store.get();
    const pkg = currentPackage();
    if (!isExportCurrent(pkg, state.exported.revision)) return null;
    const key = exportCacheKey(pkg, state.exported.revision);
    return lastExport && lastExport.key === key ? lastExport : null;
  }

  function doneOptions(): ExportDoneOptions {
    const state = ctx.store.get();
    const pkg = currentPackage();
    return {
      pkg,
      state,
      blobUrl: blobUrl ?? '',
      sizeBytes: blob?.size ?? artifactRecord?.files.find((file) => file.name === 'video.mp4')?.bytes,
      qa: currentQa,
      captionsUrl: bundleCaptions,
      colabStopped: state.compute === 'colab' && (state.generate.status === 'done' || state.generate.status === 'stopped'),
      exportedRevision: state.exported.revision,
      artifact: {
        record: artifactRecord,
        warning: artifactWarning,
        recovery,
      },
    };
  }

  function withNotice(html: string): string {
    return syncnetNotice ? `${syncnetNotice}${html}` : html;
  }

  function paintWorking(): void {
    el.innerHTML = withNotice(renderExportWorking(progress));
    setHeading(el, COPY.export.heading, false);
    ctx.shell.setPrimary({ label: COPY.export.working, disabled: true });
  }

  function paintDone(): void {
    phase = 'done';
    stopTimer();
    el.innerHTML = withNotice(renderExportDone(doneOptions()));
    setHeading(el, narrationPending(currentPackage()) ? 'Preview' : COPY.export.doneHeading, true);
    const canDownload = Boolean(blobUrl || (artifactRecord && (!recovery || recovery.state === 'ready')));
    ctx.shell.setPrimary({ label: canDownload ? COPY.export.download : COPY.export.again });
  }

  function paintError(reason: string): void {
    phase = 'error';
    errorReason = reason;
    stopTimer();
    el.innerHTML = withNotice(renderExportError(reason));
    setHeading(el, COPY.export.heading, false);
    ctx.shell.setPrimary({ label: COPY.export.retry });
  }

  function startTimer(): void {
    stopTimer();
    timer = setInterval(() => {
      if (destroyed || phase !== 'working') return;
      progress = Math.min(WORKING_LIMIT, progress + WORKING_STEP);
      if (phase === 'working') el.innerHTML = withNotice(renderExportWorking(progress));
    }, WORKING_EVERY_MS);
  }

  async function begin(): Promise<void> {
    if (destroyed) return;
    currentRun += 1;
    const run = currentRun;
    phase = 'working';
    progress = WORKING_STEP;
    currentQa = null;
    blob = null;
    artifactRecord = null;
    artifactWarning = '';
    recovery = null;
    revoke();
    paintWorking();
    startTimer();
    try {
      const state = ctx.store.get();
      let persistedRevision: number | undefined;
      if (state.productionId && state.idea.text.trim() && (state.plan.status === 'stale' || state.planHash !== planInputsHash(state))) {
        throw new Error('The plan inputs changed. Review and approve the current plan before exporting.');
      }
      if (state.productionId && !state.idea.text.trim()) {
        if (!await recoverProductionIdentity({ api: ctx.api, host: ctx.host, state, productionId: state.productionId })) {
          throw new Error('The approved project version could not be verified. Return to the plan before exporting.');
        }
        persistedRevision = currentPackage()?.revision;
        if (!Number.isSafeInteger(persistedRevision)) throw new Error('The project version could not be verified.');
      }
      const result = await ctx.host.renderMp4({ productionId: state.productionId, ...(persistedRevision === undefined ? {} : { persistedRevision }) });
      if (destroyed || run !== currentRun) return;
      blob = result.blob;
      if (blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        blobUrl = URL.createObjectURL(blob);
      }
      const revision = typeof result.revision === 'number' ? result.revision : null;
      ctx.store.patch({
        exported: {
          revision,
          at: new Date().toISOString(),
        },
      });
      try {
        const built = createExportArtifactRecord(result);
        if (built.ok) {
          artifactRecord = built.record;
          const saved = saveExportArtifact(built.record, artifactStorage());
          if (!saved.saved) artifactWarning = exportStorageWarning(saved.reason);
        } else {
          artifactWarning = built.notice;
        }
      } catch {
        artifactWarning = 'This export finished, but its delivery record could not be read, so it cannot be reopened after reload.';
      }
      if (result.renderId) {
        try {
          currentQa = qaFrom(await ctx.api.qa(result.renderId));
        } catch {
          currentQa = null;
        }
      }
      if (destroyed || run !== currentRun) return;
      if (blob) {
        lastExport = {
          key: exportCacheKey(currentPackage(), revision),
          blob,
          qa: currentQa,
          captions: bundleCaptions,
        };
      }
      paintDone();
    } catch (error) {
      if (destroyed || run !== currentRun) return;
      const reason = error instanceof Error ? error.message : String(error ?? DEFAULT_REASON);
      paintError(reason);
    }
  }

  async function recoverSaved(): Promise<void> {
    if (!artifactRecord) {
      void begin();
      return;
    }
    const access = await resolveSavedExport(artifactRecord, artifactResolver());
    if (destroyed) {
      if (access.href?.startsWith('blob:')) URL.revokeObjectURL(access.href);
      return;
    }
    if (access.state === 'ready' && access.href) {
      recovery = null;
      blobUrl = access.href;
      triggerDownload(doc, access.href, exportFileName(currentPackage()?.title));
      paintDone();
      return;
    }
    recovery = { state: access.state, message: access.message };
    paintDone();
  }

  async function downloadExtras(button: HTMLButtonElement): Promise<void> {
    const state = ctx.store.get();
    button.disabled = true;
    try {
      const result = await ctx.api.exportBundle({ packageId: state.packageId });
      const url = downloadUrlFrom(result);
      if (url) triggerDownload(doc, url, zipNameFor(currentPackage()?.title ?? COPY.shell.untitled));
      const captions = captionUrlFrom(result);
      if (captions && phase === 'done') {
        bundleCaptions = captions;
        el.innerHTML = withNotice(renderExportDone(doneOptions()));
      }
    } catch (error) {
      ctx.shell.alert(error instanceof Error ? error.message : String(error ?? DEFAULT_REASON));
    } finally {
      button.disabled = false;
    }
  }

  function startNew(): void {
    try {
      const resettable = ctx.store as { reset?: () => unknown };
      if (typeof resettable.reset === 'function') resettable.reset();
      else ctx.store.patch(defaultEasyState());
    } catch {
      ctx.store.patch(defaultEasyState());
    }
    const view = doc.defaultView;
    if (view?.location) view.location.assign('/');
    else ctx.go('idea');
  }

  function primary(): void {
    if (phase === 'done') {
      if (blobUrl) triggerDownload(doc, blobUrl, exportFileName(currentPackage()?.title));
      else if (artifactRecord && (!recovery || recovery.state === 'ready')) void recoverSaved();
      else void begin();
      return;
    }
    if (phase === 'error') {
      void begin();
      return;
    }
    void begin();
  }

  function onClick(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest<HTMLElement>('button, a');
    if (!button) return;
    if (button.hasAttribute('data-easy-export-download')) {
      event.preventDefault();
      if (blobUrl) triggerDownload(doc, blobUrl, exportFileName(currentPackage()?.title));
      else if (artifactRecord) void recoverSaved();
      return;
    }
    if (button.hasAttribute('data-easy-export-retry') || button.hasAttribute('data-easy-export-again')) {
      event.preventDefault();
      void begin();
      return;
    }
    if (button.hasAttribute('data-easy-export-another')) {
      event.preventDefault();
      ctx.go('review');
      return;
    }
    if (button.hasAttribute('data-easy-export-change')) {
      event.preventDefault();
      ctx.openAsk?.();
      return;
    }
    if (button.hasAttribute('data-easy-export-editor')) {
      event.preventDefault();
      ctx.host.openEditor();
      return;
    }
    if (button.hasAttribute('data-easy-export-extras')) {
      event.preventDefault();
      void downloadExtras(button as HTMLButtonElement);
      return;
    }
    if (button.hasAttribute('data-easy-export-new')) {
      event.preventDefault();
      startNew();
    }
  }

  function onVideoMetadata(event: Event): void {
    const video = el.querySelector<HTMLVideoElement>('video[data-easy-player]');
    if (destroyed || phase !== 'done' || !video || event.target !== video) return;
    const label = el.querySelector<HTMLElement>('[data-easy-export-duration]');
    if (!label) return;
    label.textContent = event.type !== 'error' && Number.isFinite(video.duration) && video.duration > 0
      ? formatDuration(video.duration)
      : 'Duration unavailable';
  }

  function destroy(): void {
    destroyed = true;
    currentRun += 1;
    stopTimer();
    revoke();
    el.removeEventListener('click', onClick);
    el.removeEventListener('loadedmetadata', onVideoMetadata, true);
    el.removeEventListener('durationchange', onVideoMetadata, true);
    el.removeEventListener('error', onVideoMetadata, true);
    if (activeController === controller) activeController = null;
  }

  const controller: ExportController = { destroy, primary };
  el.addEventListener('click', onClick);
  el.addEventListener('loadedmetadata', onVideoMetadata, true);
  el.addEventListener('durationchange', onVideoMetadata, true);
  el.addEventListener('error', onVideoMetadata, true);
  void loadSyncnetBanner(ctx).then((html) => {
    if (html === null || destroyed) return;
    syncnetNotice = html;
    ctx.shell.setBanner(html);
    if (phase === 'working') paintWorking();
    else if (phase === 'done') paintDone();
    else paintError(errorReason);
  });
  const pkg = currentPackage();
  const packageId = recordOf(pkg)?.id;
  const loaded = loadExportArtifact(typeof packageId === 'string' ? packageId : '', artifactStorage());
  if (loaded.status === 'corrupt') artifactWarning = corruptExportArtifactNotice();
  else if (loaded.status === 'ok') artifactRecord = loaded.record;
  const cached = cachedExportForCurrent();
  if (cached) {
    blob = cached.blob;
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      blobUrl = URL.createObjectURL(blob);
    }
    currentQa = cached.qa;
    bundleCaptions = cached.captions;
    paintDone();
  } else if (artifactRecord) {
    paintDone();
  } else if (isExportCurrent(pkg, ctx.store.get().exported.revision)) {
    paintDone();
  } else {
    void begin();
  }
  return controller;
}

export const step: EasyStepModule = {
  id: 'export',
  heading: COPY.export.heading,
  intro: '',
  primaryLabel() {
    return COPY.export.download;
  },
  render(_state: EasyState, _facts: StepFacts): string {
    return renderExportWorking(WORKING_STEP);
  },
  bind(el: HTMLElement, ctx: EasyStepContext): () => void {
    activeController?.destroy();
    const controller = mountExport(el, ctx);
    activeController = controller;
    return () => controller.destroy();
  },
  onPrimary(_ctx: EasyStepContext): void {
    activeController?.primary();
  },
};
