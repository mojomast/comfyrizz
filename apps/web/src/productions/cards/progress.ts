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

// IP33: pause, resume and cancel controls, plus an honest teardown readout.
//
// These functions are a view of durable production records, not a second state
// store. `production.intent` is the only durable production status and it is
// exactly one of the four contract values. A journal event may override the
// snapshot only when the event is newer than the snapshot it was read with.
//
// Teardown is never inferred from a status-shaped field. It comes from exactly
// one explicit backend teardown record supplied as an option, and from a
// pending action whose pipeline status is `shutdown_unconfirmed`. An
// unconfirmed shutdown always wins over a stopped record.

export const PROGRESS_INTENTS = Object.freeze([
  'active',
  'paused',
  'cancel_requested',
  'archived',
] as const);

export type ProgressIntent = (typeof PROGRESS_INTENTS)[number] | 'unknown';

export const PROGRESS_INTENT_TEXT: Readonly<Record<ProgressIntent, string>> = Object.freeze({
  active: 'Active',
  paused: 'Paused',
  cancel_requested: 'Cancelling',
  archived: 'Archived',
  unknown: 'Unknown',
});

export const PROGRESS_CONTROL_NAMES = Object.freeze(['pause', 'resume', 'cancel'] as const);
export type ProgressControlName = (typeof PROGRESS_CONTROL_NAMES)[number];

/** The one closed command vocabulary this card can produce. */
export const PROGRESS_COMMANDS = Object.freeze({
  pause: 'production.pause',
  resume: 'production.resume',
  cancel: 'production.cancel',
} as const);

export type ProgressCommandKind = (typeof PROGRESS_COMMANDS)[ProgressControlName];

export type ProgressTeardownState = 'stopped' | 'not_owned' | 'shutdown_unconfirmed';

export interface ProgressTeardown {
  state: ProgressTeardownState;
  evidence: string | null;
  text: string;
}

export interface ProgressControlState {
  enabled: boolean;
  reason: string | null;
}

export interface ProgressControlsCard {
  productionId: string | null;
  revision: number | null;
  intent: ProgressIntent;
  intentText: string;
  stale: boolean;
  controls: Record<ProgressControlName, ProgressControlState>;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  teardown: ProgressTeardown | null;
  remainingWork: number;
  collectedTakeIds: string[];
}

export interface ProgressControlsInput {
  production?: unknown;
  revision?: unknown;
  lastSequence?: unknown;
  events?: unknown;
  pendingActions?: unknown;
  collectedTakeIds?: unknown;
  stale?: unknown;
  gap?: unknown;
}

export interface ProgressControlsOptions {
  /** The backend teardown record: {state, evidence?}. No other source is read. */
  teardown?: unknown;
}

export interface ProgressControlContext {
  commandId?: string;
  idempotencyKey?: string;
  baseRevision?: number;
  /** The originating user event; attribution itself stays server-owned. */
  userEventId?: string;
}

export interface ProgressControlCommand {
  commandId: string;
  idempotencyKey: string;
  kind: ProgressCommandKind;
  productionId: string;
  expected: { productionRevision: number };
  payload: Record<string, never>;
}

export type ProgressControlErrorCode =
  | 'NOT_READY'
  | 'STALE_VIEW'
  | 'REVISION_MISMATCH'
  | 'NOT_AVAILABLE'
  | 'INVALID_CONTEXT';

export interface ProgressControlSuccess {
  ok: true;
  command: ProgressControlCommand;
  card: ProgressControlsCard;
  /** Echo of the caller's user event; attribution is still server-owned. */
  citation: string | null;
}

export interface ProgressControlFailure {
  ok: false;
  code: ProgressControlErrorCode;
  error: string;
}

export type ProgressControlResult = ProgressControlSuccess | ProgressControlFailure;

export interface ProgressControlClient {
  sendCommand: (envelope: unknown) => Promise<unknown> | unknown;
}

const TERMINAL_ACTION_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'submission_unknown',
]);

const INTENT_EVENT_TYPES = new Set([
  'production.intent_changed',
  'production.cancelled',
]);

