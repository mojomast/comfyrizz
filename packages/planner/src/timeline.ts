/**
 * Comfyrizz timeline compiler (spec 6.8).
 *
 * Pure TypeScript, no I/O and no clocks: the same package + the same measured
 * narration always produce the same `timeline.json`, including its hash.
 *
 * Frame model (integer frames at the package's fps, normally 30):
 *   scene length = max(clamped preferredFrames, narration frames + padding)
 *   transitions overlap: total = sum(scene frames) - sum(overlaps)
 *   six 150-frame scenes with five 15-frame fades = 825 frames.
 *
 * Duration modes:
 *   target    - grow scenes toward `targetFrames` and report the deviation;
 *               any non-zero deviation requires explicit user acceptance.
 *   flexible  - grow to fit speech; exceeding MAX_FLEXIBLE_FRAMES (90 s) gives
 *               a pacing advisory, never speeding up, clipping or cutting speech.
 */

import type {
  CompileOptions,
  ComfyrizzPackage,
  LayoutId,
  NarrationChunk,
  NarrationWord,
  Scene,
  SceneLowerThird,
} from './package-types.js';
import { sha256Hex } from './sha256.js';

export const TIMELINE_VERSION = 1;
export const DEFAULT_FPS = 30;
/** 90 s at 30 fps. */
export const MAX_FLEXIBLE_FRAMES = 2700;

export interface LayoutLimit {
  min: number;
  max: number;
}

/** Conservative readable-window limits per layout, in frames at 30 fps. */
export const LAYOUT_LIMITS: Record<LayoutId, LayoutLimit> = {
  title: { min: 30, max: 450 },
  hero: { min: 45, max: 600 },
  stat: { min: 30, max: 300 },
  chart: { min: 45, max: 450 },
  list: { min: 45, max: 600 },
  // Same readable window the compiler used when these layouts fell through to hero.
  split: { min: 45, max: 600 },
  compare: { min: 45, max: 600 },
  code: { min: 45, max: 600 },
};

export interface TimelineTransition {
  type: string;
  frames: number;
}

export interface TimelineScene {
  id: string;
  layout: LayoutId;
  variant?: string;
  from: number;
  durationInFrames: number;
  transitionInFrames: number;
  transitionOutFrames: number;
  copy: Record<string, unknown>;
  data: unknown;
  background: unknown;
  foreground: unknown;
  /** Media-only scene: the layout is skipped and only the media layer draws (P-fix1, N8). */
  mediaOnly: boolean;
  /** Lower-third overlay carried through the compile so the render can draw it (N8). */
  lowerThird: SceneLowerThird | null;
  narration: string | null;
  provisional: boolean;
}

export interface TimelineCaption {
  text: string;
  from: number;
  to: number;
  sceneId: string;
  estimated: boolean;
  /** K1: per-word cues inside this sentence (absolute frames). Absent when unmeasured. */
  words?: TimelineWord[];
}

/** K1: one word inside a caption cue, in absolute frames. */
export interface TimelineWord {
  text: string;
  from: number;
  to: number;
}

/**
 * P-pres: one presenter clip placed over a scene (H17 schema `presenter`). The track carries the
 * absolute frame window so the overlay layer can sit outside the TransitionSeries (above the scene
 * layers, below captions) and cross-dissolve at seams instead of riding the scene transition.
 */
export interface TimelinePresenter {
  sceneId: string;
  /** the ltx25-a2v clip, or the package portrait still until the clip exists. */
  assetId: string;
  placement: 'pip-br' | 'pip-bl' | 'pip-bc' | 'split-left';
  shape: 'circle' | 'rounded-rect';
  /** width as a fraction of the frame's short side (0.18-0.32). */
  size: number;
  label: string | null;
  from: number;
  durationInFrames: number;
  /** frames of cross-dissolve into this scene's clip (0 = hard cut). */
  dissolveInFrames: number;
  /** frames of cross-dissolve out of this scene's clip (0 = hard cut / last scene). */
  dissolveOutFrames: number;
}

