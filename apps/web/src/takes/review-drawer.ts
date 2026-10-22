/**
 * DN03: Approval drawer.
 *
 * One reviewable-clip list for the whole app. The pure helpers and the model
 * can be exercised without a DOM; `mountReviewDrawer` is the only DOM entry
 * point and it does nothing until it is called. The drawer is non-modal, keeps
 * every input alive while it is hidden and only moves focus after an approval.
 */
import type { ClipSummary } from './api.ts';

export const REVIEW_FILTERS = ['needs', 'stale', 'approved', 'failed'] as const;

export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

export const REVIEW_SORTS = ['timeline', 'status'] as const;

export type ReviewSort = (typeof REVIEW_SORTS)[number];

export const REVIEW_FILTER_LABELS: Readonly<Record<ReviewFilter, string>> = Object.freeze({
  needs: 'Needs review',
  stale: 'Stale',
  approved: 'Approved',
  failed: 'Failed',
});

export type ReviewDensity = 'compact' | 'comfortable';

/**
 * The CSS row height is `--row-height + --space-2`:
 * compact 28 + 8 = 36 and comfortable 36 + 8 = 44. The row has room for the
 * 64x36 thumbnail plus its two-line title/meta block, so virtualization offsets
 * and the rendered rows share the same height in both densities.
 */
export const REVIEW_ROW_HEIGHT_COMPACT = 36;
export const REVIEW_ROW_HEIGHT_COMFORTABLE = 44;
export const REVIEW_ROW_HEIGHT = REVIEW_ROW_HEIGHT_COMFORTABLE;
export const REVIEW_ROW_HEIGHTS: Readonly<Record<ReviewDensity, number>> = Object.freeze({
  compact: REVIEW_ROW_HEIGHT_COMPACT,
  comfortable: REVIEW_ROW_HEIGHT_COMFORTABLE,
});
export const REVIEW_OVERSCAN = 4;
export const REVIEW_DEFAULT_VIEWPORT = 480;

export function reviewRowHeight(density: unknown = 'comfortable'): number {
  return density === 'compact' ? REVIEW_ROW_HEIGHT_COMPACT : REVIEW_ROW_HEIGHT_COMFORTABLE;
}

function currentDensity(): ReviewDensity {
  if (typeof document === 'undefined') return 'comfortable';
  const root = document.documentElement;
  const explicit = root?.dataset?.density;
  if (explicit === 'compact' || explicit === 'comfortable') return explicit;
  return root?.dataset?.mode === 'advanced' ? 'compact' : 'comfortable';
}

export function currentReviewRowHeight(): number {
  return reviewRowHeight(currentDensity());
}

export const MIN_OVERRIDE_REASON = 4;
export const MAX_OVERRIDE_REASON = 500;

export interface ReviewGateLike {
  ok: boolean;
  approved: number;
  total: number;
  blocking?: ReadonlyArray<{ clipId: string; state: string; sceneId?: string; assetId?: string; label?: string }>;
}

export interface ReviewCounts {
  needs: number;
  stale: number;
  approved: number;
  failed: number;
  total: number;
}

export interface ReviewRow {
  clip: ClipSummary;
  clipId: string;
  fullId: string;
  shortId: string;
  scene: string;
  slot: string;
  kind: string;
  group: ReviewFilter;
  statusLabel: string;
  tone: 'warn' | 'danger' | 'ok';
  takeLabel: string;
  title: string;
}

export interface ReviewFilterOptions {
  filter?: ReviewFilter;
  query?: string;
  sort?: ReviewSort;
}

export interface ReviewWindow {
  start: number;
  end: number;
  top: number;
  bottom: number;
  total: number;
}

export type ReviewClipAction = (clip: ClipSummary) => boolean | void | Promise<boolean | void>;

export interface ReviewDrawerModelOptions {
  clips?: readonly ClipSummary[];
  gate?: ReviewGateLike | null;
  filter?: ReviewFilter;
  query?: string;
  sort?: ReviewSort;
  density?: ReviewDensity;
  rowHeight?: number;
  viewportHeight?: number;
  overscan?: number;
  onApprove?: ReviewClipAction;
  onRedo?: ReviewClipAction;
  onSelect?: (clipId: string) => void;
  onOpenTakes?: (clipId: string) => void;
  onAnnounce?: (message: string) => void;
  onChange?: (model: ReviewDrawerModel) => void;
  confirm?: (message: string) => boolean;
  getMode?: () => 'easy' | 'advanced';
}

export interface ReviewKeyOptions {
  shiftKey?: boolean;
  inEditable?: boolean;
}

export interface ReviewDrawerMountOptions extends ReviewDrawerModelOptions {
  host?: HTMLElement;
  id?: string;
  onOpenChange?: (open: boolean) => void;
  onRender?: (overrideReason?: string) => void | Promise<void>;
}

