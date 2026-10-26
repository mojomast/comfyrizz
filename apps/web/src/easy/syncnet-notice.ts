// The SyncNet lip-sync check is optional. When it is not configured, Easy Studio
// shows this warning before Generate and Export instead of skipping in silence.

import { COPY } from './copy.ts';
import { renderBanner } from './components.ts';

export const SYNCNET_SKIP_CODES = new Set(['SYNCNET_UNAVAILABLE', 'SYNCNET_SKIPPED']);

export interface SyncnetWarning {
  code: string;
  message: string;
}

interface SyncnetHost {
  getPackage(): unknown;
}

interface SyncnetApi {
  pipelineDiagnostics?: () => Promise<unknown>;
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
export function renderSyncnetBanner(warning: { message?: string } | null | undefined): string {
  const text = typeof warning?.message === 'string' ? warning.message.trim() : '';
  if (!text) return '';
  const banner = renderBanner({ tone: 'warn', text });
  return `<div class="easy-syncnet-warning" data-easy-syncnet-warning>${banner}</div>`;
}

/**
 * Load the skip banner for a presenter project.
 * `null` means this project does not use a presenter, so the caller leaves
 * whatever banner is already on screen. A string (including empty) means the
 * SyncNet status was read and the banner should be replaced.
 */
export async function loadSyncnetBanner(ctx: { host: SyncnetHost; api: SyncnetApi }): Promise<string | null> {
  let pkg: unknown = null;
  try {
    pkg = ctx.host.getPackage();
  } catch {
    return null;
  }
  if (!packageUsesPresenter(pkg)) return null;
  if (typeof ctx.api.pipelineDiagnostics !== 'function') return null;
  try {
    const diagnostics = await ctx.api.pipelineDiagnostics();
    return renderSyncnetBanner(syncnetSkipWarning(diagnostics));
  } catch {
    return null;
  }
}
