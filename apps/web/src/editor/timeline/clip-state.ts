/**
 * Pure clip-chip view state for the timeline (TIMELINE-REVIEW TR14).
 *
 * The server derives the eight clip states; this module only turns a compiled
 * timeline plus the clip summaries from the takes API into positioned chips.
 * It has no clock, network, DOM or React dependency, so tests and the view use
 * exactly the same rules.
 */
import type { CompiledTimeline as Timeline } from '../../../../../packages/planner/dist/src/browser.js';
import type { ClipState, ClipSummary } from '../../takes/api.ts';
import type { ThumbResult, ThumbTile } from '../../thumbs/client.ts';

export interface ClipStyle {
  /** Short text inside the chip. */
  badge: string;
  /** Human name used by the aria-label and the title. */
  label: string;
  /** CSS tone token rendered as data-state. */
  tone: 'neutral' | 'blue' | 'amber' | 'green' | 'red';
  /** Phrase after the take counter in the aria-label. */
  aria: string;
  /** The state shows a progress bar. */
  progress: boolean;
  /** The state draws a diagonal stripe. */
  striped?: boolean;
}

/**
 * One row per derived state (TIMELINE_REVIEW.md section 4). Order is the
 * document order so callers can render a legend without another table.
 */
export const STATE_STYLE: Record<ClipState, ClipStyle> = {
  planned: { badge: 'planned', label: 'Planned', tone: 'neutral', aria: 'planned', progress: false },
  queued: { badge: 'queued', label: 'Queued', tone: 'neutral', aria: 'queued', progress: false },
  generating: { badge: 'generating', label: 'Generating', tone: 'blue', aria: 'generating', progress: true },
  review: { badge: 'review', label: 'Needs review', tone: 'amber', aria: 'needs review', progress: false },
  approved: { badge: '✓', label: 'Approved', tone: 'green', aria: 'approved', progress: false },
  rejected: { badge: 'rejected', label: 'Rejected', tone: 'red', aria: 'rejected', progress: false },
  failed: { badge: '!', label: 'Failed', tone: 'red', aria: 'failed', progress: false },
  stale: { badge: 'stale', label: 'Stale', tone: 'amber', aria: 'stale', progress: false, striped: true },
};

const STATE_ORDER: ClipState[] = ['planned', 'queued', 'generating', 'review', 'approved', 'rejected', 'failed', 'stale'];

export interface TakeCounter {
  takeCount: number;
  selectedN?: number | null;
  newTakes?: number;
}

/**
 * "take 3 of 3", with ", +1 new" when a take landed beside an approved one.
 * A clip without takes has no counter.
 */
export function formatTakeCounter(
  input: number | TakeCounter,
  selectedN: number | null = null,
  newTakes = 0,
): string {
  const counter: TakeCounter = typeof input === 'number'
    ? { takeCount: input, selectedN, newTakes }
    : input;
  const total = Number.isFinite(counter.takeCount) ? Math.max(0, Math.floor(counter.takeCount)) : 0;
  if (total === 0) return '';
  const selected = counter.selectedN;
  const base = typeof selected === 'number' && Number.isFinite(selected) && selected > 0
    ? `take ${Math.min(total, Math.max(1, Math.floor(selected)))} of ${total}`
    : `${total} take${total === 1 ? '' : 's'}`;
  const fresh = Number.isFinite(counter.newTakes) ? Math.max(0, Math.floor(counter.newTakes ?? 0)) : 0;
  return fresh > 0 ? `${base}, +${fresh} new` : base;
}