export interface ReviewDrawerHandle {
  element: HTMLElement;
  model: ReviewDrawerModel;
  open(): void;
  close(returnFocus?: boolean): void;
  toggle(): void;
  isOpen(): boolean;
  setClips(clips: readonly ClipSummary[]): void;
  setGate(gate: ReviewGateLike | null | undefined): void;
  requestOverride(gate?: ReviewGateLike | null): Promise<string | null>;
  closeOverride(): void;
  destroy(): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clipList(clips: readonly ClipSummary[] | null | undefined): ClipSummary[] {
  return Array.isArray(clips) ? clips.filter(clip => isObject(clip) && typeof clip.clipId === 'string') : [];
}

export function escapeReviewHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

export function reviewGroupFor(state: unknown): ReviewFilter {
  const value = textOf(state);
  if (value === 'approved') return 'approved';
  if (value === 'stale') return 'stale';
  if (value === 'failed' || value === 'rejected') return 'failed';
  return 'needs';
}

export function clipNeedsReview(clip: ClipSummary | null | undefined): boolean {
  return Boolean(clip) && reviewGroupFor(clip!.state) === 'needs';
}

export function shortClipId(clipId: unknown): string {
  const full = textOf(clipId);
  const colon = full.lastIndexOf(':');
  const tail = colon >= 0 ? full.slice(colon + 1) : full;
  if (tail.length <= 18) return tail || full;
  return `${tail.slice(0, 10)}…${tail.slice(-6)}`;
}

export function clipSceneLabel(clip: ClipSummary | null | undefined): string {
  if (!clip) return '';
  return textOf(clip.sceneId) || textOf(clip.slot) || 'Scene';
}

export function takeProgressLabel(clip: ClipSummary | null | undefined): string {
  if (!clip) return '';
  const total = Math.max(0, Math.floor(Number(clip.takeCount) || 0));
  if (total === 0) return 'no takes';
  const selected = Number.isFinite(Number(clip.selectedN)) ? Math.max(0, Math.floor(Number(clip.selectedN))) : 0;
  return `take ${selected || '–'}/${total}`;
}

export function reviewCounts(clips: readonly ClipSummary[] | null | undefined): ReviewCounts {
  const counts: ReviewCounts = { needs: 0, stale: 0, approved: 0, failed: 0, total: 0 };
  for (const clip of clipList(clips)) {
    counts[reviewGroupFor(clip.state)] += 1;
    counts.total += 1;
  }
  return counts;
}

function matchesQuery(clip: ClipSummary, query: string): boolean {
  if (!query) return true;
  const haystack = [
    clip.clipId,
    clip.sceneId,
    clip.slot,
    clip.kind,
    clip.state,
    clip.assetId,
    clip.selected,
  ].map(textOf).join(' ').toLowerCase();
  return haystack.includes(query);
}

export function normalizeReviewQuery(query: unknown): string {
  return textOf(query).trim().toLowerCase();
}

export function sortedReviewClips(clips: readonly ClipSummary[] | null | undefined, sort: ReviewSort = 'timeline'): ClipSummary[] {
  const list = clipList(clips);
  if (sort === 'status') {
    const order: Record<ReviewFilter, number> = { needs: 0, stale: 1, failed: 2, approved: 3 };
    return list.sort((a, b) => {
      const group = order[reviewGroupFor(a.state)] - order[reviewGroupFor(b.state)];
      if (group !== 0) return group;
      return Number(a.from || 0) - Number(b.from || 0) || a.clipId.localeCompare(b.clipId);
    });
  }
  return list.sort((a, b) => Number(a.from || 0) - Number(b.from || 0) || a.clipId.localeCompare(b.clipId));
}

export function filterReviewClips(
  clips: readonly ClipSummary[] | null | undefined,
  options: ReviewFilterOptions = {},
): ClipSummary[] {
  const filter = options.filter ?? 'needs';
  const query = normalizeReviewQuery(options.query);
  const sort = options.sort ?? 'timeline';
  return sortedReviewClips(
    clipList(clips).filter(clip => reviewGroupFor(clip.state) === filter && matchesQuery(clip, query)),
    sort,
  );
}

export function reviewRowFor(clip: ClipSummary, index = 0): ReviewRow {
  const group = reviewGroupFor(clip.state);
  const statusLabel = REVIEW_FILTER_LABELS[group];
  const fullId = textOf(clip.clipId);
  const shortId = shortClipId(fullId);
  const scene = clipSceneLabel(clip);
  const slot = textOf(clip.slot);
  const title = slot && slot !== scene ? `${fullId} · ${scene} · ${slot}` : `${fullId} · ${scene}`;
  return {
    clip,
    clipId: fullId,
    fullId,
    shortId,
    scene,
    slot,
    kind: textOf(clip.kind) || 'clip',
    group,
    statusLabel,
    tone: group === 'approved' ? 'ok' : group === 'failed' ? 'danger' : 'warn',
    takeLabel: takeProgressLabel(clip),
    title: index >= 0 ? title : title,
  };
}

export function reviewRows(clips: readonly ClipSummary[] | null | undefined, options: ReviewFilterOptions = {}): ReviewRow[] {
  return filterReviewClips(clips, options).map((clip, index) => reviewRowFor(clip, index));
}

export function windowRange(
  total: number,
  scrollTop = 0,
  viewportHeight = REVIEW_DEFAULT_VIEWPORT,
  rowHeight = REVIEW_ROW_HEIGHT,
  overscan = REVIEW_OVERSCAN,
): ReviewWindow {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  const height = Math.max(1, Number(rowHeight) || REVIEW_ROW_HEIGHT);
  const top = Math.max(0, Number(scrollTop) || 0);
  const view = Math.max(0, Number(viewportHeight) || 0);
  const pad = Math.max(0, Math.floor(Number(overscan) || 0));
  const start = Math.min(count, Math.max(0, Math.floor(top / height) - pad));
  const end = Math.min(count, Math.max(start, Math.ceil((top + view) / height) + pad));
  return {
    start,
    end,
    top: start * height,
    bottom: Math.max(0, (count - end) * height),
    total: count,
  };
}

function rowId(index: number): string {
  return `review-option-${index}`;
}

export function renderReviewRows(
  rows: readonly ReviewRow[],
  options: { activeId?: string; offset?: number } = {},
): string {
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const activeId = textOf(options.activeId);
  return rows.map((row, localIndex) => {
    const index = offset + localIndex;
    const active = row.clipId === activeId;
    const blocking = row.group === 'approved' ? '' : ` data-render-blocker="${escapeReviewHtml(row.clipId)}"`;
    return `<div class="review-row" id="${rowId(index)}" role="option" tabindex="${active ? '0' : '-1'}" aria-selected="${active ? 'true' : 'false'}" data-review-clip="${escapeReviewHtml(row.clipId)}" data-review-status="${row.group}" data-tone="${row.tone}"${blocking} title="${escapeReviewHtml(row.title)}">
      <span class="review-thumb" aria-hidden="true"><span>${escapeReviewHtml(row.kind)}</span></span>
      <span class="review-row-main">
        <span class="review-row-title" title="${escapeReviewHtml(row.fullId)}">${escapeReviewHtml(row.shortId)}</span>
        <span class="review-row-meta">
          <span class="review-row-scene">${escapeReviewHtml(row.scene)}${row.slot ? ` · ${escapeReviewHtml(row.slot)}` : ''}</span>
          <span class="review-take hint tabular-nums">${escapeReviewHtml(row.takeLabel)}</span>
        </span>
      </span>
      <span class="review-status review-status-${row.group} badge badge-${row.tone}" data-status="${row.group}">${escapeReviewHtml(row.statusLabel)}</span>
    </div>`;
  }).join('');
}

export function renderReviewWindow(
  rows: readonly ReviewRow[],
  view: ReviewWindow,
  activeId = '',
): string {
  const slice = rows.slice(view.start, view.end);
  const top = view.top > 0 ? `<div class="review-spacer" role="presentation" style="height:${Math.round(view.top)}px"></div>` : '';
  const bottom = view.bottom > 0 ? `<div class="review-spacer" role="presentation" style="height:${Math.round(view.bottom)}px"></div>` : '';
  return `${top}${renderReviewRows(slice, { activeId, offset: view.start })}${bottom}`;
}

function gateFromClips(clips: readonly ClipSummary[] | null | undefined, fallback?: ReviewGateLike | null): ReviewGateLike {
  const list = clipList(clips);
  if (list.length === 0 && fallback && isObject(fallback)) {
    return {
      ok: fallback.ok === true,
      approved: Math.max(0, Number(fallback.approved) || 0),
      total: Math.max(0, Number(fallback.total) || 0),
      blocking: Array.isArray(fallback.blocking) ? fallback.blocking : [],
    };
  }
  const blocking = list
    .filter(clip => clip.state !== 'approved')
    .map(clip => ({ clipId: clip.clipId, state: textOf(clip.state) || 'unknown', sceneId: textOf(clip.sceneId) }));
  const approved = list.length - blocking.length;
  return { ok: blocking.length === 0, approved, total: list.length, blocking };
}

export class ReviewDrawerModel {
  clips: ClipSummary[];
  filter: ReviewFilter;
  query: string;
  sort: ReviewSort;
  activeId = '';
  scrollTop = 0;
  viewportHeight: number;
  rowHeight: number;
  overscan: number;
  liveMessage = '';
  busy = false;
  fallbackGate: ReviewGateLike | null;
  options: ReviewDrawerModelOptions;