const TEARDOWN_TEXT: Readonly<Record<ProgressTeardownState, string>> = Object.freeze({
  stopped: 'Compute teardown confirmed.',
  not_owned: 'Compute was not owned by this production.',
  shutdown_unconfirmed: 'Compute shutdown unconfirmed.',
});

const NOT_READY_REASON = 'Wait for the production snapshot before changing the production.';
const STALE_REASON = 'This card is behind the event journal. Refresh before changing the production.';

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function normalizeIntent(value: unknown): ProgressIntent {
  const key = textOf(value).trim();
  return (PROGRESS_INTENTS as readonly string[]).includes(key) ? key as ProgressIntent : 'unknown';
}

function normalizeTeardown(value: unknown): ProgressTeardown | null {
  if (!isPlainObject(value)) return null;
  const state = textOf(value.state).trim();
  let normalized: ProgressTeardownState;
  if (state === 'stopped') normalized = 'stopped';
  else if (state === 'not_owned') normalized = 'not_owned';
  else if (state === 'stop_unconfirmed' || state === 'shutdown_unconfirmed') normalized = 'shutdown_unconfirmed';
  else return null;

  const evidence = typeof value.evidence === 'string' && value.evidence.trim() !== ''
    ? value.evidence
    : null;
  return { state: normalized, evidence, text: TEARDOWN_TEXT[normalized] };
}

function pendingShutdownUnconfirmed(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(action => isPlainObject(action) && action.status === 'shutdown_unconfirmed');
}

function controlState(enabled: boolean, reason: string | null): ProgressControlState {
  return { enabled, reason: enabled ? null : reason };
}

function disabledReason(
  requested: ProgressControlName,
  intent: ProgressIntent,
  baseReason: string | null,
): string | null {
  if (baseReason !== null) return baseReason;
  if (requested === 'pause') {
    return intent === 'active' ? null : 'Only an active production can be paused.';
  }
  if (requested === 'resume') {
    return intent === 'paused' ? null : 'Only a paused production can be resumed.';
  }
  if (intent === 'cancel_requested') return 'Cancellation is already requested.';
  if (intent === 'archived') return 'An archived production cannot be cancelled.';
  return null;
}

/**
 * Read the controls from an IP28 production state. The snapshot's intent is
 * the truth at its revision; only a strictly newer intent event may override
 * it. Missing revisions and unknown intents are NOT_READY and disable every
 * control rather than assuming revision zero or an active production.
 */
export function readProgressControls(
  input: unknown,
  options: ProgressControlsOptions = {},
): ProgressControlsCard {
  const source = isPlainObject(input) ? input : null;
  const production = source !== null && isPlainObject(source.production) ? source.production : null;
  const optionValues = isPlainObject(options) ? options : {};

  const productionId = production !== null && textOf(production.id).trim() !== ''
    ? textOf(production.id).trim()
    : null;
  const revision = nonNegativeInteger(source?.revision)
    ?? nonNegativeInteger(production?.revision);
  const lastSequence = nonNegativeInteger(source?.lastSequence)
    ?? nonNegativeInteger(production?.lastSequence);

  let intent: ProgressIntent = production === null || revision === null
    ? 'unknown'
    : normalizeIntent(production.intent);
  if (revision !== null && lastSequence !== null && Array.isArray(source?.events)) {
    let overriddenAt = -1;
    let overriddenIntent: ProgressIntent | null = null;
    for (const event of source.events) {
      if (!isPlainObject(event)) continue;
      if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) <= lastSequence) continue;
      if (typeof event.type !== 'string' || !INTENT_EVENT_TYPES.has(event.type)) continue;
      if (!isPlainObject(event.data) || !Object.prototype.hasOwnProperty.call(event.data, 'intent')) continue;
      if ((event.sequence as number) < overriddenAt) continue;
      overriddenAt = event.sequence as number;
      overriddenIntent = normalizeIntent(event.data.intent);
    }
    if (overriddenIntent !== null) intent = overriddenIntent;
  }

  const stale = source?.stale === true || source?.gap === true;
  const ready = productionId !== null && revision !== null && intent !== 'unknown';
  const baseReason = stale ? STALE_REASON : ready ? null : NOT_READY_REASON;

  const active = intent === 'active';
  const paused = intent === 'paused';
  const controls: Record<ProgressControlName, ProgressControlState> = {
    pause: controlState(
      !stale && ready && active,
      disabledReason('pause', intent, baseReason),
    ),
    resume: controlState(
      !stale && ready && paused,
      disabledReason('resume', intent, baseReason),
    ),
    cancel: controlState(
      !stale && ready && (active || paused),
      disabledReason('cancel', intent, baseReason),
    ),
  };

  let teardown = normalizeTeardown(optionValues.teardown);
  if (pendingShutdownUnconfirmed(source?.pendingActions)) {
    teardown = {
      state: 'shutdown_unconfirmed',
      evidence: teardown?.state === 'shutdown_unconfirmed' ? teardown.evidence : null,
      text: TEARDOWN_TEXT.shutdown_unconfirmed,
    };
  }

  const pendingActions = Array.isArray(source?.pendingActions) ? source.pendingActions : [];
  const remainingWork = pendingActions.filter((action) => {
    if (!isPlainObject(action)) return false;
    return !TERMINAL_ACTION_STATES.has(textOf(action.state).trim());
  }).length;

  const collectedTakeIds = Array.isArray(source?.collectedTakeIds)
    ? source.collectedTakeIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    : [];

  return {
    productionId,
    revision,
    intent,
    intentText: PROGRESS_INTENT_TEXT[intent],
    stale,
    controls,
    canPause: controls.pause.enabled,
    canResume: controls.resume.enabled,
    canCancel: controls.cancel.enabled,
    teardown,
    remainingWork,
    collectedTakeIds,
  };
}

