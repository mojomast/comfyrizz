/**
 * Final-render gate UI (TIMELINE-REVIEW TR17).
 *
 * The render bar only mirrors the server gate: every reviewable clip has to be
 * approved before the final render, or the user has to give a written override
 * reason. The gate helpers and the HTML renderer are pure so a fake clip list
 * can exercise them without a DOM, a network or a server.
 */
import type { ClipSummary } from './api.ts';

export const MIN_OVERRIDE_REASON = 4;
export const MAX_OVERRIDE_REASON = 500;

export interface RenderGateBlocker {
  clipId: string;
  state: string;
  sceneId?: string;
  assetId?: string;
  label?: string;
}

export interface RenderGateSummary {
  ok: boolean;
  approved: number;
  total: number;
  blocking: RenderGateBlocker[];
}

export interface ClipStoreMeta {
  packageId?: string;
  revision?: number | null;
}

export interface ClipStoreSnapshot {
  packageId: string;
  revision: number | null;
  clips: ClipSummary[];
  byId: Map<string, ClipSummary>;
  gate: RenderGateSummary;
}

export type ClipStoreListener = (snapshot: ClipStoreSnapshot) => void;

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function clipList(clips: readonly ClipSummary[] | null | undefined): ClipSummary[] {
  return Array.isArray(clips) ? clips.filter(clip => isObject(clip) && typeof clip.clipId === 'string') : [];
}

/**
 * Evaluate the same rule as the server's finalGate, from the clip summaries the
 * takes API returns. A missing or unknown state is never treated as approved.
 */
export function summarizeGate(clips: readonly ClipSummary[] | null | undefined): RenderGateSummary {
  const list = clipList(clips);
  const blocking: RenderGateBlocker[] = [];
  let approved = 0;
  for (const clip of list) {
    if (clip.state === 'approved') {
      approved += 1;
      continue;
    }
    blocking.push({
      clipId: clip.clipId,
      state: textOf(clip.state) || 'unknown',
      ...(textOf(clip.sceneId) ? { sceneId: clip.sceneId } : {}),
      ...(textOf(clip.assetId) ? { assetId: clip.assetId } : {}),
      ...(textOf(clip.slot) ? { label: clip.slot } : {}),
    });
  }
  return { ok: blocking.length === 0, approved, total: list.length, blocking };
}

/** Names used by callers that describe the gate rather than its result. */
export const gateSummary = summarizeGate;
export const renderGate = summarizeGate;
export const renderGateSummary = summarizeGate;
export const clipGate = summarizeGate;
export const gateForClips = summarizeGate;
export const finalGate = summarizeGate;

/** "3/5 clips approved" (the spec's "n/m clips approved"). */
export function approvedLabel(gate: Pick<RenderGateSummary, 'approved' | 'total'> | null | undefined): string {
  const approved = Number.isFinite(gate?.approved) ? Math.max(0, Math.floor(gate!.approved)) : 0;
  const total = Number.isFinite(gate?.total) ? Math.max(0, Math.floor(gate!.total)) : 0;
  return `${approved}/${total} clips approved`;
}

export const renderBarLabel = approvedLabel;
export const clipsApprovedLabel = approvedLabel;

export function blockerLabel(blocker: RenderGateBlocker): string {
  const state = textOf(blocker.state) || 'unknown';
  const slot = textOf(blocker.label);
  return slot ? `${blocker.clipId} · ${slot} · ${state}` : `${blocker.clipId} · ${state}`;
}

export type OverrideValidation =
  | { ok: true; reason: string }
  | { ok: false; error: string };

/** The server accepts a trimmed reason of 4 to 500 characters. */
export function validateOverrideReason(reason: unknown): OverrideValidation {
  if (typeof reason !== 'string') {
    return { ok: false, error: 'Write a reason of 4 to 500 characters before overriding the gate.' };
  }
  const trimmed = reason.trim();
  if (trimmed.length < MIN_OVERRIDE_REASON) {
    return { ok: false, error: `Write at least ${MIN_OVERRIDE_REASON} characters explaining the override.` };
  }
  if (trimmed.length > MAX_OVERRIDE_REASON) {
    return { ok: false, error: `Keep the override reason to ${MAX_OVERRIDE_REASON} characters or fewer.` };
  }
  return { ok: true, reason: trimmed };
}

