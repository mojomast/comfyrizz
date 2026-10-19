/**
 * Editor commands. Pure: `applyCommand` clones and returns the next document.
 * Undo stores a before/after patch of `package` + `editor` (see PHASE0.md).
 *
 * The original seven commands are the CA-1 set. SetTransition, SplitScene,
 * SetNarrationText and SetVoice are the timeline and script commands. `text: null`
 * and `startSeconds: null` clear a caption override or a source trim.
 */
import {
  normalizeMeasured,
  projectFps,
  speechFloorFrames,
  type MeasuredInput,
} from '../../../../packages/planner/dist/src/browser.js';
import {
  narrationFromChunks,
  narrationInputFingerprint,
  placeScenes,
  sampleCut,
  sentenceCues,
  snapSplitFrame,
  splitAlignmentAtFrame,
  textFingerprint,
} from './audio/speech.ts';
import type {
  AlignmentChunk,
  EditorPackage,
  EditorScene,
  NarrationTake,
  PresenterClip,
  SceneAlignment,
  VoiceSettings,
} from './types.ts';

export type { MeasuredInput, VoiceSettings };

export interface CaptionOverride {
  sceneId: string;
  index: number;
  text: string;
}

export interface EditorSidecar {
  version: 1;
  captionOverrides: CaptionOverride[];
  /** Narration takes keyed by scene id. Not part of package-v1. */
  takes?: Record<string, NarrationTake>;
  alignment?: Record<string, SceneAlignment>;
  presenterClips?: Record<string, PresenterClip>;
}

export interface EditableScene {
  id: string;
  layout: string;
  preferredFrames?: number;
  copy?: Record<string, unknown>;
  background?: { asset?: string; trim?: { startSeconds: number; endSeconds?: number } | null; [key: string]: unknown } | null;
  media?: Array<{ asset?: string; trim?: { startSeconds: number; endSeconds?: number } | null; [key: string]: unknown } | null>;
  narration?: string;
  narration_asset?: string;
  narration_duration_frames?: number;
  transitionOut?: { type: string; frames?: number; direction?: string } | null;
  locked?: boolean;
  presenter?: 'off' | 'pip' | 'split' | string;
  [key: string]: unknown;
}

export interface EditablePackage {
  id?: string;
  revision?: number;
  format?: { fps?: number; width?: number; height?: number };
  scenes: EditableScene[];
  assets?: Record<string, { kind?: string; media?: { fps?: number; frames?: number; audio?: string; durationSeconds?: number } } | undefined>;
  voice?: VoiceSettings;
  [key: string]: unknown;
}

export interface ProjectDoc {
  package: EditablePackage;
  /** Monotonic save/compile cursor. Undo does not rewind it. */
  editSequence: number;
  editor: EditorSidecar;
}

export interface MoveScene { type: 'MoveScene'; sceneId: string; toIndex: number }
export interface TrimScene { type: 'TrimScene'; sceneId: string; preferredFrames: number }
export interface SetSceneCopy { type: 'SetSceneCopy'; sceneId: string; copy: Record<string, unknown> }
export interface SetMediaRange {
  type: 'SetMediaRange';
  sceneId: string;
  target: 'background' | { mediaIndex: number };
  /** null clears the source trim. Seconds are source time, not project frames. */
  startSeconds: number | null;
  endSeconds?: number | null;
}
export interface SetCaptionText {
  type: 'SetCaptionText';
  sceneId: string;
  index: number;
  /** null removes the override. Does not change scene.narration. */
  text: string | null;
}
export interface DuplicateScene { type: 'DuplicateScene'; sceneId: string; newId?: string }
export interface DeleteScene { type: 'DeleteScene'; sceneId: string }
export interface SetTransition {
  type: 'SetTransition';
  sceneId: string;
  transitionOut: { type: string; frames: number; direction?: string } | null;
}
export interface SplitScene {
  type: 'SplitScene';
  sceneId: string;
  frame: number;
  newSceneId: string;
  snapFrames?: number;
}
export interface SetNarrationText { type: 'SetNarrationText'; sceneId: string; text: string }
export interface SetVoice { type: 'SetVoice'; voice: VoiceSettings | null }

export type Command =
  | MoveScene
  | TrimScene
  | SetSceneCopy
  | SetMediaRange
  | SetCaptionText
  | DuplicateScene
  | DeleteScene
  | SetTransition
  | SplitScene
  | SetNarrationText
  | SetVoice;

export type ApplyResult =
  | { ok: true; doc: ProjectDoc }
  | { ok: false; code: string; error: string };