  constructor(options: ReviewDrawerModelOptions = {}) {
    this.options = options;
    this.clips = clipList(options.clips);
    this.filter = REVIEW_FILTERS.includes(options.filter as ReviewFilter) ? options.filter as ReviewFilter : 'needs';
    this.query = textOf(options.query);
    this.sort = REVIEW_SORTS.includes(options.sort as ReviewSort) ? options.sort as ReviewSort : 'timeline';
    this.viewportHeight = Math.max(1, Number(options.viewportHeight) || REVIEW_DEFAULT_VIEWPORT);
    this.rowHeight = Math.max(1, Number(options.rowHeight) || reviewRowHeight(options.density ?? currentDensity()));
    this.overscan = Math.max(0, Math.floor(Number(options.overscan ?? REVIEW_OVERSCAN) || 0));
    this.fallbackGate = options.gate ?? null;
    this.ensureActive();
  }

  get counts(): ReviewCounts {
    return reviewCounts(this.clips);
  }

  get gate(): ReviewGateLike {
    return gateFromClips(this.clips, this.fallbackGate);
  }

  get rows(): ReviewRow[] {
    return reviewRows(this.clips, { filter: this.filter, query: this.query, sort: this.sort });
  }

  get activeClip(): ClipSummary | null {
    return this.clips.find(clip => clip.clipId === this.activeId) ?? null;
  }

