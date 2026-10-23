/**
 * IL19: side-by-side take comparison.
 *
 * Two to four takes are compared with one shared play/scrub state, a difference
 * overlay and a safe-area overlay. "Keep" is the only action that writes a
 * selection and it goes through the existing takes select API exactly once;
 * "Keep both for later" only pins a take in this view. Nothing here is modal
 * state on the server and no new route is introduced.
 */
import {
  isMediaTicketUrl,
  takeLooksLikeImage,
  takePosterMediaUrl,
  type ClipTake,
  type SelectResult,
  type TakesApi,
} from './api.ts';
import { escapeHtml } from './panel.ts';

export const COMPARE_MIN_TAKES = 2;
export const COMPARE_MAX_TAKES = 4;

export const compareKeyMap: Readonly<Record<string, string>> = Object.freeze({
  '1': 'focus take 1',
  '2': 'focus take 2',
  '3': 'focus take 3',
  '4': 'focus take 4',
  Space: 'play or pause all',
  Enter: 'keep the focused take',
  '[': 'previous shot',
  ']': 'next shot',
  Escape: 'close compare',
});

export const COMPARE_KEY_HELP =
  'Keyboard: 1-4 focus a take, Space plays or pauses all, Enter keeps the focused take, [ and ] move to the previous or next shot, Esc closes compare.';

export interface CompareShot {
  shotId: string;
  clipId: string;
  takes?: readonly ClipTake[];
  selected?: string | null;
}

export interface CompareControllerOptions {
  api: Pick<TakesApi, 'select'> & Partial<Pick<TakesApi, 'takeUrl'>>;
  packageId: string;
  clipId: string;
  shotId: string;
  takes: readonly ClipTake[];
  selected?: string | null;
  shots?: readonly CompareShot[];
  onClose?: () => void;
  onAnnounce?: (message: string) => void;
  onShotChange?: (shot: CompareShot) => void;
}

export interface CompareState {
  packageId: string;
  clipId: string;
  shotId: string;
  takes: ClipTake[];
  focusIndex: number;
  playing: boolean;
  position: number;
  showDifference: boolean;
  showSafeArea: boolean;
  pinned: Set<string>;
  selected: string | null;
  keepError: string | null;
  liveMessage: string;
  busy: boolean;
  closed: boolean;
  shots: CompareShot[];
  shotIndex: number;
}

export interface CompareKeyOptions {
  inEditable?: boolean;
}

export type CompareKeyCommand =
  | { kind: 'focus'; index: number }
  | { kind: 'play' }
  | { kind: 'keep' }
  | { kind: 'shot'; delta: -1 | 1 }
  | { kind: 'close' }
  | { kind: 'none' };

export function takeCompareLabel(position: number, total: number, shotId: unknown): string {
  const n = Number.isFinite(position) ? Math.max(1, Math.floor(position)) : 1;
  const m = Number.isFinite(total) ? Math.max(1, Math.floor(total)) : 1;
  return `Take ${n} of ${m}, shot ${String(shotId ?? '').trim() || 'unknown'}`;
}

export function compareKeyCommand(key: unknown): CompareKeyCommand {
  const value = typeof key === 'string' ? key : '';
  if (value === '1' || value === '2' || value === '3' || value === '4') {
    return { kind: 'focus', index: Number(value) - 1 };
  }
  if (value === ' ' || value === 'Spacebar' || value === 'Space') return { kind: 'play' };
  if (value === 'Enter') return { kind: 'keep' };
  if (value === '[') return { kind: 'shot', delta: -1 };
  if (value === ']') return { kind: 'shot', delta: 1 };
  if (value === 'Escape') return { kind: 'close' };
  return { kind: 'none' };
}

/** Compare only the newest four live takes; purged takes cannot be compared. */
export function compareVisibleTakes(
  takes: readonly ClipTake[] | null | undefined,
): ClipTake[] {
  const seen = new Set<string>();
  const list: ClipTake[] = [];
  for (const take of Array.isArray(takes) ? takes : []) {
    if (!take || typeof take.takeId !== 'string' || !take.takeId || take.purged === true) continue;
    if (seen.has(take.takeId)) continue;
    seen.add(take.takeId);
    list.push(take);
  }
  return list.slice(0, COMPARE_MAX_TAKES);
}

