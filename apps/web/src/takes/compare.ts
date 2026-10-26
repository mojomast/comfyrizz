/**
 * IL19 / UX12: side-by-side take comparison.
 *
 * Two to four takes are compared with one shared seconds/frame position, one
 * audible monitored take, a difference overlay and a safe-area overlay. "Keep"
 * is the only action that writes a selection and it goes through the existing
 * takes select API exactly once, using the exact shot/clip/take target captured
 * when the gesture started. "Favorite for later" is an honest, persisted local
 * favorite and never writes a selection. Nothing here is modal state on the
 * server and no new route is introduced.
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

/** The exact write target; frozen so navigation cannot rewrite an in-flight Keep. */
export interface CompareTarget {
  readonly packageId: string;
  readonly shotId: string;
  readonly clipId: string;
  readonly takeId: string;
}

export interface CompareFavoriteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const COMPARE_END_BEHAVIOR = 'clamp-each-take';
export const COMPARE_FAVORITES_KEY = 'comfyrizz.compare.favorites.v1';
const FALLBACK_FPS = 24;

export interface CompareControllerOptions {
  api: Pick<TakesApi, 'select'> & Partial<Pick<TakesApi, 'takeUrl'>>;
  packageId: string;
  clipId: string;
  shotId: string;
  takes: readonly ClipTake[];
  selected?: string | null;
  shots?: readonly CompareShot[];
  storage?: CompareFavoriteStorage | null;
  favoritesKey?: string;
  onClose?: () => void;
  onAnnounce?: (message: string) => void;
  onShotChange?: (shot: CompareShot) => void;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A take's duration in seconds, from the media summary without guessing. */
export function takeDurationSeconds(take: ClipTake | null | undefined): number {
  const media = take?.media;
  const duration = finiteNumber(media?.durationInSeconds);
  if (duration > 0) return duration;
  const fps = finiteNumber(media?.fps);
  const frames = finiteNumber(media?.frames);
  return fps > 0 && frames > 0 ? frames / fps : 0;
}

export function takeFps(take: ClipTake | null | undefined): number {
  const fps = finiteNumber(take?.media?.fps);
  return fps > 0 ? fps : FALLBACK_FPS;
}

/**
 * One shared position in seconds mapped onto one take. A shorter take stops at
 * its own end while a longer take keeps the shared second, which is the
 * explicit end behaviour of the comparison.
 */
export function takeTimeAtSeconds(
  take: ClipTake | null | undefined,
  seconds: unknown,
): { seconds: number; frame: number; atEnd: boolean } {
  const duration = takeDurationSeconds(take);
  const requested = Math.max(0, finiteNumber(seconds));
  const clamped = duration > 0 ? Math.min(duration, requested) : requested;
  return {
    seconds: clamped,
    frame: Math.round(clamped * takeFps(take)),
    atEnd: duration > 0 && clamped >= duration,
  };
}

function makeTarget(
  packageId: string,
  shotId: string,
  clipId: string,
  takeId: string | null | undefined,
): CompareTarget | null {
  if (typeof takeId !== 'string' || !takeId) return null;
  return Object.freeze({ packageId, shotId, clipId, takeId });
}

function sharedDuration(takes: readonly ClipTake[]): number {
  let duration = 0;
  for (const take of takes) duration = Math.max(duration, takeDurationSeconds(take));
  return duration;
}

function resolveFavoriteStorage(
  storage: CompareFavoriteStorage | null | undefined,
): CompareFavoriteStorage | null {
  if (storage !== undefined) return storage;
  try {
    const candidate = (globalThis as { localStorage?: CompareFavoriteStorage }).localStorage;
    if (candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function') {
      return candidate;
    }
  } catch {
    /* storage can be fenced by the browser; favorites then stay in-session */
  }
  return null;
}

export interface CompareState {
  packageId: string;
  clipId: string;
  shotId: string;
  target: CompareTarget | null;
  takes: ClipTake[];
  focusIndex: number;
  playing: boolean;
  position: number;
  positionSeconds: number;
  positionFrame: number;
  durationSeconds: number;
  endBehavior: typeof COMPARE_END_BEHAVIOR;
  monitoredTakeId: string | null;
  showDifference: boolean;
  showSafeArea: boolean;
  pinned: Set<string>;
  favoritePersistent: boolean;
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
 * id is never filled from the shot id; that entry is dropped instead. A shot
 * (package scene) may hold several clips, so another clipId under the caller's
 * shotId is a sibling and stays; an entry that puts the caller's clipId under
 * another shotId contradicts it and is dropped. The caller's exact shotId +
 * clipId pair is the one the compare view opens on.
 */
function normalizeShots(
  shots: readonly CompareShot[] | null | undefined,
  fallback: CompareShot,
): CompareShot[] {
  const list: CompareShot[] = [];
  for (const shot of Array.isArray(shots) ? shots : []) {
    if (!shot || typeof shot.shotId !== 'string' || !shot.shotId) continue;
    if (typeof shot.clipId !== 'string' || !shot.clipId) continue;
    if (shot.clipId === fallback.clipId && shot.shotId !== fallback.shotId) continue;
    list.push({
      shotId: shot.shotId,
      clipId: shot.clipId,
      ...(Array.isArray(shot.takes) ? { takes: compareVisibleTakes(shot.takes) } : {}),
      selected: typeof shot.selected === 'string' ? shot.selected : null,
    });
  }
  if (list.length === 0) return [fallback];
  if (!list.some(shot => shot.shotId === fallback.shotId && shot.clipId === fallback.clipId)) {
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
  storage: CompareFavoriteStorage | null;
  favoritesKey: string;
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
      shot.shotId === shotId && shot.clipId === options.clipId
    )));
    const active = shots[shotIndex] ?? shots[0]!;