  window(): ReviewWindow {
    return windowRange(this.rows.length, this.scrollTop, this.viewportHeight, this.rowHeight, this.overscan);
  }

  ensureActive(): void {
    const rows = this.rows;
    if (rows.length === 0) {
      this.activeId = '';
      return;
    }
    if (!rows.some(row => row.clipId === this.activeId)) this.activeId = rows[0]!.clipId;
  }

  setClips(clips: readonly ClipSummary[] | null | undefined): void {
    this.clips = clipList(clips);
    this.ensureActive();
    this.notify();
  }

  setGate(gate: ReviewGateLike | null | undefined): void {
    this.fallbackGate = gate ?? null;
    this.notify();
  }

  setFilter(filter: ReviewFilter): void {
    if (!REVIEW_FILTERS.includes(filter)) return;
    this.filter = filter;
    this.scrollTop = 0;
    this.ensureActive();
    this.notify();
  }

  setQuery(query: unknown): void {
    this.query = textOf(query);
    this.scrollTop = 0;
    this.ensureActive();
    this.notify();
  }

  setSort(sort: ReviewSort): void {
    if (!REVIEW_SORTS.includes(sort)) return;
    this.sort = sort;
    this.scrollTop = 0;
    this.ensureActive();
    this.notify();
  }

  setScrollTop(value: number): void {
    this.scrollTop = Math.max(0, Number(value) || 0);
    this.notify();
  }

  setViewportHeight(value: number): void {
    this.viewportHeight = Math.max(1, Number(value) || REVIEW_DEFAULT_VIEWPORT);
    this.notify();
  }

  setRowHeight(value: number): void {
    const height = Math.max(1, Number(value) || REVIEW_ROW_HEIGHT);
    if (height === this.rowHeight) return;
    this.rowHeight = height;
    this.notify();
  }

  setActive(clipId: string, focus = false): void {
    if (!this.rows.some(row => row.clipId === clipId)) return;
    this.activeId = clipId;
    this.notify();
    if (focus) this.options.onSelect?.(clipId);
  }

  moveActive(delta: number): boolean {
    const rows = this.rows;
    if (rows.length === 0) return false;
    const current = rows.findIndex(row => row.clipId === this.activeId);
    const step = delta < 0 ? -1 : 1;
    const base = current >= 0 ? current : 0;
    const next = rows[(base + step + rows.length) % rows.length]!;
    this.activeId = next.clipId;
    this.notify();
    return true;
  }

  private setLive(message: string): void {
    this.liveMessage = message;
    this.options.onAnnounce?.(message);
  }

  private updateClip(clipId: string, patch: Partial<ClipSummary>): void {
    this.clips = this.clips.map(clip => (clip.clipId === clipId ? { ...clip, ...patch } : clip));
  }