export interface PlateRetime {
  assetId: string;
  sourceFps: number;
  sourceFrames: number;
  targetFps: number;
  /** targetFps / sourceFps; <1 means slow down, >1 means speed up. */
  speed: number;
  retimedFrames: number;
  strategy: 'retime' | 'trim' | 'loop';
  loopPeriodFrames?: number;
}

export interface Timeline {
  version: number;
  fps: number;
  width: number;
  height: number;
  mode: 'target' | 'flexible';
  /** Total frames including every overlap. */
  durationInFrames: number;
  scenes: TimelineScene[];
  captions: TimelineCaption[];
  plates: PlateRetime[];
  /** Present only when the package turns the presenter on (H17). */
  presenters?: TimelinePresenter[];
  target: {
    requested: number | null;
    actual: number;
    deviationFrames: number;
    requiresAcceptance: boolean;
  };
  provisional: boolean;
  warnings: string[];
  proposals: string[];
  sourceHash: string;
  hash: string;
}

export class TimelineError extends Error {
  readonly code: string;
  readonly sceneId?: string;
  constructor(code: string, message: string, sceneId?: string) {
    super(message);
    this.name = 'TimelineError';
    this.code = code;
    this.sceneId = sceneId;
  }
}

/** P-pres: the longest seam cross-dissolve, in frames (research 2.2: 4-6). */
export const PRESENTER_DISSOLVE_FRAMES = 5;
/** P-pres: presenter width as a fraction of the short side when the package does not say. */
export const PRESENTER_SIZE_DEFAULT = 0.24;
/**
 * X1: frames for a cutdown target (6 / 15 / 30 s). The cutdown tool writes
 * `duration.mode = "target"` with this count; target mode then holds the film
 * on it. Rounding matches `packages/agent` `targetFramesForSeconds`.
 */
export function targetFramesForSeconds(seconds: number, fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new TimelineError('bad-target', 'A target duration needs a positive number of seconds.');
  }
  const rate = Number.isFinite(fps) && fps > 0 ? Math.floor(fps) : DEFAULT_FPS;
  return Math.max(1, Math.round(seconds * rate));
}

const DEFAULT_NARRATION_GAP_SECONDS = 0.15;
const DEFAULT_NARRATION_PADDING_SECONDS = 0.25;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Canonical JSON: sorted keys, `undefined` dropped, deterministic across runs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortValue(item);
    }
    return out;
  }
  return value;
}

export function hashTimeline(timeline: Omit<Timeline, 'hash'> | Timeline): string {
  const { hash: _ignored, ...rest } = timeline as Timeline;
  return sha256Hex(canonicalJson(rest));
}

/** Integer project fps. Non-finite or non-positive rates fall back to 30. */
export function projectFps(format?: { fps?: number } | null): number {
  return isFiniteNumber(format?.fps) && (format?.fps ?? 0) > 0 ? Math.floor(format!.fps) : DEFAULT_FPS;
}

/**
 * Lower bound for TrimScene, in integer project frames.
 * Measured speech (chunks + gap + padding) wins over the layout minimum.
 * Unmeasured scenes use the layout minimum. Speech is never the thing being trimmed.
 */
export function speechFloorFrames(
  scene: { id: string; layout: LayoutId },
  options: CompileOptions,
  fps: number,
): { frames: number; measured: boolean } {
  const limit = sceneLimit(scene.layout);
  const spoken = narrationFrames(options.narration?.[scene.id], options, fps);
  if (spoken === null) return { frames: limit.min, measured: false };
  return { frames: spoken, measured: true };
}

function frameSecondsToFrames(seconds: number, fps: number): number {
  return Math.max(0, Math.ceil(seconds * fps));
}

