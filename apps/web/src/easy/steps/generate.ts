// UR24: Step 5, Generate. A shot list, a preview slot, a counter and Stop.
//
// The view is honest about every durable shot status. A status is never
// rounded up: only review and approved count as ready. The step owns no
// generation loop; it reads the production snapshot and sends one explicit
// production.cancel through the shared progress-control builder.

import { COPY, fill } from '../copy.ts';
import { escapeHtml } from '../components.ts';
import { confirmDialog } from '../dialog.ts';
import { renderColabBanner } from '../colab-banner.ts';
import { loadSyncnetBanner } from '../syncnet-notice.ts';
import type { EasyState, EasyStepContext, EasyStepModule, StepFacts } from '../types.ts';
import {
  PROGRESS_ANNOUNCE_INTERVAL_MS,
  buildProgressControlCommand,
  createProgressAnnouncer,
  normalizeShots,
  normalizeStatus,
  readProgressControls,
  sendProgressControl,
  type NormalizedShot,
  type ProgressInput,
  type ShotStatus,
} from '../../productions/cards/progress.ts';

export type GenerateStatusKey = ShotStatus | 'waiting_gpu' | 'generatingUnknown' | 'unknown';

export const GENERATE_STATUS_ICONS: Readonly<Record<GenerateStatusKey, string>> = Object.freeze({
  planned: '◌',
  queued: '◌',
  waiting_gpu: '◌',
  generating: '◔',
  generatingUnknown: '◔',
  review: '✓',
  approved: '✓',
  rejected: '–',
  failed: '⚠',
  stale: '⚠',
  unknown: '?',
});

const UNKNOWN_STATUS_TEXT = 'Status unknown';

const READY_STATUSES = new Set<ShotStatus>(['review', 'approved']);
const RUNNING_STATUSES = new Set<ShotStatus>(['planned', 'queued', 'generating']);

export interface GenerateOptions {
  session?: unknown;
  usage?: unknown;
  colab?: unknown;
  sessionState?: unknown;
  startingSession?: unknown;
}

export interface GenerateShotView {
  shotId: string;
  label: string;
  status: ShotStatus | null;
  statusKey: GenerateStatusKey;
  statusText: string;
  icon: string;
  index: number;
}

export interface GenerateReadiness {
  ready: number;
  total: number;
  left: number;
  allReady: boolean;
}

export interface GeneratePrimary {
  label: string;
  disabled: boolean;
  reason: string | null;
  ready: number;
  total: number;
  left: number;
}

export interface GenerateViewOptions extends GenerateOptions {
  snapshot?: unknown;
  shots?: unknown;
  production?: unknown;
  teardown?: unknown;
  syncnetNotice?: string;
}

