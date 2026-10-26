/**
 * UX11 timeline hydration.
 *
 * The timeline does not wait for every shot before it becomes usable. Hydration
 * orders work by distance from the playhead (current, next, then the rest),
 * runs a bounded number of requests, publishes each shot as soon as its ticket
 * and thumbnail are ready, and cancels work for a superseded selection or a
 * far-away seek. A seek that finds an expired ticket renews that ticket while
 * keeping the playhead where the user put it.
 *
 * The module is a plain coordinator: no DOM, no React, no storage. The mount
 * adapter passes the shared ticket resolver and thumbnail client in.
 */
import type { ClipKind, ClipSummary } from '../../takes/api.ts';
import type { ThumbKind, ThumbRequest, ThumbResult } from '../../thumbs/client.ts';
import type { MediaSource, MediaTicket } from '../../media/ticket-resolver.ts';
import type { MediaThumbnailResult } from '../../media/thumbnail-client.ts';
import {
  MEDIA_RENEW_BEFORE_MS,
  ticketExpiryState,
} from '../../../../server/src/productions/contract.mjs';

export type TimelineShotStatus = 'pending' | 'ready' | 'unavailable';

export interface TimelineHydrationShot {
  clipId: string;
  sceneId: string;
  assetId: string;
  selectedTakeId: string | null;
  kind?: ClipKind;
  from: number;
  durationInFrames: number;
}

/**
 * A clip summary or the smaller shape a timeline fixture can build. `selected`
 * is read only when `selectedTakeId` is absent.
 */
export type TimelineShotInput = Partial<ClipSummary> & {
  clipId?: string;
  selectedTakeId?: string | null;
};

export interface TimelineShotState extends TimelineHydrationShot {
  status: TimelineShotStatus;
  ticket: MediaTicket | null;
  thumbnail: MediaThumbnailResult | ThumbResult | null;
  reason: string | null;
  distance: number;
}

export interface TimelineHydrationSnapshot {
  playheadFrame: number;
  /** Increments when the shot/selection input changes. */
  revision: number;
  /** Increments on every published update. */
  sequence: number;
  currentClipId: string | null;
  nextClipId: string | null;
  shots: Readonly<Record<string, TimelineShotState>>;
}

export interface TimelineHydratorOptions {
  packageId: string | (() => string);
  resolveTicket: (source: MediaSource, options?: { signal?: AbortSignal }) => Promise<MediaTicket>;
  loadThumbnail?: (request: ThumbRequest, signal?: AbortSignal) => Promise<ThumbResult | MediaThumbnailResult>;
  thumbKind?: (shot: TimelineShotState) => ThumbKind;
  now?: () => number;
  renewBeforeMs?: number;
  concurrency?: number;
  onUpdate?: (snapshot: TimelineHydrationSnapshot) => void;
  onThumbnail?: (shot: TimelineShotState, result: ThumbResult | MediaThumbnailResult) => void;
  onOpen?: (shot: TimelineShotState) => void;
}

export interface SetShotsOptions {
  playheadFrame?: number;
  revision?: number;
}

export interface TimelineHydrator {
  setShots(shots: readonly TimelineShotInput[], options?: SetShotsOptions): void;
  seek(frame: number): void;
  open(clipId: string): boolean;
  snapshot(): TimelineHydrationSnapshot;
  subscribe(listener: (snapshot: TimelineHydrationSnapshot) => void): () => void;
  idle(): Promise<void>;
  cancel(): void;
  dispose(): void;
}

const MAX_CONCURRENCY = 8;
const CLIP_KINDS = new Set(['still', 'plate', 'presenter']);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeShot(value: unknown): TimelineHydrationShot | null {
  if (!isObject(value)) return null;
  const clipId = text(value.clipId);
  if (!clipId) return null;
  const selectedTakeId = text(value.selectedTakeId) || text(value.selected) || null;
  const rawKind = text(value.kind);
  const kind = CLIP_KINDS.has(rawKind) ? rawKind as ClipKind : undefined;
  return {
    clipId,
    sceneId: text(value.sceneId),
    assetId: text(value.assetId),
    selectedTakeId,
    ...(kind ? { kind } : {}),
    from: Math.max(0, finite(value.from, 0)),
    durationInFrames: Math.max(0, finite(value.durationInFrames, 0)),
  };
}

