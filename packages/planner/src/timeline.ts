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
  NarrationTiming,
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
  /**
   * Resolved `scene.motion.cue_phrases` (absolute frames). Present only when the package uses
   * cue_phrases, so packages without them keep their exact timeline shape and hash.
   * `source` is deliberately conservative: `word-cues` means per-word timing existed, not that
   * the words were provably forced-aligned; `timing` is copied only when the chunk declared it,
   * and `syllable-fallback` marks measured audio with estimated word boundaries.
   */
  motionCues?: TimelineCueResolution[];
}

export interface TimelineCaption {
  text: string;
  from: number;
  to: number;
  sceneId: string;
  estimated: boolean;
  /** K1: per-word cues inside this sentence (absolute frames). Absent when unmeasured. */
  words?: TimelineWord[];
  /**
   * Provenance of `words[]`, copied from `NarrationChunk.timing` only when the chunk declared it.
   * Absent keeps the legacy caption shape. `syllable-fallback` means measured sentence audio with
   * estimated word boundaries.
   */
  timing?: NarrationTiming;
}

/** K1: one word inside a caption cue, in absolute frames. */
export interface TimelineWord {
  text: string;
  from: number;
  to: number;
}

/**
 * Where a resolved cue phrase got its timing. Deliberately does not say "forced alignment":
 * the current narration options may carry word cues without a timing-provenance field.
 */
export type TimelineCueSource =
  | 'explicit-seconds'
  | 'word-cues'
  | 'measured-caption'
  | 'estimated-caption'
  | 'unresolved';

export interface TimelineCueResolution {
  phrase: string;
  /** Absolute timeline frame, or null when no caption/word cue matched. */
  frame: number | null;
  /** Scene-local seconds (frame - scene.from), or null when unresolved. */
  seconds: number | null;
  source: TimelineCueSource;
  /**
   * True when the anchor's word positions are estimated, not when the sentence audio itself is
   * unmeasured: `word-cues` + `syllable-fallback` is measured audio with estimated word boundaries.
   */
  estimated: boolean;
  /** Word-timing provenance from a matched caption, when the chunk declared it. */
  timing?: NarrationTiming;
  /** 1-based occurrence of the phrase inside the scene when it was found. */
  occurrence?: number;
}

export type TimelineCueDiagnosticCode =
  | 'MOTION_CUE_PHRASE_MISSING'
  | 'MOTION_CUE_PHRASE_AMBIGUOUS'
  | 'MOTION_CUE_ESTIMATED';

export interface TimelineCueDiagnostic {
  code: TimelineCueDiagnosticCode;
  severity: 'warning';
  scene: string;
  phrase: string;
  message: string;
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
  /** Structured cue-phrase diagnostics; present only when at least one cue needed one. */
  motionCueDiagnostics?: TimelineCueDiagnostic[];
  sourceHash: string;
  hash: string;
}