export interface TakeCounts {
  current: number;
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeText(value: unknown): string {
  return String(value ?? '').replace(/[&<>]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
  })[char] as string);
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function firstPositive(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = positiveInteger(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstNonNegative(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = nonNegativeInteger(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function rawShots(input: unknown): readonly unknown[] {
  if (Array.isArray(input)) return input;
  if (isRecord(input)) {
    if (Array.isArray(input.shots)) return input.shots;
    if (Array.isArray(input.shotIds)) return input.shotIds;
    if (isRecord(input.production)) {
      if (Array.isArray(input.production.shots)) return input.production.shots;
      if (Array.isArray(input.production.shotIds)) return input.production.shotIds;
    }
  }
  return [];
}

function snapshotInput(view: unknown): unknown {
  if (Array.isArray(view)) return view;
  if (!isRecord(view)) return { shots: [] };
  if (view.snapshot !== undefined) return view.snapshot;
  if (view.shots !== undefined || view.shotIds !== undefined) return view;
  if (isRecord(view.production)) {
    if (view.production.shots !== undefined || view.production.shotIds !== undefined) return view.production;
  }
  return { shots: [] };
}

/** The version count for a generating shot, or null when the record is silent. */
export function takeCountsFor(value: unknown): TakeCounts | null {
  if (!isRecord(value)) return null;
  let total = firstPositive(value, [
    'takeCount',
    'totalTakes',
    'takesTotal',
    'versionCount',
    'expectedTakes',
    'versionTotal',
    'takes',
    'takeTotal',
    'total',
    'count',
  ]);
  let done = firstNonNegative(value, [
    'completedTakes',
    'takesDone',
    'takesCompleted',
    'doneTakes',
    'versionsDone',
    'completedCount',
    'generatedTakes',
    'readyCount',
    'completed',
    'done',
  ]);

  if (Array.isArray(value.takes)) {
    total = total ?? positiveInteger(value.takes.length);
    done = done ?? value.takes.filter((entry) => {
      if (typeof entry === 'string') return READY_STATUSES.has(entry as ShotStatus);
      return isRecord(entry) && READY_STATUSES.has(normalizeStatus(entry.status) as ShotStatus);
    }).length;
  }
  if (Array.isArray(value.takeIds)) total = total ?? positiveInteger(value.takeIds.length);
  if (Array.isArray(value.completedTakeIds)) done = done ?? value.completedTakeIds.length;

  if (total === null) return null;
  const explicitCurrent = firstPositive(value, ['currentTake', 'takeNumber', 'makingTake', 'takeIndex']);
  const current = explicitCurrent ?? (done === null ? 1 : done + 1);
  return {
    current: Math.min(Math.max(current, 1), total),
    total,
  };
}

function startingSession(options: GenerateOptions): boolean {
  if (options.startingSession === true) return true;
  const candidates = [options.sessionState, options.session, options.usage, options.colab];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().toLowerCase() === 'starting') return true;
    if (isRecord(candidate)) {
      const state = String(candidate.state ?? candidate.status ?? '').trim().toLowerCase();
      if (state === 'starting' || state === 'allocating' || state === 'dispatching') return true;
      if (isRecord(candidate.session)) {
        const nested = String(candidate.session.state ?? candidate.session.status ?? '').trim().toLowerCase();
        if (nested === 'starting' || nested === 'allocating') return true;
      }
    }
  }
  return false;
}

export function generateStatusKey(
  status: unknown,
  raw: unknown = null,
  options: GenerateOptions = {},
): GenerateStatusKey {
  const shotStatus = typeof status === 'string'
    ? normalizeStatus(status)
    : (isRecord(status) ? normalizeStatus(status.status ?? status.state) : null);
  if (shotStatus === null) return 'unknown';
  if (shotStatus === 'queued' && startingSession(options)) return 'waiting_gpu';
  if (shotStatus === 'generating') {
    return takeCountsFor(raw ?? status) === null ? 'generatingUnknown' : 'generating';
  }
  return shotStatus;
}

function statusText(key: GenerateStatusKey, raw: unknown): string {
  if (key === 'waiting_gpu') return COPY.generate.status.waiting_gpu;
  if (key === 'generatingUnknown') return COPY.generate.status.generatingUnknown;
  if (key === 'unknown') return UNKNOWN_STATUS_TEXT;
  if (key === 'generating') {
    const counts = takeCountsFor(raw);
    if (counts !== null) return fill(COPY.generate.status.generating, { i: counts.current, count: counts.total });
    return COPY.generate.status.generatingUnknown;
  }
  return COPY.generate.status[key];
}

export function readGenerateShots(snapshot: unknown, options: GenerateOptions = {}): GenerateShotView[] {
  const normalized = normalizeShots(snapshot as ProgressInput);
  const raw = rawShots(snapshot);
  return normalized.map((shot: NormalizedShot, index: number) => {
    const record = raw[index] ?? shot;
    const statusKey = generateStatusKey(shot.status, record, options);
    return {
      shotId: shot.shotId,
      label: shot.label,
      status: shot.status,
      statusKey,
      statusText: statusText(statusKey, record),
      icon: GENERATE_STATUS_ICONS[statusKey],
      index,
    };
  });
}

export function generateReadiness(snapshot: unknown, options: GenerateOptions = {}): GenerateReadiness {
  const shots = readGenerateShots(snapshot, options);
  const ready = shots.filter((shot) => READY_STATUSES.has(shot.status as ShotStatus)).length;
  const left = shots.filter((shot) => RUNNING_STATUSES.has(shot.status as ShotStatus)).length;
  return {
    ready,
    total: shots.length,
    left,
    allReady: shots.length > 0 && ready === shots.length,
  };
}

export function generateCounter(snapshot: unknown): string {
  const readiness = generateReadiness(snapshot);
  return fill(COPY.generate.count, { ready: readiness.ready, total: readiness.total });
}

export function generatePrimary(snapshot: unknown, options: GenerateOptions = {}): GeneratePrimary {
  const readiness = generateReadiness(snapshot, options);
  const disabled = readiness.left > 0;
  return {
    label: COPY.generate.review,
    disabled,
    reason: disabled ? fill(COPY.generate.notReady, { left: readiness.left }) : null,
    ready: readiness.ready,
    total: readiness.total,
    left: readiness.left,
  };
}

function renderShotRow(shot: GenerateShotView): string {
  const retry = shot.status === 'failed' && shot.statusKey === 'failed'
    ? `<button type="button" class="btn btn-secondary btn-sm easy-generate-retry" data-easy-generate-retry="${escapeHtml(shot.shotId)}">${escapeHtml(COPY.generate.retry)}</button>`
    : '';
  return `<li class="easy-generate-shot" data-easy-generate-shot data-shot-id="${escapeHtml(shot.shotId)}" data-status="${shot.statusKey}" aria-label="${escapeHtml(`${shot.label}: ${shot.statusText}`)}">
<span class="easy-generate-shot-icon" aria-hidden="true">${shot.icon}</span>
<span class="easy-generate-shot-label">${escapeHtml(shot.label)}</span>
<span class="easy-generate-shot-status" data-easy-generate-status>${escapeText(shot.statusText)}</span>
${retry}
</li>`;
}

export function renderGenerateShots(snapshot: unknown, options: GenerateOptions = {}): string {
  const shots = readGenerateShots(snapshot, options);
  if (shots.length === 0) {
    return '<ol class="easy-generate-shots" data-easy-generate-shots></ol>';
  }
  return `<ol class="easy-generate-shots" data-easy-generate-shots>
${shots.map(renderShotRow).join('\n')}
</ol>`;
}

/** Pure HTML for the Generate step body. */
export function renderGenerate(
  state: Partial<EasyState> = {},
  _facts: Partial<StepFacts> = {},
  view: unknown = {},
): string {
  const options = isRecord(view) ? view as GenerateViewOptions : {};
  const input = snapshotInput(view);
  const shots = readGenerateShots(input, options);
  const readiness = generateReadiness(input, options);
  const counter = fill(COPY.generate.count, { ready: readiness.ready, total: readiness.total });
  const notReady = readiness.ready < readiness.total;
  const placeholder = notReady
    ? `<p class="easy-generate-placeholder" data-easy-generate-placeholder>${escapeHtml(COPY.generate.placeholder)}</p>`
    : '';
  const stopDisabled = state.generate?.status === 'stopping' ? ' disabled' : '';
  const cpu = state.compute === 'cpu'
    ? `<p class="easy-generate-cpu" data-easy-generate-cpu>${escapeHtml(state.generate?.status === 'done' ? COPY.generate.cpuReady : COPY.generate.cpuWorking)}</p>`
    : '';
  const notice = typeof options.syncnetNotice === 'string' ? options.syncnetNotice : '';
  return `<div class="easy-generate" data-easy-generate>
${notice}
<div class="easy-generate-grid easy-two-col">
<section class="easy-generate-list" aria-label="${escapeHtml(COPY.generate.heading)}">
<h2 class="easy-generate-subhead">${escapeHtml(COPY.generate.heading)}</h2>
${shots.length === 0 ? `<ol class="easy-generate-shots" data-easy-generate-shots></ol>` : renderGenerateShots(input, options)}
<p class="easy-generate-count" data-easy-generate-count>${escapeText(counter)}</p>
</section>
<section class="easy-generate-preview" data-easy-generate-preview aria-label="${escapeHtml(COPY.generate.placeholder)}">
<div class="easy-generate-player" data-easy-player></div>
${placeholder}
</section>
</div>
${cpu}
<p class="easy-generate-live sr-only" data-easy-generate-live role="status" aria-live="polite" aria-atomic="true"></p>
<div class="easy-generate-actions">
<button type="button" class="btn btn-danger" data-easy-generate-stop${stopDisabled}>${escapeHtml(COPY.generate.stop)}</button>
</div>
</div>`;
}

export interface GenerateAnnouncerOptions {
  intervalMs?: number;
  now?: () => number;
  onAnnounce?: (message: string) => void;
}

export interface GenerateAnnouncer {
  update(snapshot: unknown): string | null;
  tick(): string | null;
  flush(): string | null;
  reset(): void;
}

/** The counter is announced through the shared throttled progress announcer. */
export function createGenerateAnnouncer(options: GenerateAnnouncerOptions = {}): GenerateAnnouncer {
  let latest: unknown = { shots: [] };
  const announcer = createProgressAnnouncer({
    intervalMs: Number.isFinite(options.intervalMs) ? options.intervalMs : PROGRESS_ANNOUNCE_INTERVAL_MS,
    now: options.now,
    onAnnounce: () => {
      options.onAnnounce?.(generateCounter(latest));
    },
  });
  return {
    update(snapshot: unknown): string | null {
      latest = snapshot;
      return announcer.update(snapshot as ProgressInput);
    },
    tick: () => announcer.tick(),
    flush: () => announcer.flush(),
    reset(): void {
      latest = { shots: [] };
      announcer.reset();
    },
  };
}

const DEFAULT_FACTS: StepFacts = {
  hasPackage: false,
  planApproved: false,
  actionsActive: false,
  allShotsKept: false,
  exportCurrent: false,
};

function controlInput(snapshot: unknown): unknown {
  if (isRecord(snapshot) && snapshot.controls !== undefined) return snapshot;
  if (isRecord(snapshot) && isRecord(snapshot.production)) return snapshot;
  return snapshot;
}

export async function mountEasyGenerate(el: HTMLElement, ctx: EasyStepContext): Promise<() => void> {
  const doc = el.ownerDocument;
  let destroyed = false;
  let snapshot: unknown = (ctx.state as EasyState & { generateView?: unknown }).generateView ?? { shots: [] };
  let dismissed = false;
  let syncnetNotice = '';
  const announcer = createGenerateAnnouncer({
    onAnnounce: (message) => {
      const live = el.querySelector<HTMLElement>('[data-easy-generate-live]');
      if (live) live.textContent = message;
    },
  });
  const shellRoot = el.closest('[data-easy-shell]') ?? doc;

  function paintBanner(): void {
    if (destroyed) return;
    const colab = dismissed ? '' : renderColabBanner(
      isRecord(snapshot) ? snapshot.teardown ?? (isRecord(snapshot.production) ? snapshot.production.teardown : null) : null,
      isRecord(snapshot) ? snapshot.usage ?? snapshot.colab ?? snapshot.session : null,
    );
    ctx.shell.setBanner(`${syncnetNotice}${colab}`);
  }

  function paint(): void {
    if (destroyed) return;
    el.innerHTML = renderGenerate(ctx.store.get(), DEFAULT_FACTS, { snapshot, syncnetNotice });
    const primary = generatePrimary(snapshotInput(snapshot));
    ctx.shell.setPrimary({ label: primary.label, disabled: primary.disabled, reason: primary.reason });
    paintBanner();
    announcer.update(snapshotInput(snapshot));
  }

  async function refresh(): Promise<void> {
    const productionId = ctx.state.productionId;
    if (!productionId) return;
    try {
      const loaded = await ctx.api.getProduction(productionId);
      if (destroyed) return;
      snapshot = loaded;
      paint();
    } catch (error) {
      if (destroyed) return;
      ctx.shell.alert(error instanceof Error ? error.message : String(error));
    }
  }

  async function onStop(button: HTMLElement): Promise<void> {
    const ok = await confirmDialog({
      title: COPY.generate.stopTitle,
      text: COPY.generate.stopText,
      confirmLabel: COPY.generate.stopConfirm,
      cancelLabel: COPY.generate.keepGoing,
      opener: button,
    });
    if (!ok) return;
    const control = readProgressControls(controlInput(snapshot));
    const command = buildProgressControlCommand(control, 'cancel');
    if (command.ok === false) {
      ctx.shell.alert(command.error);
      return;
    }
    const productionId = ctx.state.productionId ?? control.productionId;
    if (!productionId) {
      ctx.shell.alert('The production is not ready yet.');
      return;
    }
    try {
      await sendProgressControl({
        sendCommand: (envelope) => ctx.api.sendCommand(productionId, envelope),
      }, command);
      if (destroyed) return;
      ctx.store.patch({ generate: { ...ctx.store.get().generate, status: 'stopping' } });
      paint();
    } catch (error) {
      ctx.shell.alert(error instanceof Error ? error.message : String(error));
    }
  }

  async function onClick(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const retry = target.closest<HTMLElement>('[data-easy-generate-retry]');
    if (retry) {
      const shotId = retry.getAttribute('data-easy-generate-retry');
      if (!shotId || !ctx.retryShot) return;
      try {
        await ctx.retryShot(shotId);
        await refresh();
      } catch (error) {
        ctx.shell.alert(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const stop = target.closest<HTMLElement>('[data-easy-generate-stop]');
    if (stop) await onStop(stop);
  }

  function onBannerClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('[data-easy-colab-dismiss]')) {
      dismissed = true;
      paintBanner();
      return;
    }
    if (target.closest('[data-easy-colab-open]')) ctx.host.openAgentSettings();
  }

  el.addEventListener('click', onClick);
  shellRoot.addEventListener('click', onBannerClick);
  paint();
  void loadSyncnetBanner(ctx).then((html) => {
    if (html === null || destroyed) return;
    syncnetNotice = html;
    paint();
  });
  void refresh();

  return () => {
    destroyed = true;
    el.removeEventListener('click', onClick);
    shellRoot.removeEventListener('click', onBannerClick);
  };
}

export const step: EasyStepModule = {
  id: 'generate',
  heading: COPY.generate.heading,
  intro: COPY.generate.intro,
  primaryLabel: () => COPY.generate.review,
  render(state: EasyState, facts: StepFacts): string {
    const view = (state as EasyState & { generateView?: unknown }).generateView ?? {};
    return renderGenerate(state, facts, view);
  },
  bind(el: HTMLElement, ctx: EasyStepContext): () => void {
    let cleanup: (() => void) | null = null;
    let stopped = false;
    void mountEasyGenerate(el, ctx).then((fn) => {
      if (stopped) fn();
      else cleanup = fn;
    });
    return () => {
      stopped = true;
      cleanup?.();
    };
  },
  onPrimary(ctx: EasyStepContext): void {
    ctx.go('review');
  },
};

export const renderEasyGenerate = renderGenerate;
export const renderGenerateView = renderGenerate;
export const mountGenerate = mountEasyGenerate;
