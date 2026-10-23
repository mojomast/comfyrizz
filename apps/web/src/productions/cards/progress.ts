// IP30: a per-shot progress strip whose statuses are honest.
//
// The strip is a view of durable production/take data, never a mutable status
// flag (architecture D6). Its eight statuses are the take system's clip states,
// and every one has visible text: colour or an icon alone is not a status.
//
// A missing or unrecognised state is reported as Unknown. It is never rounded
// up to Planned, Approved or any other reassuring status. Only an explicitly
// approved shot counts as finished.
//
// Announcements are throttled by a caller-injected clock so rapid status
// changes are coalesced instead of flooding a screen reader. The first change
// is announced immediately, later changes wait for the interval, and `flush()`
// releases the newest pending message when the UI goes quiet.

export const SHOT_STATUSES = Object.freeze([
  'planned',
  'queued',
  'generating',
  'review',
  'approved',
  'rejected',
  'failed',
  'stale',
] as const);

export type ShotStatus = (typeof SHOT_STATUSES)[number];

export type ShotStatusKey = ShotStatus | 'unknown';

/** The visible text for each status; every entry is distinct. */
export const SHOT_STATUS_TEXT: Readonly<Record<ShotStatus, string>> = Object.freeze({
  planned: 'Planned',
  queued: 'Queued',
  generating: 'Generating',
  review: 'Needs review',
  approved: 'Approved',
  rejected: 'Rejected',
  failed: 'Failed',
  stale: 'Stale',
});

export const SHOT_STATUS_LABELS = SHOT_STATUS_TEXT;

export const PROGRESS_ANNOUNCE_INTERVAL_MS = 5000;

const UNKNOWN_TEXT = 'Unknown';

const STATUS_MARK: Readonly<Record<ShotStatusKey, string>> = Object.freeze({
  planned: '·',
  queued: '…',
  generating: '▶',
  review: '◑',
  approved: '✓',
  rejected: '×',
  failed: '!',
  stale: '↻',
  unknown: '?',
});

export interface NormalizedShot {
  /** Stable shot id from the record, or an index-based fallback. */
  shotId: string;
  /** Human name to show and announce. Falls back to the shot id. */
  label: string;
  /** One of the eight statuses, or null when the record does not say. */
  status: ShotStatus | null;
  /** `unknown` is a distinct readout, not an eighth reassuring status. */
  statusKey: ShotStatusKey;
  statusText: string;
  /** Zero-based position in the input order. */
  index: number;
}

export interface ProgressCounts {
  planned: number;
  queued: number;
  generating: number;
  review: number;
  approved: number;
  rejected: number;
  failed: number;
  stale: number;
  unknown: number;
}

export interface ProgressSummary {
  shots: NormalizedShot[];
  total: number;
  counts: ProgressCounts;
  approved: number;
  done: number;
  remaining: number;
  isComplete: boolean;
  complete: boolean;
  text: string;
}

export interface ProgressCardOptions {
  /** Explicit card lifecycle state; otherwise inferred from the data/options. */
  state?: 'ready' | 'loading' | 'error' | 'stale' | 'empty';
  loading?: boolean;
  error?: string | null;
  stale?: boolean;
  title?: string;
  ariaLabel?: string;
  emptyText?: string;
  loadingText?: string;
  /** The throttled message to expose through the polite live region. */
  liveMessage?: string;
}

export type ProgressInput =
  | readonly unknown[]
  | { shots?: readonly unknown[]; shotIds?: readonly unknown[] }
  | null
  | undefined;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = textOf(value).trim();
    if (text !== '') return text;
  }
  return '';
}

export function normalizeStatus(value: unknown): ShotStatus | null {
  const key = textOf(value).trim().toLowerCase();
  return (SHOT_STATUSES as readonly string[]).includes(key) ? key as ShotStatus : null;
}