export class TimelineError extends Error {
  readonly code: string;
  readonly sceneId?: string;
  /** A package/plan problem is client-correctable, so routes answer 422 instead of a naked 500. */
  readonly status = 422;
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
  scene: { id: string; layout: LayoutId; media_only?: boolean },
  options: CompileOptions,
  fps: number,
): { frames: number; measured: boolean } {
  const limit = sceneLimit(scene.layout, undefined, scene.media_only);
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

function sceneLimit(layout: LayoutId, variant?: string, mediaOnly = false): LayoutLimit {
  void variant;
  // Cinematic inserts have no layout copy to read; allow frame-exact short cuts.
  if (mediaOnly) return { min: 1, max: (LAYOUT_LIMITS[layout] ?? LAYOUT_LIMITS.hero).max };
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
    const limit = sceneLimit(scene.layout, scene.variant, scene.media_only);
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

/** Adjust only scene windows; never change fps, transitions, audio or media playback. */
function retimeExact(plans: ScenePlan[], pkg: ComfyrizzPackage, target: number, fps: number, options: CompileOptions): void {
  const bounds = plans.map((plan, i) => {
    const incoming = i ? plans[i - 1].transitionOut : 0;
    const chunks = options.narration?.[plan.scene.id] ?? [];
    const roundedSpeech = chunks.length ? chunks.reduce((sum, chunk) => sum + frameSecondsToFrames(chunk.seconds, fps), 0)
      + frameSecondsToFrames(options.narrationGapSeconds ?? DEFAULT_NARRATION_GAP_SECONDS, fps) * (chunks.length - 1)
      + frameSecondsToFrames(options.narrationPaddingSeconds ?? DEFAULT_NARRATION_PADDING_SECONDS, fps) : 0;
    const spoken = Math.max(roundedSpeech, plan.narrationFrames ?? 0, plan.scene.narration_duration_frames ?? 0);
    const cues = plan.scene.motion?.cue_seconds ?? [];
    const cueFloor = cues.reduce((max, seconds) => isFiniteNumber(seconds) && seconds >= 0 ? Math.max(max, Math.floor(seconds * fps) + 1) : max, 0);
    let min = Math.max(plan.min, incoming, plan.transitionOut, spoken ? spoken + plan.transitionOut : 0, cueFloor);
    let max = Math.max(plan.max, spoken ? spoken + plan.transitionOut : 0);
    // Timed drawings and edited audio cannot safely be shortened without editing their content.
    if (plan.scene.drawing || plan.scene.audio_trim) min = Math.max(min, plan.duration);
    const refs = [plan.scene.background?.asset, ...(plan.scene.foreground ?? []).map(item => item.asset), ...(plan.scene.media ?? []).map(item => item.asset)];
    // Generated/video coverage and user-locked scenes must not be stretched or trimmed here.
    const video = refs.some(id => id && pkg.assets?.[id]?.kind === 'video');
    if (plan.scene.locked || video) {
      min = Math.max(min, plan.duration);
      max = Math.min(max, plan.duration);
    }
    return { min, max, video };
  });
  const overlaps = plans.slice(0, -1).reduce((sum, plan) => sum + plan.transitionOut, 0);
  const minTotal = bounds.reduce((sum, bound) => sum + bound.min, -overlaps);
  const maxTotal = bounds.reduce((sum, bound) => sum + bound.max, -overlaps);
  if (bounds.some(bound => bound.min > bound.max) || target < minTotal || target > maxTotal) {
    const videoCount = bounds.filter(bound => bound.video).length;
    const coverage = target > maxTotal && videoCount > 0
      ? ` Shortfall ${target - maxTotal} project frames at ${fps} fps; ${videoCount} video scene windows are fixed. Explicitly author scene preferredFrames totalling ${target + overlaps} frames (${overlaps} overlap), then plan sufficient source footage at each source's fps for changed windows, or add shots. Do not stretch playback or insert unrequested holds.`
      : ' Shorten narration or transitions, adjust locked/timed scenes, add scenes, or choose a different duration.';
    throw new TimelineError('exact-duration-impossible', `Exact target ${target} frames cannot fit the scene, transition, narration, trim and media constraints (available ${minTotal}–${maxTotal} frames).${coverage}`);
  }
  plans.forEach((plan, i) => { plan.duration = clamp(plan.duration, bounds[i].min, bounds[i].max); });
  let delta = target - totalFrames(plans);
  while (delta !== 0) {
    const candidates = plans.map((plan, i) => ({ plan, bound: bounds[i] })).filter(({ plan, bound }) => delta > 0 ? plan.duration < bound.max : plan.duration > bound.min);
    const share = Math.max(1, Math.floor(Math.abs(delta) / candidates.length));
    for (const { plan, bound } of candidates) {
      const amount = Math.min(Math.abs(delta), share, delta > 0 ? bound.max - plan.duration : plan.duration - bound.min);
      const change = Math.sign(delta) * amount;
      plan.duration += change;
      delta -= change;
      if (!delta) break;
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
        if (typeof chunk.timing === 'string' && chunk.timing.trim().length > 0) caption.timing = chunk.timing;
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

interface CueToken {
  text: string;
  from: number | null;
  to: number | null;
}

/** Case/punctuation-insensitive word tokens; keeps letters and numbers in any script. */
function cueTokens(text: string): CueToken[] {
  const matches = String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu);
  return (matches ?? []).map(token => ({ text: token, from: null, to: null }));
}

function captionTokens(caption: TimelineCaption): CueToken[] {
  if (Array.isArray(caption.words) && caption.words.length > 0) {
    const out: CueToken[] = [];
    for (const word of caption.words) {
      for (const token of cueTokens(word.text)) out.push({ text: token.text, from: word.from, to: word.to });
    }
    return out;
  }
  return cueTokens(caption.text);
}

interface PhraseMatch {
  from: number;
  to: number;
  source: Exclude<TimelineCueSource, 'explicit-seconds' | 'unresolved'>;
  /** True when a word boundary is estimated (syllable fallback) or the whole caption is estimated. */
  estimated: boolean;
  /** Known word-timing provenance, only when the matched caption carried one. */
  timing?: NarrationTiming;
  count: number;
}

/**
 * Find every occurrence of a phrase's token sequence in the scene's captions, in order.
 * The first occurrence wins; the count lets the caller emit an explicit ambiguity diagnostic
 * instead of silently deciding what a repeated phrase meant.
 */
function findPhrase(phrase: string, captions: TimelineCaption[]): PhraseMatch | null {
  const needle = cueTokens(phrase).map(token => token.text);
  if (needle.length === 0) return null;
  let count = 0;
  let first: Omit<PhraseMatch, 'count'> | null = null;
  for (const caption of captions) {
    const tokens = captionTokens(caption);
    for (let i = 0; i + needle.length <= tokens.length; i += 1) {
      if (!needle.every((token, offset) => tokens[i + offset].text === token)) continue;
      count += 1;
      if (first) continue;
      const start = tokens[i];
      const end = tokens[i + needle.length - 1];
      const wordCues = start.from !== null && end.to !== null;
      const timing = wordCues && typeof caption.timing === 'string' && caption.timing.length > 0 ? caption.timing : undefined;
      first = {
        from: wordCues ? start.from! : caption.from,
        to: wordCues ? end.to! : caption.to,
        source: wordCues ? 'word-cues' : caption.estimated ? 'estimated-caption' : 'measured-caption',
        // A syllable fallback has measured audio but estimated word boundaries; an aligner and an
        // unknown/absent timing keep the conservative legacy behaviour (not claimed as estimated).
        estimated: wordCues ? caption.estimated || timing === 'syllable-fallback' : caption.estimated,
        ...(timing ? { timing } : {}),
      };
    }
  }
  return first ? { ...first, count } : null;
}

/**
 * Resolve `scene.motion.cue_phrases` against the compiled captions.
 *
 * Explicit `cue_seconds` wins per index. Otherwise a phrase is matched token-for-token against
 * measured word cues first, then the caption text. A caption-level anchor uses the caption's
 * start frame and is labelled `measured-caption`/`estimated-caption`; it never claims
 * word-perfect/forced alignment. A phrase with no match stays unresolved with a diagnostic.
 *
 * Pure: reads package scenes and captions, changes no scene timing or narration.
 */
function resolveMotionCues(
  pkg: ComfyrizzPackage,
  scenes: TimelineScene[],
  captions: TimelineCaption[],
  fps: number,
): { byScene: Map<string, TimelineCueResolution[]>; diagnostics: TimelineCueDiagnostic[] } {
  const byScene = new Map<string, TimelineCueResolution[]>();
  const diagnostics: TimelineCueDiagnostic[] = [];
  const packageScenes = new Map(pkg.scenes.map(scene => [scene.id, scene]));
  for (const scene of scenes) {
    const motion = packageScenes.get(scene.id)?.motion;
    if (!motion || !Array.isArray(motion.cue_phrases)) continue;
    const phrases = motion.cue_phrases.filter(phrase => typeof phrase === 'string' && phrase.trim().length > 0);
    if (phrases.length === 0) continue;
    const explicitSeconds = Array.isArray(motion.cue_seconds) ? motion.cue_seconds : [];
    const sceneCaptions = captions.filter(caption => caption.sceneId === scene.id);
    const cues: TimelineCueResolution[] = [];
    phrases.forEach((phrase, index) => {
      const explicit = explicitSeconds[index];
      if (isFiniteNumber(explicit) && explicit >= 0) {
        cues.push({ phrase, frame: scene.from + Math.round(explicit * fps), seconds: explicit, source: 'explicit-seconds', estimated: false });
        return;
      }
      const match = findPhrase(phrase, sceneCaptions);
      if (!match) {
        cues.push({ phrase, frame: null, seconds: null, source: 'unresolved', estimated: false });
        diagnostics.push({
          code: 'MOTION_CUE_PHRASE_MISSING',
          severity: 'warning',
          scene: scene.id,
          phrase,
          message: `Cue phrase ${JSON.stringify(phrase)} in ${scene.id} has no matching measured caption or word cue; left unresolved (no forced alignment is claimed).`,
        });
        return;
      }
      cues.push({
        phrase,
        frame: match.from,
        seconds: (match.from - scene.from) / fps,
        source: match.source,
        estimated: match.estimated,
        ...(match.timing ? { timing: match.timing } : {}),
        occurrence: 1,
      });
      if (match.count > 1) {
        diagnostics.push({
          code: 'MOTION_CUE_PHRASE_AMBIGUOUS',
          severity: 'warning',
          scene: scene.id,
          phrase,
          message: `Cue phrase ${JSON.stringify(phrase)} occurs ${match.count} times in ${scene.id}; using occurrence 1. Add explicit cue_seconds when a later occurrence is meant.`,
        });
      }
      if (match.estimated) {
        const message = match.source === 'estimated-caption'
          ? `Cue phrase ${JSON.stringify(phrase)} in ${scene.id} is anchored to estimated captions, not measured narration; it will move when audio is measured.`
          : match.timing === 'syllable-fallback'
            ? `Cue phrase ${JSON.stringify(phrase)} in ${scene.id} uses syllable-fallback word positions: the sentence audio is measured, but this word boundary is estimated.`
            : `Cue phrase ${JSON.stringify(phrase)} in ${scene.id} has estimated word positions; its sentence audio is measured but the word boundary is not treated as exact.`;
        diagnostics.push({
          code: 'MOTION_CUE_ESTIMATED',
          severity: 'warning',
          scene: scene.id,
          phrase,
          message,
        });
      }
    });
    byScene.set(scene.id, cues);
  }
  return { byScene, diagnostics };
}

/**
 * Editor caption corrections. Only cue text changes: frames, word cues, timing provenance and
 * scene narration stay exactly as compiled. Motion cues keep resolving against the spoken
 * captions below, so correcting display wording cannot move a cue in time.
 */
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
  if (!pkg.duration?.exact) validateTransitions(plans);

  const mode = pkg.duration?.mode === 'target' ? 'target' : 'flexible';
  const requested = mode === 'target' && isFiniteNumber(pkg.duration?.targetFrames) ? Math.max(1, Math.floor(pkg.duration!.targetFrames!)) : null;
  if (pkg.duration?.exact && requested === null) {
    throw new TimelineError('bad-target', 'Exact duration requires target mode and targetFrames.');
  }
  const warnings: string[] = [];
  if (mode === 'target') {
    if (requested === null) warnings.push('Target mode without targetFrames: using the flexible length.');
    else if (pkg.duration?.exact) retimeExact(plans, pkg, requested, fps, options);
    else growTowardTarget(plans, requested);
  }
  validateTransitions(plans);

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

  // Storytelling cues: resolve against the spoken captions (before display-only wording fixes),
  // and never change scene timing or narration.
  const { byScene: motionCuesByScene, diagnostics: motionCueDiagnostics } = resolveMotionCues(pkg, scenes, built.captions, fps);
  for (const scene of scenes) {
    const cues = motionCuesByScene.get(scene.id);
    if (cues) scene.motionCues = cues;
  }
  warnings.push(...motionCueDiagnostics.map(diagnostic => diagnostic.message));

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
    // Only emitted when a cue phrase needed a diagnostic, so ordinary packages are unchanged.
    ...(motionCueDiagnostics.length > 0 ? { motionCueDiagnostics } : {}),
    sourceHash: sha256Hex(canonicalJson(pkg)),
  };

  return { ...withoutHash, hash: hashTimeline(withoutHash) };
}
