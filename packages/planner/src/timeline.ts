/**
 * Comfyrizz timeline compiler (spec 6.8).
 *
 * Pure TypeScript, no I/O and no clocks: the same package + the same measured
 * narration always produce the same `timeline.json`, including its hash.
 *
 * Frame model (integer frames at the package's fps, normally 30):
 *   scene length = max(preferredFrames, narration frames + padding)  (clamped to layout limits)
 *   transitions overlap: total = sum(scene frames) - sum(overlaps)
 *   six 150-frame scenes with five 15-frame fades = 825 frames.
 *
 * Duration modes:
 *   target    - grow scenes toward `targetFrames` and report the deviation;
 *               any non-zero deviation requires explicit user acceptance.
 *   flexible  - grow to fit speech, up to MAX_FLEXIBLE_FRAMES (90 s); never
 *               speed up, clip or silently cut speech.
 */

import { createHash } from 'node:crypto';
import type {
  CompileOptions,
  ComfyrizzPackage,
  LayoutId,
  NarrationChunk,
  Scene,
  SceneLowerThird,
} from './package-types.js';

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
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
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
    const duration = clamp(base, limit.min, limit.max);
    const transitionOut = scene.transitionOut?.type && scene.transitionOut.type !== 'none' && scene.transitionOut.type !== 'cut'
      ? Math.max(0, Math.floor(scene.transitionOut.frames || 0))
      : 0;
    return { scene, duration, transitionOut, narrationFrames: spoken, provisional, min: limit.min, max: limit.max };
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
        captions.push({ text: chunk.text, from: cursor, to: cursor + frames, sceneId: scene.id, estimated: false });
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

export function compileTimeline(pkg: ComfyrizzPackage, options: CompileOptions = {}): Timeline {
  if (!pkg || !Array.isArray(pkg.scenes) || pkg.scenes.length === 0) {
    throw new TimelineError('empty-package', 'A package needs at least one scene.');
  }
  const fps = isFiniteNumber(pkg.format?.fps) && pkg.format.fps > 0 ? Math.floor(pkg.format.fps) : DEFAULT_FPS;
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

  const { captions, warnings: captionWarnings } = buildCaptions(scenes, pkg, options, fps);
  warnings.push(...captionWarnings);

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
    target,
    provisional,
    warnings,
    proposals,
    sourceHash: createHash('sha256').update(canonicalJson(pkg)).digest('hex'),
  };

  return { ...withoutHash, hash: hashTimeline(withoutHash) };
}
