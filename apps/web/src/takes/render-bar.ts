/**
 * Final-render gate UI (TIMELINE-REVIEW TR17).
 *
 * The render bar only mirrors the server gate: every reviewable clip has to be
 * approved before the final render, or the user has to give a written override
 * reason. The gate helpers and the HTML renderer are pure so a fake clip list
 * can exercise them without a DOM, a network or a server.
 */
import type { ClipSummary } from './api.ts';
import { mountReviewDrawer } from './review-drawer.ts';

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

/**
 * A take verdict belongs to the generated asset, not to one timeline clip: the
 * same asset can back several scenes (`<scene>:<asset>` clip ids). Apply the
 * approved verdict to every clip that uses the asset so the drawer progress
 * and the top-bar pill count the same clips the server will count.
 */
export function approveSharedAsset(
  clips: readonly ClipSummary[] | null | undefined,
  assetId: unknown,
): ClipSummary[] {
  const list = clipList(clips);
  const id = textOf(assetId);
  if (!id) return list;
  return list.map(clip => (textOf(clip.assetId) === id ? { ...clip, state: 'approved' } : clip));
}

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
  open?: boolean;
}

export function approvedPillLabel(gate: Pick<RenderGateSummary, 'approved' | 'total'> | null | undefined): string {
  const approved = Number.isFinite(gate?.approved) ? Math.max(0, Math.floor(gate!.approved)) : 0;
  const total = Number.isFinite(gate?.total) ? Math.max(0, Math.floor(gate!.total)) : 0;
  return `${approved}/${total} approved`;
}

export const renderPillLabel = approvedPillLabel;

/**
 * Pure HTML for the top-bar approval pill. The drawer owns the blocker rows,
 * the render action and the override form; the top bar keeps exactly one pill.
 */
