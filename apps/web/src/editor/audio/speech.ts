/**
 * Scene placement, sentence cues and source-range splits.
 * Frame math matches packages/planner (gap 0.15 s, pad 0.25 s, ceil to frames,
 * layout floors that never clip measured speech). Playback of a take range is
 * always 1:1 samples — split and reorder copy slices, they never resample.
 */
import { fingerprint } from '../hash.ts';
import type {
  AlignmentChunk,
  AlignmentWord,
  EditorPackage,
  EditorScene,
  NarrationTake,
  PlacedScene,
  SentenceCue,
  VoiceSettings,
} from '../types.ts';

export const NARRATION_GAP_SECONDS = 0.15;
export const NARRATION_PADDING_SECONDS = 0.25;
/** Narration is copied at this rate. There is no stretch control. */
export const NARRATION_PLAYBACK_RATE = 1;

const LAYOUT_LIMITS: Record<string, { min: number; max: number }> = {
  title: { min: 30, max: 450 },
  hero: { min: 45, max: 600 },
  stat: { min: 30, max: 300 },
  chart: { min: 45, max: 450 },
  list: { min: 45, max: 600 },
  split: { min: 45, max: 600 },
  compare: { min: 45, max: 600 },
  code: { min: 45, max: 600 },
};

export function narrationInputFingerprint(scene: EditorScene, voice: VoiceSettings | undefined): string {
  return fingerprint({
    text: scene.narration ?? '',
    spoken: scene.narration_spoken ?? scene.spoken_text ?? '',
    style: scene.narration_style ?? '',
    engine: voice?.enabled === false || voice?.engine === 'none' ? 'none' : (voice?.engine ?? 'kokoro'),
    voice: voice?.voice ?? '',
    speed: voice?.speed ?? 1,
    language: voice?.language ?? '',
    lang: voice?.lang ?? '',
    persona: voice?.persona ?? '',
    // Optional production controls affect the synthesized take too. Omit absent
    // keys so existing basic-voice fingerprints keep their legacy shape.
    ...(voice?.chunking !== undefined ? { chunking: voice.chunking } : {}),
    ...(voice?.blend !== undefined ? { blend: voice.blend } : {}),
    ...(voice?.qwen_mode !== undefined ? { qwen_mode: voice.qwen_mode } : {}),
    ...(voice?.delivery !== undefined ? { delivery: voice.delivery } : {}),
    ...(voice?.non_streaming !== undefined ? { non_streaming: voice.non_streaming } : {}),
    ...(voice?.reference_text !== undefined ? { reference_text: voice.reference_text } : {}),
  });
}

export function textFingerprint(text: string): string {
  return fingerprint({ text });
}

export function conditioningHash(take: NarrationTake): string {
  return fingerprint({
    sourceHash: take.sourceHash,
    inSample: take.range.inSample,
    outSample: take.range.outSample,
    sampleRate: take.sampleRate,
  });
}

export function projectFps(pkg: EditorPackage): number {
  const fps = pkg.format?.fps;
  return typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? Math.floor(fps) : 30;
}

function ceilFrames(seconds: number, fps: number): number {
  return Math.max(0, Math.ceil(seconds * fps));
}

