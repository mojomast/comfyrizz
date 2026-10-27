// Procedure capture formats: redaction, the journal document, WebVTT cues and
// ffmpeg chapter metadata.
//
// No imports on purpose: scripts/capture-procedure.mjs loads this file with
// --experimental-strip-types to assemble MP4s outside the browser.

export const PROCEDURE_FORMAT = 'comfyrizz.procedure/1';

export type ProcedureEntryKind =
  | 'start'
  | 'note'
  | 'prompt'
  | 'compute'
  | 'approval'
  | 'step'
  | 'stage'
  | 'google-colab'
  | 'preview'
  | 'result'
  | 'download'
  | 'failure'
  | 'stop';

export interface ProcedureEntry {
  /** Milliseconds since the capture started. */
  atMs: number;
  kind: ProcedureEntryKind;
  label: string;
}

export interface ProcedureDocument {
  format: typeof PROCEDURE_FORMAT;
  title: string;
  startedAt: string;
  durationMs: number;
  video: { fileName: string; mimeType: string } | null;
  videoUnavailable: string | null;
  entries: ProcedureEntry[];
}

const MAX_LABEL = 160;

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/data:[\w/+.-]+(?:;[\w=.-]+)*,[^\s"'<>]*/giu, '[data]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, '[link]'],
  [/#?\b(?:token|ticket|key|secret|password|auth|session)=[^\s&#"'<>]+/giu, '[redacted]'],
  [/\bx-comfyrizz-token\b\s*[:=]?\s*\S*/giu, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/gu, '[redacted]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/gu, '[redacted]'],
  [/\b(?:hf|ghp|gho|ghs|github_pat|xox[abpr]|glpat)_[A-Za-z0-9_-]{8,}/gu, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/gu, '[redacted]'],
  [/\be2e-[0-9a-f]{16,}/giu, '[redacted]'],
  [/\b[0-9a-f]{32,}\b/giu, '[redacted]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/gu, '[redacted]'],
  [/(?:[A-Za-z]:)?[\\/](?:home|Users)[\\/][^\s"'<>]+/gu, '[path]'],
  [/[\\/](?:tmp|private[\\/]var|var[\\/]folders)[\\/][^\s"'<>]+/gu, '[path]'],
];

/**
 * Strip anything credential-shaped from a journal line: links (media tickets
 * ride on them), tokens, API keys, long opaque strings and local paths. The
 * journal is meant to be shared, so it errs on the side of removing text.
 */
export function redactProcedureText(value: unknown, max = MAX_LABEL): string {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/gu, ' ').trim();
  if (text.length > max) text = `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  return text;
}

function pad(value: number, width = 2): string {
  return String(Math.trunc(value)).padStart(width, '0');
}

/** `HH:MM:SS.mmm`, the WebVTT timestamp form. */
export function vttTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(total % 1000, 3)}`;
}

const MIN_CUE_MS = 1500;

interface Span {
  startMs: number;
  endMs: number;
  label: string;
}

function spans(entries: readonly ProcedureEntry[], durationMs: number): Span[] {
  const sorted = entries
    .filter((entry) => Number.isFinite(entry.atMs) && entry.label !== '')
    .slice()
    .sort((left, right) => left.atMs - right.atMs);
  const end = Math.max(durationMs, ...sorted.map((entry) => entry.atMs + MIN_CUE_MS), 0);
  return sorted.map((entry, index) => {
    const next = sorted[index + 1];
    const startMs = Math.max(0, Math.round(entry.atMs));
    const until = next === undefined ? end : Math.max(next.atMs, startMs + 1);
    return { startMs, endMs: Math.max(startMs + 1, Math.round(until)), label: entry.label };
  });
}

/** One cue per journal entry, held until the next entry; editors read these as captions or markers. */
export function toWebVtt(doc: Pick<ProcedureDocument, 'entries' | 'durationMs'>): string {
  const cues = spans(doc.entries, doc.durationMs).map((span, index) => (
    `${index + 1}\n${vttTimestamp(span.startMs)} --> ${vttTimestamp(span.endMs)}\n${span.label.replace(/-->/gu, '→')}`
  ));
  return `WEBVTT\n\n${cues.join('\n\n')}${cues.length > 0 ? '\n' : ''}`;
}

function ffEscape(value: string): string {
  return value.replace(/[\\=;#\n]/gu, (char) => (char === '\n' ? ' ' : `\\${char}`));
}

/** ffmpeg FFMETADATA1 chapters, so the assembled MP4 has a chapter per procedure step. */
export function toFfmetadata(doc: Pick<ProcedureDocument, 'entries' | 'durationMs' | 'title'>): string {
  const lines = [';FFMETADATA1', `title=${ffEscape(doc.title)}`];
  for (const span of spans(doc.entries, doc.durationMs)) {
    lines.push('', '[CHAPTER]', 'TIMEBASE=1/1000', `START=${span.startMs}`, `END=${span.endMs}`, `title=${ffEscape(span.label)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** `comfyrizz-procedure-<slug>-<yyyymmdd-hhmmss>`; the slug comes from the redacted title. */
export function procedureBaseName(title: string, at: Date): string {
  const slug = redactProcedureText(title, 200)
    .toLowerCase()
    .replace(/\[[a-z]+\]/gu, ' ')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/u, '');
  const valid = Number.isFinite(at.getTime()) ? at : new Date(0);
  const stamp = `${valid.getFullYear()}${pad(valid.getMonth() + 1)}${pad(valid.getDate())}-${pad(valid.getHours())}${pad(valid.getMinutes())}${pad(valid.getSeconds())}`;
  return `comfyrizz-procedure-${slug === '' ? 'run' : slug}-${stamp}`;
}

/** Re-redact every label of a document read from disk before it is reused. */
export function sanitizeProcedureDocument(input: unknown): ProcedureDocument {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  const entries: ProcedureEntry[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const atMs = typeof entry.atMs === 'number' && Number.isFinite(entry.atMs) ? Math.max(0, entry.atMs) : null;
    const label = redactProcedureText(entry.label);
    if (atMs === null || label === '') continue;
    entries.push({ atMs, kind: (typeof entry.kind === 'string' ? entry.kind : 'note') as ProcedureEntryKind, label });
  }
  const durationMs = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? Math.max(0, record.durationMs) : 0;
  const video = record.video && typeof record.video === 'object' ? record.video as Record<string, unknown> : null;
  return {
    format: PROCEDURE_FORMAT,
    title: redactProcedureText(record.title) || 'Comfyrizz procedure',
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : new Date(0).toISOString(),
    durationMs,
    video: video && typeof video.fileName === 'string' && typeof video.mimeType === 'string'
      ? { fileName: redactProcedureText(video.fileName, 200), mimeType: video.mimeType }
      : null,
    videoUnavailable: typeof record.videoUnavailable === 'string' ? redactProcedureText(record.videoUnavailable) : null,
    entries,
  };
}
