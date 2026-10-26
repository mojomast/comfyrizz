/**
 * Provisional Comfyrizz package types (spec 6.3).
 *
 * These are intentionally a *subset* of `comfyrizz.package/v1`: Pi codes against
 * the spec 6.3 example until Hermes lands `packages/schema/types.ts` (task B1).
 * When that happens, replace the imports in this package with the generated
 * types; the compiler itself only needs the fields below.
 */

export type LayoutId = 'title' | 'hero' | 'stat' | 'chart' | 'list' | 'split' | 'compare' | 'code';

export interface PackageFormat {
  width: number;
  height: number;
  fps: number;
}

export interface PackageDuration {
  mode: 'target' | 'flexible';
  targetFrames?: number;
}

export interface PackageCopy {
  headline?: string;
  sub?: string;
  quote?: string;
  bullets?: string[];
  /** charts may carry inline labels; datasets are referenced by `data.dataset`. */
  [key: string]: unknown;
}

export interface SceneData {
  dataset?: string;
  value?: number;
  label?: string;
  unit?: string;
  [key: string]: unknown;
}

export interface SceneBackground {
  asset?: string;
  fit?: 'cover' | 'contain';
  loop?: boolean;
}

export interface SceneForeground {
  asset: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  anim?: string;
}

export interface SceneTransition {
  type: 'fade' | 'none' | string;
  frames: number;
}

/** Storytelling recipe id: the shared catalogue is packages/schema/src/animation.mjs. */
export type AnimationRecipeId = 'sketch' | 'paper-cut' | 'morph' | 'technical-flow' | 'focus' | 'kinetic';

/** Bounded shape ids accepted by `scene.motion.morph`. */
export type MorphShape = 'circle' | 'square' | 'triangle' | 'blob';

/** Normalised focus window (all values 0..1; x + width and y + height stay within 1). */
export interface SceneMotionFocus {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneMotionMorph {
  from: MorphShape;
  to: MorphShape;
}

/**
 * The optional storytelling motion contract. Every field is additive: an absent block keeps the
 * renderer's current layout defaults. `cue_seconds` remains the explicit timing source; when it
 * is absent the planner resolves `cue_phrases` against measured captions/word cues.
 */
export interface SceneMotion {
  diagram?: 'flow' | 'hub';
  recipe?: AnimationRecipeId;
  /** Stable seed for recipe texture/geometry, 1..2147483647. */
  seed?: number;
  /** Recipe strength, 0..1. */
  intensity?: number;
  focus?: SceneMotionFocus;
  morph?: SceneMotionMorph;
  /** Narration phrases that anchor scene beats, in order (max 6). */
  cue_phrases?: string[];
  /** Explicit scene-local cue seconds; takes priority over cue_phrases. */
  cue_seconds?: number[];
  entry?: string;
  ease?: string;
  spring?: string;
  stagger?: string;
  emphasis?: string;
  highlight?: string;
  energy?: string;
}

export interface SceneLowerThird {
  kicker?: string;
  text: string;
}

export interface Scene {
  id: string;
  layout: LayoutId;
  variant?: string;
  preferredFrames?: number;
  copy?: PackageCopy;
  data?: SceneData | null;
  background?: SceneBackground | null;
  foreground?: SceneForeground[];
  transitionOut?: SceneTransition;
  motion?: SceneMotion;
  narration?: string;
  /** Draw only the media layer (background + scrim + foreground + lower third), skipping the layout. */
  media_only?: boolean;
  /** Lower-third overlay content for full-bleed and media-only scenes. */
  lower_third?: SceneLowerThird;
  /** H17: this scene's own presenter answer - off, picture-in-picture, or the split layout. */
  presenter?: 'off' | 'pip' | 'split';
  /** H17: the ltx25-a2v clip generated for this scene (falls back to the package portrait). */
  presenter_asset?: string;
  locked?: boolean;
}

export interface AssetGen {
  generator?: string;
  sanitizer_version?: string;
  render_check?: unknown;
  [key: string]: unknown;
}

export interface AssetMedia {
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  audio?: string;
}

export interface Asset {
  kind?: string;
  origin?: string;
  status?: string;
  file?: string;
  sha256?: string;
  media?: AssetMedia;
  gen?: AssetGen;
  [key: string]: unknown;
}

export interface Voice {
  enabled?: boolean;
  engine?: string;
  voice?: string;
  speed?: number;
}

/** H17 presenter block (schema v1 `presenter`). Opt-in per video. */
export interface Presenter {
  enabled?: boolean;
  portrait?: string;
  placement?: 'pip-br' | 'pip-bl' | 'pip-bc' | 'split-left';
  shape?: 'circle' | 'rounded-rect';
  /** width as a fraction of the frame's short side, 0.18-0.32. */
  size?: number;
  /** which scenes show the presenter: both bookends, every scene, or explicit scene ids. */
  scenes?: 'all' | 'bookends' | string[];
  label?: string;
}

export interface ComfyrizzPackage {
  id?: string;
  title?: string;
  format: PackageFormat;
  duration?: PackageDuration;
  scenes: Scene[];
  assets?: Record<string, Asset>;
  voice?: Voice;
  theme?: { palette?: string[]; font?: string; logo_asset?: string };
  datasets?: Record<string, unknown>;
  presenter?: Presenter;
  /** K1: caption presentation (sentence default; 9:16 defaults to big-word when absent). */
  captions?: { style?: 'sentence' | 'karaoke' | 'word-pop' | 'big-word'; presentation?: 'phrases' };
  [key: string]: unknown;
}

/** Measured narration chunks, one entry per spoken sentence/utterance. */
export interface NarrationWord {
  text: string;
  /** seconds from the start of the sentence (chunk) */
  start: number;
  /** seconds from the start of the sentence (chunk) */
  end: number;
}

/**
 * How a chunk's `words[]` were produced. The two known values are interpreted by the planner:
 * `aligner` is accurate word timing; `syllable-fallback` is an estimated word boundary inside
 * measured audio. Any other string is carried through for compatibility but is not treated as
 * either accurate or estimated.
 */
export type NarrationTiming = 'aligner' | 'syllable-fallback' | (string & {});

export interface NarrationChunk {
  text: string;
  seconds: number;
  /** K1: optional per-word timings inside this sentence (seconds, sentence-relative). */
  words?: NarrationWord[];
  /** Provenance of `words[]`; absent keeps the legacy unknown-provenance behaviour. */
  timing?: NarrationTiming;
}

/** Caption wording correction. Timing stays on the compiled cue; speech text is untouched. */
export interface CaptionOverride {
  sceneId: string;
  /** Index among that scene's caption cues, in compile order. */
  index: number;
  text: string;
}

export interface CompileOptions {
  /** Opt-in measured phrase presentation; existing cue-index overrides apply before splitting. */
  captionPresentation?: 'phrases';
  /** Measured Kokoro chunks per scene id. Absent while narration is provisional. */
  narration?: Record<string, NarrationChunk[]>;
  /** Fixed silence between narration chunks, in seconds. Default 0.15. */
  narrationGapSeconds?: number;
  /** Fixed end padding after speech, in seconds. Default 0.25. */
  narrationPaddingSeconds?: number;
  /** Emit estimated caption cues when narration audio is not ready yet. Default true. */
  estimateCaptions?: boolean;
  /** Replace caption cue text after timing is projected. Does not change scene.narration. */
  captionOverrides?: CaptionOverride[];
}
