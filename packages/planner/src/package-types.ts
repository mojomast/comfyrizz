/**
 * Provisional Comfyrizz package types (spec 6.3).
 *
 * These are intentionally a *subset* of `comfyrizz.package/v1`: Pi codes against
 * the spec 6.3 example until Hermes lands `packages/schema/types.ts` (task B1).
 * When that happens, replace the imports in this package with the generated
 * types; the compiler itself only needs the fields below.
 */

export type LayoutId = 'title' | 'hero' | 'stat' | 'chart' | 'list';

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
  narration?: string;
  /** Draw only the media layer (background + scrim + foreground + lower third), skipping the layout. */
  media_only?: boolean;
  /** Lower-third overlay content for full-bleed and media-only scenes. */
  lower_third?: SceneLowerThird;
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
  [key: string]: unknown;
}

/** Measured narration chunks, one entry per spoken sentence/utterance. */
export interface NarrationChunk {
  text: string;
  seconds: number;
}

export interface CompileOptions {
  /** Measured Kokoro chunks per scene id. Absent while narration is provisional. */
  narration?: Record<string, NarrationChunk[]>;
  /** Fixed silence between narration chunks, in seconds. Default 0.15. */
  narrationGapSeconds?: number;
  /** Fixed end padding after speech, in seconds. Default 0.25. */
  narrationPaddingSeconds?: number;
  /** Emit estimated caption cues when narration audio is not ready yet. Default true. */
  estimateCaptions?: boolean;
}