export function renderRenderBar(gate: RenderGateSummary, options: RenderBarRenderOptions = {}): string {
  const disabled = options.disabled ? ' disabled' : '';
  const title = options.description || 'Review clips (R)';
  return `<div class="render-bar toolbar" data-render-bar data-gate-ok="${gate.ok ? 'true' : 'false'}" aria-label="Final render gate">
    <button type="button" class="btn btn-secondary btn-sm render-bar-pill" data-review-open aria-haspopup="dialog" aria-expanded="${options.open ? 'true' : 'false'}" aria-controls="review-drawer" aria-keyshortcuts="R" title="${escapeHtml(title)}"${disabled}>
      <span class="render-bar-pill-dot" aria-hidden="true">●</span>
      <span class="render-bar-pill-label" data-render-approved aria-live="polite">${escapeHtml(approvedPillLabel(gate))}</span>
      <span class="render-bar-pill-caret" aria-hidden="true">▾</span>
      ${gate.ok ? '<span hidden data-render-ready>All clips approved</span>' : ''}
    </button>
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
  onApprove?: (clip: ClipSummary) => boolean | void | Promise<boolean | void>;
  onRedo?: (clip: ClipSummary) => boolean | void | Promise<boolean | void>;
  onOpenTakes?: (clipId: string) => void;
  disabled?: boolean | (() => boolean);
  description?: string;
  drawerHost?: HTMLElement;
}

export interface RenderBarHandle {
  update(gate?: RenderGateSummary | readonly ClipSummary[]): void;
  requestOverride(gate?: RenderGateSummary | readonly ClipSummary[]): Promise<string | null>;
  closeOverride(): void;
  destroy(): void;
}

let stylesInstalled = false;

function installStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  const style = document.createElement('style');
  style.dataset.comfyrizz = 'render-bar';
  style.textContent = `
.render-bar { display:inline-flex; align-items:center; gap:var(--space-2); min-height:var(--space-6); }
.render-bar-pill { display:inline-flex; align-items:center; gap:var(--space-1); min-height:var(--target-min); padding:var(--space-1) var(--space-2); border-radius:var(--radius-pill); white-space:nowrap; }
.render-bar-pill[aria-expanded="true"] { border-color:var(--accent-border); color:var(--accent); }
.render-bar-pill-dot { color:var(--warn); font-size:var(--font-size-12); line-height:1; }
.render-bar[data-gate-ok="true"] .render-bar-pill-dot { color:var(--ok); }
.render-bar-pill-label { font-variant-numeric:var(--font-numeric-tabular); }
.render-bar-pill-caret { color:var(--text-3); }
`;
  document.head.append(style);
}

function clipsFromGate(gate: RenderGateSummary): ClipSummary[] {
  return gate.blocking.map((blocker, index) => ({
    clipId: blocker.clipId,
    sceneId: blocker.sceneId ?? '',
    assetId: blocker.assetId ?? '',
    slot: blocker.label ?? '',
    kind: 'plate',
    from: index,
    durationInFrames: 0,
    state: (blocker.state || 'review') as ClipSummary['state'],
    selected: null,
    selectedN: null,
    takeCount: 0,
    newTakes: 0,
    lastJob: null,
    queued: false,
  }));
}

/**
 * Mount the one top-bar pill. The review drawer owns every render-bar hook
 * (`data-render-blocker`, `data-render-run`, `data-render-open-override`) and
 * the shared gate logic is unchanged.
 */
export function mountRenderBar(el: HTMLElement, options: RenderBarMountOptions): RenderBarHandle {
  if (!el) throw new TypeError('mountRenderBar requires a host element');
  const readGate = (): RenderGateSummary => {
    if (typeof options.gate === 'function') return options.gate();
    const clips = typeof options.clips === 'function' ? options.clips() : options.clips;
    return summarizeGate(clips ?? []);
  };
  const readClips = (): ClipSummary[] => {
    const clips = typeof options.clips === 'function' ? options.clips() : options.clips;
    if (Array.isArray(clips) && clips.length > 0) return [...clips];
    const gate = readGate();
    return clipsFromGate(gate);
  };
  let gateOverride: RenderGateSummary | null = null;
  let usingClips = Boolean(options.clips);
  let destroyed = false;

  const disabledNow = (): boolean => (typeof options.disabled === 'function' ? options.disabled() : options.disabled === true);

  const drawer = mountReviewDrawer({
    host: options.drawerHost,
    clips: readClips(),
    gate: readGate(),
    onSelect: options.onSelectBlocker,
    onApprove: options.onApprove,
    onRedo: options.onRedo,
    onOpenTakes: options.onOpenTakes,
    onRender: options.onRender,
    onChange: () => paintPill(),
    onOpenChange: (open) => {
      const button = el.querySelector<HTMLButtonElement>('[data-review-open]');
      button?.setAttribute('aria-expanded', open ? 'true' : 'false');
    },
  });

  function paintPill(): void {
    if (destroyed) return;
    const gate = !usingClips && gateOverride
      ? gateOverride
      : (drawer.model.clips.length > 0 ? summarizeGate(drawer.model.clips) : (gateOverride ?? readGate()));
    el.innerHTML = renderRenderBar(gate, {
      disabled: disabledNow(),
      description: options.description,
      open: drawer.isOpen(),
    });
    el.querySelector<HTMLButtonElement>('[data-review-open]')?.addEventListener('click', () => drawer.toggle());
  }

  const asClips = (value: RenderGateSummary | readonly ClipSummary[] | undefined): ClipSummary[] | null => {
    if (value === undefined) return null;
    if (Array.isArray(value)) return [...value] as ClipSummary[];
    gateOverride = value as RenderGateSummary;
    return null;
  };

  installStyles();
  paintPill();

  return {
    update(next?: RenderGateSummary | readonly ClipSummary[]) {
      const clips = asClips(next);
      if (clips) {
        gateOverride = null;
        usingClips = true;
        drawer.setClips(clips);
      } else if (next) {
        usingClips = false;
        if (drawer.model.clips.length === 0) drawer.setClips(clipsFromGate(next as RenderGateSummary));
        else drawer.setGate(next as RenderGateSummary);
      } else {
        gateOverride = null;
        usingClips = Boolean(options.clips);
        drawer.setClips(readClips());
      }
      paintPill();
    },
    requestOverride(next?: RenderGateSummary | readonly ClipSummary[]) {
      const clips = asClips(next);
      if (clips) drawer.setClips(clips);
      else if (next) drawer.setGate(next as RenderGateSummary);
      return drawer.requestOverride();
    },
    closeOverride() {
      drawer.closeOverride();
    },
    destroy() {
      destroyed = true;
      drawer.destroy();
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
