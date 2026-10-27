// The procedure capture controller: one recording of this tab plus the step
// journal, saved to Downloads when the run finishes or the person stops it.
//
// The badge it shows is part of the recording on purpose: it is the live
// caption of the current step. While recording, `html[data-procedure-recording]`
// lets CSS hide anything marked as a secret.

import { watchProduction, type WatchProductionOptions } from '../events.ts';
import { escapeHtml } from '../components.ts';
import { fill } from '../copy.ts';
import { PROCEDURE_COPY } from './copy.ts';
import { procedureBaseName, type ProcedureEntryKind } from './format.ts';
import { createProcedureJournal, type ProcedureJournal } from './journal.ts';
import {
  browserRecorderEnv,
  extensionForMime,
  startTabRecording,
  type TabRecorderEnv,
  type TabRecording,
} from './recorder.ts';

export type ProcedureCaptureStatus = 'idle' | 'recording' | 'logging' | 'saving' | 'saved' | 'failed';

export interface ProcedureFile {
  name: string;
  blob: Blob;
}

type Timer = unknown;

export interface ProcedureCaptureOptions {
  doc?: Document | null;
  env?: TabRecorderEnv;
  startRecording?: typeof startTabRecording;
  journal?: ProcedureJournal;
  wallClock?: () => Date;
  /** Saves one file; defaults to an `<a download>` click. */
  download?(file: ProcedureFile): void;
  watch?: (options: WatchProductionOptions) => () => void;
  /** How long the finished screen stays in the recording. */
  tailMs?: number;
  /** A forgotten recording stops on its own after this long. */
  maxMs?: number;
  setTimer?(callback: () => void, ms: number): Timer;
  clearTimer?(timer: Timer): void;
  createObjectUrl?(blob: Blob): string;
  revokeObjectUrl?(url: string): void;
}

export interface ProcedureCapture {
  status(): ProcedureCaptureStatus;
  active(): boolean;
  /** Call from the Generate click itself; resolves once recording (or logging) has started. */
  start(input: { title: string }): Promise<ProcedureCaptureStatus>;
  mark(kind: ProcedureEntryKind, label: string): void;
  observe(snapshot: unknown): void;
  /** Watch a production directly, for surfaces that do not feed snapshots in. */
  follow(productionId: string): void;
  fail(message: string): void;
  finishSoon(): void;
  stop(): Promise<ProcedureFile[]>;
  destroy(): void;
}

export const DEFAULT_TAIL_MS = 4000;
export const DEFAULT_MAX_MS = 30 * 60 * 1000;

function objectUrls(options: ProcedureCaptureOptions): { create(blob: Blob): string; revoke(url: string): void } {
  const scope = globalThis as unknown as { URL?: { createObjectURL?(blob: Blob): string; revokeObjectURL?(url: string): void } };
  return {
    create: options.createObjectUrl ?? ((blob) => scope.URL?.createObjectURL?.(blob) ?? ''),
    revoke: options.revokeObjectUrl ?? ((url) => scope.URL?.revokeObjectURL?.(url)),
  };
}