function isCommandId(value: string): boolean {
  return value !== '' && value.length <= 256 && /^[^\s/\\\u0000-\u001f]+$/u.test(value);
}

function stableProgressHash(value: unknown): string {
  const source = (function stableJson(entry: unknown): string {
    if (entry === null || typeof entry !== 'object') return JSON.stringify(entry);
    if (Array.isArray(entry)) {
      return `[${entry.map((item) => (item === undefined ? 'null' : stableJson(item))).join(',')}]`;
    }
    const object = entry as Record<string, unknown>;
    const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  })(value);
  let high = 0x811c9dc5;
  let low = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    low = Math.imul(low ^ code, 0x85ebca6b) >>> 0;
  }
  return `fnv1a64:${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

function failure(code: ProgressControlErrorCode, error: string): ProgressControlFailure {
  return { ok: false, code, error };
}

/**
 * Build one pause, resume or cancel command for the exact snapshot the card
 * shows. Refusals happen before a command exists, so a stale or unavailable
 * control never becomes a write.
 */
export function buildProgressControlCommand(
  card: ProgressControlsCard,
  name: ProgressControlName,
  context: ProgressControlContext = {},
): ProgressControlResult {
  if (!isPlainObject(card)) {
    return failure('NOT_READY', NOT_READY_REASON);
  }
  if (card.productionId === null || card.productionId === '' || card.revision === null || card.intent === 'unknown') {
    return failure('NOT_READY', NOT_READY_REASON);
  }
  if (card.stale) {
    return failure('STALE_VIEW', STALE_REASON);
  }
  if (!(PROGRESS_CONTROL_NAMES as readonly string[]).includes(name)) {
    return failure('NOT_AVAILABLE', 'That production control does not exist.');
  }
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return failure('INVALID_CONTEXT', 'The control context must be an object.');
  }

  const baseRevision = context.baseRevision === undefined ? card.revision : context.baseRevision;
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    return failure('INVALID_CONTEXT', 'baseRevision must be a non-negative integer.');
  }
  if (baseRevision !== card.revision) {
    return failure('REVISION_MISMATCH', 'baseRevision does not match the revision this card was read from.');
  }
  if (context.commandId !== undefined && !isCommandId(context.commandId)) {
    return failure('INVALID_CONTEXT', 'commandId is not a valid command identifier.');
  }
  if (context.idempotencyKey !== undefined && !isCommandId(context.idempotencyKey)) {
    return failure('INVALID_CONTEXT', 'idempotencyKey is not a valid idempotency key.');
  }

  const control = card.controls[name];
  if (!control || !control.enabled) {
    return failure('NOT_AVAILABLE', control?.reason ?? 'That production control is not available.');
  }

  const kind = PROGRESS_COMMANDS[name];
  const digest = stableProgressHash({
    productionId: card.productionId,
    revision: card.revision,
    kind,
  }).replace(/^fnv1a64:/, '');
  const commandId = context.commandId ?? `cmd_progress_${name}_${digest}`;
  const idempotencyKey = context.idempotencyKey ?? commandId;

  return {
    ok: true,
    command: {
      commandId,
      idempotencyKey,
      kind,
      productionId: card.productionId,
      expected: { productionRevision: card.revision },
      payload: {},
    },
    card,
    citation: context.userEventId ?? null,
  };
}

/**
 * Send one accepted control through an IP28 production client. A refused
 * control never reaches the client, so an unavailable action cannot be sent.
 */
export async function sendProgressControl(
  client: ProgressControlClient,
  result: ProgressControlResult,
): Promise<unknown> {
  if (result.ok === false) {
    throw new Error(`${result.code}: ${result.error}`);
  }
  if (!client || typeof client.sendCommand !== 'function') {
    throw new TypeError('sendProgressControl requires a production client');
  }
  return client.sendCommand(result.command);
}

function renderControl(
  name: ProgressControlName,
  label: string,
  description: string,
  state: ProgressControlState,
): string {
  const disabled = state.enabled ? '' : ' disabled';
  return `<button type="button" class="btn ${name === 'cancel' ? 'btn-danger' : 'btn-secondary'}" data-progress-control="${name}" data-progress-command="${PROGRESS_COMMANDS[name]}" aria-label="${escapeHtml(description)}"${disabled}>${escapeHtml(label)}</button>`;
}

function remainingWorkText(count: number): string {
  if (count === 0) return 'No actions still active.';
  return `${count} action${count === 1 ? '' : 's'} still active.`;
}

/** Pure HTML for the controls. Every durable value is escaped. */
export function renderProgressControls(card: ProgressControlsCard): string {
  if (!isPlainObject(card)) card = readProgressControls(null);

  const productionId = card.productionId ?? '';
  const attributes = [
    'class="production-card production-progress-controls"',
    'data-production-card="progress-controls"',
    'data-progress-controls',
    `data-production-id="${escapeHtml(productionId)}"`,
    `data-progress-intent="${card.intent}"`,
    `data-revision="${card.revision ?? ''}"`,
    `data-progress-stale="${card.stale ? 'true' : 'false'}"`,
    `data-progress-remaining-work="${card.remainingWork}"`,
    `aria-label="Production controls"`,
  ].join(' ');

  const teardown = card.teardown === null
    ? ''
    : `<p class="progress-teardown" data-progress-teardown="${card.teardown.state}" data-progress-teardown-state="${card.teardown.state}" role="status">
      <span data-progress-teardown-text>${escapeHtml(card.teardown.text)}</span>${card.teardown.evidence === null ? '' : ` <span data-progress-teardown-evidence>Evidence: ${escapeHtml(card.teardown.evidence)}</span>`}
    </p>`;

  const collected = card.collectedTakeIds.length === 0
    ? ''
    : `<ol class="progress-collected-takes" data-progress-collected-takes>${card.collectedTakeIds.map((id) => `<li data-collected-take-id="${escapeHtml(id)}">${escapeHtml(id)}</li>`).join('')}</ol>`;

  return `<section ${attributes}>
    <header class="progress-controls-head">
      <h2>Production controls</h2>
      <span class="progress-controls-intent" data-progress-intent-label>${escapeHtml(card.intentText)}</span>
    </header>
    <p class="progress-remaining-work" data-progress-remaining-work>${escapeHtml(remainingWorkText(card.remainingWork))}</p>
    ${teardown}
    <p class="progress-collected-copy" data-progress-collected-copy>Collected takes are kept if you cancel.</p>
    ${collected}
    <div class="progress-control-buttons">
      ${renderControl('pause', 'Pause', 'Pause this production', card.controls.pause)}
      ${renderControl('resume', 'Resume', 'Resume this production', card.controls.resume)}
      ${renderControl('cancel', 'Cancel production', 'Cancel this production but keep collected takes', card.controls.cancel)}
    </div>
  </section>`;
}