export function narrationFloorFrames(chunks: AlignmentChunk[] | undefined, fps: number): number | null {
  if (!chunks || chunks.length === 0) return null;
  const spoken = chunks.reduce((sum, chunk) => sum + Math.max(0, chunk.seconds), 0);
  const gaps = NARRATION_GAP_SECONDS * Math.max(0, chunks.length - 1);
  return ceilFrames(spoken + gaps + NARRATION_PADDING_SECONDS, fps);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface Plan {
  scene: EditorScene;
  duration: number;
  transitionOut: number;
  min: number;
  max: number;
}

function planScenes(pkg: EditorPackage, chunksByScene: Record<string, AlignmentChunk[] | undefined>, fps: number): Plan[] {
  return pkg.scenes.map(scene => {
    const layoutLimit = LAYOUT_LIMITS[scene.layout] ?? LAYOUT_LIMITS.hero;
    const limit = scene.media_only ? { ...layoutLimit, min: 1 } : layoutLimit;
    const preferred = typeof scene.preferredFrames === 'number' && Number.isFinite(scene.preferredFrames)
      ? Math.floor(scene.preferredFrames)
      : limit.min;
    const spoken = narrationFloorFrames(chunksByScene[scene.id], fps);
    const base = spoken === null ? preferred : Math.max(preferred, spoken);
    const max = Math.max(limit.max, spoken ?? 0);
    const duration = clamp(base, limit.min, max);
    const type = scene.transitionOut?.type;
    const transitionOut = type && type !== 'none' && type !== 'cut'
      ? Math.max(0, Math.floor(scene.transitionOut?.frames || 0))
      : 0;
    return { scene, duration, transitionOut, min: limit.min, max };
  });
}

function totalFrames(plans: Plan[]): number {
  const sum = plans.reduce((acc, plan) => acc + plan.duration, 0);
  const overlaps = plans.slice(0, -1).reduce((acc, plan) => acc + plan.transitionOut, 0);
  return sum - overlaps;
}

function growTowardTarget(plans: Plan[], target: number): void {
  let guard = 0;
  while (totalFrames(plans) < target && guard < 100000) {
    guard += 1;
    const growable = plans.filter(plan => plan.duration < plan.max);
    if (growable.length === 0) break;
    const step = Math.min(5, target - totalFrames(plans));
    for (const plan of growable) {
      if (totalFrames(plans) >= target) break;
      plan.duration = Math.min(plan.max, plan.duration + step);
    }
  }
}

export function placeScenes(
  pkg: EditorPackage,
  chunksByScene: Record<string, AlignmentChunk[] | undefined>,
): { ok: true; fps: number; scenes: PlacedScene[] } | { ok: false; reason: string } {
  if (!pkg.scenes?.length) return { ok: false, reason: 'A package needs at least one scene.' };
  const fps = projectFps(pkg);
  const plans = planScenes(pkg, chunksByScene, fps);
  for (let i = 0; i < plans.length; i += 1) {
    const frames = plans[i].transitionOut;
    if (frames <= 0) continue;
    const neighbour = plans[i + 1];
    if (!neighbour) return { ok: false, reason: `Scene ${plans[i].scene.id} has a transition but is the last scene.` };
    if (frames > plans[i].duration || frames > neighbour.duration) {
      return { ok: false, reason: `Transition ${frames} on scene ${plans[i].scene.id} does not fit its neighbours.` };
    }
  }
  if (pkg.duration?.mode === 'target' && typeof pkg.duration.targetFrames === 'number') {
    growTowardTarget(plans, Math.max(1, Math.floor(pkg.duration.targetFrames)));
  }
  const scenes: PlacedScene[] = [];
  let cursor = 0;
  for (const plan of plans) {
    scenes.push({ id: plan.scene.id, from: cursor, duration: plan.duration, transitionOut: plan.transitionOut });
    cursor += plan.duration - plan.transitionOut;
  }
  return { ok: true, fps, scenes };
}

/** Absolute sentence cues. Caption edits replace wording and leave timing alone. */
export function sentenceCues(
  chunks: AlignmentChunk[],
  sceneFrom: number,
  sceneId: string,
  fps: number,
  edits?: Array<{ index: number; text: string }>,
): SentenceCue[] {
  const gap = ceilFrames(NARRATION_GAP_SECONDS, fps);
  let cursor = sceneFrom;
  return chunks.map((chunk, index) => {
    const frames = Math.max(1, ceilFrames(chunk.seconds, fps));
    const edit = edits?.find(item => item.index === index);
    const cue: SentenceCue = {
      index,
      text: edit?.text ?? chunk.text,
      from: cursor,
      to: cursor + frames,
      sceneId,
      estimated: false,
    };
    cursor += frames + gap;
    return cue;
  });
}

export function seekFrameForSentence(cues: SentenceCue[], index: number): number | null {
  const cue = cues.find(item => item.index === index);
  return cue ? cue.from : null;
}

/**
 * Snap the playhead to a sentence boundary when one is within `snapFrames`,
 * but only when both sides would still contain a sentence.
 */
export function snapSplitFrame(cues: SentenceCue[], frame: number, sceneFrom: number, sceneEnd: number, snapFrames: number): number {
  const boundaries: number[] = [];
  for (const cue of cues) {
    if (cue.from > sceneFrom && cue.from < sceneEnd) boundaries.push(cue.from);
    if (cue.to > sceneFrom && cue.to < sceneEnd) boundaries.push(cue.to);
  }
  let best = frame;
  let bestDist = snapFrames + 1;
  for (const boundary of boundaries) {
    const left = cues.some(cue => cue.to <= boundary);
    const right = cues.some(cue => cue.from >= boundary);
    if (!left || !right) continue;
    const dist = Math.abs(boundary - frame);
    if (dist <= snapFrames && dist < bestDist) {
      best = boundary;
      bestDist = dist;
    }
  }
  return best;
}

function ratioText(text: string, ratio: number): { left: string; right: string } {
  const at = Math.max(0, Math.min(text.length, Math.round(text.length * ratio)));
  const leftRaw = text.slice(0, at);
  const space = leftRaw.lastIndexOf(' ');
  const cut = space > 0 && at - space <= 12 ? space : at;
  return { left: text.slice(0, cut).trim(), right: text.slice(cut).trim() };
}

export function splitChunk(chunk: AlignmentChunk, localCut: number): { left: AlignmentChunk; right: AlignmentChunk } {
  const seconds = Math.max(0, chunk.seconds);
  const cut = Math.min(Math.max(localCut, 0), seconds);
  const words = chunk.words ?? [];
  const joined = words.map(word => word.text).join(' ');
  const useWords = words.length > 0 && joined === chunk.text.trim();
  if (!useWords) {
    const ratio = seconds === 0 ? 0 : cut / seconds;
    const text = ratioText(chunk.text, ratio);
    return {
      left: { text: text.left, seconds: cut },
      right: { text: text.right, seconds: Math.max(0, seconds - cut) },
    };
  }
  const leftWords: AlignmentWord[] = [];
  const rightWords: AlignmentWord[] = [];
  for (const word of words) {
    if (word.end <= cut + 1e-6) leftWords.push({ ...word, end: Math.min(word.end, cut) });
    else if (word.start >= cut - 1e-6) rightWords.push({ text: word.text, start: word.start - cut, end: word.end - cut });
    else if ((word.start + word.end) / 2 < cut) leftWords.push({ ...word, end: cut });
    else rightWords.push({ text: word.text, start: 0, end: Math.max(0, word.end - cut) });
  }
  return {
    left: { text: leftWords.map(word => word.text).join(' '), seconds: cut, words: leftWords, ...(chunk.timing ? { timing: chunk.timing } : {}) },
    right: { text: rightWords.map(word => word.text).join(' '), seconds: Math.max(0, seconds - cut), words: rightWords, ...(chunk.timing ? { timing: chunk.timing } : {}) },
  };
}

export interface AlignmentSplit {
  left: AlignmentChunk[];
  right: AlignmentChunk[];
  /** Seconds of speech (chunk time, not silence gaps) assigned to the left. */
  cutSeconds: number;
}

/** Divide chunks at an absolute frame. A cue that contains the frame is split; others stay whole. */
export function splitAlignmentAtFrame(chunks: AlignmentChunk[], cues: SentenceCue[], cutFrame: number): AlignmentSplit {
  const left: AlignmentChunk[] = [];
  const right: AlignmentChunk[] = [];
  let seen = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const cue = cues[index];
    if (!cue || cue.to <= cutFrame) {
      left.push(chunk);
      seen += chunk.seconds;
      continue;
    }
    if (cue.from >= cutFrame) {
      right.push(chunk);
      continue;
    }
    const span = Math.max(1, cue.to - cue.from);
    const local = ((cutFrame - cue.from) / span) * chunk.seconds;
    const parts = splitChunk(chunk, local);
    left.push(parts.left);
    right.push(parts.right);
    for (let rest = index + 1; rest < chunks.length; rest += 1) right.push(chunks[rest]);
    return { left, right, cutSeconds: seen + local };
  }
  return { left, right, cutSeconds: seen };
}