export function shotStatusLabel(status: unknown): string {
  const key = normalizeStatus(status);
  return key === null ? UNKNOWN_TEXT : SHOT_STATUS_TEXT[key];
}

function readInputShots(input: ProgressInput): readonly unknown[] {
  if (Array.isArray(input)) return input;
  if (isPlainObject(input)) {
    if (Array.isArray(input.shots)) return input.shots;
    if (Array.isArray(input.shotIds)) return input.shotIds;
  }
  return [];
}

function shotIdOf(value: unknown, index: number): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (isPlainObject(value)) {
    const explicit = firstText(value.shotId, value.id, value.sceneId);
    if (explicit !== '') return explicit;
  }
  return `shot-${index + 1}`;
}

function shotLabelOf(value: unknown, shotId: string, index: number): string {
  if (isPlainObject(value)) {
    const explicit = firstText(value.label, value.title, value.name);
    if (explicit !== '') return explicit;
  }
  if (/^shot-\d+$/.test(shotId)) return `Shot ${index + 1}`;
  return `Shot ${shotId}`;
}

function shotStatusOf(value: unknown): unknown {
  if (!isPlainObject(value)) return undefined;
  if (value.status !== undefined) return value.status;
  if (value.state !== undefined) return value.state;
  if (value.clipState !== undefined) return value.clipState;
  if (isPlainObject(value.clip) && value.clip.state !== undefined) return value.clip.state;
  if (isPlainObject(value.action) && value.action.state !== undefined) return value.action.state;
  return undefined;
}

/**
 * Normalise any accepted shot shape into the strip's stable view.
 *
 * Accepted inputs are an array of shot records (or ids), a `{shots}` object,
 * or a production-like `{shotIds}` object. A record may carry its status as
 * `status`, `state`, `clipState`, `clip.state` or `action.state`.
 */
export function normalizeShots(input: ProgressInput): NormalizedShot[] {
  return readInputShots(input).map((value, index) => {
    const shotId = shotIdOf(value, index);
    const status = normalizeStatus(shotStatusOf(value));
    return {
      shotId,
      label: shotLabelOf(value, shotId, index),
      status,
      statusKey: status ?? 'unknown',
      statusText: status === null ? UNKNOWN_TEXT : SHOT_STATUS_TEXT[status],
      index,
    };
  });
}

function emptyCounts(): ProgressCounts {
  return {
    planned: 0,
    queued: 0,
    generating: 0,
    review: 0,
    approved: 0,
    rejected: 0,
    failed: 0,
    stale: 0,
    unknown: 0,
  };
}

/** Count only `approved` as done; every other status remains outstanding. */
export function summarizeProgress(input: ProgressInput): ProgressSummary {
  const shots = normalizeShots(input);
  const counts = emptyCounts();
  for (const shot of shots) counts[shot.statusKey] += 1;
  const total = shots.length;
  const approved = counts.approved;
  const isComplete = total > 0 && approved === total;
  const text = total === 0
    ? 'No shots yet'
    : isComplete
      ? (total === 1 ? 'The shot is approved' : `All ${total} shots approved`)
      : `${approved} of ${total} shots approved`;
  return {
    shots,
    total,
    counts,
    approved,
    done: approved,
    remaining: total - approved,
    isComplete,
    complete: isComplete,
    text,
  };
}

export const progressSummary = summarizeProgress;