export function overrideReasonError(reason: unknown): string | null {
  const result = validateOverrideReason(reason);
  return result.ok ? null : result.error;
}

export function isValidOverrideReason(reason: unknown): boolean {
  return validateOverrideReason(reason).ok;
}

/**
 * Add `override.reason` to a render request body. An invalid reason is never
 * sent; the caller should ask for a valid one first.
 */
export function withRenderOverride<T extends Record<string, unknown>>(body: T, reason: unknown): T & { override?: { reason: string } } {
  const result = validateOverrideReason(reason);
  if (!result.ok) return { ...body };
  return { ...body, override: { reason: result.reason } };
}

export interface RenderBarRenderOptions {
  idPrefix?: string;
  disabled?: boolean;
  description?: string;
}

/** Pure HTML for the render bar; the mount helper binds the buttons. */
export function renderRenderBar(gate: RenderGateSummary, options: RenderBarRenderOptions = {}): string {
  const prefix = options.idPrefix ?? 'render-bar';
  const label = approvedLabel(gate);
  const disabled = options.disabled ? ' disabled' : '';
  const blockers = gate.blocking.length === 0
    ? ''
    : `<div class="render-bar-blockers" data-render-blockers>
        <p class="render-bar-hint">${gate.blocking.length} clip${gate.blocking.length === 1 ? '' : 's'} still need approval:</p>
        <ul class="render-bar-list">${gate.blocking.map(blocker => `<li>
          <button type="button" class="render-bar-blocker" data-render-blocker="${escapeHtml(blocker.clipId)}" title="Review ${escapeHtml(blockerLabel(blocker))}">${escapeHtml(blockerLabel(blocker))}</button>
        </li>`).join('')}</ul>
      </div>`;
  const action = gate.ok
    ? `<button type="button" class="primary" data-render-run${disabled}>Render</button>`
    : `<button type="button" class="render-bar-override-open" data-render-open-override${disabled}>Render anyway</button>`;
  const dialog = gate.ok
    ? ''
    : `<form class="render-bar-override" data-render-override hidden aria-label="Override the render gate">
        <label for="${escapeHtml(prefix)}-reason">Override reason</label>
        <textarea id="${escapeHtml(prefix)}-reason" name="reason" data-override-reason rows="2" required minlength="${MIN_OVERRIDE_REASON}" maxlength="${MAX_OVERRIDE_REASON}" placeholder="Why is this render allowed before every clip is approved?"${disabled}></textarea>
        <p class="render-bar-hint" data-override-count aria-live="polite">0 / ${MAX_OVERRIDE_REASON}</p>
        <p class="render-bar-error" data-override-error role="alert"></p>
        <div class="render-bar-actions">
          <button type="submit" class="primary" data-override-submit${disabled}>Render with override</button>
          <button type="button" data-override-cancel${disabled}>Cancel</button>
        </div>
      </form>`;
  return `<div class="render-bar" data-render-bar data-gate-ok="${gate.ok ? 'true' : 'false'}" aria-label="Final render gate">
    <span class="render-bar-title">Final render</span>
    <span class="render-bar-count" data-render-approved aria-live="polite">${escapeHtml(label)}</span>
    ${gate.ok ? '<span class="render-bar-ready" data-render-ready>All clips approved</span>' : blockers}
    ${action}
    ${options.description ? `<span class="render-bar-hint">${escapeHtml(options.description)}</span>` : ''}
    ${dialog}
  </div>`;
}

export const renderBarHtml = renderRenderBar;
export const renderBar = renderRenderBar;

export interface RenderBarMountOptions {
  /** One of `gate` or `clips` is required. */
  gate?: () => RenderGateSummary;
  clips?: readonly ClipSummary[] | (() => readonly ClipSummary[]);
  onRender?: (overrideReason?: string) => void | Promise<void>;
  onSelectBlocker?: (clipId: string) => void;
  disabled?: boolean | (() => boolean);
  description?: string;
}