export interface ClipChip {
  clipId: string;
  sceneId: string;
  /** 1-based scene position, used for "Scene 2 ..." labels. */
  sceneIndex: number;
  assetId: string;
  slot: string;
  /** "background" or "foreground 1" etc. */
  slotLabel: string;
  kind: ClipSummary['kind'];
  state: ClipState;
  from: number;
  durationInFrames: number;
  /** Timeline frames; the view multiplies by zoom. */
  left: number;
  width: number;
  /** Stack row inside the scene block. */
  lane: number;
  badge: string;
  label: string;
  tone: ClipStyle['tone'];
  ariaLabel: string;
  title: string;
  takeCounter: string;
  takeCount: number;
  selectedN: number | null;
  newTakes: number;
  /** 0..1 for a generating clip, null when unknown. */
  progress: number | null;
  indeterminate: boolean;
  striped: boolean;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isClipState(value: unknown): value is ClipState {
  return typeof value === 'string' && STATE_ORDER.includes(value as ClipState);
}

function slotLabel(slot: string): string {
  if (slot === 'background') return 'background';
  if (slot === 'presenter') return 'presenter';
  const foreground = /^foreground(?::(\d+))?$/.exec(slot);
  if (foreground) return foreground[1] ? `foreground ${foreground[1]}` : 'foreground';
  return slot || 'clip';
}

function slotRank(slot: string): number {
  if (slot === 'background') return 0;
  const foreground = /^foreground(?::(\d+))?$/.exec(slot);
  if (foreground) return 1 + (foreground[1] ? Number(foreground[1]) : 0);
  if (slot === 'presenter') return 1000;
  return 500;
}

function progressOf(clip: ClipSummary, state: ClipState): number | null {
  if (state !== 'generating') return null;
  const raw = clip.lastJob?.progress;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const fraction = raw > 1 ? raw / 100 : raw;
  return Math.min(1, Math.max(0, fraction));
}

/**
 * Position every clip in its scene block. Clips of a scene stack by slot
 * (background, foreground 1..n, presenter), so a scene with a background and
 * a presenter shows two rows. Unknown scenes are dropped rather than guessed.
 */
export function clipChips(timeline: Timeline | null | undefined, clips: readonly ClipSummary[] | null | undefined): ClipChip[] {
  if (!timeline || !Array.isArray(timeline.scenes) || !Array.isArray(clips)) return [];
  const chips: ClipChip[] = [];
  const sceneIndex = new Map(timeline.scenes.map((scene, index) => [scene.id, index]));
  const ordered = clips
    .filter(clip => clip && typeof clip.clipId === 'string' && sceneIndex.has(clip.sceneId))
    .slice()
    .sort((a, b) => {
      const sceneA = sceneIndex.get(a.sceneId) ?? 0;
      const sceneB = sceneIndex.get(b.sceneId) ?? 0;
      if (sceneA !== sceneB) return sceneA - sceneB;
      const rank = slotRank(a.slot) - slotRank(b.slot);
      if (rank !== 0) return rank;
      return (finite(a.from, 0) - finite(b.from, 0)) || a.clipId.localeCompare(b.clipId);
    });

  const lanes = new Map<string, number>();
  for (const clip of ordered) {
    const index = sceneIndex.get(clip.sceneId) ?? 0;
    const scene = timeline.scenes[index]!;
    const state: ClipState = isClipState(clip.state) ? clip.state : 'planned';
    const style = STATE_STYLE[state];
    const sceneFrom = finite(scene.from, 0);
    const sceneDuration = Math.max(1, finite(scene.durationInFrames, 1));
    const clipFrom = Math.max(sceneFrom, finite(clip.from, sceneFrom));
    const clipDuration = Math.max(1, Math.min(sceneFrom + sceneDuration - clipFrom, finite(clip.durationInFrames, sceneDuration)));
    const lane = lanes.get(clip.sceneId) ?? 0;
    lanes.set(clip.sceneId, lane + 1);
    const takeCount = Math.max(0, Math.floor(finite(clip.takeCount, 0)));
    const selectedN = typeof clip.selectedN === 'number' && Number.isFinite(clip.selectedN)
      ? Math.max(1, Math.floor(clip.selectedN))
      : null;
    const newTakes = Math.max(0, Math.floor(finite(clip.newTakes, 0)));
    const takeCounter = formatTakeCounter({ takeCount, selectedN, newTakes });
    const progress = progressOf(clip, state);
    const sceneNumber = index + 1;
    const slotName = slotLabel(clip.slot);
    const ariaPieces = [`Scene ${sceneNumber} ${slotName}`];
    if (takeCounter) ariaPieces.push(takeCounter);
    ariaPieces.push(style.aria);
    const ariaLabel = ariaPieces.join(', ');
    const error = typeof clip.lastJob?.error === 'string' && clip.lastJob.error.trim() ? clip.lastJob.error.trim() : '';
    chips.push({
      clipId: clip.clipId,
      sceneId: clip.sceneId,
      sceneIndex: sceneNumber,
      assetId: clip.assetId,
      slot: clip.slot,
      slotLabel: slotName,
      kind: clip.kind,
      state,
      from: clipFrom,
      durationInFrames: clipDuration,
      left: clipFrom,
      width: clipDuration,
      lane,
      badge: style.badge,
      label: style.label,
      tone: style.tone,
      ariaLabel,
      title: error ? `${ariaLabel}: ${error}` : ariaLabel,
      takeCounter,
      takeCount,
      selectedN,
      newTakes,
      progress,
      indeterminate: state === 'generating' && progress === null,
      striped: style.striped === true,
    });
  }
  return chips;
}

export interface ClipKeyInput {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  typing?: boolean;
  onButton?: boolean;
}

export type ClipKeyAction =
  | { type: 'prev-take' }
  | { type: 'next-take' }
  | { type: 'approve' };

/**
 * Clip keys. The existing timeline model keeps `[`/`]` for trim when no clip
 * is focused; the view only consults this helper while a chip has focus, so
 * trim, move and drag keep their behaviour.
 */
export function clipKeyboardAction(input: ClipKeyInput): ClipKeyAction | null {
  if (!input || input.typing) return null;
  if (input.key === '[') return { type: 'prev-take' };
  if (input.key === ']') return { type: 'next-take' };
  if ((input.key === 'a' || input.key === 'A') && !input.meta && !input.ctrl && !input.alt) return { type: 'approve' };
  return null;
}

export type ThumbMode = 'filmstrip' | 'head' | 'off';

export interface ChipThumbRequestOptions {
  mode?: ThumbMode | 'auto' | null | undefined;
  chipPixelWidth?: number;
}

export function chipThumbRequest(
  chip: { kind: ClipSummary['kind'] },
  options: ChipThumbRequestOptions = {},
): { kind: 'poster' | 'filmstrip' } | null {
  const mode = options.mode ?? undefined;
  if (mode === 'off') return null;
  const auto = mode === undefined || mode === null || mode === 'auto';
  if (chip.kind === 'still') return { kind: 'poster' };
  if (mode === 'filmstrip' || auto) return { kind: 'filmstrip' };
  return { kind: 'poster' };
}

export interface FilmstripCell {
  tile: ThumbTile;
  backgroundPosition: string;
  backgroundSize: string;
}

export function filmstripLayout(
  result: ThumbResult,
  options: { chipPixelWidth: number; chipPixelHeight: number },
): FilmstripCell[] {
  if (result.status !== 'ready' || !Array.isArray(result.tiles) || result.tiles.length === 0) return [];
  const tile0 = result.tiles[0] as ThumbTile;
  if (!tile0 || !Number.isFinite(tile0.w) || !Number.isFinite(tile0.h) || tile0.w <= 0 || tile0.h <= 0) return [];
  const displayedTileWidth = tile0.w * options.chipPixelHeight / tile0.h;
  if (!Number.isFinite(displayedTileWidth) || displayedTileWidth <= 0) return [];
  const count = Math.floor(options.chipPixelWidth / displayedTileWidth);
  if (!Number.isFinite(count) || count <= 0) return [];

  const tiles = result.tiles as ThumbTile[];
  const lastIndex = tiles.length - 1;
  const sampled: ThumbTile[] = [];
  if (count === 1) {
    sampled.push(tiles[0]);
  } else {
    for (let i = 0; i < count; i += 1) {
      const idx = Math.round((i * lastIndex) / (count - 1));
      const clamped = Math.min(lastIndex, Math.max(0, idx));
      sampled.push(tiles[clamped]);
    }
  }

  const scale = options.chipPixelHeight / tile0.h;
  return sampled.map((tile) => ({
    tile,
    backgroundPosition: `-${tile.x * scale}px -${tile.y * scale}px`,
    backgroundSize: `${result.width * scale}px ${result.height * scale}px`,
  }));
}

export interface LazyThumbs {
  observe(el: unknown, request: unknown): void;
  disconnect(): void;
}

export interface CreateLazyThumbsOptions {
  observerFactory: (callback: (entries: unknown[]) => void) => {
    observe?: (el: unknown) => void;
    unobserve?: (el: unknown) => void;
    disconnect?: () => void;
  } | null;
  load: (el: unknown, request: unknown) => unknown;
}

export function createLazyThumbs(options: CreateLazyThumbsOptions): LazyThumbs {
  const loaded = new Set<unknown>();
  const pending = new Map<unknown, unknown>();
  let disconnected = false;
  let observer: ReturnType<CreateLazyThumbsOptions['observerFactory']> = null;

  const handleEntries = (entries: unknown[]) => {
    if (disconnected) return;
    const list = Array.isArray(entries) ? entries : [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as { isIntersecting?: boolean; target?: unknown };
      if (!record.isIntersecting) continue;
      const el = record.target;
      if (el === undefined || loaded.has(el)) continue;
      if (!pending.has(el)) continue;
      if (disconnected) return;
      loaded.add(el);
      const request = pending.get(el);
      try {
        options.load(el, request);
      } catch {
        // ignore
      }
      if (observer && typeof observer.unobserve === 'function') observer.unobserve(el);
    }
  };

  try {
    observer = typeof options.observerFactory === 'function'
      ? options.observerFactory(handleEntries)
      : null;
  } catch {
    observer = null;
  }

  return {
    observe(el: unknown, request: unknown) {
      if (disconnected) return;
      if (loaded.has(el)) return;
      pending.set(el, request);
      // Without an observer nothing loads lazily (the caller passes no factory when IntersectionObserver is missing).
      if (observer && typeof observer.observe === 'function') observer.observe(el);
    },
    disconnect() {
      disconnected = true;
      pending.clear();
      if (observer && typeof observer.disconnect === 'function') observer.disconnect();
    },
  };
}
