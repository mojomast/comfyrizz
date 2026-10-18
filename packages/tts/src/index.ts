/**
 * Captions and measured narration (spec 6.8).
 *
 * Kokoro synthesises one sentence at a time. `synth.py` writes the measured
 * seconds per chunk and, since K1, a `words[]` list inside each chunk. A real
 * aligner can supply those words; otherwise `synth.py`'s syllable fallback fills
 * the sentence. This module turns them into compiler options and exports SRT/VTT
 * from the *same* cues the player uses.
 */

export interface NarrationWord {
  text: string;
  /** seconds from the start of the sentence (chunk) */
  start: number;
  /** seconds from the start of the sentence (chunk) */
  end: number;
}

export interface NarrationChunk {
  text: string;
  seconds: number;
  words?: NarrationWord[];
}

export interface SceneNarration {
  chunks: NarrationChunk[];
  gapSeconds: number;
  paddingSeconds: number;
  seconds: number;
  file?: string;
}

export interface NarrationDurations {
  version: number;
  engine: string;
  engineVersion: string;
  model: string;
  voices: string;
  voice: string;
  speed: number;
  sampleRate: number;
  gapSeconds: number;
  paddingSeconds: number;
  scenes: Record<string, SceneNarration>;
  totalSeconds: number;
  file?: string;
}

export interface CaptionCue {
  text: string;
  from: number;
  to: number;
  sceneId?: string;
  estimated?: boolean;
}

export interface CompileNarrationOptions {
  narration: Record<string, NarrationChunk[]>;
  narrationGapSeconds: number;
  narrationPaddingSeconds: number;
}

const DEFAULT_GAP = 0.15;
const DEFAULT_PADDING = 0.25;
/** K1: allow an aligner's rounding when checking that words fill their sentence. */
const WORD_TOLERANCE = 0.02;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse and validate `durations.json`; throws instead of trusting partial data. */
export function parseDurations(input: unknown): NarrationDurations {
  if (!isRecord(input)) throw new Error('durations must be an object');
  if (input.version !== 1) throw new Error(`unsupported durations version ${String(input.version)}`);
  if (!isRecord(input.scenes)) throw new Error('durations.scenes must be an object');
  const scenes: Record<string, SceneNarration> = {};
  for (const [sceneId, value] of Object.entries(input.scenes)) {
    if (!isRecord(value)) throw new Error(`scene ${sceneId} must be an object`);
    if (!Array.isArray(value.chunks) || value.chunks.length === 0) {
      throw new Error(`scene ${sceneId} has no measured chunks`);
    }
    const chunks = value.chunks.map((chunk, index) => {
      if (!isRecord(chunk) || typeof chunk.text !== 'string' || typeof chunk.seconds !== 'number') {
        throw new Error(`scene ${sceneId} chunk ${index} is invalid`);
      }
      if (!(chunk.seconds > 0)) throw new Error(`scene ${sceneId} chunk ${index} has no duration`);
      return { text: chunk.text, seconds: chunk.seconds, words: parseWords(chunk.words, chunk.seconds, sceneId, index) };
    });
    const seconds = typeof value.seconds === 'number' ? value.seconds : 0;
    scenes[sceneId] = {
      chunks,
      gapSeconds: typeof value.gapSeconds === 'number' ? value.gapSeconds : DEFAULT_GAP,
      paddingSeconds: typeof value.paddingSeconds === 'number' ? value.paddingSeconds : DEFAULT_PADDING,
      seconds,
      file: typeof value.file === 'string' ? value.file : undefined,
    };
  }
  const sampleRate = typeof input.sampleRate === 'number' ? input.sampleRate : 24_000;
  if (sampleRate !== 24_000) throw new Error(`unexpected Kokoro sample rate ${sampleRate}`);
  return {
    version: 1,
    engine: String(input.engine ?? 'kokoro-onnx'),
    engineVersion: String(input.engineVersion ?? ''),
    model: String(input.model ?? ''),
    voices: String(input.voices ?? ''),
    voice: String(input.voice ?? ''),
    speed: typeof input.speed === 'number' ? input.speed : 1,
    sampleRate,
    gapSeconds: typeof input.gapSeconds === 'number' ? input.gapSeconds : DEFAULT_GAP,
    paddingSeconds: typeof input.paddingSeconds === 'number' ? input.paddingSeconds : DEFAULT_PADDING,
    scenes,
    totalSeconds: typeof input.totalSeconds === 'number' ? input.totalSeconds : 0,
    file: typeof input.file === 'string' ? input.file : undefined,
  };
}