export interface RenderBarHandle {
  update(gate?: RenderGateSummary | readonly ClipSummary[]): void;
  requestOverride(gate?: RenderGateSummary | readonly ClipSummary[]): Promise<string | null>;
  closeOverride(): void;
  destroy(): void;
}

let barSequence = 0;
let stylesInstalled = false;

function installStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  const style = document.createElement('style');
  style.dataset.comfyrizz = 'render-bar';
  style.textContent = `
.render-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-height:32px; }
.render-bar-title { font-size:12px; font-weight:600; white-space:nowrap; }
.render-bar-count { font-size:12px; color:var(--muted,#8b93a7); white-space:nowrap; }
.render-bar[data-gate-ok="false"] .render-bar-count { color:var(--warn,#e0a33a); }
.render-bar[data-gate-ok="true"] .render-bar-count { color:var(--ok,#55c98a); }
.render-bar-blockers { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.render-bar-list { display:flex; gap:4px; flex-wrap:wrap; list-style:none; margin:0; padding:0; }
.render-bar-blocker { max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.render-bar-override { display:flex; flex-direction:column; gap:4px; min-width:260px; }
.render-bar-override[hidden] { display:none; }
.render-bar-actions { display:flex; gap:6px; }
.render-bar-error { margin:0; color:var(--warn,#e0a33a); font-size:12px; }
.render-bar-error:empty { display:none; }
.render-bar-hint { margin:0; font-size:12px; color:var(--muted,#8b93a7); }
`;
  document.head.append(style);
}

/**
 * Mount the render bar into the existing render controls. It only requests a
 * reason when the gate is blocked; a valid reason is passed to onRender.
 */
export function mountRenderBar(el: HTMLElement, options: RenderBarMountOptions): RenderBarHandle {
  if (!el) throw new TypeError('mountRenderBar requires a host element');
  const prefix = `render-bar-${++barSequence}`;
  const asGate = (value: RenderGateSummary | readonly ClipSummary[] | undefined): RenderGateSummary | undefined => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? summarizeGate(value as readonly ClipSummary[]) : value as RenderGateSummary;
  };
  const readGate = (): RenderGateSummary => {
    if (typeof options.gate === 'function') return options.gate();
    const clips = typeof options.clips === 'function' ? options.clips() : options.clips;
    return summarizeGate(clips ?? []);
  };
  let gate = readGate();
  let pending: ((reason: string | null) => void) | null = null;
  let destroyed = false;

  const disabledNow = (): boolean => (typeof options.disabled === 'function' ? options.disabled() : options.disabled === true);

  const settle = (reason: string | null): void => {
    const resolve = pending;
    pending = null;
    resolve?.(reason);
  };

  const bind = (): void => {
    el.querySelector<HTMLButtonElement>('[data-render-run]')?.addEventListener('click', () => {
      void options.onRender?.();
    });
    el.querySelector<HTMLButtonElement>('[data-render-open-override]')?.addEventListener('click', () => {
      void open().then(reason => {
        if (reason) void options.onRender?.(reason);
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-render-blocker]').forEach(button => {
      button.addEventListener('click', () => {
        const clipId = button.getAttribute('data-render-blocker');
        if (clipId) options.onSelectBlocker?.(clipId);
      });
    });
    const form = el.querySelector<HTMLFormElement>('[data-render-override]');
    const reason = form?.querySelector<HTMLTextAreaElement>('[data-override-reason]');
    reason?.addEventListener('input', () => {
      const count = el.querySelector<HTMLElement>('[data-override-count]');
      if (count) count.textContent = `${Math.min(MAX_OVERRIDE_REASON, reason.value.length)} / ${MAX_OVERRIDE_REASON}`;
    });
    form?.addEventListener('submit', event => {
      event.preventDefault();
      const checked = validateOverrideReason(reason?.value ?? '');
      const error = el.querySelector<HTMLElement>('[data-override-error]');
      if (!checked.ok) {
        if (error) error.textContent = checked.error;
        reason?.focus();
        return;
      }
      if (error) error.textContent = '';
      settle(checked.reason);
      close();
    });
    el.querySelector<HTMLButtonElement>('[data-override-cancel]')?.addEventListener('click', () => {
      settle(null);
      close();
    });
  };

  const paint = (nextGate?: RenderGateSummary): void => {
    if (destroyed) return;
    gate = nextGate ?? readGate();
    // A refresh must not wipe the reason the user is typing.
    if (pending) return;
    el.innerHTML = renderRenderBar(gate, { idPrefix: prefix, disabled: disabledNow(), description: options.description });
    bind();
  };

  const open = (forced?: RenderGateSummary | readonly ClipSummary[]): Promise<string | null> => {
    if (pending) settle(null);
    gate = asGate(forced) ?? readGate();
    paint(gate);
    const form = el.querySelector<HTMLFormElement>('[data-render-override]');
    if (!form) return Promise.resolve(null);
    form.hidden = false;
    const reason = form.querySelector<HTMLTextAreaElement>('[data-override-reason]');
    reason?.focus();
    return new Promise<string | null>(resolve => {
      pending = resolve;
    });
  };

  const close = (): void => {
    const form = el.querySelector<HTMLFormElement>('[data-render-override]');
    if (form) form.hidden = true;
  };

  installStyles();
  paint();

  return {
    update(next?: RenderGateSummary | readonly ClipSummary[]) {
      paint(asGate(next));
    },
    requestOverride(next?: RenderGateSummary | readonly ClipSummary[]) {
      return open(next);
    },
    closeOverride() {
      settle(null);
      close();
    },
    destroy() {
      destroyed = true;
      settle(null);
      el.innerHTML = '';
    },
  };
}

