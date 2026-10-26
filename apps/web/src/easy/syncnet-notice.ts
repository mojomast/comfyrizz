// The lip-sync check is optional. When it is not configured, Easy Studio
// shows this warning before Generate and Export instead of skipping in silence.
// Dismissal lasts for the page session only; it is never saved as a preference.

import { COPY } from './copy.ts';
import { renderBanner } from './components.ts';

export const SYNCNET_SKIP_CODES = new Set(['SYNCNET_UNAVAILABLE', 'SYNCNET_SKIPPED']);

export interface SyncnetWarning {
  code: string;
  message: string;
}

export interface SyncnetNoticeSession {
  dismissed: boolean;
}

interface SyncnetHost {
  getPackage(): unknown;
}

interface SyncnetApi {
  pipelineDiagnostics?: () => Promise<unknown>;
}

interface SyncnetLoadContext {
  host: SyncnetHost;
  api: SyncnetApi;
  notice?: SyncnetNoticeSession;
}

const DEFAULT_SESSION: SyncnetNoticeSession = { dismissed: false };
const DISMISS_ATTRIBUTE = 'data-easy-syncnet-dismissed';
const DISMISS_SELECTOR = '[data-easy-syncnet-dismiss]';
const STYLE_ID = 'easy-syncnet-notice-style';
const boundSessions = new WeakSet<SyncnetNoticeSession>();

export function createSyncnetNoticeSession(): SyncnetNoticeSession {
  return { dismissed: false };
}

function documentOf(): Document | null {
  const candidate = (globalThis as { document?: Document }).document;
  return candidate && typeof candidate === 'object' ? candidate : null;
}

function ensureStyles(doc: Document): void {
  try {
    if (typeof doc.getElementById === 'function' && doc.getElementById(STYLE_ID)) return;
    if (typeof doc.createElement !== 'function' || !doc.head) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `[${DISMISS_ATTRIBUTE}] [data-easy-syncnet-warning], [${DISMISS_ATTRIBUTE}] [data-easy-syncnet-slot]{display:none !important}`;
    doc.head.append(style);
  } catch {
    // A document without a head still hides the current banner by removal.
  }
}

function installDismissHandler(doc: Document, session: SyncnetNoticeSession): void {
  if (boundSessions.has(session)) return;
  boundSessions.add(session);
  try {
    doc.addEventListener('click', (event: Event) => {
      const target = event.target as Element | null;
      const button = target && typeof target.closest === 'function' ? target.closest(DISMISS_SELECTOR) : null;
      if (!button) return;
      event.preventDefault();
      dismissSyncnetNotice(session);
    });
  } catch {
    boundSessions.delete(session);
  }
}

export function isSyncnetNoticeDismissed(session: SyncnetNoticeSession = DEFAULT_SESSION): boolean {
  return session.dismissed === true;
}

/** Hide the notice for the rest of the page session and keep it hidden. */
export function dismissSyncnetNotice(session: SyncnetNoticeSession = DEFAULT_SESSION): void {
  session.dismissed = true;
  const doc = documentOf();
  if (!doc) return;
  try {
    doc.documentElement?.setAttribute(DISMISS_ATTRIBUTE, '');
  } catch {
    // The banner is still removed below when the document has no root.
  }
  ensureStyles(doc);
  try {
    doc.querySelectorAll('[data-easy-syncnet-warning], [data-easy-syncnet-slot]').forEach((node) => {
      if (typeof node.remove === 'function') node.remove();
      else node.parentNode?.removeChild(node);
    });
  } catch {
    // A static document may not expose the banner nodes.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function warningFromList(value: unknown): SyncnetWarning | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.code !== 'string') continue;
    if (!SYNCNET_SKIP_CODES.has(entry.code)) continue;
    return { code: entry.code, message: COPY.syncnet.skipped };
  }
  return null;
}

/** A presenter project, or one that already has an LTX talking-head shot. */
export function packageUsesPresenter(pkg: unknown): boolean {
  if (!isRecord(pkg)) return false;
  const presenter = pkg.presenter;
  if (isRecord(presenter) && presenter.enabled === true) return true;
  if (!isRecord(pkg.assets)) return false;
  return Object.values(pkg.assets).some((asset) => {
    if (!isRecord(asset) || !isRecord(asset.gen)) return false;
    return asset.gen.generator === 'ltx25-a2v';
  });
}

/**
 * The warning Easy should show, or null when SyncNet is configured or this
 * project does not need the check. A plan warning and a diagnostics payload
 * both count. The visible sentence is the Easy copy, not the pipeline text.
 */
export function syncnetSkipWarning(source: unknown): SyncnetWarning | null {
  if (Array.isArray(source)) return warningFromList(source);
  if (!isRecord(source)) return null;
  const fromPlan = warningFromList(source.warnings);
  if (fromPlan) return fromPlan;
  const syncnet = source.syncnet;
  if (isRecord(syncnet) && syncnet.configured === false) {
    const code = typeof syncnet.code === 'string' && syncnet.code ? syncnet.code : 'SYNCNET_UNAVAILABLE';
    return { code, message: COPY.syncnet.skipped };
  }
  return null;
}

/** Banner HTML for the shell and for a step body. Empty when there is nothing to say. */
export function renderSyncnetBanner(
  warning: { message?: string } | null | undefined,
  session: SyncnetNoticeSession = DEFAULT_SESSION,
): string {
  if (session.dismissed) return '';
  const text = typeof warning?.message === 'string' ? warning.message.trim() : '';
  if (!text) return '';
  const doc = documentOf();
  if (doc) installDismissHandler(doc, session);
  const banner = renderBanner({
    tone: 'warn',
    text,
    actions: [{ label: COPY.syncnet.dismiss, kind: 'link', data: { easySyncnetDismiss: '' } }],
  });
  return `<div class="easy-syncnet-warning" data-easy-syncnet-warning>${banner}</div>`;
}

/**
 * Load the skip banner for a presenter project.
 * `null` means this project does not use a presenter, so the caller leaves
 * whatever banner is already on screen. A string (including empty) means the
 * SyncNet status was read and the banner should be replaced.
 */
export async function loadSyncnetBanner(ctx: SyncnetLoadContext): Promise<string | null> {
  const session = ctx.notice ?? DEFAULT_SESSION;
  let pkg: unknown = null;
  try {
    pkg = ctx.host.getPackage();
  } catch {
    return null;
  }
  if (!packageUsesPresenter(pkg)) return null;
  if (session.dismissed) return '';
  if (typeof ctx.api.pipelineDiagnostics !== 'function') return null;
  try {
    const diagnostics = await ctx.api.pipelineDiagnostics();
    return renderSyncnetBanner(syncnetSkipWarning(diagnostics), session);
  } catch {
    return null;
  }
}