/** K1: validate the optional per-word timings; they must fill the measured sentence. */
function parseWords(input: unknown, seconds: number, sceneId: string, chunkIndex: number): NarrationWord[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error(`scene ${sceneId} chunk ${chunkIndex} words must be an array`);
  const where = `scene ${sceneId} chunk ${chunkIndex}`;
  let previousStart = 0;
  const words = input.map((word, index) => {
    if (!isRecord(word) || typeof word.text !== 'string' || !word.text.trim()) {
      throw new Error(`${where} word ${index} has no text`);
    }
    if (typeof word.start !== 'number' || typeof word.end !== 'number') {
      throw new Error(`${where} word ${index} needs numeric start/end`);
    }
    if (word.start < previousStart - WORD_TOLERANCE || word.end < word.start) {
      throw new Error(`${where} word ${index} is not monotonic`);
    }
    if (word.start < -WORD_TOLERANCE || word.end > seconds + WORD_TOLERANCE) {
      throw new Error(`${where} word ${index} falls outside the ${seconds}s sentence`);
    }
    previousStart = word.start;
    return { text: word.text, start: word.start, end: word.end };
  });
  if (words.length > 0 && Math.abs(words[words.length - 1].end - seconds) > WORD_TOLERANCE) {
    throw new Error(`${where} words end at ${words[words.length - 1].end}s, sentence is ${seconds}s`);
  }
  return words;
}

/** Options for `compileTimeline` — measured durations only, so not provisional. */
export function compileOptionsFromDurations(durations: NarrationDurations): CompileNarrationOptions {
  const narration: Record<string, NarrationChunk[]> = {};
  for (const [sceneId, scene] of Object.entries(durations.scenes)) {
    narration[sceneId] = scene.chunks.map(chunk => (chunk.words && chunk.words.length > 0 ? { text: chunk.text, seconds: chunk.seconds, words: chunk.words } : { text: chunk.text, seconds: chunk.seconds }));
  }
  return {
    narration,
    narrationGapSeconds: durations.gapSeconds,
    narrationPaddingSeconds: durations.paddingSeconds,
  };
}

/** Sum of measured speech + fixed gaps + end padding, in seconds. */
export function sceneNarrationSeconds(scene: SceneNarration): number {
  const spoken = scene.chunks.reduce((total, chunk) => total + chunk.seconds, 0);
  return spoken + scene.gapSeconds * Math.max(0, scene.chunks.length - 1) + scene.paddingSeconds;
}

function timestamp(seconds: number, comma: boolean): string {
  const safe = Math.max(0, seconds);
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${comma ? ',' : '.'}${pad(ms, 3)}`;
}

function cueBounds(cue: CaptionCue, fps: number): { from: number; to: number } {
  const from = cue.from / fps;
  const to = Math.max(from + 0.2, cue.to / fps);
  return { from, to };
}

/** SRT from timeline cues (frames at `fps`). Sentence-level, no word timing. */
export function captionsToSrt(cues: CaptionCue[], fps = 30): string {
  if (cues.length === 0) return '';
  return `${cues
    .map((cue, index) => {
      const { from, to } = cueBounds(cue, fps);
      return `${index + 1}\n${timestamp(from, true)} --> ${timestamp(to, true)}\n${cue.text.trim()}\n`;
    })
    .join('\n')}`;
}

/** WebVTT from the same cues, with a stable header for Remotion/HTML players. */
export function captionsToVtt(cues: CaptionCue[], fps = 30): string {
  const body = cues
    .map((cue, index) => {
      const { from, to } = cueBounds(cue, fps);
      return `cue-${index + 1}\n${timestamp(from, false)} --> ${timestamp(to, false)}\n${cue.text.trim()}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** K1: a caption cue that also carries measured per-word timings (absolute frames). */
export interface WordCaptionCue extends CaptionCue {
  words?: Array<{ text: string; from: number; to: number }>;
}

/**
 * K1: an optional word-level WebVTT. Sentence `captions.vtt`/`captions.srt` are
 * unchanged; this file is only written when the timeline has word cues.
 */
export function captionsToWordVtt(cues: WordCaptionCue[], fps = 30): string {
  const lines: string[] = [];
  let index = 0;
  for (const cue of cues) {
    for (const word of cue.words ?? []) {
      const from = word.from / fps;
      const to = Math.max(from + 0.05, word.to / fps);
      index += 1;
      lines.push(`word-${index}\n${timestamp(from, false)} --> ${timestamp(to, false)}\n${word.text.trim()}\n`);
    }
  }
  return `WEBVTT\n\n${lines.join('\n')}`;
}

/** R3: optional narration engines. `kokoro` is the default and the no-GPU fallback. */
export type VoiceEngine = 'kokoro' | 'qwen3-tts';