export function narrationFromChunks(chunks: AlignmentChunk[]): string {
  return chunks.map(chunk => chunk.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** Integer sample cut. Both sides keep a non-empty slice of the same source. */
export function sampleCut(take: NarrationTake, cutSeconds: number, totalSeconds: number): number {
  const span = take.range.outSample - take.range.inSample;
  const frac = totalSeconds <= 0 ? 0.5 : cutSeconds / totalSeconds;
  const raw = take.range.inSample + Math.round(frac * span);
  return Math.min(take.range.outSample - 1, Math.max(take.range.inSample + 1, raw));
}

export function rangeDurationSeconds(take: NarrationTake): number {
  return (take.range.outSample - take.range.inSample) / take.sampleRate;
}

/** Copy each scene's source slice in story order. Samples are not resampled. */
export function assembleNarration(takesInOrder: NarrationTake[], pcm: Map<string, Float32Array>): Float32Array {
  const parts: Float32Array[] = [];
  for (const take of takesInOrder) {
    const src = pcm.get(take.sourceHash);
    if (!src) throw new Error(`missing audio for ${take.sourceHash}`);
    if (take.range.inSample < 0 || take.range.outSample > src.length || take.range.inSample >= take.range.outSample) {
      throw new Error(`source range ${take.range.inSample}-${take.range.outSample} is outside ${src.length} samples`);
    }
    parts.push(src.slice(take.range.inSample, take.range.outSample));
  }
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A caption crosses the cut when its source interval strictly contains that time. */
export function chunkCrosses(chunks: AlignmentChunk[], cutSeconds: number): boolean {
  let cursor = 0;
  for (const chunk of chunks) {
    const start = cursor;
    const end = cursor + chunk.seconds;
    if (start < cutSeconds - 1e-6 && end > cutSeconds + 1e-6) return true;
    if (chunk.words) {
      for (const word of chunk.words) {
        const wordStart = cursor + word.start;
        const wordEnd = cursor + word.end;
        if (wordStart < cutSeconds - 1e-6 && wordEnd > cutSeconds + 1e-6) return true;
      }
    }
    cursor = end;
  }
  return false;
}