function clampPosition(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

/**
 * A shot entry is only usable when it carries both ids itself. A missing clip
 * id is never filled from the shot id; that entry is dropped instead.
 */
function normalizeShots(
  shots: readonly CompareShot[] | null | undefined,
  fallback: CompareShot,
): CompareShot[] {
  const list: CompareShot[] = [];
  for (const shot of Array.isArray(shots) ? shots : []) {
    if (!shot || typeof shot.shotId !== 'string' || !shot.shotId) continue;
    if (typeof shot.clipId !== 'string' || !shot.clipId) continue;
    list.push({
      shotId: shot.shotId,
      clipId: shot.clipId,
      ...(Array.isArray(shot.takes) ? { takes: compareVisibleTakes(shot.takes) } : {}),
      selected: typeof shot.selected === 'string' ? shot.selected : null,
    });
  }
  if (list.length === 0) return [fallback];
  if (!list.some(shot => shot.shotId === fallback.shotId || shot.clipId === fallback.clipId)) {
    list.unshift(fallback);
  }
  return list;
}

export function prefersReducedMotion(
  query?: (() => Pick<MediaQueryList, 'matches'> | null) | null,
): boolean {
  const resolve = query === undefined
    ? (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? () => window.matchMedia('(prefers-reduced-motion: reduce)')
        : null)
    : query;
  if (typeof resolve !== 'function') return false;
  try {
    return resolve()?.matches === true;
  } catch {
    return false;
  }
}

type CompareListener = (state: CompareState, change: CompareChange) => void;

export type CompareChange = 'all' | 'focus' | 'play' | 'overlay' | 'pin' | 'keep' | 'shot' | 'close';

export class CompareController {
  api: Pick<TakesApi, 'select'> & Partial<Pick<TakesApi, 'takeUrl'>>;
  packageId: string;
  state: CompareState;
  listeners: Set<CompareListener>;
  destroyed: boolean;
  onClose?: () => void;
  onAnnounce?: (message: string) => void;
  onShotChange?: (shot: CompareShot) => void;

  constructor(options: CompareControllerOptions) {
    if (!options?.api) throw new TypeError('CompareController requires an api');
    if (typeof options.api.select !== 'function') {
      throw new TypeError('CompareController requires the takes select API');
    }
    if (!options.packageId) throw new TypeError('CompareController requires a packageId');
    if (!options.clipId) throw new TypeError('CompareController requires a clipId');
    if (typeof options.shotId !== 'string' || !options.shotId.trim()) {
      throw new TypeError('CompareController requires a shotId');
    }

    const takes = compareVisibleTakes(options.takes);
    const shotId = options.shotId;
    const shots = normalizeShots(options.shots, {
      shotId,
      clipId: options.clipId,
      takes,
      selected: typeof options.selected === 'string' ? options.selected : null,
    });
    const shotIndex = Math.max(0, shots.findIndex(shot => (
      shot.shotId === shotId || shot.clipId === options.clipId
    )));
    const active = shots[shotIndex] ?? shots[0]!;

    this.api = options.api;
    this.packageId = options.packageId;
    this.onClose = options.onClose;
    this.onAnnounce = options.onAnnounce;
    this.onShotChange = options.onShotChange;
    this.listeners = new Set();
    this.destroyed = false;
    this.state = {
      packageId: options.packageId,
      clipId: active.clipId,
      shotId: active.shotId,
      takes,
      focusIndex: 0,
      playing: false,
      position: 0,
      showDifference: false,
      showSafeArea: false,
      pinned: new Set(),
      selected: typeof options.selected === 'string' ? options.selected : active.selected ?? null,
      keepError: null,
      liveMessage: takes.length > 0
        ? takeCompareLabel(1, Math.max(1, takes.length), active.shotId)
        : 'Compare needs at least two takes.',
      busy: false,
      closed: false,
      shots,
      shotIndex,
    };
  }

  subscribe(listener: CompareListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get focusedTake(): ClipTake | null {
    return this.state.takes[this.state.focusIndex] ?? null;
  }

  private announce(message: string): void {
    this.state.liveMessage = message;
    this.onAnnounce?.(message);
  }

  private notify(change: CompareChange = 'all'): void {
    if (this.destroyed) return;
    for (const listener of Array.from(this.listeners)) {
      try { listener(this.state, change); } catch { /* a view error must not break compare */ }
    }
  }

  focusTake(index: number): boolean {
    if (!Number.isFinite(index)) return false;
    const next = Math.floor(index);
    if (next < 0 || next >= this.state.takes.length) return false;
    this.state.focusIndex = next;
    this.announce(takeCompareLabel(next + 1, this.state.takes.length, this.state.shotId));
    this.notify('focus');
    return true;
  }

  togglePlayback(): boolean {
    this.state.playing = !this.state.playing;
    this.announce(this.state.playing ? 'Playing all takes' : 'Paused all takes');
    this.notify('play');
    return true;
  }

  play(): void {
    if (this.state.playing) return;
    this.state.playing = true;
    this.announce('Playing all takes');
    this.notify('play');
  }

  pause(): void {
    if (!this.state.playing) return;
    this.state.playing = false;
    this.announce('Paused all takes');
    this.notify('play');
  }

  /** One shared position in 0..1 keeps every take on the same frame. */
  scrubTo(value: unknown): number {
    this.state.position = clampPosition(value);
    this.notify('play');
    return this.state.position;
  }

  private overlayMessage(): string {
    const parts: string[] = [];
    parts.push(this.state.showDifference ? 'Difference overlay on' : 'Difference overlay off');
    parts.push(this.state.showSafeArea ? 'Safe area overlay on' : 'Safe area overlay off');
    return parts.join('. ');
  }

  toggleDifference(): boolean {
    this.state.showDifference = !this.state.showDifference;
    this.announce(this.overlayMessage());
    this.notify('overlay');
    return true;
  }

  toggleSafeArea(): boolean {
    this.state.showSafeArea = !this.state.showSafeArea;
    this.announce(this.overlayMessage());
    this.notify('overlay');
    return true;
  }

  /** Keep both for later is local: it pins and never writes a selection. */
  pinFocused(): boolean {
    const take = this.focusedTake;
    if (!take || this.state.busy) return false;
    const label = takeCompareLabel(this.state.focusIndex + 1, this.state.takes.length, this.state.shotId);
    if (this.state.pinned.has(take.takeId)) {
      this.state.pinned.delete(take.takeId);
      this.announce(`Unpinned ${label} for later`);
    } else {
      this.state.pinned.add(take.takeId);
      this.announce(`Pinned ${label} for later`);
    }
    this.notify('pin');
    return true;
  }

  /**
   * Keep delegates to the existing select route through the takes API. The
   * busy guard makes a double Enter/click a no-op, so one gesture is one call.
   * The selection is only ever the take id the server confirms in its response.
   */
  async keepFocused(): Promise<boolean> {
    if (this.state.busy) return false;
    const take = this.focusedTake;
    if (!take) return false;
    const label = takeCompareLabel(this.state.focusIndex + 1, this.state.takes.length, this.state.shotId);
    this.state.busy = true;
    this.notify('all');
    try {
      const result = await this.api.select(this.state.packageId, this.state.clipId, take.takeId) as SelectResult | undefined;
      const confirmed = typeof result?.takeId === 'string' && result.takeId ? result.takeId : '';
      if (!confirmed) {
        const message = 'Keep failed: the server did not confirm the take';
        this.state.keepError = message;
        this.announce(message);
        this.notify('keep');
        return false;
      }
      this.state.keepError = null;
      this.state.selected = confirmed;
      this.announce(`Kept ${label}.`);
      this.notify('keep');
      return true;
    } catch (error) {
      const reason = error instanceof Error && error.message ? `: ${error.message}` : '';
      this.state.keepError = `Could not keep ${label}${reason}`;
      this.announce(this.state.keepError);
      this.notify('keep');
      return false;
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  private applyShot(index: number): boolean {
    const shots = this.state.shots;
    if (shots.length < 2) return false;
    const nextIndex = (index + shots.length) % shots.length;
    const shot = shots[nextIndex]!;
    this.state.shotIndex = nextIndex;
    this.state.shotId = shot.shotId;
    this.state.clipId = shot.clipId;
    if (Array.isArray(shot.takes)) {
      this.state.takes = compareVisibleTakes(shot.takes);
      this.state.selected = typeof shot.selected === 'string' ? shot.selected : null;
    }
    this.state.focusIndex = 0;
    this.state.position = 0;
    this.state.playing = false;
    this.state.keepError = null;
    this.announce(takeCompareLabel(1, Math.max(1, this.state.takes.length), shot.shotId));
    this.onShotChange?.(shot);
    this.notify('shot');
    return true;
  }

  previousShot(): boolean {
    return this.applyShot(this.state.shotIndex - 1);
  }

  nextShot(): boolean {
    return this.applyShot(this.state.shotIndex + 1);
  }

  close(): boolean {
    if (this.state.closed) return false;
    this.state.closed = true;
    this.announce('Compare closed.');
    this.onClose?.();
    this.notify('close');
    return true;
  }

  async handleKey(key: unknown, options: CompareKeyOptions = {}): Promise<boolean> {
    if (options.inEditable) return false;
    const command = compareKeyCommand(key);
    if (command.kind === 'none') return false;
    if (command.kind === 'focus') return this.focusTake(command.index);
    if (command.kind === 'play') return this.togglePlayback();
    if (command.kind === 'keep') return await this.keepFocused();
    if (command.kind === 'shot') {
      return command.delta < 0 ? this.previousShot() : this.nextShot();
    }
    return this.close();
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }
}

function statusAttribute(take: ClipTake, state: CompareState): string {
  if (take.takeId === state.selected) return 'kept';
  if (state.pinned.has(take.takeId)) return 'pinned';
  if (state.takes[state.focusIndex]?.takeId === take.takeId) return 'focused';
  return 'idle';
}

function renderMedia(take: ClipTake): string {
  const poster = takePosterMediaUrl(take);
  const image = takeLooksLikeImage(take);
  const id = escapeHtml(take.takeId);
  const media = image
    ? `<img class="compare-media-el compare-poster" data-compare-media="${id}" data-media-kind="image" alt="" loading="lazy" decoding="async"${poster ? ` src="${escapeHtml(poster)}"` : ''} />`
    : `<video class="compare-media-el" data-compare-media="${id}" data-media-kind="video" muted playsinline preload="metadata"${poster ? ` poster="${escapeHtml(poster)}"` : ''}></video>`;
  return `<div class="compare-media" aria-hidden="true">
    <span class="compare-media-frame"></span>
    ${media}
  </div>`;
}

function renderTake(take: ClipTake, index: number, state: CompareState): string {
  const focused = index === state.focusIndex;
  const pinned = state.pinned.has(take.takeId);
  const kept = take.takeId === state.selected;
  const label = takeCompareLabel(index + 1, state.takes.length, state.shotId);
  const classes = [
    'compare-take',
    focused ? 'is-focused' : '',
    pinned ? 'is-pinned' : '',
    kept ? 'is-kept' : '',
  ].filter(Boolean).join(' ');
  const flags = [
    focused ? 'Focused' : '',
    kept ? 'Kept' : '',
    pinned ? 'Pinned' : '',
  ].filter(Boolean);
  return `<li class="${classes}" data-compare-take="${escapeHtml(take.takeId)}" data-take-index="${index}" data-compare-status="${statusAttribute(take, state)}" data-focused="${focused ? 'true' : 'false'}" data-pinned="${pinned ? 'true' : 'false'}" tabindex="${focused ? '0' : '-1'}" role="group" aria-label="${escapeHtml(label)}"${focused ? ' aria-current="true"' : ''}>
    ${renderMedia(take)}
    <div class="compare-take-bar">
      <span class="compare-take-label">${escapeHtml(label)}</span>
      <span class="compare-take-flags">${flags.map(flag => `<span class="compare-state-text" data-state="${flag.toLowerCase()}">${escapeHtml(flag)}</span>`).join('')}</span>
    </div>
  </li>`;
}

export function renderCompare(state: CompareState): string {
  const total = state.takes.length;
  const focused = state.takes[state.focusIndex];
  const focusedLabel = focused
    ? takeCompareLabel(state.focusIndex + 1, total, state.shotId)
    : `shot ${state.shotId}`;
  const takes = state.takes.map((take, index) => renderTake(take, index, state)).join('');
  const playLabel = state.playing ? 'Pause all' : 'Play all';
  return `<section class="compare-view" data-compare-view role="dialog" aria-modal="true" aria-labelledby="compare-title" aria-describedby="compare-keys" data-compare-shot="${escapeHtml(state.shotId)}" data-compare-position="${state.position}"${state.closed ? ' hidden' : ''}>
    <header class="compare-head">
      <div class="compare-head-main">
        <h2 id="compare-title" class="compare-title">Compare takes</h2>
        <span class="compare-shot" data-compare-shot-label>Shot <code>${escapeHtml(state.shotId)}</code></span>
      </div>
      <button type="button" class="btn btn-ghost btn-icon btn-sm compare-close" data-compare-close aria-label="Close compare" aria-keyshortcuts="Escape">✕</button>
    </header>
    <div class="compare-toolbar" role="toolbar" aria-label="Compare controls">
      <button type="button" class="btn btn-secondary btn-sm" data-compare-play aria-pressed="${state.playing ? 'true' : 'false'}" aria-keyshortcuts="Space">${playLabel}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-compare-difference aria-pressed="${state.showDifference ? 'true' : 'false'}">Difference</button>
      <button type="button" class="btn btn-secondary btn-sm" data-compare-safe-area aria-pressed="${state.showSafeArea ? 'true' : 'false'}">Safe area</button>
      <button type="button" class="btn btn-secondary btn-sm" data-compare-pin aria-pressed="${focused && state.pinned.has(focused.takeId) ? 'true' : 'false'}"${focused && !state.busy ? '' : ' disabled'}>Keep both for later</button>
      <button type="button" class="btn btn-primary primary btn-sm" data-compare-keep${focused && !state.busy ? '' : ' disabled'}>Keep</button>
    </div>
    <div class="compare-stage" data-difference="${state.showDifference ? 'on' : 'off'}" data-safe-area="${state.showSafeArea ? 'on' : 'off'}">
      <ol class="compare-takes" aria-label="${escapeHtml(`Takes for shot ${state.shotId}`)}" aria-keyshortcuts="1 2 3 4"${state.busy ? ' aria-busy="true"' : ''}>${takes}</ol>
      ${state.showDifference ? '<span class="compare-overlay compare-overlay-difference" aria-hidden="true">Difference overlay</span>' : ''}
      ${state.showSafeArea ? '<span class="compare-overlay compare-overlay-safe-area" aria-hidden="true">Safe area</span>' : ''}
    </div>
    <div class="compare-scrub">
      <label class="compare-scrub-field" for="compare-scrub">Position for all takes</label>
      <input id="compare-scrub" class="field-control compare-scrub-input" type="range" min="0" max="100" step="1" data-compare-scrub value="${Math.round(state.position * 100)}" />
      <span class="compare-time tabular-nums" data-compare-time>${Math.round(state.position * 100)}%</span>
    </div>
    <ul class="compare-legend" aria-label="Compare states">
      <li data-compare-status="focused"><span class="compare-state-text">Focused</span></li>
      <li data-compare-status="kept"><span class="compare-state-text">Kept</span></li>
      <li data-compare-status="pinned"><span class="compare-state-text">Pinned</span></li>
    </ul>
    <p class="compare-live hint" data-compare-live role="status" aria-live="polite">${escapeHtml(state.liveMessage)}</p>
    <p class="compare-error" data-compare-error role="alert"${state.keepError ? '' : ' hidden'}>${escapeHtml(state.keepError ?? '')}</p>
    <p class="compare-keys hint" id="compare-keys" data-compare-keys>${escapeHtml(COMPARE_KEY_HELP)}</p>
    <p class="compare-current hint" data-compare-current>${escapeHtml(focusedLabel)}</p>
  </section>`;
}

let stylesRequested = false;

function ensureStyles(): void {
  if (stylesRequested || typeof document === 'undefined') return;
  stylesRequested = true;
  void import('./panel.css').catch(() => undefined);
}

export type CompareMountOptions = CompareControllerOptions;

export interface CompareHandle {
  element: HTMLElement;
  controller: CompareController;
  focusTake(index: number): boolean;
  destroy(): void;
}

function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = String(element.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return element.isContentEditable === true;
}

function mediaElements(root: HTMLElement): HTMLMediaElement[] {
  return Array.from(root.querySelectorAll<HTMLMediaElement>('audio, video'));
}

/**
 * Mount the compare view. The markup is rendered as one string and only the
 * click, input and keydown hooks are bound, matching the other takes views.
 */
export function mountCompare(host: HTMLElement, options: CompareMountOptions): CompareHandle {
  if (!host) throw new TypeError('mountCompare requires a host element');
  ensureStyles();
  const controller = new CompareController(options);
  const reducedMotion = prefersReducedMotion();
  host.innerHTML = renderCompare(controller.state);
  const view = host.querySelector<HTMLElement>('[data-compare-view]');
  if (!view) throw new TypeError('mountCompare could not render the compare view');
  view.dataset.reducedMotion = reducedMotion ? 'true' : 'false';

  let destroyed = false;
  let focusBeforeRender = '';

  const paint = (focusNew = false): void => {
    if (destroyed) return;
    if (focusNew) {
      focusBeforeRender = '';
    } else {
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (active instanceof HTMLElement && host.contains(active)) {
        const take = active.closest<HTMLElement>('[data-compare-take]');
        focusBeforeRender = take?.getAttribute('data-compare-take') ?? '';
      }
    }
    host.innerHTML = renderCompare(controller.state);
    const next = host.querySelector<HTMLElement>('[data-compare-view]');
    if (next) next.dataset.reducedMotion = reducedMotion ? 'true' : 'false';
    if (controller.state.closed) return;
    const selector = focusBeforeRender
      ? `[data-compare-take="${focusBeforeRender.replace(/"/g, '\\"')}"]`
      : '[data-compare-take][tabindex="0"]';
    host.querySelector<HTMLElement>(selector)?.focus();
    void hydrateMedia();
  };

  const mediaUrls = new Map<string, string>();
  let mediaToken = 0;

  /**
   * Media tickets are minted by the existing takes API. The controller and the
   * tests work without takeUrl; when it is present each take gets one ticket.
   */
  const hydrateMedia = async (): Promise<void> => {
    const takeUrl = controller.api.takeUrl;
    if (typeof takeUrl !== 'function') return;
    const token = ++mediaToken;
    for (const take of controller.state.takes) {
      const element = Array.from(host.querySelectorAll<HTMLElement>('[data-compare-media]'))
        .find(node => node.getAttribute('data-compare-media') === take.takeId);
      if (!element) continue;
      let url = mediaUrls.get(take.takeId) ?? '';
      if (!url) {
        try {
          url = await takeUrl.call(controller.api, controller.state.packageId, controller.state.clipId, take.takeId);
        } catch {
          continue;
        }
        if (!isMediaTicketUrl(url)) continue;
        mediaUrls.set(take.takeId, url);
      }
      if (destroyed || token !== mediaToken) return;
      if (element.getAttribute('src') !== url) element.setAttribute('src', url);
    }
    applyMedia();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (compareKeyCommand(key).kind === 'none') return;
    if (isEditable(event.target)) return;
    event.preventDefault();
    void controller.handleKey(key);
  };

  const applyMedia = (): void => {
    const { playing, position } = controller.state;
    for (const media of mediaElements(host)) {
      try {
        const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
        if (duration > 0) media.currentTime = position * duration;
        if (playing) {
          const result = media.play();
          if (result && typeof result.catch === 'function') result.catch(() => undefined);
        } else {
          media.pause();
        }
      } catch {
        /* a take without a loaded media file still scrubs its placed frame */
      }
    }
  };

  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const take = target.closest<HTMLElement>('[data-compare-take]');
    const takeId = take?.getAttribute('data-compare-take');
    if (takeId) {
      const index = controller.state.takes.findIndex(item => item.takeId === takeId);
      if (index >= 0) controller.focusTake(index);
      return;
    }
    if (target.closest('[data-compare-close]')) { controller.close(); return; }
    if (target.closest('[data-compare-play]')) {
      if (controller.state.playing) controller.pause();
      else controller.play();
      applyMedia();
      return;
    }
    if (target.closest('[data-compare-difference]')) { controller.toggleDifference(); return; }
    if (target.closest('[data-compare-safe-area]')) { controller.toggleSafeArea(); return; }
    if (target.closest('[data-compare-pin]')) { controller.pinFocused(); return; }
    if (target.closest('[data-compare-keep]')) { void controller.keepFocused(); }
  };

  const onInput = (event: Event): void => {
    const target = event.target as HTMLInputElement | null;
    if (!target || !target.hasAttribute('data-compare-scrub')) return;
    controller.scrubTo(Number(target.value) / 100);
    applyMedia();
  };

  const unsubscribe = controller.subscribe((_state, change) => {
    const focusNew = change === 'focus' || change === 'shot';
    paint(focusNew);
    if (change === 'play') applyMedia();
  });

  host.addEventListener('click', onClick);
  host.addEventListener('input', onInput);
  host.addEventListener('keydown', onKeyDown);
  host.querySelector<HTMLElement>('[data-compare-take][tabindex="0"]')?.focus();
  void hydrateMedia();

  return {
    get element() {
      return host.querySelector<HTMLElement>('[data-compare-view]') ?? view;
    },
    controller,
    focusTake(index: number) {
      const focused = controller.focusTake(index);
      paint();
      return focused;
    },
    destroy() {
      destroyed = true;
      unsubscribe();
      controller.destroy();
      host.removeEventListener('click', onClick);
      host.removeEventListener('input', onInput);
      host.removeEventListener('keydown', onKeyDown);
      host.innerHTML = '';
    },
  };
}
