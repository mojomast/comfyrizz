/**
 * Editor document, derived projection and session.
 * ProjectDoc is the CA-1 document class. Source ranges and take fingerprints live
 * here (render-affecting editor state) until CA-1's schema extensions land.
 * They are included in the editor export sidecar, not in session or media tickets.
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
}

export interface EditorScene {
  id: string;
  layout: string;
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

export interface ProjectDoc {
  pkg: EditorPackage;
  takes: Record<string, NarrationTake>;
  alignment: Record<string, SceneAlignment>;
  /** Wording corrections. They do not change the spoken take. */
  captions: Record<string, CaptionEdit[]>;
  presenterClips: Record<string, PresenterClip>;
  editSeq: number;
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

export interface EditorTimeline {
  fps: number;
  durationInFrames: number;
  scenes: Array<{ id: string; from: number; durationInFrames: number; transitionOutFrames: number }>;
  captions: SentenceCue[];
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

export interface DerivedState {
  timeline: EditorTimeline;
  placed: PlacedScene[];
  status: Record<string, SceneFreshness>;
  /** `take:s1`, `alignment:s1`, `presenter:s1` — the invalidation table, nothing else. */
  staleWork: string[];
  /** Presenter asset ids whose conditioning no longer matches. Visual and music assets are absent. */
  staleAssets: string[];
  sentences: Record<string, SentenceCue[]>;
  audition: AuditionMix;
  waveforms: Record<string, WaveformPeaks>;
  diagnostics: string[];
}

export interface AuditionSession {
  /** Session-only. Export uses the unmuted renderer mix. */
  narration: boolean;
  music: boolean;
  ambience: boolean;
  sfx: boolean;
  /** `cpu` plays the Kokoro fixture and must not replace a selected Qwen voice. */
  voicePreview: 'selected' | 'cpu';
}

export interface SessionState {
  selectedSceneId: string | null;
  selectedCaption: number | null;
  playheadFrame: number;
  audition: AuditionSession;
  saveStatus: 'saved' | 'pending' | 'offline' | 'conflict';
}

export type Result = { ok: true } | { ok: false; reason: string };