  private async runApprove(clip: ClipSummary): Promise<boolean> {
    let ok = true;
    try {
      if (this.options.onApprove) {
        const result = await this.options.onApprove(clip);
        ok = result !== false;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      this.setLive(`Could not approve ${shortClipId(clip.clipId)}`);
      return false;
    }
    this.updateClip(clip.clipId, { state: 'approved' });
    return true;
  }

  private advanceAfterApprove(): void {
    if (this.filter !== 'needs') {
      this.ensureActive();
      return;
    }
    const needs = sortedReviewClips(this.clips.filter(clip => reviewGroupFor(clip.state) === 'needs'), 'timeline');
    if (needs.length === 0) {
      this.activeId = '';
      return;
    }
    const previous = this.clips.find(clip => clip.clipId === this.activeId);
    const from = Number(previous?.from ?? -1);
    const next = needs.find(clip => Number(clip.from || 0) > from)
      ?? needs.find(clip => Number(clip.from || 0) === from && clip.clipId > this.activeId)
      ?? needs[0]!;
    this.activeId = next.clipId;
    this.ensureActive();
  }

  async approve(clipId = this.activeId): Promise<boolean> {
    if (this.busy) return false;
    const clip = this.clips.find(item => item.clipId === clipId);
    if (!clip) return false;
    this.busy = true;
    try {
      const ok = await this.runApprove(clip);
      if (!ok) {
        this.notify();
        return false;
      }
      const counts = this.counts;
      this.setLive(`Approved ${counts.approved}/${counts.total}`);
      this.advanceAfterApprove();
      this.notify();
      return true;
    } finally {
      this.busy = false;
    }
  }

  async redo(clipId = this.activeId): Promise<boolean> {
    if (this.busy) return false;
    const clip = this.clips.find(item => item.clipId === clipId);
    if (!clip) return false;
    this.busy = true;
    try {
      let ok = true;
      if (this.options.onRedo) {
        const result = await this.options.onRedo(clip);
        ok = result !== false;
      }
      if (!ok) {
        this.setLive(`Could not redo ${shortClipId(clip.clipId)}`);
        this.notify();
        return false;
      }
      this.updateClip(clip.clipId, { state: 'queued', newTakes: 0 });
      this.setLive(`Redo queued for ${shortClipId(clip.clipId)}`);
      this.ensureActive();
      this.notify();
      return true;
    } catch {
      this.setLive(`Could not redo ${shortClipId(clip.clipId)}`);
      this.notify();
      return false;
    } finally {
      this.busy = false;
    }
  }

  async approveVisible(): Promise<number> {
    if (this.busy) return 0;
    const visible = this.rows.filter(row => row.group === 'needs');
    if (visible.length === 0) {
      this.setLive('No visible clips need review');
      this.notify();
      return 0;
    }
    const confirm = this.options.confirm ?? (typeof globalThis.confirm === 'function' ? globalThis.confirm.bind(globalThis) : null);
    if (confirm && !confirm(`Approve ${visible.length} visible clip${visible.length === 1 ? '' : 's'}?`)) {
      this.setLive('Approve all cancelled');
      this.notify();
      return 0;
    }
    this.busy = true;
    try {
      let approved = 0;
      for (const row of visible) {
        if (await this.runApprove(row.clip)) approved += 1;
      }
      const counts = this.counts;
      this.setLive(approved === visible.length
        ? `Approved ${counts.approved}/${counts.total}`
        : `Approved ${approved} of ${visible.length} visible clips`);
      this.advanceAfterApprove();
      this.notify();
      return approved;
    } finally {
      this.busy = false;
    }
  }

  async handleKey(key: string, options: ReviewKeyOptions = {}): Promise<boolean> {
    if (options.inEditable) return false;
    const normalized = textOf(key).toLowerCase();
    if (normalized === 'j' || normalized === 'arrowdown') return this.moveActive(1);
    if (normalized === 'k' || normalized === 'arrowup') return this.moveActive(-1);
    if (normalized === 'a') {
      if (options.shiftKey) {
        await this.approveVisible();
        return true;
      }
      return this.approve();
    }
    if (normalized === 'd') return this.redo();
    if (normalized === 'enter') {
      const clip = this.activeClip;
      if (!clip || !this.options.onOpenTakes) return false;
      const mode = this.options.getMode
        ? this.options.getMode()
        : (typeof document !== 'undefined' && document.documentElement?.dataset.mode === 'easy' ? 'easy' : 'advanced');
      if (mode !== 'advanced') return false;
      this.options.onOpenTakes(clip.clipId);
      return true;
    }
    return false;
  }

  notify(): void {
    this.options.onChange?.(this);
  }
}

export function createReviewDrawerModel(options: ReviewDrawerModelOptions = {}): ReviewDrawerModel {
  return new ReviewDrawerModel(options);
}

export const reviewDrawerModel = createReviewDrawerModel;

function filterButton(filter: ReviewFilter, active: ReviewFilter, counts: ReviewCounts): string {
  const selected = filter === active;
  return `<button type="button" class="review-chip btn btn-sm" data-review-filter="${filter}" aria-pressed="${selected ? 'true' : 'false'}"${selected ? ' data-active="true"' : ''}>${REVIEW_FILTER_LABELS[filter]} <span class="review-chip-count tabular-nums" data-review-count-for="${filter}">${counts[filter]}</span></button>`;
}

function drawerShell(model: ReviewDrawerModel): string {
  const counts = model.counts;
  return `<div class="review-head">
      <div class="review-head-title">
        <h2 id="review-drawer-title">Review takes</h2>
        <span class="review-total hint tabular-nums" data-review-count>${model.gate.approved}/${model.gate.total} approved</span>
      </div>
      <button type="button" class="btn btn-ghost btn-icon btn-sm review-close" data-review-close aria-label="Close review drawer">✕</button>
    </div>
    <div class="review-filters" role="group" aria-label="Filter clips">
      ${REVIEW_FILTERS.map(filter => filterButton(filter, model.filter, counts)).join('')}
    </div>
    <div class="review-controls">
      <label class="review-search-label" for="review-search">Search</label>
      <input id="review-search" class="field-control review-search" type="search" data-review-search placeholder="Clip id or scene" autocomplete="off" />
      <label class="review-sort-label" for="review-sort">Sort</label>
      <select id="review-sort" class="field-control review-sort" data-review-sort>
        <option value="timeline">Timeline order</option>
        <option value="status">Status</option>
      </select>
    </div>
    <p class="review-live hint" data-review-live role="status" aria-live="polite"></p>
    <div class="review-list-wrap">
      <div class="review-list" id="review-list" role="listbox" aria-label="Clips" aria-activedescendant="" data-review-list></div>
    </div>
    <div class="review-footer">
      <button type="button" class="btn btn-secondary btn-sm review-approve-all" data-review-approve-all aria-keyshortcuts="Shift+A">Approve all visible</button>
      <div class="review-gate-actions" data-review-gate-actions></div>
    </div>
    <form class="review-override" data-render-override hidden aria-label="Override the render gate">
      <label for="review-override-reason" class="field-label">Override reason</label>
      <textarea id="review-override-reason" name="reason" class="field-control" data-override-reason rows="2" required minlength="${MIN_OVERRIDE_REASON}" maxlength="${MAX_OVERRIDE_REASON}" placeholder="Why is this render allowed before every clip is approved?"></textarea>
      <p class="review-override-count hint" data-override-count aria-live="polite">0 / ${MAX_OVERRIDE_REASON}</p>
      <p class="review-override-error" data-override-error role="alert"></p>
      <div class="review-override-actions toolbar">
        <button type="submit" class="btn btn-primary primary" data-override-submit>Render with override</button>
        <button type="button" class="btn btn-secondary" data-override-cancel>Cancel</button>
      </div>
    </form>`;
}

function gateActions(model: ReviewDrawerModel): string {
  const gate = model.gate;
  if (gate.ok) {
    return '<button type="button" class="btn btn-primary primary btn-sm" data-render-run>Render</button>';
  }
  return `<span class="hint">${gate.blocking?.length ?? Math.max(0, gate.total - gate.approved)} waiting</span>
    <button type="button" class="btn btn-secondary btn-sm render-bar-override-open" data-render-open-override>Render anyway</button>`;
}

function hydratedDrawerShell(model: ReviewDrawerModel): string {
  const rows = model.rows;
  const view = windowRange(rows.length, 0, model.viewportHeight, model.rowHeight, model.overscan);
  const activeIndex = rows.findIndex(row => row.clipId === model.activeId);
  const active = activeIndex >= 0 ? ` aria-activedescendant="review-option-${activeIndex}"` : '';
  return drawerShell(model)
    .replace(
      '<div class="review-list" id="review-list" role="listbox" aria-label="Clips" aria-activedescendant="" data-review-list></div>',
      `<div class="review-list" id="review-list" role="listbox" aria-label="Clips"${active} data-review-list>${renderReviewWindow(rows, view, model.activeId)}</div>`,
    )
    .replace(
      '<div class="review-gate-actions" data-review-gate-actions></div>',
      `<div class="review-gate-actions" data-review-gate-actions>${gateActions(model)}</div>`,
    );
}

export function renderReviewDrawer(
  clips: readonly ClipSummary[] | null | undefined,
  options: ReviewDrawerModelOptions & { id?: string; open?: boolean } = {},
): string {
  const model = new ReviewDrawerModel({ ...options, clips: clips ?? undefined });
  const id = options.id ?? 'review-drawer';
  const hidden = options.open ? '' : ' hidden';
  return `<aside id="${escapeReviewHtml(id)}" class="review-drawer panel" data-review-drawer role="dialog" aria-modal="false" aria-labelledby="review-drawer-title"${hidden}>
    ${hydratedDrawerShell(model)}
  </aside>`;
}

export const reviewDrawerHtml = renderReviewDrawer;
export const renderReviewDrawerHtml = renderReviewDrawer;

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

function validateOverride(reason: unknown): { ok: true; reason: string } | { ok: false; error: string } {
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

export function mountReviewDrawer(
  hostOrOptions: HTMLElement | ReviewDrawerMountOptions = {},
  maybeOptions: ReviewDrawerMountOptions = {},
): ReviewDrawerHandle {
  if (typeof document === 'undefined') throw new TypeError('mountReviewDrawer requires a DOM');
  const options: ReviewDrawerMountOptions = hostOrOptions instanceof HTMLElement
    ? { ...maybeOptions, host: hostOrOptions }
    : hostOrOptions;
  const host = options.host ?? document.body;
  if (!host) throw new TypeError('mountReviewDrawer requires a host element');
  void import('./panel.css').catch(() => undefined);

  const id = options.id ?? 'review-drawer';
  const model = new ReviewDrawerModel(options);
  const aside = document.createElement('aside');
  aside.id = id;
  aside.className = 'review-drawer panel';
  aside.dataset.reviewDrawer = '';
  aside.setAttribute('role', 'dialog');
  aside.setAttribute('aria-modal', 'false');
  aside.setAttribute('aria-labelledby', 'review-drawer-title');
  aside.innerHTML = drawerShell(model);
  aside.hidden = true;
  host.append(aside);

  let lastFocus: HTMLElement | null = null;
  let pendingOverride: ((reason: string | null) => void) | null = null;
  let destroyed = false;

  function syncRowHeight(): void {
    const height = reviewRowHeight(currentDensity());
    if (height !== model.rowHeight) model.setRowHeight(height);
  }

  const densityRoot = document.documentElement;
  const densityObserver = densityRoot && typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => syncRowHeight())
    : null;
  densityObserver?.observe(densityRoot, { attributes: true, attributeFilter: ['data-density', 'data-mode'] });

  const q = <T extends Element>(selector: string): T | null => aside.querySelector<T>(selector);
  const list = q<HTMLElement>('[data-review-list]')!;
  const search = q<HTMLInputElement>('[data-review-search]')!;
  const sort = q<HTMLSelectElement>('[data-review-sort]')!;
  const overrideForm = q<HTMLFormElement>('[data-render-override]')!;
  const reason = q<HTMLTextAreaElement>('[data-override-reason]')!;
  const count = q<HTMLElement>('[data-override-count]')!;
  const error = q<HTMLElement>('[data-override-error]')!;
  const live = q<HTMLElement>('[data-review-live]')!;

  const externalOnChange = options.onChange;
  model.options.onChange = () => {
    if (!destroyed) paint();
    externalOnChange?.(model);
  };

  function activeIndex(): number {
    return model.rows.findIndex(row => row.clipId === model.activeId);
  }

  function scrollActiveIntoView(): void {
    const index = activeIndex();
    if (index < 0) return;
    const top = index * model.rowHeight;
    const bottom = top + model.rowHeight;
    if (top < model.scrollTop) model.scrollTop = top;
    else if (bottom > model.scrollTop + model.viewportHeight) model.scrollTop = bottom - model.viewportHeight;
    list.scrollTop = model.scrollTop;
  }

  function focusActive(): void {
    const index = activeIndex();
    if (index < 0) {
      (q<HTMLElement>('[data-review-close]') ?? list)?.focus();
      return;
    }
    scrollActiveIntoView();
    let row = aside.querySelector<HTMLElement>(`[id="review-option-${index}"]`);
    if (!row) {
      paint();
      row = aside.querySelector<HTMLElement>(`[id="review-option-${index}"]`);
    }
    row?.focus();
  }

  function paint(): void {
    if (destroyed) return;
    const counts = model.counts;
    const total = q<HTMLElement>('[data-review-count]');
    if (total) total.textContent = `${model.gate.approved}/${model.gate.total} approved`;
    aside.querySelectorAll<HTMLButtonElement>('[data-review-filter]').forEach(button => {
      const filter = button.dataset.reviewFilter as ReviewFilter | undefined;
      if (!filter) return;
      const active = filter === model.filter;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (active) button.dataset.active = 'true';
      else delete button.dataset.active;
      const target = button.querySelector<HTMLElement>(`[data-review-count-for="${filter}"]`);
      if (target) target.textContent = String(counts[filter]);
    });
    if (document.activeElement !== search && search.value !== model.query) search.value = model.query;
    if (document.activeElement !== sort) sort.value = model.sort;
    if (!model.activeId) model.ensureActive();
    const rows = model.rows;
    const view = windowRange(rows.length, model.scrollTop, model.viewportHeight, model.rowHeight, model.overscan);
    list.innerHTML = renderReviewWindow(rows, view, model.activeId);
    if (list.scrollTop !== model.scrollTop) list.scrollTop = model.scrollTop;
    const index = activeIndex();
    if (index >= 0) list.setAttribute('aria-activedescendant', `review-option-${index}`);
    else list.removeAttribute('aria-activedescendant');
    const actions = q<HTMLElement>('[data-review-gate-actions]');
    if (actions) actions.innerHTML = gateActions(model);
    const approveAll = q<HTMLButtonElement>('[data-review-approve-all]');
    if (approveAll) approveAll.disabled = !rows.some(row => row.group === 'needs') || model.busy;
    if (live.textContent !== model.liveMessage) live.textContent = model.liveMessage;
    bindGateActions();
  }

  function settleOverride(value: string | null): void {
    const resolve = pendingOverride;
    pendingOverride = null;
    resolve?.(value);
  }

  function hideOverride(): void {
    overrideForm.hidden = true;
    error.textContent = '';
    reason.value = '';
    count.textContent = `0 / ${MAX_OVERRIDE_REASON}`;
  }

  function openOverride(): Promise<string | null> {
    if (pendingOverride) settleOverride(null);
    open();
    if (model.gate.ok && model.clips.length > 0) return Promise.resolve(null);
    overrideForm.hidden = false;
    reason.focus();
    return new Promise<string | null>(resolve => { pendingOverride = resolve; });
  }

  function bindGateActions(): void {
    q<HTMLButtonElement>('[data-render-run]')?.addEventListener('click', () => {
      void options.onRender?.();
    });
    q<HTMLButtonElement>('[data-render-open-override]')?.addEventListener('click', () => {
      void openOverride().then(value => {
        if (value) void options.onRender?.(value);
      });
    });
  }

  function open(): void {
    if (!aside.hidden) return;
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    syncRowHeight();
    model.setViewportHeight(list.parentElement?.clientHeight || model.viewportHeight);
    aside.hidden = false;
    paint();
    focusActive();
    options.onOpenChange?.(true);
  }

  function close(returnFocus = true): void {
    if (aside.hidden) return;
    aside.hidden = true;
    hideOverride();
    settleOverride(null);
    options.onOpenChange?.(false);
    if (returnFocus) (lastFocus ?? null)?.focus?.();
  }

  aside.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const closeButton = target.closest('[data-review-close]');
    if (closeButton) { close(); return; }
    const filter = target.closest<HTMLButtonElement>('[data-review-filter]');
    if (filter?.dataset.reviewFilter) {
      model.setFilter(filter.dataset.reviewFilter as ReviewFilter);
      focusActive();
      return;
    }
    const row = target.closest<HTMLElement>('[data-review-clip]');
    if (row?.dataset.reviewClip) {
      model.setActive(row.dataset.reviewClip);
      options.onSelect?.(row.dataset.reviewClip);
      focusActive();
      return;
    }
    if (target.closest('[data-review-approve-all]')) {
      void model.approveVisible().then(() => focusActive());
      return;
    }
    if (target.closest('[data-override-cancel]')) {
      hideOverride();
      settleOverride(null);
      return;
    }
  });