    this.api = options.api;
    this.packageId = options.packageId;
    this.storage = resolveFavoriteStorage(options.storage);
    this.favoritesKey = options.favoritesKey || COMPARE_FAVORITES_KEY;
    this.onClose = options.onClose;
    this.onAnnounce = options.onAnnounce;
    this.onShotChange = options.onShotChange;
    this.listeners = new Set();
    this.destroyed = false;
    const activeTakes = takes;
    const focused = activeTakes[0] ?? null;
    this.state = {
      packageId: options.packageId,
      clipId: active.clipId,
      shotId: active.shotId,
      target: makeTarget(options.packageId, active.shotId, active.clipId, focused?.takeId),
      takes: activeTakes,
      focusIndex: 0,
      playing: false,
      position: 0,
      positionSeconds: 0,
      positionFrame: 0,
      durationSeconds: sharedDuration(activeTakes),
      endBehavior: COMPARE_END_BEHAVIOR,
      monitoredTakeId: focused?.takeId ?? null,
      showDifference: false,
      showSafeArea: false,
      pinned: this.loadFavorites(),
      favoritePersistent: this.storage !== null,
      selected: typeof options.selected === 'string' ? options.selected : active.selected ?? null,
      keepError: null,
      liveMessage: activeTakes.length > 0
        ? takeCompareLabel(1, Math.max(1, activeTakes.length), active.shotId)
        : 'Compare needs at least two takes.',
      busy: false,
      closed: false,
      shots,
      shotIndex,
    };
  }

  private loadFavorites(): Set<string> {
    if (!this.storage) return new Set();
    try {
      const raw = this.storage.getItem(this.favoritesKey);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((value: unknown) => typeof value === 'string' && value));
    } catch {
      return new Set();
    }
  }

  private saveFavorites(): boolean {
    if (!this.storage) {
      this.state.favoritePersistent = false;
      return false;
    }
    try {
      this.storage.setItem(this.favoritesKey, JSON.stringify(Array.from(this.state.pinned)));
      this.state.favoritePersistent = true;
      return true;
    } catch {
      this.state.favoritePersistent = false;
      return false;
    }
  }

  private syncTarget(): void {
    const focused = this.focusedTake;
    this.state.target = makeTarget(
      this.state.packageId,
      this.state.shotId,
      this.state.clipId,
      focused?.takeId,
    );
  }

  canKeep(): boolean {
    return stateCanKeep(this.state);
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
    this.state.monitoredTakeId = this.state.takes[next]?.takeId ?? null;
    this.syncTarget();
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

  private applyPosition(seconds: number): void {
    const duration = this.state.durationSeconds;
    const clamped = Math.max(0, Math.min(duration > 0 ? duration : 0, finiteNumber(seconds)));
    this.state.positionSeconds = clamped;
    this.state.position = duration > 0 ? clamped / duration : 0;
    this.state.positionFrame = Math.round(clamped * this.referenceFps());
  }

  private referenceFps(): number {
    return takeFps(this.focusedTake ?? this.state.takes[0]);
  }

  /** One shared position in 0..1 keeps every take on the same frame. */
  scrubTo(value: unknown): number {
    this.state.position = clampPosition(value);
    this.applyPosition(this.state.position * this.state.durationSeconds);
    this.notify('play');
    return this.state.position;
  }

  /** One shared position in seconds; each take clamps to its own end. */
  setPositionSeconds(value: unknown): number {
    this.applyPosition(finiteNumber(value));
    this.notify('play');
    return this.state.positionSeconds;
  }

  takeTime(takeId: string): { seconds: number; frame: number; atEnd: boolean } | null {
    const take = this.state.takes.find(item => item.takeId === takeId);
    if (!take) return null;
    return takeTimeAtSeconds(take, this.state.positionSeconds);
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

  /**
   * Favorites are local and persisted; they never write a selection. If the
   * browser cannot persist them, the message says they last only this session
   * instead of claiming they were saved.
   */
  pinFocused(): boolean {
    const take = this.focusedTake;
    if (!take || this.state.busy) return false;
    const label = takeCompareLabel(this.state.focusIndex + 1, this.state.takes.length, this.state.shotId);
    let removing = false;
    if (this.state.pinned.has(take.takeId)) {
      this.state.pinned.delete(take.takeId);
      removing = true;
    } else {
      this.state.pinned.add(take.takeId);
    }
    const persisted = this.saveFavorites();
    const scope = persisted ? 'saved' : 'saved for this session only';
    this.announce(
      removing
        ? `Removed ${label} from favorites (${scope})`
        : `Favorited ${label} (${scope})`,
    );
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
    if (!this.canKeep()) return false;
    const take = this.focusedTake!;
    const target = this.state.target!;
    const label = takeCompareLabel(this.state.focusIndex + 1, this.state.takes.length, target.shotId);
    this.state.busy = true;
    this.notify('all');
    try {
      const result = await this.api.select(target.packageId, target.clipId, target.takeId) as SelectResult | undefined;
      if (this.state.target?.takeId !== target.takeId || this.state.target?.clipId !== target.clipId) {
        const message = 'Keep was not applied: the compare selection changed while it was in flight.';
        this.state.keepError = message;
        this.announce(message);
        this.notify('keep');
        return false;
      }
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
    this.state.takes = compareVisibleTakes(shot.takes);
    this.state.selected = typeof shot.selected === 'string' ? shot.selected : null;
    this.state.focusIndex = 0;
    this.state.playing = false;
    this.state.keepError = null;
    this.state.durationSeconds = sharedDuration(this.state.takes);
    this.state.monitoredTakeId = this.state.takes[0]?.takeId ?? null;
    this.applyPosition(0);
    this.syncTarget();
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

function stateCanKeep(state: CompareState): boolean {
  const focused = state.takes[state.focusIndex] ?? null;
  const target = state.target;
  return (
    !state.busy &&
    state.takes.length >= COMPARE_MIN_TAKES &&
    target !== null &&
    focused !== null &&
    target.shotId === state.shotId &&
    target.clipId === state.clipId &&
    target.takeId === focused.takeId &&
    Boolean(target.packageId)
  );
}

function renderMedia(take: ClipTake, state: CompareState): string {
  const poster = takePosterMediaUrl(take);
  const image = takeLooksLikeImage(take);
  const id = escapeHtml(take.takeId);
  const monitored = take.takeId === state.monitoredTakeId;
  const media = image
    ? `<img class="compare-media-el compare-poster" data-compare-media="${id}" data-media-kind="image" data-monitored="false" alt="" loading="lazy" decoding="async"${poster ? ` src="${escapeHtml(poster)}"` : ''} />`
    : `<video class="compare-media-el" data-compare-media="${id}" data-media-kind="video" data-monitored="${monitored ? 'true' : 'false'}"${monitored ? '' : ' muted'} playsinline preload="metadata"${poster ? ` poster="${escapeHtml(poster)}"` : ''}></video>`;
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
  const time = takeTimeAtSeconds(take, state.positionSeconds);
  return `<li class="${classes}" data-compare-take="${escapeHtml(take.takeId)}" data-take-index="${index}" data-compare-status="${statusAttribute(take, state)}" data-focused="${focused ? 'true' : 'false'}" data-pinned="${pinned ? 'true' : 'false'}" data-take-seconds="${Number(time.seconds.toFixed(3))}" data-take-frame="${time.frame}" data-take-at-end="${time.atEnd ? 'true' : 'false'}" tabindex="${focused ? '0' : '-1'}" role="group" aria-label="${escapeHtml(label)}"${focused ? ' aria-current="true"' : ''}>
    ${renderMedia(take, state)}
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
  const favoriteLabel = focused && state.pinned.has(focused.takeId) ? 'Remove favorite' : 'Favorite for later';
  const keepEnabled = stateCanKeep(state);
  return `<section class="compare-view" data-compare-view role="dialog" aria-modal="true" aria-labelledby="compare-title" aria-describedby="compare-keys" data-compare-shot="${escapeHtml(state.shotId)}" data-compare-position="${state.position}" data-compare-seconds="${Number(state.positionSeconds.toFixed(3))}" data-compare-frame="${state.positionFrame}" data-compare-duration="${Number(state.durationSeconds.toFixed(3))}" data-compare-end="${state.endBehavior}" data-compare-monitored="${escapeHtml(state.monitoredTakeId ?? '')}"${state.closed ? ' hidden' : ''}>
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
      <button type="button" class="btn btn-secondary btn-sm" data-compare-pin aria-pressed="${focused && state.pinned.has(focused.takeId) ? 'true' : 'false'}"${focused && !state.busy ? '' : ' disabled'}>${escapeHtml(favoriteLabel)}</button>
      <button type="button" class="btn btn-primary primary btn-sm" data-compare-keep${keepEnabled ? '' : ' disabled'}>Keep</button>
    </div>
    <div class="compare-stage" data-difference="${state.showDifference ? 'on' : 'off'}" data-safe-area="${state.showSafeArea ? 'on' : 'off'}">
      <ol class="compare-takes" aria-label="${escapeHtml(`Takes for shot ${state.shotId}`)}" aria-keyshortcuts="1 2 3 4"${state.busy ? ' aria-busy="true"' : ''}>${takes}</ol>
      <span class="compare-overlay compare-overlay-difference" aria-hidden="true"${state.showDifference ? '' : ' hidden'}>Difference overlay</span>
      <span class="compare-overlay compare-overlay-safe-area" aria-hidden="true"${state.showSafeArea ? '' : ' hidden'}>Safe area</span>
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

function isActivationControl(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = String(element.tagName ?? '').toLowerCase();
  return tag === 'button' || tag === 'a' || tag === 'summary';
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

  const paintFull = (focusNew = false): void => {
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
    bindMediaEvents();
    void hydrateMedia();
  };

  /**
   * Focus, play, pin, overlay and keep changes patch the existing nodes so the
   * players (and their buffered media) stay the same elements. Only a shot
   * change replaces the markup, because it replaces the take set itself.
   */
  const patch = (): void => {
    if (destroyed) return;
    const state = controller.state;
    const view = host.querySelector<HTMLElement>('[data-compare-view]');
    if (!view) {
      paintFull(false);
      return;
    }
    view.setAttribute('data-compare-shot', state.shotId);
    view.setAttribute('data-compare-position', String(state.position));
    view.setAttribute('data-compare-seconds', String(Number(state.positionSeconds.toFixed(3))));
    view.setAttribute('data-compare-frame', String(state.positionFrame));
    view.setAttribute('data-compare-duration', String(Number(state.durationSeconds.toFixed(3))));
    view.setAttribute('data-compare-monitored', state.monitoredTakeId ?? '');
    view.toggleAttribute('hidden', state.closed);

    for (const row of Array.from(host.querySelectorAll<HTMLElement>('[data-compare-take]'))) {
      const takeId = row.getAttribute('data-compare-take');
      const index = state.takes.findIndex(take => take.takeId === takeId);
      const take = index >= 0 ? state.takes[index] : null;
      if (!take) continue;
      const focused = index === state.focusIndex;
      const pinned = state.pinned.has(take.takeId);
      const kept = take.takeId === state.selected;
      row.className = [
        'compare-take',
        focused ? 'is-focused' : '',
        pinned ? 'is-pinned' : '',
        kept ? 'is-kept' : '',
      ].filter(Boolean).join(' ');
      row.setAttribute('data-compare-status', statusAttribute(take, state));
      row.setAttribute('data-focused', focused ? 'true' : 'false');
      row.setAttribute('data-pinned', pinned ? 'true' : 'false');
      row.setAttribute('tabindex', focused ? '0' : '-1');
      if (focused) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
      const time = takeTimeAtSeconds(take, state.positionSeconds);
      row.setAttribute('data-take-seconds', String(Number(time.seconds.toFixed(3))));
      row.setAttribute('data-take-frame', String(time.frame));
      row.setAttribute('data-take-at-end', time.atEnd ? 'true' : 'false');
    }

    for (const media of Array.from(host.querySelectorAll<HTMLElement>('[data-compare-media]'))) {
      const takeId = media.getAttribute('data-compare-media');
      const monitored = takeId === state.monitoredTakeId;
      if (media.getAttribute('data-media-kind') === 'video' || media.tagName === 'VIDEO') {
        media.setAttribute('data-monitored', monitored ? 'true' : 'false');
      }
      (media as HTMLMediaElement).muted = !monitored;
    }

    const play = host.querySelector<HTMLButtonElement>('[data-compare-play]');
    if (play) {
      play.textContent = state.playing ? 'Pause all' : 'Play all';
      play.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    }
    const focused = state.takes[state.focusIndex];
    const pin = host.querySelector<HTMLButtonElement>('[data-compare-pin]');
    if (pin) {
      pin.setAttribute('aria-pressed', focused && state.pinned.has(focused.takeId) ? 'true' : 'false');
      pin.textContent = focused && state.pinned.has(focused.takeId) ? 'Remove favorite' : 'Favorite for later';
      pin.disabled = !focused || state.busy;
    }
    const keep = host.querySelector<HTMLButtonElement>('[data-compare-keep]');
    if (keep) keep.disabled = !stateCanKeep(state);
    const difference = host.querySelector<HTMLElement>('[data-compare-difference]');
    if (difference) difference.setAttribute('aria-pressed', state.showDifference ? 'true' : 'false');
    const safe = host.querySelector<HTMLElement>('[data-compare-safe-area]');
    if (safe) safe.setAttribute('aria-pressed', state.showSafeArea ? 'true' : 'false');
    const stage = host.querySelector<HTMLElement>('[data-difference]');
    if (stage) stage.setAttribute('data-difference', state.showDifference ? 'on' : 'off');
    const safeStage = host.querySelector<HTMLElement>('[data-safe-area]');
    if (safeStage) safeStage.setAttribute('data-safe-area', state.showSafeArea ? 'on' : 'off');
    const overlayDifference = host.querySelector<HTMLElement>('.compare-overlay-difference');
    if (overlayDifference) overlayDifference.toggleAttribute('hidden', !state.showDifference);
    const overlaySafe = host.querySelector<HTMLElement>('.compare-overlay-safe-area');
    if (overlaySafe) overlaySafe.toggleAttribute('hidden', !state.showSafeArea);
    const live = host.querySelector<HTMLElement>('[data-compare-live]');
    if (live) live.textContent = state.liveMessage;
    const error = host.querySelector<HTMLElement>('[data-compare-error]');
    if (error) {
      error.textContent = state.keepError ?? '';
      error.toggleAttribute('hidden', !state.keepError);
    }
    const scrub = host.querySelector<HTMLInputElement>('[data-compare-scrub]');
    if (scrub) scrub.value = String(Math.round(state.position * 100));
    const timeLabel = host.querySelector<HTMLElement>('[data-compare-time]');
    if (timeLabel) timeLabel.textContent = `${Math.round(state.positionSeconds * 10) / 10}s`;
    const current = host.querySelector<HTMLElement>('[data-compare-current]');
    if (current) {
      current.textContent = focused
        ? takeCompareLabel(state.focusIndex + 1, state.takes.length, state.shotId)
        : `shot ${state.shotId}`;
    }
  };

  const paint = (change: CompareChange): void => {
    if (destroyed) return;
    if (change === 'shot' || change === 'close') {
      paintFull(change === 'shot');
    } else {
      patch();
    }
  };

  const mediaUrls = new Map<string, string>();
  const boundMedia = new WeakSet<HTMLMediaElement>();
  let mediaToken = 0;

  const bindMediaEvents = (): void => {
    for (const media of mediaElements(host)) {
      if (boundMedia.has(media)) continue;
      boundMedia.add(media);
      const takeId = media.getAttribute('data-compare-media') ?? '';
      media.addEventListener('ended', () => {
        if (takeId !== controller.state.monitoredTakeId) return;
        const time = controller.takeTime(takeId);
        if (time) controller.setPositionSeconds(time.seconds);
        if (controller.state.playing) controller.pause();
      });
      media.addEventListener('play', () => {
        if (takeId !== controller.state.monitoredTakeId) return;
        if (!controller.state.playing) controller.play();
      });
      media.addEventListener('pause', () => {
        if (takeId !== controller.state.monitoredTakeId) return;
        if (controller.state.playing) controller.pause();
      });
      media.addEventListener('error', () => {
        if (takeId !== controller.state.monitoredTakeId) return;
        if (controller.state.playing) controller.pause();
      });
    }
  };

  /**
   * Media tickets are minted by the existing takes API. The controller and the
   * tests work without takeUrl; when it is present each take gets one ticket.
   */
  const hydrateMedia = async (): Promise<void> => {
    bindMediaEvents();
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
    bindMediaEvents();
    applyMedia();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (compareKeyCommand(key).kind === 'none') return;
    if (isEditable(event.target)) return;
    if ((key === ' ' || key === 'Enter') && isActivationControl(event.target)) return;
    event.preventDefault();
    void controller.handleKey(key);
  };

  const applyMedia = (): void => {
    const { playing, monitoredTakeId } = controller.state;
    for (const media of mediaElements(host)) {
      try {
        const takeId = media.getAttribute('data-compare-media') ?? '';
        const take = controller.state.takes.find(item => item.takeId === takeId);
        const time = takeTimeAtSeconds(take, controller.state.positionSeconds);
        media.muted = takeId !== monitoredTakeId;
        media.currentTime = time.seconds;
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
    paint(change);
    if (change === 'play' || change === 'focus' || change === 'shot') applyMedia();
  });

  host.addEventListener('click', onClick);
  host.addEventListener('input', onInput);
  host.addEventListener('keydown', onKeyDown);
  bindMediaEvents();
  host.querySelector<HTMLElement>('[data-compare-take][tabindex="0"]')?.focus();
  void hydrateMedia();

  return {
    get element() {
      return host.querySelector<HTMLElement>('[data-compare-view]') ?? view;
    },
    controller,
    focusTake(index: number) {
      const focused = controller.focusTake(index);
      paint('focus');
      return focused;
    },
    destroy() {
      destroyed = true;
      unsubscribe();
      controller.destroy();
      host.removeEventListener('click', onClick);
      host.removeEventListener('input', onInput);
      host.removeEventListener('keydown', onKeyDown);
      for (const media of mediaElements(host)) {
        try {
          media.pause();
          media.removeAttribute('src');
        } catch {
          /* a detached media element has nothing to release */
        }
      }
      host.innerHTML = '';
    },
  };
}