export function emptyEditor(): EditorSidecar {
  return { version: 1, captionOverrides: [] };
}

const SCENE_ID = /^s[A-Za-z0-9_-]{0,63}$/;
const LOCKED = new Set(['MoveScene', 'TrimScene', 'DeleteScene', 'DuplicateScene', 'SetMediaRange', 'SetTransition', 'SplitScene']);

function fail(code: string, error: string): ApplyResult {
  return { ok: false, code, error };
}

function clone(doc: ProjectDoc): ProjectDoc {
  return structuredClone(doc);
}

export function nextSceneId(scenes: { id: string }[], sourceId: string): string {
  const taken = new Set(scenes.map(scene => scene.id));
  const stem = sourceId.replace(/_copy\d*$/, '').replace(/_\d+$/, '');
  for (let n = 2; n < 10000; n += 1) {
    const suffix = `_${n}`;
    const id = `${stem.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    if (SCENE_ID.test(id) && !taken.has(id)) return id;
  }
  return failId(sourceId);
}

function failId(sourceId: string): string {
  throw new Error(`No free scene id near ${sourceId}`);
}

function sceneAt(doc: ProjectDoc, sceneId: string): { index: number; scene: EditableScene } | ApplyResult {
  const index = doc.package.scenes.findIndex(scene => scene.id === sceneId);
  if (index < 0) return fail('unknown-scene', `No scene ${sceneId}.`);
  return { index, scene: doc.package.scenes[index]! };
}

function isFail(value: { index: number; scene: EditableScene } | ApplyResult): value is ApplyResult {
  return 'ok' in value;
}

export function applyCommand(doc: ProjectDoc, command: Command, measured: MeasuredInput = {}): ApplyResult {
  if (command.type === 'SetVoice') return setVoice(clone(doc), command);
  const found = sceneAt(doc, command.sceneId);
  if (isFail(found)) return found;
  if (found.scene.locked && LOCKED.has(command.type)) {
    return fail('locked', `Scene ${command.sceneId} is locked.`);
  }
  const next = clone(doc);
  const scene = next.package.scenes[found.index]!;
  switch (command.type) {
    case 'MoveScene':
      return moveScene(next, found.index, command);
    case 'TrimScene':
      return trimScene(next, scene, command, measured);
    case 'SetSceneCopy':
      return setCopy(next, scene, command);
    case 'SetMediaRange':
      return setMediaRange(next, scene, command);
    case 'SetCaptionText':
      return setCaption(next, command);
    case 'DuplicateScene':
      return duplicateScene(next, found.index, scene, command);
    case 'DeleteScene':
      return deleteScene(next, found.index, command);
    case 'SetTransition':
      return setTransition(next, scene, command, measured);
    case 'SplitScene':
      return splitScene(next, scene, command, measured);
    case 'SetNarrationText':
      return setNarration(next, scene, command);
    default: {
      const unknown: never = command;
      return fail('unknown-command', `Unknown command ${(unknown as Command).type}.`);
    }
  }
}

function moveScene(doc: ProjectDoc, index: number, command: MoveScene): ApplyResult {
  const length = doc.package.scenes.length;
  if (!Number.isInteger(command.toIndex) || command.toIndex < 0 || command.toIndex >= length) {
    return fail('bad-index', `Move ${command.sceneId} needs an index from 0 to ${length - 1} after the scene is removed.`);
  }
  if (command.toIndex === index) return { ok: true, doc };
  const [scene] = doc.package.scenes.splice(index, 1);
  doc.package.scenes.splice(command.toIndex, 0, scene!);
  clearTerminalTransition(doc);
  return { ok: true, doc };
}

function trimScene(doc: ProjectDoc, scene: EditableScene, command: TrimScene, measured: MeasuredInput): ApplyResult {
  if (!Number.isInteger(command.preferredFrames) || command.preferredFrames < 1 || command.preferredFrames > 108000) {
    return fail('bad-frames', 'A trim needs an integer project frame count from 1 to 108000.');
  }
  const fps = projectFps(doc.package.format);
  const floor = speechFloorFrames(
    { id: scene.id, layout: scene.layout as 'title' },
    normalizeMeasured(measured),
    fps,
  );
  if (command.preferredFrames < floor.frames) {
    return fail(
      floor.measured ? 'below-speech-floor' : 'below-layout-min',
      floor.measured
        ? `Scene ${scene.id} cannot be shorter than ${floor.frames} frames of measured speech and padding. Revise the script to trim further.`
        : `Scene ${scene.id} cannot be shorter than the ${floor.frames}-frame readable minimum for its layout.`,
    );
  }
  scene.preferredFrames = command.preferredFrames;
  return { ok: true, doc };
}

function setCopy(doc: ProjectDoc, scene: EditableScene, command: SetSceneCopy): ApplyResult {
  if (!command.copy || typeof command.copy !== 'object' || Array.isArray(command.copy)) {
    return fail('bad-copy', 'Scene copy must be an object.');
  }
  scene.copy = structuredClone(command.copy);
  return { ok: true, doc };
}

function setMediaRange(doc: ProjectDoc, scene: EditableScene, command: SetMediaRange): ApplyResult {
  const trim = readTrim(command);
  if ('ok' in trim) return trim;
  if (command.target === 'background') {
    if (!scene.background || typeof scene.background !== 'object') return fail('no-media', `Scene ${scene.id} has no background plate.`);
    if (trim.trim === null) delete scene.background.trim;
    else scene.background.trim = trim.trim;
    return { ok: true, doc };
  }
  const index = command.target.mediaIndex;
  const item = scene.media?.[index];
  if (!item) return fail('no-media', `Scene ${scene.id} has no media plate ${index}.`);
  if (trim.trim === null) delete item.trim;
  else item.trim = trim.trim;
  return { ok: true, doc };
}

function readTrim(command: SetMediaRange): { trim: { startSeconds: number; endSeconds?: number } | null } | ApplyResult {
  if (command.startSeconds === null) return { trim: null };
  if (typeof command.startSeconds !== 'number' || !Number.isFinite(command.startSeconds) || command.startSeconds < 0) {
    return fail('bad-range', 'A media range starts at a non-negative number of source seconds.');
  }
  const trim: { startSeconds: number; endSeconds?: number } = { startSeconds: command.startSeconds };
  if (command.endSeconds != null) {
    if (typeof command.endSeconds !== 'number' || !Number.isFinite(command.endSeconds) || command.endSeconds < command.startSeconds) {
      return fail('bad-range', 'A media range ends at or after its start, in source seconds.');
    }
    trim.endSeconds = command.endSeconds;
  }
  return { trim };
}

function setCaption(doc: ProjectDoc, command: SetCaptionText): ApplyResult {
  if (!Number.isInteger(command.index) || command.index < 0) return fail('bad-caption', 'A caption override needs an index of 0 or more.');
  if (command.text !== null && (typeof command.text !== 'string' || command.text.length > 2000)) {
    return fail('bad-caption', 'Caption text must be a string of at most 2000 characters.');
  }
  const rest = doc.editor.captionOverrides.filter(item => !(item.sceneId === command.sceneId && item.index === command.index));
  doc.editor.captionOverrides = command.text === null
    ? rest
    : [...rest, { sceneId: command.sceneId, index: command.index, text: command.text }];
  return { ok: true, doc };
}

function duplicateScene(doc: ProjectDoc, index: number, scene: EditableScene, command: DuplicateScene): ApplyResult {
  const newId = command.newId ?? nextSceneId(doc.package.scenes, scene.id);
  if (!SCENE_ID.test(newId)) return fail('bad-id', `Scene id ${newId} does not match the scene id pattern.`);
  if (doc.package.scenes.some(item => item.id === newId)) return fail('duplicate-id', `Scene id ${newId} is already used.`);
  const copy = structuredClone(scene);
  copy.id = newId;
  copy.locked = false;
  doc.package.scenes.splice(index + 1, 0, copy);
  const carried = doc.editor.captionOverrides
    .filter(item => item.sceneId === scene.id)
    .map(item => ({ ...item, sceneId: newId }));
  doc.editor.captionOverrides = [...doc.editor.captionOverrides, ...carried];
  copySceneSidecar(doc, scene.id, newId);
  clearTerminalTransition(doc);
  return { ok: true, doc };
}

function deleteScene(doc: ProjectDoc, index: number, command: DeleteScene): ApplyResult {
  if (doc.package.scenes.length < 2) return fail('last-scene', 'A package keeps at least one scene.');
  doc.package.scenes.splice(index, 1);
  dropSceneSidecar(doc, command.sceneId);
  clearTerminalTransition(doc);
  return { ok: true, doc };
}

function transitionFrames(scene: EditableScene | undefined): number {
  const type = scene?.transitionOut?.type;
  if (!type || type === 'none' || type === 'cut') return 0;
  return Math.max(0, Math.floor(scene?.transitionOut?.frames ?? 0));
}

/** A valid compile rejects an outgoing transition on the last scene. */
function clearTerminalTransition(doc: ProjectDoc): void {
  const last = doc.package.scenes[doc.package.scenes.length - 1];
  if (last && transitionFrames(last) > 0) last.transitionOut = { type: 'cut', frames: 0 };
}

function copySceneSidecar(doc: ProjectDoc, fromId: string, toId: string): void {
  const take = doc.editor.takes?.[fromId];
  if (take) {
    doc.editor.takes = { ...doc.editor.takes, [toId]: { ...structuredClone(take), takeId: `${take.takeId}-copy` } };
  }
  const alignment = doc.editor.alignment?.[fromId];
  if (alignment) doc.editor.alignment = { ...doc.editor.alignment, [toId]: structuredClone(alignment) };
  const clip = doc.editor.presenterClips?.[fromId];
  if (clip) doc.editor.presenterClips = { ...doc.editor.presenterClips, [toId]: structuredClone(clip) };
}

function dropSceneSidecar(doc: ProjectDoc, sceneId: string): void {
  doc.editor.captionOverrides = doc.editor.captionOverrides.filter(item => item.sceneId !== sceneId);
  if (doc.editor.takes) delete doc.editor.takes[sceneId];
  if (doc.editor.alignment) delete doc.editor.alignment[sceneId];
  if (doc.editor.presenterClips) delete doc.editor.presenterClips[sceneId];
}

function chunkMapFor(doc: ProjectDoc, measured: MeasuredInput): Record<string, AlignmentChunk[] | undefined> {
  const out: Record<string, AlignmentChunk[] | undefined> = {};
  for (const scene of doc.package.scenes) {
    const aligned = doc.editor.alignment?.[scene.id]?.chunks;
    const spoken = measured.narration?.[scene.id] as AlignmentChunk[] | undefined;
    if (aligned?.length) out[scene.id] = aligned;
    else if (spoken?.length) out[scene.id] = spoken;
  }
  return out;
}

function setTransition(doc: ProjectDoc, scene: EditableScene, command: SetTransition, measured: MeasuredInput): ApplyResult {
  const index = doc.package.scenes.findIndex(item => item.id === scene.id);
  const spec = command.transitionOut;
  if (!spec || spec.type === 'none' || spec.type === 'cut' || spec.frames <= 0) {
    scene.transitionOut = { type: 'cut', frames: 0 };
    return { ok: true, doc };
  }
  const frames = Math.floor(spec.frames);
  if (!Number.isFinite(frames) || frames < 0 || frames > 120) {
    return fail('bad-transition', 'Transition length has to be from 0 to 120 frames.');
  }
  if (index < 0 || index === doc.package.scenes.length - 1) {
    return fail('bad-transition', 'The last scene has no outgoing transition.');
  }
  scene.transitionOut = { type: spec.type, frames, ...(spec.direction ? { direction: spec.direction } : {}) };
  const placed = placeScenes(doc.package as EditorPackage, chunkMapFor(doc, measured));
  if (!placed.ok) return fail('bad-transition', placed.reason);
  return { ok: true, doc };
}

function setNarration(doc: ProjectDoc, scene: EditableScene, command: SetNarrationText): ApplyResult {
  if (typeof command.text !== 'string' || command.text.length > 600) {
    return fail('bad-narration', 'Narration is longer than 600 characters.');
  }
  scene.narration = command.text;
  doc.editor.captionOverrides = doc.editor.captionOverrides.filter(item => item.sceneId !== command.sceneId);
  return { ok: true, doc };
}

function setVoice(doc: ProjectDoc, command: SetVoice): ApplyResult {
  if (command.voice === null) {
    delete doc.package.voice;
    return { ok: true, doc };
  }
  const voice = command.voice;
  if (typeof voice.enabled !== 'boolean') return fail('bad-voice', 'Voice needs an enabled flag.');
  if (voice.engine && voice.engine !== 'kokoro' && voice.engine !== 'qwen3-tts' && voice.engine !== 'none') {
    return fail('bad-voice', 'Voice engine must be kokoro, qwen3-tts or none.');
  }
  if (voice.speed !== undefined && (typeof voice.speed !== 'number' || voice.speed < 0.5 || voice.speed > 2)) {
    return fail('bad-voice', 'Voice speed must be between 0.5 and 2.');
  }
  if (voice.voice !== undefined && (voice.voice.length < 1 || voice.voice.length > 64)) {
    return fail('bad-voice', 'Voice id must be 1–64 characters.');
  }
  if (voice.persona !== undefined && voice.persona.length > 400) return fail('bad-voice', 'Persona is longer than 400 characters.');
  doc.package.voice = structuredClone(voice);
  return { ok: true, doc };
}

function splitScene(doc: ProjectDoc, scene: EditableScene, command: SplitScene, measured: MeasuredInput): ApplyResult {
  if (!SCENE_ID.test(command.newSceneId) || doc.package.scenes.some(item => item.id === command.newSceneId)) {
    return fail('bad-id', 'Split needs a new scene id that is not already used.');
  }
  const take = doc.editor.takes?.[command.sceneId];
  const align = doc.editor.alignment?.[command.sceneId];
  if (!take || !align?.chunks?.length) return fail('no-take', `Scene ${command.sceneId} has no measured narration take to split.`);
  if (take.range.outSample - take.range.inSample < 2) return fail('short-range', 'The source range is too short to split.');
  const placed = placeScenes(doc.package as EditorPackage, chunkMapFor(doc, measured));
  if (!placed.ok) return fail('placement', placed.reason);
  const slot = placed.scenes.find(item => item.id === command.sceneId);
  if (!slot) return fail('placement', `Scene ${command.sceneId} is not on the timeline.`);
  if (!Number.isInteger(command.frame) || command.frame <= slot.from || command.frame >= slot.from + slot.duration) {
    return fail('bad-frame', 'The playhead is outside this scene.');
  }
  const overrides = doc.editor.captionOverrides.filter(item => item.sceneId === command.sceneId);
  const cues = sentenceCues(align.chunks, slot.from, command.sceneId, placed.fps, overrides);
  const cutFrame = snapSplitFrame(cues, command.frame, slot.from, slot.from + slot.duration, command.snapFrames ?? 8);
  const baked = align.chunks.map((chunk, index) => {
    const edit = overrides.find(item => item.index === index);
    return edit ? { ...chunk, text: edit.text } : chunk;
  });
  const bakedCues = sentenceCues(baked, slot.from, command.sceneId, placed.fps);
  const split = splitAlignmentAtFrame(baked, bakedCues, cutFrame);
  if (split.left.length === 0 || split.right.length === 0) {
    return fail('bad-split', 'Split needs speech on both sides. Move onto a sentence or closer to its boundary.');
  }
  const original = structuredClone(take);
  const totalSeconds = baked.reduce((sum, chunk) => sum + chunk.seconds, 0);
  const cutSample = sampleCut(original, split.cutSeconds, totalSeconds);
  const leftText = narrationFromChunks(split.left);
  const rightText = narrationFromChunks(split.right);
  const voice = doc.package.voice;
  const originalTransition = scene.transitionOut ? structuredClone(scene.transitionOut) : undefined;
  const local = cutFrame - slot.from;
  scene.narration = leftText;
  scene.preferredFrames = Math.max(1, local);
  scene.narration_duration_frames = Math.max(1, Math.round(((cutSample - original.range.inSample) / original.sampleRate) * placed.fps));
  scene.transitionOut = { type: 'cut', frames: 0 };
  const right = structuredClone(scene);
  right.id = command.newSceneId;
  right.narration = rightText;
  right.preferredFrames = Math.max(1, slot.duration - local);
  right.narration_duration_frames = Math.max(1, Math.round(((original.range.outSample - cutSample) / original.sampleRate) * placed.fps));
  right.transitionOut = originalTransition;
  right.locked = false;
  doc.package.scenes.splice(doc.package.scenes.findIndex(item => item.id === command.sceneId) + 1, 0, right);
  const takes = { ...(doc.editor.takes ?? {}) };
  takes[command.sceneId] = {
    ...original,
    range: { inSample: original.range.inSample, outSample: cutSample },
    inputFingerprint: narrationInputFingerprint(scene as EditorScene, voice),
  };
  takes[command.newSceneId] = {
    ...structuredClone(original),
    takeId: `${original.takeId}-b`,
    range: { inSample: cutSample, outSample: original.range.outSample },
    inputFingerprint: narrationInputFingerprint(right as EditorScene, voice),
  };
  doc.editor.takes = takes;
  const alignment = { ...(doc.editor.alignment ?? {}) };
  alignment[command.sceneId] = { sourceHash: original.sourceHash, textFingerprint: textFingerprint(leftText), chunks: split.left };
  alignment[command.newSceneId] = { sourceHash: original.sourceHash, textFingerprint: textFingerprint(rightText), chunks: split.right };
  doc.editor.alignment = alignment;
  doc.editor.captionOverrides = doc.editor.captionOverrides.filter(item => item.sceneId !== command.sceneId);
  clearTerminalTransition(doc);
  const check = placeScenes(doc.package as EditorPackage, chunkMapFor(doc, measured));
  if (!check.ok) return fail('placement', check.reason);
  return { ok: true, doc };
}