  search.addEventListener('input', () => {
    model.setQuery(search.value);
    paint();
  });
  sort.addEventListener('change', () => {
    model.setSort(sort.value as ReviewSort);
    paint();
  });
  list.addEventListener('scroll', () => {
    model.setScrollTop(list.scrollTop);
  });

  aside.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (isEditableElement(event.target)) return;
    const key = event.key.toLowerCase();
    if (!['j', 'k', 'a', 'd', 'arrowup', 'arrowdown', 'enter'].includes(key)) return;
    event.preventDefault();
    void model.handleKey(event.key, { shiftKey: event.shiftKey })
      .then(handled => {
        if (handled) focusActive();
      });
  });

  overrideForm.addEventListener('input', () => {
    count.textContent = `${Math.min(MAX_OVERRIDE_REASON, reason.value.length)} / ${MAX_OVERRIDE_REASON}`;
  });
  overrideForm.addEventListener('submit', event => {
    event.preventDefault();
    const checked = validateOverride(reason.value);
    if (!checked.ok) {
      error.textContent = checked.error;
      reason.focus();
      return;
    }
    hideOverride();
    settleOverride(checked.reason);
  });

  const onDocumentKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() !== 'r' || isEditableElement(event.target)) return;
    event.preventDefault();
    open();
  };
  document.addEventListener('keydown', onDocumentKey);

  paint();

  return {
    element: aside,
    model,
    open,
    close,
    toggle() { if (aside.hidden) open(); else close(); },
    isOpen() { return !aside.hidden; },
    setClips(clips) { model.setClips(clips); },
    setGate(gate) { model.setGate(gate); },
    requestOverride(nextGate) {
      if (nextGate !== undefined) model.setGate(nextGate);
      return openOverride();
    },
    closeOverride() {
      hideOverride();
      settleOverride(null);
    },
    destroy() {
      destroyed = true;
      densityObserver?.disconnect();
      document.removeEventListener('keydown', onDocumentKey);
      settleOverride(null);
      aside.remove();
    },
  };
}

export const reviewDrawer = mountReviewDrawer;