/**
 * A tiny clips store. The shell updates it from `listClips` and every clip.* SSE
 * event, so the inspector and the render bar always read the same map.
 */
export function createClipStore(initial: readonly ClipSummary[] = []) {
  const byId = new Map<string, ClipSummary>();
  let packageId = '';
  let revision: number | null = null;
  const listeners = new Set<ClipStoreListener>();
  let snapshot: ClipStoreSnapshot = { packageId, revision, clips: [], byId: new Map(), gate: summarizeGate([]) };

  const rebuild = (): void => {
    const clips = Array.from(byId.values());
    snapshot = {
      packageId,
      revision,
      clips,
      byId: new Map(byId),
      gate: summarizeGate(clips),
    };
  };

  const emit = (): void => {
    for (const listener of Array.from(listeners)) {
      try { listener(snapshot); } catch { /* a view error must not break the store */ }
    }
  };

  const store = {
    get: (clipId: string): ClipSummary | undefined => byId.get(clipId),
    all: (): ClipSummary[] => Array.from(byId.values()),
    map: (): Map<string, ClipSummary> => new Map(byId),
    gate: (): RenderGateSummary => snapshot.gate,
    snapshot: (): ClipStoreSnapshot => snapshot,
    replace(clips: readonly ClipSummary[] | null | undefined, meta: ClipStoreMeta = {}): ClipStoreSnapshot {
      byId.clear();
      for (const clip of clipList(clips)) byId.set(clip.clipId, clip);
      if (meta.packageId !== undefined) packageId = String(meta.packageId);
      if (meta.revision !== undefined) revision = typeof meta.revision === 'number' ? meta.revision : null;
      rebuild();
      emit();
      return snapshot;
    },
    upsert(clip: ClipSummary | null | undefined): ClipStoreSnapshot {
      if (clip && typeof clip.clipId === 'string') byId.set(clip.clipId, clip);
      rebuild();
      emit();
      return snapshot;
    },
    remove(clipId: string): ClipStoreSnapshot {
      byId.delete(clipId);
      rebuild();
      emit();
      return snapshot;
    },
    clear(): ClipStoreSnapshot {
      byId.clear();
      packageId = '';
      revision = null;
      rebuild();
      emit();
      return snapshot;
    },
    subscribe(listener: ClipStoreListener): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };

  if (initial.length > 0) store.replace(initial);
  return store;
}

/** Compatibility alias for callers that pluralise the clip store. */
export const createClipsStore = createClipStore;
