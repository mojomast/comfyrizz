/**
 * Script, audio and media shapes. The project document and the command union
 * live in commands.ts. Takes, alignment and presenter clips are editor sidecar
 * fields, not package-v1.
 */

export interface VoiceSettings {
  enabled: boolean;
  engine?: 'kokoro' | 'qwen3-tts' | 'none';
  voice?: string;
  speed?: number;
  language?: string;
  lang?: string;
  persona?: string;
  ref_asset?: string;
  strict?: boolean;
  chunking?: 'sentence' | 'paragraph';
  blend?: Array<{ voice: string; weight: number }>;
  qwen_mode?: 'design' | 'custom';
  delivery?: string;
  non_streaming?: boolean;
  reference_text?: string;
}

export interface EditorScene {
  id: string;
  layout: string;
  media_only?: boolean;
  preferredFrames?: number;
  copy?: Record<string, unknown>;
  transitionOut?: { type: string; frames?: number; direction?: string };
  narration?: string;
  narration_spoken?: string;
  spoken_text?: string;
  narration_style?: string;
  narration_asset?: string;
  narration_duration_frames?: number;
  presenter?: 'off' | 'pip' | 'split';
  presenter_asset?: string;
  locked?: boolean;
  background?: { asset?: string } | null;
  foreground?: Array<{ asset?: string }>;
}

export interface EditorPackage {
  id: string;
  title?: string;
  revision?: number;
  format: { width: number; height: number; fps: number };
  duration?: { mode?: 'target' | 'flexible'; targetFrames?: number };
  voice?: VoiceSettings;
  scenes: EditorScene[];
  assets?: Record<string, EditorAsset>;
  /** Sound-design block consumed by the renderer's resolveAudioMix. */
  audio?: unknown;
  presenter?: {
    enabled?: boolean;
    portrait?: string;
    scenes?: 'all' | 'bookends' | string[];
    placement?: string;
  };
}

export interface EditorAsset {
  kind?: string;
  status?: string;
  file?: string;
  media?: { audio?: string; durationSeconds?: number; fps?: number; frames?: number };
}

/** Inclusive start, exclusive end, in source samples. Playback rate is always 1. */
export interface SourceRange {
  inSample: number;
  outSample: number;
}

export interface NarrationTake {
  takeId: string;
  assetId: string;
  /** Content hash of the full source audio, not the trimmed range. */
  sourceHash: string;
  /** Fingerprint of narration text + voice when this take was produced. */
  inputFingerprint: string;
  sampleRate: number;
  /** Total samples in the source asset. */
  sampleCount: number;
  range: SourceRange;
}

export interface AlignmentWord {
  text: string;
  /** Seconds from the start of the chunk. */
  start: number;
  end: number;
}

/** Planner-compatible measured chunk. Times are scene-local once the chunk is placed. */
export interface AlignmentChunk {
  timing?: 'aligner' | 'syllable-fallback';
  text: string;
  seconds: number;
  words?: AlignmentWord[];
}

export interface SceneAlignment {
  sourceHash: string;
  /** Fingerprint of the narration text this alignment was measured against. */
  textFingerprint: string;
  chunks: AlignmentChunk[];
}

export interface CaptionEdit {
  index: number;
  text: string;
}

export interface PresenterClip {
  assetId: string;
  /** Hash of the narration source range that conditioned this clip. */
  conditioningHash: string;
}

export type Freshness = 'fresh' | 'stale' | 'missing';

export interface SceneFreshness {
  take: Freshness;
  alignment: Freshness;
  presenter: Freshness | 'unused';
}

export interface PlacedScene {
  id: string;
  from: number;
  duration: number;
  transitionOut: number;
}

export interface SentenceCue {
  index: number;
  text: string;
  from: number;
  to: number;
  sceneId: string;
  estimated: boolean;
}

export interface WaveformPeaks {
  sourceHash: string;
  buckets: number;
  min: Float32Array;
  max: Float32Array;
}

export interface AuditionMix {
  /** True when resolveAudioMix produced at least one bus. */
  enabled: boolean;
  narrationGain: 1;
  musicGainDb: number | null;
  musicLoop: boolean | null;
  musicDuck: { enabled: boolean; reductionDb: number; attackMs: number; releaseMs: number } | null;
  musicGains: number[] | null;
  ambience: Array<{ sceneId: string; gainDb: number; from: number; durationInFrames: number; gains: number[] }>;
  sfx: Array<{ sceneId: string; gainDb: number; from: number; durationInFrames: number }>;
}
