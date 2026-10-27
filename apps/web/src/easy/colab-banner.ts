// UR24: the Google Colab session banner for the Easy shot list.
//
// The banner is a pure view of one explicit teardown record and one usage
// record. An unconfirmed stop always wins. No Google Colab session means no
// banner at all, never an optimistic "stopped" line.

import { COPY, fill } from './copy.ts';
import { escapeHtml } from './components.ts';

export const COLAB_BANNER_STATES = Object.freeze([
  'starting',
  'running',
  'collecting',
  'stopping',
  'stopped',
  'stop_unconfirmed',
] as const);

export type ColabBannerState = (typeof COLAB_BANNER_STATES)[number];
export type ColabBannerTone = 'info' | 'warn' | 'danger' | 'success';

export interface ColabTeardownLike {
  state?: unknown;
  status?: unknown;
  evidence?: unknown;
}

export interface ColabUsageLike {
  state?: unknown;
  status?: unknown;
  used?: unknown;
  usedUnits?: unknown;
  spent?: unknown;
  spentUnits?: unknown;
  unitsUsed?: unknown;
  cap?: unknown;
  ceiling?: unknown;
  spendCap?: unknown;
  capUnits?: unknown;
  active?: unknown;
  session?: unknown;
  colab?: unknown;
  runtime?: unknown;
}

const CAP_NOT_SET = 'not set';

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

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stateValue(value: unknown): string {
  if (!isRecord(value)) return '';
  const direct = textOf(value.state) || textOf(value.status);
  if (direct !== '') return direct;
  for (const key of ['session', 'colab', 'runtime', 'backend']) {
    const nested = value[key];
    if (isRecord(nested)) {
      const nestedState = textOf(nested.state) || textOf(nested.status);
      if (nestedState !== '') return nestedState;
    }
  }
  return '';
}

function normalizeState(value: string): ColabBannerState | null {
  switch (value.toLowerCase()) {
    case 'starting':
    case 'allocating':
    case 'pending':
    case 'queued':
    case 'dispatching':
      return 'starting';
    case 'running':
    case 'active':
    case 'ready':
      return 'running';
    case 'collecting':
      return 'collecting';
    case 'stopping':
    case 'cancelling':
    case 'cancel_requested':
      return 'stopping';
    case 'stopped':
      return 'stopped';
    case 'stop_unconfirmed':
    case 'shutdown_unconfirmed':
      return 'stop_unconfirmed';
    default:
      return null;
  }
}

function amountOf(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = textOf(value);
  return text;
}

function firstAmount(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const text = amountOf(source[key]);
    if (text !== '') return text;
  }
  return '';
}

function usageOf(usage: unknown): Record<string, unknown> {
  return isRecord(usage) ? usage : {};
}

function resolvedState(teardown: unknown, usage: unknown): ColabBannerState | null {
  const teardownState = normalizeState(stateValue(teardown));
  const usageState = normalizeState(stateValue(usage));
  if (teardownState === 'stop_unconfirmed' || usageState === 'stop_unconfirmed') return 'stop_unconfirmed';
  if (usageState !== null) return usageState;
  if (teardownState !== null) return teardownState;
  return null;
}

function hasSession(usage: unknown, teardown: unknown): boolean {
  if (resolvedState(teardown, usage) === 'stop_unconfirmed') return true;
  if (isRecord(usage) && usage.active === false) return false;
  if (isRecord(usage)) {
    for (const key of ['session', 'colab']) {
      const nested = usage[key];
      if (isRecord(nested) && nested.active === false) return false;
    }
  }
  return resolvedState(teardown, usage) !== null;
}

interface BannerLine {
  state: ColabBannerState;
  tone: ColabBannerTone;
  text: string;
}

function bannerLine(state: ColabBannerState, usage: unknown): BannerLine {
  if (state === 'running') {
    const source = usageOf(usage);
    const nested = isRecord(source.session) ? source.session : (isRecord(source.colab) ? source.colab : null);
    const used = firstAmount(source, ['used', 'usedUnits', 'spent', 'spentUnits', 'unitsUsed'])
      || (nested === null ? '' : firstAmount(nested, ['used', 'usedUnits', 'spent', 'spentUnits', 'unitsUsed']));
    const cap = firstAmount(source, ['cap', 'ceiling', 'spendCap', 'capUnits'])
      || (nested === null ? '' : firstAmount(nested, ['cap', 'ceiling', 'spendCap', 'capUnits']));
    return {
      state,
      tone: 'info',
      text: fill(COPY.colab.running, {
        used: used === '' ? '0' : used,
        cap: cap === '' ? CAP_NOT_SET : cap,
      }),
    };
  }
  if (state === 'starting') return { state, tone: 'info', text: COPY.colab.starting };
  if (state === 'collecting') return { state, tone: 'info', text: COPY.colab.collecting };
  if (state === 'stopping') return { state, tone: 'warn', text: COPY.colab.stopping };
  if (state === 'stopped') return { state, tone: 'success', text: COPY.colab.stopped };
  return { state, tone: 'danger', text: COPY.colab.stopUnconfirmed };
}

function actionButton(
  label: string,
  dataName: string,
  kind: 'secondary' | 'link',
): string {
  return `<button type="button" class="btn ${kind === 'link' ? 'btn-ghost easy-button-link' : 'btn-secondary'}" data-${dataName}>${escapeHtml(label)}</button>`;
}

/** The banner's state and sentence without markup, or null when there is no session. */
export function colabBannerLine(teardown: unknown, usage: unknown): { state: ColabBannerState; text: string } | null {
  if (!hasSession(usage, teardown)) return null;
  const state = resolvedState(teardown, usage);
  if (state === null) return null;
  const line = bannerLine(state, usage);
  return { state: line.state, text: line.text };
}

/**
 * Pure HTML for the Google Colab banner. `teardown` is the explicit teardown
 * record and `usage` is the session usage record. An unconfirmed stop stays
 * an alert and offers both dismissal and a way into Google Colab settings.
 */
export function renderColabBanner(teardown: unknown, usage: unknown): string {
  if (!hasSession(usage, teardown)) return '';
  const state = resolvedState(teardown, usage);
  if (state === null) return '';
  const line = bannerLine(state, usage);
  const alert = line.state === 'stop_unconfirmed';
  const role = alert ? 'alert' : 'status';
  const live = alert ? 'assertive' : 'polite';
  const actions = alert
    ? `<div class="easy-banner-actions">${actionButton(COPY.colab.dismiss, 'easy-colab-dismiss', 'secondary')}${actionButton(COPY.colab.open, 'easy-colab-open', 'link')}</div>`
    : '';
  return `<div class="easy-banner easy-banner-${line.tone} easy-colab-banner" role="${role}" aria-live="${live}" data-easy-colab-banner data-easy-colab-state="${line.state}">
<p class="easy-banner-text">${escapeText(line.text)}</p>
${actions}
</div>`;
}

export const colabBannerHtml = renderColabBanner;
export const renderEasyColabBanner = renderColabBanner;
