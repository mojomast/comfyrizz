/**
 * Browser-safe compile entry. No node builtins.
 *
 * `compileTimeline(doc, measured)` is the contract CA-2 and CA-3 share with the
 * server route. The node entry (`@comfyrizz/planner`) keeps `compileTimeline(pkg, options)`.
 * Both call the same core, so frame projections and hashes match.
 */
import type { CaptionOverride, CompileOptions, ComfyrizzPackage, NarrationChunk } from './package-types.js';
import { canonicalJson, compileTimeline as compilePackage, projectFps, TimelineError, type Timeline } from './timeline.js';
import { sha256Hex } from './sha256.js';

export type { CaptionOverride, CompileOptions, ComfyrizzPackage };
export type CompiledTimeline = Timeline;
export { projectFps, speechFloorFrames, TimelineError } from './timeline.js';
export { measuredFromReport } from './measured.js';
export * from './lyrics.js';

/** Measured durations and optional word alignment. Alignment fills words the duration chunks omit. */
export interface MeasuredInput {
  narration?: Record<string, NarrationChunk[]>;
  alignment?: Record<string, NarrationChunk[]>;
  narrationGapSeconds?: number;
  narrationPaddingSeconds?: number;
  estimateCaptions?: boolean;
}

export interface EditorSidecar {
  version: 1;
  captionOverrides: CaptionOverride[];
}

/** Enough of a package for the compiler. Editor documents are not full schema types. */
export interface CompilePackage {
  scenes: unknown[];
  format?: { fps?: number; width?: number; height?: number };
  [key: string]: unknown;
}

/** A project document. A raw package (with `scenes`) is also accepted. */
export interface CompileDocument {
  package: CompilePackage;
  editor?: { captionOverrides?: CaptionOverride[] };
  editSequence?: number;
}

export function normalizeMeasured(measured: MeasuredInput = {}): CompileOptions {
  const narration: Record<string, NarrationChunk[]> = {};
  for (const [sceneId, chunks] of Object.entries(measured.narration ?? {})) {
    narration[sceneId] = chunks.map(chunk => ({ ...chunk }));
  }
  for (const [sceneId, chunks] of Object.entries(measured.alignment ?? {})) {
    if (!narration[sceneId]) {
      narration[sceneId] = chunks.map(chunk => ({ ...chunk }));
      continue;
    }
    narration[sceneId] = narration[sceneId].map((chunk, index) => {
      const aligned = chunks[index];
      if (!aligned?.words || chunk.words?.length) return chunk;
      const merged = { ...chunk, words: aligned.words };
      // Provenance belongs to the adopted word positions, not the duration
      // chunk. Unknown alignment must not inherit an unrelated timing claim.
      if (aligned.timing) merged.timing = aligned.timing;
      else delete merged.timing;
      return merged;
    });
  }
  return {
    narration,
    ...(measured.narrationGapSeconds !== undefined ? { narrationGapSeconds: measured.narrationGapSeconds } : {}),
    ...(measured.narrationPaddingSeconds !== undefined ? { narrationPaddingSeconds: measured.narrationPaddingSeconds } : {}),
    ...(measured.estimateCaptions !== undefined ? { estimateCaptions: measured.estimateCaptions } : {}),
  };
}

export function unwrapCompileDocument(doc: CompileDocument | ComfyrizzPackage): { pkg: ComfyrizzPackage; overrides: CaptionOverride[] } {
  if (doc && Array.isArray((doc as ComfyrizzPackage).scenes) && !('package' in doc && (doc as CompileDocument).package)) {
    return { pkg: doc as ComfyrizzPackage, overrides: [] };
  }
  const wrapped = doc as CompileDocument;
  if (wrapped?.package && Array.isArray(wrapped.package.scenes)) {
    return { pkg: wrapped.package as ComfyrizzPackage, overrides: wrapped.editor?.captionOverrides ?? [] };
  }
  throw new TimelineError('empty-package', 'compileTimeline needs a package or a project document.');
}

function assertIntegerFrames(timeline: Timeline): void {
  const bad = (value: number) => typeof value !== 'number' || !Number.isInteger(value);
  if (bad(timeline.durationInFrames) || bad(timeline.fps)) {
    throw new TimelineError('non-integer-frame', 'Compiled timeline has a non-integer project frame.');
  }
  for (const scene of timeline.scenes) {
    if (bad(scene.from) || bad(scene.durationInFrames) || bad(scene.transitionInFrames) || bad(scene.transitionOutFrames)) {
      throw new TimelineError('non-integer-frame', `Scene ${scene.id} has a non-integer project frame.`);
    }
  }
  for (const cue of timeline.captions) {
    if (bad(cue.from) || bad(cue.to)) throw new TimelineError('non-integer-frame', 'A caption cue has a non-integer project frame.');
    for (const word of cue.words ?? []) {
      if (bad(word.from) || bad(word.to)) throw new TimelineError('non-integer-frame', 'A caption word has a non-integer project frame.');
    }
  }
}

/** Hash of the compile inputs. Not the timeline hash. Client and server share it. */
export function compileInputHash(doc: CompileDocument | ComfyrizzPackage, measured: MeasuredInput = {}): string {
  const { pkg, overrides } = unwrapCompileDocument(doc);
  const ordered = [...overrides].sort((a, b) => a.sceneId.localeCompare(b.sceneId) || a.index - b.index);
  return sha256Hex(canonicalJson({ package: pkg, measured: normalizeMeasured(measured), captionOverrides: ordered }));
}

/**
 * Compile a project document (or a raw package) with measured durations.
 * Frames are integers at the package fps. Caption overrides change cue text only.
 */
export function compileTimeline(doc: CompileDocument | ComfyrizzPackage, measured: MeasuredInput = {}): CompiledTimeline {
  const { pkg, overrides } = unwrapCompileDocument(doc);
  const options = normalizeMeasured(measured);
  if (overrides.length > 0) options.captionOverrides = overrides;
  const timeline = compilePackage(pkg, options);
  assertIntegerFrames(timeline);
  return timeline;
}

/** The fields a parity test compares. Hashes are checked separately. */
export function frameProjection(timeline: Timeline) {
  return {
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    durationInFrames: timeline.durationInFrames,
    scenes: timeline.scenes.map(scene => ({
      id: scene.id,
      from: scene.from,
      durationInFrames: scene.durationInFrames,
      transitionInFrames: scene.transitionInFrames,
      transitionOutFrames: scene.transitionOutFrames,
    })),
    captions: timeline.captions.map(cue => ({
      sceneId: cue.sceneId,
      text: cue.text,
      from: cue.from,
      to: cue.to,
      estimated: cue.estimated,
      words: cue.words?.map(word => ({ text: word.text, from: word.from, to: word.to })),
    })),
    plates: timeline.plates.map(plate => ({ ...plate })),
    presenters: (timeline.presenters ?? []).map(presenter => ({
      sceneId: presenter.sceneId,
      from: presenter.from,
      durationInFrames: presenter.durationInFrames,
      dissolveInFrames: presenter.dissolveInFrames,
      dissolveOutFrames: presenter.dissolveOutFrames,
    })),
  };
}
