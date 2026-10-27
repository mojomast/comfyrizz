// The procedure journal: a timestamped list of what happened during one
// Generate, built from the same production snapshots the stage gauges read.
//
// Pure apart from the injected clock. Only status changes are logged, never
// gauge fractions, and every label goes through redaction before it is kept.

import { readStages, type StageId, type StageStatus } from '../super-easy/stages.ts';
import { buildGalleryModel } from '../super-easy/gallery-model.ts';
import { hasFinalArtifact } from '../super-easy/progress-view.ts';
import { colabBannerLine } from '../colab-banner.ts';
import {
  PROCEDURE_FORMAT,
  redactProcedureText,
  type ProcedureDocument,
  type ProcedureEntry,
  type ProcedureEntryKind,
} from './format.ts';
import { PROCEDURE_COPY } from './copy.ts';

export interface ProcedureJournalOptions {
  /** Monotonic milliseconds; defaults to `performance.now()`. */
  now?: () => number;
  /** Wall clock for `startedAt`; defaults to `new Date()`. */
  wallClock?: () => Date;
}

export interface ProcedureObservation {
  /** Kept when the snapshot has a final video; the journal never stores its URL. */
  finalReady: boolean;
  failed: boolean;
}

export interface ProcedureJournal {
  start(title: string): void;
  mark(kind: ProcedureEntryKind, label: string): ProcedureEntry | null;
  observe(snapshot: unknown): ProcedureObservation;
  entries(): ProcedureEntry[];
  latest(): ProcedureEntry | null;
  elapsedMs(): number;
  startedAt(): Date | null;
  document(video: ProcedureDocument['video'], videoUnavailable: string | null): ProcedureDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function defaultNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

function colabRecords(snapshot: unknown): { teardown: unknown; usage: unknown } {
  if (!isRecord(snapshot)) return { teardown: null, usage: null };
  const production = isRecord(snapshot.production) ? snapshot.production : null;
  return {
    teardown: snapshot.teardown ?? production?.teardown ?? null,
    usage: snapshot.usage ?? snapshot.colab ?? snapshot.session ?? production?.usage ?? null,
  };
}

export function stageLabel(label: string, status: StageStatus, error: string | null): string {
  const text = PROCEDURE_COPY.stageStatus[status];
  return error ? `${label}: ${text} (${error})` : `${label}: ${text}`;
}

export function createProcedureJournal(options: ProcedureJournalOptions = {}): ProcedureJournal {
  const now = options.now ?? defaultNow;
  const wallClock = options.wallClock ?? (() => new Date());
  let origin: number | null = null;
  let started: Date | null = null;
  let title = '';
  let list: ProcedureEntry[] = [];
  let stageStatus = new Map<StageId, StageStatus>();
  let colabState: string | null = null;
  let finalLogged = false;

  function elapsedMs(): number {
    return origin === null ? 0 : Math.max(0, Math.round(now() - origin));
  }

  function mark(kind: ProcedureEntryKind, label: string): ProcedureEntry | null {
    if (origin === null) return null;
    const text = redactProcedureText(label);
    if (text === '') return null;
    const entry: ProcedureEntry = { atMs: elapsedMs(), kind, label: text };
    list.push(entry);
    return entry;
  }

  function start(nextTitle: string): void {
    origin = now();
    started = wallClock();
    title = redactProcedureText(nextTitle) || PROCEDURE_COPY.defaultTitle;
    list = [];
    stageStatus = new Map();
    colabState = null;
    finalLogged = false;
    mark('start', PROCEDURE_COPY.started);
  }

  function observe(snapshot: unknown): ProcedureObservation {
    if (origin === null || snapshot === null || snapshot === undefined) return { finalReady: finalLogged, failed: false };
    const stages = readStages(snapshot);
    const finalReady = hasFinalArtifact(buildGalleryModel(snapshot));
    let failed = false;
    for (const stage of stages.stages) {
      // A delivery id without a playable URL is not a finished video.
      const status: StageStatus = stage.id === 'render' && stage.status === 'done' && !finalReady ? 'running' : stage.status;
      if (status === 'error') failed = true;
      const previous = stageStatus.get(stage.id) ?? 'waiting';
      if (previous === status) continue;
      stageStatus.set(stage.id, status);
      mark('stage', stageLabel(stage.label, status, stage.error));
    }
    const { teardown, usage } = colabRecords(snapshot);
    const colab = colabBannerLine(teardown, usage);
    if (colab !== null && colab.state !== colabState) {
      colabState = colab.state;
      mark('google-colab', colab.text);
    }
    if (finalReady && !finalLogged) {
      finalLogged = true;
      mark('result', PROCEDURE_COPY.finalReady);
    }
    return { finalReady, failed };
  }

  function document(video: ProcedureDocument['video'], videoUnavailable: string | null): ProcedureDocument {
    return {
      format: PROCEDURE_FORMAT,
      title: title || PROCEDURE_COPY.defaultTitle,
      startedAt: (started ?? wallClock()).toISOString(),
      durationMs: elapsedMs(),
      video,
      videoUnavailable: videoUnavailable === null ? null : redactProcedureText(videoUnavailable),
      entries: list.map((entry) => ({ ...entry })),
    };
  }

  return {
    start,
    mark,
    observe,
    entries: () => list.map((entry) => ({ ...entry })),
    latest: () => (list.length === 0 ? null : { ...list[list.length - 1] }),
    elapsedMs,
    startedAt: () => started,
    document,
  };
}