function narrationFrames(chunks: NarrationChunk[] | undefined, options: CompileOptions, fps: number): number | null {
  if (!chunks || chunks.length === 0) return null;
  const gap = options.narrationGapSeconds ?? DEFAULT_NARRATION_GAP_SECONDS;
  const padding = options.narrationPaddingSeconds ?? DEFAULT_NARRATION_PADDING_SECONDS;
  const spoken = chunks.reduce((sum, chunk) => sum + Math.max(0, chunk.seconds), 0);
  const gaps = gap * Math.max(0, chunks.length - 1);
  return frameSecondsToFrames(spoken + gaps + padding, fps);
}

function sceneLimit(layout: LayoutId, variant?: string): LayoutLimit {
  void variant;
  return LAYOUT_LIMITS[layout] ?? LAYOUT_LIMITS.hero;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface ScenePlan {
  scene: Scene;
  duration: number;
  transitionOut: number;
  narrationFrames: number | null;
  provisional: boolean;
  min: number;
  max: number;
}

function planScenes(pkg: ComfyrizzPackage, options: CompileOptions, fps: number): ScenePlan[] {
  return pkg.scenes.map(scene => {
    const limit = sceneLimit(scene.layout, scene.variant);
    const preferred = isFiniteNumber(scene.preferredFrames) ? Math.floor(scene.preferredFrames) : limit.min;
    const chunks = options.narration?.[scene.id];
    const spoken = narrationFrames(chunks, options, fps);
    const hasNarrationText = typeof scene.narration === 'string' && scene.narration.trim().length > 0;
    const provisional = hasNarrationText && (pkg.voice?.enabled ?? false) && !chunks?.length;
    // Provisional scenes use preferred length but never below the readable floor.
    const base = spoken === null ? preferred : Math.max(preferred, spoken);
    // Layout caps constrain preferred pacing, never measured speech. Clamping a
    // long stat/title take to its visual default silently cut narration on export.
    const max = Math.max(limit.max, spoken ?? 0);
    const duration = clamp(base, limit.min, max);
    const transitionOut = scene.transitionOut?.type && scene.transitionOut.type !== 'none' && scene.transitionOut.type !== 'cut'
      ? Math.max(0, Math.floor(scene.transitionOut.frames || 0))
      : 0;
    return { scene, duration, transitionOut, narrationFrames: spoken, provisional, min: limit.min, max };
  });
}

function validateTransitions(plans: ScenePlan[]): void {
  for (let i = 0; i < plans.length; i += 1) {
    const frames = plans[i].transitionOut;
    if (frames <= 0) continue;
    const neighbour = plans[i + 1];
    if (!neighbour) {
      throw new TimelineError('transition-out-of-range', `Scene ${plans[i].scene.id} has a transition but is the last scene.`, plans[i].scene.id);
    }
    if (frames > plans[i].duration || frames > neighbour.duration) {
      throw new TimelineError(
        'transition-out-of-range',
        `Transition ${frames} on scene ${plans[i].scene.id} does not fit its neighbours (${plans[i].duration}, ${neighbour.duration} frames).`,
        plans[i].scene.id,
      );
    }
  }
}

function totalFrames(plans: ScenePlan[]): number {
  const sum = plans.reduce((acc, plan) => acc + plan.duration, 0);
  const overlaps = plans.slice(0, -1).reduce((acc, plan) => acc + plan.transitionOut, 0);
  return sum - overlaps;
}

/** Grow scenes toward the requested target without breaking narration floors. */
function growTowardTarget(plans: ScenePlan[], target: number): void {
  let guard = 0;
  while (totalFrames(plans) < target && guard < 100000) {
    guard += 1;
    const growable = plans.filter(plan => plan.duration < plan.max);
    if (growable.length === 0) break;
    // Round-robin keeps the growth even; distribute the exact remainder first.
    const step = Math.min(5, target - totalFrames(plans));
    for (const plan of growable) {
      if (totalFrames(plans) >= target) break;
      plan.duration = Math.min(plan.max, plan.duration + step);
    }
  }
}

/** Pick the shortest scene that can shrink if a narration overflows the flexible cap. */
function shrinkProposal(plans: ScenePlan[], overflow: number): string {
  const shave = Math.ceil(overflow / Math.max(1, plans.length));
  return `Shorten copy by about ${shave} frames per scene (${plans.length} scenes) or split the longest scene.`;
}

function sentenceSplit(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
}

function buildCaptions(plans: TimelineScene[], pkg: ComfyrizzPackage, options: CompileOptions, fps: number): { captions: TimelineCaption[]; warnings: string[] } {
  const captions: TimelineCaption[] = [];
  const warnings: string[] = [];
  const gap = options.narrationGapSeconds ?? DEFAULT_NARRATION_GAP_SECONDS;
  for (const scene of plans) {
    const chunks = options.narration?.[scene.id];
    if (chunks && chunks.length > 0) {
      let cursor = scene.from;
      for (const chunk of chunks) {
        const frames = frameSecondsToFrames(chunk.seconds, fps);
        const to = cursor + frames;
        const caption: TimelineCaption = { text: chunk.text, from: cursor, to, sceneId: scene.id, estimated: false };
        const words = cueWords(chunk.words, cursor, to, fps);
        if (words) caption.words = words;
        captions.push(caption);
        cursor += frames + frameSecondsToFrames(gap, fps);
      }
      continue;
    }
    if (options.estimateCaptions === false) continue;
    if (typeof scene.narration !== 'string' || !scene.narration.trim()) continue;
    const sentences = sentenceSplit(scene.narration);
    if (sentences.length === 0) continue;
    // Provisional estimate: distribute the scene length by character weight.
    const weights = sentences.map(sentence => Math.max(1, sentence.length));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let cursor = scene.from;
    sentences.forEach((sentence, index) => {
      const isLast = index === sentences.length - 1;
      const frames = isLast ? scene.from + scene.durationInFrames - cursor : Math.max(1, Math.round((scene.durationInFrames * weights[index]) / totalWeight));
      captions.push({ text: sentence, from: cursor, to: cursor + frames, sceneId: scene.id, estimated: true });
      cursor += frames;
    });
    warnings.push(`Captions for ${scene.id} are estimated until narration audio is measured.`);
  }
  return { captions, warnings };
}

/** K1: map sentence-relative word seconds into absolute caption frames, clamped inside the cue. */
function cueWords(words: NarrationWord[] | undefined, from: number, to: number, fps: number): TimelineWord[] | undefined {
  if (!words || words.length === 0) return undefined;
  const out: TimelineWord[] = [];
  for (const [index, word] of words.entries()) {
    const wordFrom = Math.max(from, from + Math.round(word.start * fps));
    const isLast = index === words.length - 1;
    const wordTo = isLast ? to : Math.min(to, Math.max(wordFrom + 1, from + Math.round(word.end * fps)));
    out.push({ text: word.text, from: wordFrom, to: wordTo });
  }
  return out;
}

function applyCaptionOverrides(captions: TimelineCaption[], overrides: CompileOptions['captionOverrides']): TimelineCaption[] {
  if (!overrides || overrides.length === 0) return captions;
  const next = captions.map(cue => ({ ...cue }));
  const byScene = new Map<string, number[]>();
  next.forEach((cue, index) => {
    const list = byScene.get(cue.sceneId) ?? [];
    list.push(index);
    byScene.set(cue.sceneId, list);
  });
  const ordered = [...overrides].sort((a, b) => a.sceneId.localeCompare(b.sceneId) || a.index - b.index);
  for (const override of ordered) {
    const at = byScene.get(override.sceneId)?.[override.index];
    if (at === undefined) continue;
    next[at] = { ...next[at]!, text: override.text };
  }
  return next;
}

function plateRetimes(pkg: ComfyrizzPackage, fps: number): PlateRetime[] {
  const used = new Set<string>();
  for (const scene of pkg.scenes) {
    if (scene.background?.asset) used.add(scene.background.asset);
    for (const fg of scene.foreground ?? []) if (fg.asset) used.add(fg.asset);
  }
  const out: PlateRetime[] = [];
  for (const [assetId, asset] of Object.entries(pkg.assets ?? {})) {
    if (!used.has(assetId)) continue;
    const media = asset.media;
    if (!media || !isFiniteNumber(media.fps) || media.fps <= 0 || media.fps === fps) continue;
    const sourceFrames = isFiniteNumber(media.frames) ? Math.max(1, Math.floor(media.frames)) : 0;
    if (sourceFrames === 0) continue;
    const speed = fps / media.fps;
    const retimedFrames = Math.max(1, Math.ceil(sourceFrames / speed));
    out.push({
      assetId,
      sourceFps: media.fps,
      sourceFrames,
      targetFps: fps,
      speed,
      retimedFrames,
      strategy: asset.kind === 'video' ? 'retime' : 'trim',
    });
  }
  return out.sort((a, b) => a.assetId.localeCompare(b.assetId));
}

/**
 * P-pres: which scenes show the presenter and where (H17 `presenter` + per-scene override).
 *
 * The presenter is opt-in: `enabled: true` is the only gate. Coverage is the cheap knob, not
 * stitching (research 2.2) - `bookends` (intro + outro) is the default, `all` and an explicit id
 * list are the alternatives. `scene.presenter` wins per scene: `off` removes it, `split` moves it to
 * the split-left card, `pip` keeps the package placement. The clip is the scene's a2v asset, with
 * the package portrait as a still fallback until the a2v jobs have run.
 */
function resolvePresenterTrack(pkg: ComfyrizzPackage, scenes: TimelineScene[]): TimelinePresenter[] {
  const presenter = pkg.presenter;
  if (!presenter || presenter.enabled !== true || scenes.length === 0) return [];
  const byId = new Map(pkg.scenes.map(scene => [scene.id, scene]));
  const coverage = presenter.scenes ?? 'bookends';
  const covered = new Set<string>();
  if (coverage === 'all') {
    for (const scene of scenes) covered.add(scene.id);
  } else if (Array.isArray(coverage)) {
    for (const id of coverage) covered.add(id);
  } else {
    covered.add(scenes[0].id);
    covered.add(scenes[scenes.length - 1].id);
  }
  const portrait = pkg.format.height > pkg.format.width;
  const size = isFiniteNumber(presenter.size) ? clamp(presenter.size, 0.18, 0.32) : PRESENTER_SIZE_DEFAULT;
  const shape = presenter.shape ?? 'circle';
  const label = presenter.label ?? 'AI presenter';
  const out: TimelinePresenter[] = [];
  for (const scene of scenes) {
    if (!covered.has(scene.id)) continue;
    const source = byId.get(scene.id);
    if (source?.presenter === 'off') continue;
    const assetId = source?.presenter_asset ?? presenter.portrait;
    if (!assetId) continue;
    // The split-left card is drawn by the hero layout's own copy; every other layout keeps the
    // package placement, so `split` on a title/chart still shows the presenter instead of vanishing.
    const wantsSplit = source?.presenter === 'split' && source.layout === 'hero';
    const placement: TimelinePresenter['placement'] =
      wantsSplit ? 'split-left' : presenter.placement ?? (portrait ? 'pip-bc' : 'pip-br');
    out.push({
      sceneId: scene.id,
      assetId,
      placement,
      shape,
      size,
      label,
      from: scene.from,
      durationInFrames: scene.durationInFrames,
      dissolveInFrames: Math.min(PRESENTER_DISSOLVE_FRAMES, scene.transitionInFrames),
      dissolveOutFrames: scene.transitionOutFrames > 0 ? Math.min(PRESENTER_DISSOLVE_FRAMES, scene.transitionOutFrames) : 0,
    });
  }
  return out;
}

export function compileTimeline(pkg: ComfyrizzPackage, options: CompileOptions = {}): Timeline {
  if (!pkg || !Array.isArray(pkg.scenes) || pkg.scenes.length === 0) {
    throw new TimelineError('empty-package', 'A package needs at least one scene.');
  }
  const fps = projectFps(pkg.format);
  const ids = new Set<string>();
  for (const scene of pkg.scenes) {
    if (!scene.id || typeof scene.id !== 'string') throw new TimelineError('missing-scene-id', 'Every scene needs a string id.');
    if (ids.has(scene.id)) throw new TimelineError('duplicate-scene-id', `Scene id ${scene.id} is used more than once.`, scene.id);
    ids.add(scene.id);
  }

  const plans = planScenes(pkg, options, fps);
  validateTransitions(plans);

  const mode = pkg.duration?.mode === 'target' ? 'target' : 'flexible';
  const requested = mode === 'target' && isFiniteNumber(pkg.duration?.targetFrames) ? Math.max(1, Math.floor(pkg.duration!.targetFrames!)) : null;
  const warnings: string[] = [];
  if (mode === 'target') {
    if (requested === null) warnings.push('Target mode without targetFrames: using the flexible length.');
    else growTowardTarget(plans, requested);
  }

  const provisional = plans.some(plan => plan.provisional);
  if (provisional) warnings.push('Narration is not measured yet; timeline is provisional and must not be exported as final.');

  const proposals: string[] = [];
  let actual = totalFrames(plans);
  if (mode === 'flexible' && actual > MAX_FLEXIBLE_FRAMES) {
    proposals.push(shrinkProposal(plans, actual - MAX_FLEXIBLE_FRAMES));
    warnings.push(`Flexible timeline is ${actual} frames, over the ${MAX_FLEXIBLE_FRAMES}-frame (90 s) cap. Speech is not cut.`);
  }

  const scenes: TimelineScene[] = [];
  let cursor = 0;
  plans.forEach((plan, index) => {
    const transitionInFrames = index === 0 ? 0 : plans[index - 1].transitionOut;
    scenes.push({
      id: plan.scene.id,
      layout: plan.scene.layout,
      ...(plan.scene.variant ? { variant: plan.scene.variant } : {}),
      from: cursor,
      durationInFrames: plan.duration,
      transitionInFrames,
      transitionOutFrames: plan.transitionOut,
      copy: (plan.scene.copy ?? {}) as Record<string, unknown>,
      data: plan.scene.data ?? null,
      background: plan.scene.background ?? null,
      foreground: plan.scene.foreground ?? [],
      mediaOnly: plan.scene.media_only === true,
      lowerThird: plan.scene.lower_third ?? null,
      narration: plan.scene.narration ?? null,
      provisional: plan.provisional,
    });
    cursor += plan.duration - plan.transitionOut;
  });
  actual = totalFrames(plans);

  const target = {
    requested,
    actual,
    deviationFrames: requested === null ? 0 : requested - actual,
    requiresAcceptance: requested !== null && requested !== actual,
  };

  const built = buildCaptions(scenes, pkg, options, fps);
  const captions = applyCaptionOverrides(built.captions, options.captionOverrides);
  warnings.push(...built.warnings);

  const presenters = resolvePresenterTrack(pkg, scenes);

  const withoutHash: Omit<Timeline, 'hash'> = {
    version: TIMELINE_VERSION,
    fps,
    width: isFiniteNumber(pkg.format?.width) ? Math.floor(pkg.format.width) : 1920,
    height: isFiniteNumber(pkg.format?.height) ? Math.floor(pkg.format.height) : 1080,
    mode,
    durationInFrames: actual,
    scenes,
    captions,
    plates: plateRetimes(pkg, fps),
    // Only emitted when the presenter is on, so packages without one keep their exact timeline hash.
    ...(presenters.length > 0 ? { presenters } : {}),
    target,
    provisional,
    warnings,
    proposals,
    sourceHash: sha256Hex(canonicalJson(pkg)),
  };

  return { ...withoutHash, hash: hashTimeline(withoutHash) };
}