export function createProcedureCapture(options: ProcedureCaptureOptions = {}): ProcedureCapture {
  const doc = options.doc === undefined ? ((globalThis as { document?: Document }).document ?? null) : options.doc;
  const journal = options.journal ?? createProcedureJournal(options.wallClock ? { wallClock: options.wallClock } : {});
  const startRecording = options.startRecording ?? startTabRecording;
  const watch = options.watch ?? watchProduction;
  const tailMs = options.tailMs ?? DEFAULT_TAIL_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const urls = objectUrls(options);

  let status: ProcedureCaptureStatus = 'idle';
  let recording: TabRecording | null = null;
  let videoUnavailable: string | null = null;
  let tailTimer: Timer | null = null;
  let maxTimer: Timer | null = null;
  let stopWatch: (() => void) | null = null;
  let followed: string | null = null;
  let stopping: Promise<ProcedureFile[]> | null = null;
  let badge: HTMLElement | null = null;
  let savedUrls: string[] = [];

  const active = (): boolean => status === 'recording' || status === 'logging';

  function setRecordingFlag(on: boolean): void {
    const html = doc?.documentElement;
    if (!html) return;
    if (on) html.dataset.procedureRecording = 'true';
    else delete html.dataset.procedureRecording;
  }

  function badgeHtml(): string {
    const latest = journal.latest();
    if (status === 'saved' || status === 'failed' || status === 'saving') {
      const title = status === 'saving' ? PROCEDURE_COPY.saving : status === 'failed' ? PROCEDURE_COPY.failed : '';
      return `<span class="procedure-capture-title" data-procedure-capture-title>${escapeHtml(title)}</span>`;
    }
    const title = status === 'recording' ? PROCEDURE_COPY.recording : PROCEDURE_COPY.logging;
    return `<span class="procedure-capture-dot" aria-hidden="true"></span>
<span class="procedure-capture-title" data-procedure-capture-title>${escapeHtml(title)}</span>
<span class="procedure-capture-step" data-procedure-capture-step>${escapeHtml(latest?.label ?? '')}</span>
<button type="button" class="btn btn-secondary btn-sm procedure-capture-stop" data-procedure-capture-stop>${escapeHtml(PROCEDURE_COPY.stop)}</button>`;
  }

  function paintBadge(): void {
    if (!doc?.body) return;
    if (!badge) {
      badge = doc.createElement('aside');
      badge.className = 'procedure-capture';
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-live', 'polite');
      badge.setAttribute('data-procedure-capture', '');
      badge.addEventListener('click', onBadgeClick);
      doc.body.append(badge);
    }
    badge.dataset.state = status;
    if (status === 'saved') return;
    badge.innerHTML = badgeHtml();
  }

  function paintSaved(files: ProcedureFile[]): void {
    if (!badge || !doc) return;
    badge.dataset.state = 'saved';
    for (const url of savedUrls) urls.revoke(url);
    savedUrls = [];
    const links = files.map((file) => {
      const url = urls.create(file.blob);
      savedUrls.push(url);
      return `<a class="procedure-capture-file" href="${escapeHtml(url)}" download="${escapeHtml(file.name)}" data-procedure-capture-file>${escapeHtml(file.name)}</a>`;
    });
    const names = files.map((file) => file.name).join(', ');
    badge.innerHTML = `<span class="procedure-capture-title" data-procedure-capture-title>${escapeHtml(fill(PROCEDURE_COPY.saved, { files: names }))}</span>
<span class="procedure-capture-files">${links.join(' ')}</span>
<button type="button" class="btn btn-ghost btn-sm" data-procedure-capture-dismiss>Dismiss</button>`;
  }

  function removeBadge(): void {
    for (const url of savedUrls) urls.revoke(url);
    savedUrls = [];
    badge?.removeEventListener('click', onBadgeClick);
    badge?.remove();
    badge = null;
  }

  function onBadgeClick(event: Event): void {
    const target = event.target as { closest?(selector: string): unknown } | null;
    if (typeof target?.closest !== 'function') return;
    if (target.closest('[data-procedure-capture-stop]')) {
      event.preventDefault();
      void stop();
      return;
    }
    if (target.closest('[data-procedure-capture-dismiss]')) {
      event.preventDefault();
      removeBadge();
    }
  }

  function onDocumentClick(event: Event): void {
    if (!active()) return;
    const target = event.target as { closest?(selector: string): unknown } | null;
    if (typeof target?.closest !== 'function') return;
    if (target.closest('[data-procedure-capture]')) return;
    if (target.closest('a[download]')) mark('download', PROCEDURE_COPY.downloaded);
  }

  function defaultDownload(file: ProcedureFile): void {
    if (!doc) return;
    const url = urls.create(file.blob);
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.rel = 'noopener';
    anchor.click();
    setTimer(() => urls.revoke(url), 60_000);
  }

  function clearTimers(): void {
    if (tailTimer !== null) clearTimer(tailTimer);
    if (maxTimer !== null) clearTimer(maxTimer);
    tailTimer = null;
    maxTimer = null;
  }

  function stopFollowing(): void {
    stopWatch?.();
    stopWatch = null;
    followed = null;
  }

  function mark(kind: ProcedureEntryKind, label: string): void {
    if (!active()) return;
    if (journal.mark(kind, label) !== null) paintBadge();
  }

  function finishSoon(): void {
    if (!active() || tailTimer !== null) return;
    tailTimer = setTimer(() => {
      tailTimer = null;
      void stop();
    }, tailMs);
  }

  function observe(snapshot: unknown): void {
    if (!active()) return;
    const before = journal.entries().length;
    const seen = journal.observe(snapshot);
    if (journal.entries().length !== before) paintBadge();
    if (seen.finalReady || seen.failed) finishSoon();
  }

  async function start(input: { title: string }): Promise<ProcedureCaptureStatus> {
    if (active() || status === 'saving') return status;
    removeBadge();
    videoUnavailable = null;
    recording = null;
    // getDisplayMedia must run inside the gesture, before anything awaits.
    const result = await startRecording(options.env ?? browserRecorderEnv(), {
      onEnded: () => {
        mark('note', PROCEDURE_COPY.ended);
        void stop();
      },
    });
    journal.start(input.title);
    if (result.ok) {
      recording = result;
      status = 'recording';
      if (!result.thisTabOnly) journal.mark('note', PROCEDURE_COPY.notThisTab);
    } else {
      status = 'logging';
      videoUnavailable = result.reason === 'denied' ? PROCEDURE_COPY.denied : PROCEDURE_COPY.unsupported;
      journal.mark('note', videoUnavailable);
    }
    setRecordingFlag(true);
    doc?.addEventListener('click', onDocumentClick, true);
    maxTimer = setTimer(() => {
      maxTimer = null;
      void stop();
    }, maxMs);
    paintBadge();
    return status;
  }

  function follow(productionId: string): void {
    if (!active() || productionId === '' || followed === productionId) return;
    stopFollowing();
    followed = productionId;
    stopWatch = watch({ productionId, onState: (state) => observe(state) });
  }

  function fail(message: string): void {
    if (!active()) return;
    mark('failure', fill(PROCEDURE_COPY.failure, { message }));
    finishSoon();
  }

  async function finishFiles(): Promise<ProcedureFile[]> {
    journal.mark('stop', PROCEDURE_COPY.stopped);
    const started = journal.startedAt() ?? (options.wallClock ?? (() => new Date()))();
    const base = procedureBaseName(journal.document(null, null).title, started);
    const files: ProcedureFile[] = [];
    let video: { fileName: string; mimeType: string } | null = null;
    if (recording) {
      const blob = await recording.stop();
      const name = `${base}.${extensionForMime(recording.mimeType)}`;
      if (blob.size > 0) {
        video = { fileName: name, mimeType: recording.mimeType };
        files.push({ name, blob });
      } else {
        videoUnavailable = PROCEDURE_COPY.failed;
      }
    }
    const procedure = journal.document(video, videoUnavailable);
    files.push({ name: `${base}.json`, blob: new Blob([`${JSON.stringify(procedure, null, 2)}\n`], { type: 'application/json' }) });
    return files;
  }

  function stop(): Promise<ProcedureFile[]> {
    if (stopping) return stopping;
    if (!active()) return Promise.resolve([]);
    clearTimers();
    stopFollowing();
    doc?.removeEventListener('click', onDocumentClick, true);
    status = 'saving';
    paintBadge();
    stopping = finishFiles().then((files) => {
      setRecordingFlag(false);
      for (const file of files) (options.download ?? defaultDownload)(file);
      status = 'saved';
      paintSaved(files);
      return files;
    }, () => {
      setRecordingFlag(false);
      status = 'failed';
      paintBadge();
      return [];
    }).finally(() => {
      recording = null;
      stopping = null;
    });
    return stopping;
  }

  function destroy(): void {
    if (active()) void stop();
    else removeBadge();
  }

  return {
    status: () => status,
    active,
    start,
    mark,
    observe,
    follow,
    fail,
    finishSoon,
    stop,
    destroy,
  };
}