function attentionText(counts: ProgressCounts): string {
  const parts: string[] = [];
  if (counts.generating > 0) parts.push(`${counts.generating} generating`);
  if (counts.queued > 0) parts.push(`${counts.queued} queued`);
  if (counts.review > 0) parts.push(`${counts.review} need review`);
  if (counts.rejected > 0) parts.push(`${counts.rejected} rejected`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.stale > 0) parts.push(`${counts.stale} stale`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} unknown`);
  return parts.join(', ');
}

/**
 * The sentence a screen reader hears. When `changedIds` is given, the changed
 * shot names lead, followed by the honest overall count. Planned shots are not
 * called out as attention items because no work has started on them.
 */
export function progressAnnouncement(
  input: ProgressInput,
  changedIds: readonly string[] = [],
): string {
  const summary = summarizeProgress(input);
  if (summary.total === 0) return 'No shots yet.';

  const changed = new Set(changedIds);
  const changedShots = summary.shots.filter(shot => changed.has(shot.shotId));
  const changeText = changedShots.length > 0
    ? `${changedShots.slice(0, 2).map(shot => `${shot.label}: ${shot.statusText}`).join('; ')}${changedShots.length > 2 ? `; ${changedShots.length - 2} more changed` : ''}. `
    : '';
  const overall = `${summary.text}.`;
  const attention = attentionText(summary.counts);
  return `${changeText}${overall}${attention === '' ? '' : ` ${attention}.`}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

function renderShotRow(shot: NormalizedShot): string {
  return `<li class="shot-progress-item" data-shot-id="${escapeHtml(shot.shotId)}" data-status="${shot.statusKey}" data-shot-status-text="${escapeHtml(shot.statusText)}" aria-label="${escapeHtml(`${shot.label}: ${shot.statusText}`)}">
      <span class="shot-progress-mark" aria-hidden="true">${STATUS_MARK[shot.statusKey]}</span>
      <span class="shot-progress-label" data-shot-label>${escapeHtml(shot.label)}</span>
      <span class="shot-progress-status" data-shot-status>${escapeHtml(shot.statusText)}</span>
    </li>`;
}

/**
 * Pure HTML for the progress strip. The model never returns card HTML; this
 * renderer only formats snapshot data. Empty, loading, error and stale are
 * explicit states, and the polite live region is always present.
 */
export function renderProgressCard(
  input: ProgressInput,
  options: ProgressCardOptions = {},
): string {
  const summary = summarizeProgress(input);
  const error = textOf(options.error).trim();
  const state = options.state
    ?? (options.loading ? 'loading'
      : error !== '' ? 'error'
        : options.stale ? 'stale'
          : summary.total === 0 ? 'empty' : 'ready');
  const title = options.title ?? 'Shot progress';
  const ariaLabel = options.ariaLabel ?? title;
  const busy = state === 'loading' ? ' aria-busy="true"' : '';
  const summaryText = state === 'loading'
    ? 'Loading shot progress…'
    : state === 'error'
      ? 'Shot progress is unavailable'
      : summary.text;

  let body = '';
  if (state === 'loading') {
    body = `<p class="progress-loading" data-progress-loading>${escapeHtml(options.loadingText ?? 'Loading shot progress…')}</p>`;
  } else if (state === 'error') {
    body = `<p class="progress-error" role="alert" data-progress-error>${escapeHtml(error || 'Shot progress could not be read.')}</p>`;
  } else if (state === 'empty' || summary.total === 0) {
    body = `<p class="progress-empty" data-progress-empty>${escapeHtml(options.emptyText ?? 'No shots yet.')}</p>`;
  } else {
    body = `<ol class="shot-progress-strip" data-shot-progress-strip>
      ${summary.shots.map(renderShotRow).join('\n      ')}
    </ol>`;
  }

  const staleNotice = state === 'stale'
    ? '<p class="progress-stale" data-progress-stale role="status">Snapshot may be out of date. Reloading will refresh the shot statuses.</p>'
    : '';

  return `<section class="production-card production-progress" data-production-card="progress" data-card-state="${state}" aria-label="${escapeHtml(ariaLabel)}"${busy}>
    <header class="progress-head">
      <h2>${escapeHtml(title)}</h2>
      <p class="progress-summary" data-progress-summary>${escapeHtml(summaryText)}</p>
    </header>
    ${staleNotice}
    ${body}
    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-progress-live>${escapeHtml(options.liveMessage ?? '')}</p>
  </section>`;
}

export const progressCardHtml = renderProgressCard;
export const renderProgressStrip = renderProgressCard;
export const progressCard = renderProgressCard;

export interface ProgressAnnouncerOptions {
  intervalMs?: number;
  now?: () => number;
  onAnnounce?: (message: string) => void;
  /** Announce the first non-empty strip immediately (default true). */
  announceInitial?: boolean;
}

export interface ProgressAnnouncer {
  /** Observe a fresh strip; returns the message emitted now, or null. */
  update(input: ProgressInput, options?: { force?: boolean }): string | null;
  /** Emit a pending message when the throttle interval has elapsed. */
  tick(): string | null;
  /** Emit the newest pending message immediately. */
  flush(): string | null;
  /** The latest coalesced message waiting for the interval. */
  pending(): string | null;
  reset(): void;
  readonly lastMessage: string;
}

/**
 * A small leading-edge/trailing-edge throttle.
 *
 * The first non-empty update is announced at once. Changes inside the interval
 * replace one pending message, so a burst becomes one accurate sentence. The
 * next update (or `tick()`/`flush()`) after the interval emits the newest one.
 * The clock is injected so tests never depend on wall time.
 */
export function createProgressAnnouncer(
  options: ProgressAnnouncerOptions = {},
): ProgressAnnouncer {
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(0, Number(options.intervalMs))
    : PROGRESS_ANNOUNCE_INTERVAL_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const onAnnounce = typeof options.onAnnounce === 'function' ? options.onAnnounce : () => {};
  const announceInitial = options.announceInitial !== false;

  let baseline = new Map<string, ShotStatusKey>();
  let started = false;
  let lastEmitAt: number | null = null;
  let pendingMessage: string | null = null;
  let lastMessage = '';

  function changedIdsFor(shots: NormalizedShot[]): string[] {
    return shots
      .filter(shot => baseline.get(shot.shotId) !== shot.statusKey)
      .map(shot => shot.shotId);
  }

  function remember(shots: NormalizedShot[]): void {
    baseline = new Map(shots.map(shot => [shot.shotId, shot.statusKey]));
  }

  function currentTime(): number {
    const value = Number(now());
    return Number.isFinite(value) ? value : 0;
  }

  function due(at: number): boolean {
    return lastEmitAt === null || at < lastEmitAt || at - lastEmitAt >= intervalMs;
  }

  function emit(message: string, at: number): string {
    pendingMessage = null;
    lastEmitAt = at;
    lastMessage = message;
    onAnnounce(message);
    return message;
  }

  function update(input: ProgressInput, updateOptions: { force?: boolean } = {}): string | null {
    const shots = normalizeShots(input);
    if (shots.length === 0) {
      remember(shots);
      return null;
    }

    const changedIds = changedIdsFor(shots);
    const first = !started;
    if (changedIds.length === 0) {
      remember(shots);
      return null;
    }

    remember(shots);
    if (first && !announceInitial) {
      started = true;
      lastEmitAt = currentTime();
      return null;
    }

    const at = currentTime();
    const message = progressAnnouncement(shots, first ? [] : changedIds);
    started = true;
    if (updateOptions.force === true || due(at)) return emit(message, at);

    pendingMessage = message;
    return null;
  }

  function tick(): string | null {
    if (pendingMessage === null) return null;
    const at = currentTime();
    return due(at) ? emit(pendingMessage, at) : null;
  }

  function flush(): string | null {
    if (pendingMessage === null) return null;
    return emit(pendingMessage, currentTime());
  }

  function reset(): void {
    baseline = new Map();
    started = false;
    lastEmitAt = null;
    pendingMessage = null;
    lastMessage = '';
  }

  return Object.freeze({
    update,
    tick,
    flush,
    pending: () => pendingMessage,
    reset,
    get lastMessage() { return lastMessage; },
  });
}

export const createShotProgressAnnouncer = createProgressAnnouncer;