interface Entry {
  state: TimelineShotState;
  token: number;
  selectionAbort: AbortController;
}

interface Job {
  id: number;
  clipId: string;
  token: number;
  mode: 'full' | 'refresh';
  controller: AbortController;
  cleanup: () => void;
}

export function createTimelineHydrator(options: TimelineHydratorOptions): TimelineHydrator {
  if (!isObject(options) || typeof options.resolveTicket !== 'function') {
    throw new TypeError('createTimelineHydrator requires a resolveTicket function');
  }
  const resolveTicket = options.resolveTicket;
  const loadThumbnail = typeof options.loadThumbnail === 'function' ? options.loadThumbnail : null;
  const thumbKind = typeof options.thumbKind === 'function'
    ? options.thumbKind
    : (shot: TimelineShotState): ThumbKind => (shot.kind === 'still' ? 'poster' : 'filmstrip');
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const renewBeforeMs = typeof options.renewBeforeMs === 'number' && options.renewBeforeMs >= 0
    ? options.renewBeforeMs
    : MEDIA_RENEW_BEFORE_MS;
  const concurrency = typeof options.concurrency === 'number' && Number.isFinite(options.concurrency)
    ? Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(options.concurrency)))
    : 3;

  const listeners = new Set<(snapshot: TimelineHydrationSnapshot) => void>();
  let entries = new Map<string, Entry>();
  let queue: Job[] = [];
  let running = new Map<number, Job>();
  let active = 0;
  let playheadFrame = 0;
  let revision = 0;
  let sequence = 0;
  let nextToken = 0;
  let nextJobId = 0;
  let disposed = false;
  let idleWaiters: Array<() => void> = [];

  function packageId(): string {
    const value = typeof options.packageId === 'function' ? options.packageId() : options.packageId;
    return typeof value === 'string' ? value.trim() : '';
  }

  function distanceOf(shot: TimelineHydrationShot): number {
    const start = shot.from;
    const end = shot.from + shot.durationInFrames;
    if (playheadFrame < start) return start - playheadFrame;
    if (playheadFrame > end) return playheadFrame - end;
    return 0;
  }

  function orderedEntries(): Entry[] {
    return [...entries.values()].sort((left, right) => {
      const from = left.state.from - right.state.from;
      if (from !== 0) return from;
      return left.state.clipId.localeCompare(right.state.clipId);
    });
  }

  function currentAndNext(): { currentClipId: string | null; nextClipId: string | null } {
    const ordered = orderedEntries();
    if (ordered.length === 0) return { currentClipId: null, nextClipId: null };
    let currentIndex = -1;
    for (let index = 0; index < ordered.length; index += 1) {
      const shot = ordered[index].state;
      if (playheadFrame >= shot.from && playheadFrame < shot.from + shot.durationInFrames) {
        currentIndex = index;
        break;
      }
      if (shot.from <= playheadFrame) currentIndex = index;
    }
    if (currentIndex < 0) currentIndex = 0;
    const nextIndex = ordered[currentIndex + 1] ? currentIndex + 1 : -1;
    return {
      currentClipId: ordered[currentIndex]?.state.clipId ?? null,
      nextClipId: nextIndex >= 0 ? ordered[nextIndex].state.clipId : null,
    };
  }

  function refreshDistances(): void {
    for (const entry of entries.values()) entry.state.distance = distanceOf(entry.state);
  }

  function snapshot(): TimelineHydrationSnapshot {
    const shots: Record<string, TimelineShotState> = {};
    for (const [clipId, entry] of entries) shots[clipId] = { ...entry.state };
    const focus = currentAndNext();
    return {
      playheadFrame,
      revision,
      sequence,
      currentClipId: focus.currentClipId,
      nextClipId: focus.nextClipId,
      shots,
    };
  }

  function emit(): void {
    if (disposed) return;
    refreshDistances();
    sequence += 1;
    const value = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch {
        // A view listener cannot stop hydration.
      }
    }
    try {
      options.onUpdate?.(value);
    } catch {
      // Callbacks are advisory.
    }
  }

  function settleIdle(): void {
    if (active > 0 || queue.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function isCurrentToken(entry: Entry, job: Job): boolean {
    return entries.get(job.clipId) === entry && entry.token === job.token && !job.controller.signal.aborted;
  }

  function normalizeThumbnail(value: unknown): MediaThumbnailResult | ThumbResult {
    if (!isObject(value)) return { status: 'failed', reason: 'invalid_response' };
    if (value.status === 'ready') {
      return value as unknown as ThumbResult;
    }
    if (value.status === 'pending') return { status: 'pending' };
    if (value.status === 'failed') return { status: 'failed', reason: text(value.reason) || 'failed' };
    if (value.status === 'none') return { status: 'none', reason: text(value.reason) || 'none' };
    return { status: 'failed', reason: 'invalid_response' };
  }

  async function runJob(job: Job): Promise<void> {
    const entry = entries.get(job.clipId);
    if (!entry || entry.token !== job.token) return;
    const signal = job.controller.signal;
    if (signal.aborted) return;

    if (job.mode === 'full' || job.mode === 'refresh') {
      const selectedTakeId = entry.state.selectedTakeId;
      if (!selectedTakeId) {
        entry.state.status = 'unavailable';
        entry.state.reason = 'no-selected-take';
        entry.state.ticket = null;
        if (isCurrentToken(entry, job)) emit();
      } else {
        const pkg = packageId();
        if (!pkg) {
          entry.state.status = 'unavailable';
          entry.state.reason = 'no-package';
          entry.state.ticket = null;
          if (isCurrentToken(entry, job)) emit();
        } else {
          try {
            const ticket = await resolveTicket({
              kind: 'take',
              packageId: pkg,
              clipId: entry.state.clipId,
              takeId: selectedTakeId,
            }, { signal });
            if (!isCurrentToken(entry, job)) return;
            entry.state.ticket = ticket;
            entry.state.status = 'ready';
            entry.state.reason = null;
            emit();
          } catch (error) {
            if (signal.aborted) return;
            if (!isCurrentToken(entry, job)) return;
            entry.state.ticket = null;
            entry.state.status = 'unavailable';
            entry.state.reason = error instanceof Error && error.message ? error.message : 'media-unavailable';
            emit();
          }
        }
      }
    }

    if (job.mode === 'full' && loadThumbnail && entry.state.assetId) {
      if (job.controller.signal.aborted) return;
      const request: ThumbRequest = {
        packageId: packageId(),
        ref: entry.state.assetId,
        kind: thumbKind(entry.state),
      };
      try {
        const result = normalizeThumbnail(await loadThumbnail(request, job.controller.signal));
        if (!isCurrentToken(entry, job)) return;
        entry.state.thumbnail = result;
        emit();
        try {
          options.onThumbnail?.({ ...entry.state }, result);
        } catch {
          // Callbacks are advisory.
        }
      } catch (error) {
        if (job.controller.signal.aborted || !isCurrentToken(entry, job)) return;
        const result: MediaThumbnailResult = {
          status: 'failed',
          reason: error instanceof Error && error.message ? error.message : 'thumbnail-load-failed',
        };
        entry.state.thumbnail = result;
        emit();
        try {
          options.onThumbnail?.({ ...entry.state }, result);
        } catch {
          // Callbacks are advisory.
        }
      }
    }
  }

  function pump(): void {
    if (disposed) return;
    while (active < concurrency && queue.length > 0) {
      const job = queue.shift() as Job;
      const entry = entries.get(job.clipId);
      if (!entry || entry.token !== job.token || job.controller.signal.aborted) {
        job.cleanup();
        continue;
      }
      active += 1;
      running.set(job.id, job);
      void runJob(job).catch(() => undefined).finally(() => {
        active -= 1;
        running.delete(job.id);
        job.cleanup();
        pump();
        settleIdle();
      });
    }
    settleIdle();
  }

  function makeJob(clipId: string, token: number, mode: 'full' | 'refresh'): Job {
    const controller = new AbortController();
    const entry = entries.get(clipId);
    const selection = entry?.selectionAbort.signal;
    let onSelectionAbort: (() => void) | null = null;
    if (selection) {
      if (selection.aborted) controller.abort();
      else {
        onSelectionAbort = () => controller.abort();
        selection.addEventListener('abort', onSelectionAbort, { once: true });
      }
    }
    return {
      id: ++nextJobId,
      clipId,
      token,
      mode,
      controller,
      cleanup() {
        if (selection && onSelectionAbort) selection.removeEventListener('abort', onSelectionAbort);
      },
    };
  }

  function enqueue(clipId: string, token: number, mode: 'full' | 'refresh'): void {
    queue.push(makeJob(clipId, token, mode));
  }

  function scheduleFull(entry: Entry): void {
    enqueue(entry.state.clipId, entry.token, 'full');
  }

  function setShots(values: readonly TimelineShotInput[], setOptions: SetShotsOptions = {}): void {
    if (disposed) return;
    if (typeof setOptions.playheadFrame === 'number' && Number.isFinite(setOptions.playheadFrame)) {
      playheadFrame = Math.max(0, Math.floor(setOptions.playheadFrame));
    }
    const normalized = Array.isArray(values)
      ? values.map(normalizeShot).filter((shot): shot is TimelineHydrationShot => shot !== null)
      : [];
    normalized.sort((left, right) => left.from - right.from || left.clipId.localeCompare(right.clipId));

    const next = new Map<string, Entry>();
    const added: Entry[] = [];
    for (const shot of normalized) {
      const previous = entries.get(shot.clipId);
      if (
        previous
        && !previous.selectionAbort.signal.aborted
        && previous.state.selectedTakeId === shot.selectedTakeId
      ) {
        previous.state.sceneId = shot.sceneId;
        previous.state.assetId = shot.assetId;
        previous.state.kind = shot.kind;
        previous.state.from = shot.from;
        previous.state.durationInFrames = shot.durationInFrames;
        next.set(shot.clipId, previous);
        continue;
      }
      previous?.selectionAbort.abort();
      const entry: Entry = {
        state: {
          ...shot,
          status: 'pending',
          ticket: null,
          thumbnail: null,
          reason: null,
          distance: 0,
        },
        token: ++nextToken,
        selectionAbort: new AbortController(),
      };
      next.set(shot.clipId, entry);
      added.push(entry);
    }
    for (const [clipId, entry] of entries) {
      if (!next.has(clipId)) entry.selectionAbort.abort();
    }
    entries = next;
    revision = typeof setOptions.revision === 'number' && Number.isFinite(setOptions.revision)
      ? setOptions.revision
      : revision + 1;

    added.sort((left, right) => distanceOf(left.state) - distanceOf(right.state));
    for (const entry of added) scheduleFull(entry);
    emit();
    pump();
  }

  function seek(frame: number): void {
    if (disposed || !Number.isFinite(frame)) return;
    playheadFrame = Math.max(0, Math.floor(frame));
    const focus = currentAndNext();
    const keep = new Set<string>();
    for (const clipId of [focus.currentClipId, focus.nextClipId]) {
      if (clipId) keep.add(clipId);
    }
    for (const job of running.values()) {
      if (!keep.has(job.clipId)) job.controller.abort();
    }
    for (const clipId of [focus.currentClipId, focus.nextClipId]) {
      if (!clipId) continue;
      const entry = entries.get(clipId);
      if (!entry) continue;
      const ticket = entry.state.ticket;
      if (!ticket || ticketExpiryState(ticket, now(), renewBeforeMs) !== 'fresh') {
        enqueue(entry.state.clipId, entry.token, 'refresh');
      }
    }
    emit();
    pump();
  }

  function open(clipId: string): boolean {
    const entry = entries.get(text(clipId));
    if (!entry) return false;
    try {
      options.onOpen?.({ ...entry.state });
    } catch {
      // The opener is a view callback; the click still belongs to this shot.
    }
    return true;
  }

  return {
    setShots,
    seek,
    open,
    snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe requires a listener');
      listeners.add(listener);
      try {
        listener(snapshot());
      } catch {
        // Ignore a failing first paint.
      }
      return () => listeners.delete(listener);
    },
    idle() {
      if (disposed || (active === 0 && queue.length === 0)) return Promise.resolve();
      return new Promise<void>(resolve => {
        idleWaiters.push(resolve);
      });
    },
    cancel() {
      for (const job of running.values()) job.controller.abort();
      for (const job of queue) job.cleanup();
      queue = [];
      for (const entry of entries.values()) entry.selectionAbort.abort();
      pump();
      settleIdle();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const job of running.values()) job.controller.abort();
      for (const job of queue) job.cleanup();
      queue = [];
      for (const entry of entries.values()) entry.selectionAbort.abort();
      listeners.clear();
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    },
  };
}
