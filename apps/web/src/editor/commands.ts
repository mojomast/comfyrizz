/**
 * Editor commands. Pure: `applyCommand` clones and returns the next document.
 * Undo stores a before/after patch of `package` + `editor` (see PHASE0.md).
 *
 * The original seven commands are the CA-1 set. SetTransition, SplitScene,
 * SetNarrationText and SetVoice are the timeline and script commands. `text: null`
 * and `startSeconds: null` clear a caption override or a source trim.
 */
import { type MeasuredInput } from '../../../../packages/planner/dist/src/browser.js';
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
  /** Qwen CustomVoice per-scene delivery instruction. */
  narration_style?: string;
  transitionOut?: { type: string; frames?: number; direction?: string } | null;
  /** Storytelling recipe and bounded parameters (packages/schema sceneMotion). */
  motion?: Record<string, unknown> | null;
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
/** Explicitly remove the override so the package/compiler transition default applies. */
export interface ResetSceneTransition { type: 'ResetSceneTransition'; sceneId: string }
export interface SplitScene {
  type: 'SplitScene';
  sceneId: string;
  frame: number;
  newSceneId: string;
  snapFrames?: number;
}
export interface SetNarrationText { type: 'SetNarrationText'; sceneId: string; text: string }
/** Qwen CustomVoice delivery override for one scene; null removes it. */
export interface SetNarrationStyle { type: 'SetNarrationStyle'; sceneId: string; text: string | null }
export interface SetVoice { type: 'SetVoice'; voice: VoiceSettings | null }
/** Replace the optional storytelling motion block; null removes it entirely. */
export interface SetSceneMotion { type: 'SetSceneMotion'; sceneId: string; motion: Record<string, unknown> | null }

export type Command =
  | MoveScene
  | TrimScene
  | SetSceneCopy
  | SetMediaRange
  | SetCaptionText
  | DuplicateScene
  | DeleteScene
  | SetTransition
  | ResetSceneTransition
  | SplitScene
  | SetNarrationText
  | SetNarrationStyle
  | SetVoice
  | SetSceneMotion;

export type ApplyResult =
  | { ok: true; doc: ProjectDoc }
  | { ok: false; code: string; error: string };

export function emptyEditor(): EditorSidecar {
  return { version: 1, captionOverrides: [] };
}

const SCENE_ID = /^s[A-Za-z0-9_-]{0,63}$/;
const LOCKED = new Set(['MoveScene', 'TrimScene', 'DeleteScene', 'DuplicateScene', 'SetMediaRange', 'SetTransition', 'ResetSceneTransition', 'SplitScene', 'SetSceneMotion', 'SetNarrationStyle']);

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
      return trimScene(next, scene, command);
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
    case 'ResetSceneTransition':
      return resetSceneTransition(next, scene);
    case 'SplitScene':
      return splitScene(next, scene, command, measured);
    case 'SetNarrationText':
      return setNarration(next, scene, command);
    case 'SetNarrationStyle':
      return setNarrationStyle(next, scene, command);
    case 'SetSceneMotion':
      return setSceneMotion(next, scene, command);
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

function trimScene(doc: ProjectDoc, scene: EditableScene, command: TrimScene): ApplyResult {
  if (!Number.isInteger(command.preferredFrames) || command.preferredFrames < 1 || command.preferredFrames > 108000) {
    return fail('bad-frames', 'A trim needs an integer project frame count from 1 to 108000.');
  }
  // The request is a preference. Speech and layout.min floor the compiled duration;
  // the store reports that effective length. Narration text is not changed.
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

function resetSceneTransition(doc: ProjectDoc, scene: EditableScene): ApplyResult {
  delete scene.transitionOut;
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

function setNarrationStyle(doc: ProjectDoc, scene: EditableScene, command: SetNarrationStyle): ApplyResult {
  if (command.text !== null && (typeof command.text !== 'string' || command.text.length > 240)) {
    return fail('bad-narration-style', 'Scene delivery direction must be text of at most 240 characters.');
  }
  if (command.text === null || command.text.trim() === '') delete scene.narration_style;
  else scene.narration_style = command.text;
  return { ok: true, doc };
}

function setSceneMotion(doc: ProjectDoc, scene: EditableScene, command: SetSceneMotion): ApplyResult {
  if (command.motion === null) {
    delete scene.motion;
    return { ok: true, doc };
  }
  if (!command.motion || typeof command.motion !== 'object' || Array.isArray(command.motion)) {
    return fail('bad-motion', 'Scene motion must be an object or null.');
  }
  scene.motion = structuredClone(command.motion);
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
  if (voice.delivery !== undefined && voice.delivery.length > 400) return fail('bad-voice', 'Delivery instruction is longer than 400 characters.');
  if (voice.language !== undefined && (voice.language.length < 2 || voice.language.length > 16)) return fail('bad-voice', 'Language must be 2–16 characters.');
  if (voice.lang !== undefined && (voice.lang.length < 2 || voice.lang.length > 16)) return fail('bad-voice', 'Language tag must be 2–16 characters.');
  if (voice.chunking !== undefined && voice.chunking !== 'sentence' && voice.chunking !== 'paragraph') {
    return fail('bad-voice', 'Kokoro context must be sentence or paragraph.');
  }
  if (voice.qwen_mode !== undefined && voice.qwen_mode !== 'design' && voice.qwen_mode !== 'custom') {
    return fail('bad-voice', 'Qwen mode must be design or custom.');
  }
  if (voice.strict !== undefined && typeof voice.strict !== 'boolean') return fail('bad-voice', 'Strict must be a boolean.');
  if (voice.non_streaming !== undefined && typeof voice.non_streaming !== 'boolean') return fail('bad-voice', 'Full-text conditioning must be a boolean.');
  if (voice.reference_text !== undefined && (voice.reference_text.length < 1 || voice.reference_text.length > 1000)) {
    return fail('bad-voice', 'Reference transcript must be 1–1000 characters.');
  }
  if (voice.blend !== undefined) {
    if (!Array.isArray(voice.blend) || voice.blend.length < 2 || voice.blend.length > 4) {
      return fail('bad-voice', 'A voice blend needs 2–4 voices.');
    }
    for (const part of voice.blend) {
      if (!part || typeof part.voice !== 'string' || part.voice.length < 1 || part.voice.length > 64
        || typeof part.weight !== 'number' || !(part.weight > 0) || part.weight > 1) {
        return fail('bad-voice', 'Each blended voice needs a 1–64 character id and a weight above 0 up to 1.');
      }
    }
  }
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

// ---------------------------------------------------------------------------
// Command palette registry (DN08). `commands.ts` only registers commands; the
// palette UI lives in `src/ui/palette.ts`. These helpers are intentionally
// DOM-free so they can be exercised by the unit tests.
// ---------------------------------------------------------------------------

export interface PaletteCommand {
  id: string;
  title?: string;
  label?: string;
  name?: string;
  description?: string;
  hint?: string;
  shortcut?: string;
  key?: string;
  keybinding?: string;
  keywords?: string[];
  group?: string;
  category?: string;
  enabled?: boolean | (() => boolean);
  run?: (context?: unknown) => void | Promise<void>;
  action?: (context?: unknown) => void | Promise<void>;
  execute?: (context?: unknown) => void | Promise<void>;
}

export type UiCommand = PaletteCommand;
export type CommandDefinition = PaletteCommand;

export interface CommandRegistry {
  register(command: PaletteCommand): () => void;
  unregister(id: string): void;
  clear(): void;
  reset(): void;
  list(): PaletteCommand[];
  get(id: string): PaletteCommand | undefined;
  has(id: string): boolean;
  filter(query: string): PaletteCommand[];
}

const DEFAULT_COMMANDS: ReadonlyArray<PaletteCommand> = Object.freeze([
  { id: 'palette.open', title: 'Command palette', shortcut: 'Ctrl+K', group: 'General', keywords: ['commands', 'search'] },
  { id: 'shortcuts.open', title: 'Keyboard shortcuts', shortcut: '?', group: 'General', keywords: ['help', 'keys'] },
  { id: 'view.toggleMode', title: 'Toggle Easy / Advanced view', shortcut: 'Ctrl/Cmd+Shift+A', group: 'View', keywords: ['mode', 'easy', 'advanced'] },
  { id: 'view.easy', title: 'Switch to Easy view', group: 'View', keywords: ['mode', 'easy'] },
  { id: 'view.advanced', title: 'Switch to Advanced view', group: 'View', keywords: ['mode', 'advanced'] },
  { id: 'density.compact', title: 'Density: Compact', group: 'View', keywords: ['density', 'compact'] },
  { id: 'density.comfortable', title: 'Density: Comfortable', group: 'View', keywords: ['density', 'comfortable'] },
  { id: 'panel.toggleLeft', title: 'Toggle left panel', shortcut: 'Ctrl+B', group: 'Layout', keywords: ['panel', 'chat', 'left'] },
  { id: 'panel.toggleRight', title: 'Toggle right panel', shortcut: 'Ctrl+Alt+B', group: 'Layout', keywords: ['panel', 'right', 'rail'] },
  { id: 'panel.toggleTimeline', title: 'Toggle timeline', shortcut: 'Ctrl+J', group: 'Layout', keywords: ['timeline', 'dock'] },
  { id: 'review.drawer', title: 'Review drawer', shortcut: 'R', group: 'Review', keywords: ['review', 'takes', 'approval'] },
  { id: 'layout.reset', title: 'Reset layout', group: 'Layout', keywords: ['reset', 'layout', 'panels'] },
  { id: 'inspector.tab.1', title: 'Inspector tab 1: Scene', shortcut: '1', group: 'Inspector', keywords: ['inspector', 'scene', 'tab'] },
  { id: 'inspector.tab.2', title: 'Inspector tab 2: Voice', shortcut: '2', group: 'Inspector', keywords: ['inspector', 'voice', 'tab'] },
  { id: 'inspector.tab.3', title: 'Inspector tab 3: Animation', shortcut: '3', group: 'Inspector', keywords: ['inspector', 'animation', 'tab'] },
  { id: 'inspector.tab.4', title: 'Inspector tab 4: Agent', shortcut: '4', group: 'Inspector', keywords: ['inspector', 'agent', 'tab'] },
  { id: 'inspector.tab.5', title: 'Inspector tab 5: Takes', shortcut: '5', group: 'Inspector', keywords: ['inspector', 'takes', 'tab'] },
]);

function cloneCommand(command: PaletteCommand): PaletteCommand {
  return { ...command, keywords: command.keywords ? [...command.keywords] : undefined };
}

export class DefaultCommandRegistry implements CommandRegistry {
  private items = new Map<string, PaletteCommand>();

  constructor(initial: readonly PaletteCommand[] = []) {
    for (const command of initial) this.register(command);
  }

  register(command: PaletteCommand): () => void {
    if (!command || typeof command.id !== 'string' || command.id === '') {
      throw new Error('A command needs a non-empty id.');
    }
    this.items.set(command.id, cloneCommand(command));
    const id = command.id;
    return () => this.unregister(id);
  }

  unregister(id: string): void {
    this.items.delete(id);
  }

  clear(): void {
    this.items.clear();
  }

  reset(): void {
    this.clear();
    for (const command of DEFAULT_COMMANDS) this.register(command);
  }

  list(): PaletteCommand[] {
    return Array.from(this.items.values()).map(cloneCommand);
  }

  get(id: string): PaletteCommand | undefined {
    const command = this.items.get(id);
    return command ? cloneCommand(command) : undefined;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  filter(query: string): PaletteCommand[] {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return this.list();
    return this.list().filter(command => {
      const haystack = [
        command.id,
        command.title,
        command.label,
        command.name,
        command.description,
        command.hint,
        command.shortcut,
        command.key,
        command.keybinding,
        ...(command.keywords ?? []),
        command.group,
        command.category,
      ]
        .filter(value => typeof value === 'string')
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }
}

export const defaultCommandRegistry = new DefaultCommandRegistry(DEFAULT_COMMANDS);

export function createCommandRegistry(initial: readonly PaletteCommand[] = []): CommandRegistry {
  return new DefaultCommandRegistry(initial);
}

export const commandRegistry = defaultCommandRegistry;

// Module-level convenience functions operate on the shared registry.
export function registerCommand(command: PaletteCommand, registry: CommandRegistry = defaultCommandRegistry): () => void {
  return registry.register(command);
}

export function registerCommands(commands: readonly PaletteCommand[], registry: CommandRegistry = defaultCommandRegistry): () => void {
  const unregisters = commands.map(command => registry.register(command));
  return () => {
    for (const unregister of unregisters) unregister();
  };
}

export function unregisterCommand(id: string, registry: CommandRegistry = defaultCommandRegistry): void {
  registry.unregister(id);
}

export function clearCommands(registry: CommandRegistry = defaultCommandRegistry): void {
  registry.clear();
}

export function resetCommands(registry: CommandRegistry = defaultCommandRegistry): void {
  registry.reset();
}

export function getCommands(registry: CommandRegistry = defaultCommandRegistry): PaletteCommand[] {
  return registry.list();
}

export function listCommands(registry: CommandRegistry = defaultCommandRegistry): PaletteCommand[] {
  return registry.list();
}

export function findCommand(id: string, registry: CommandRegistry = defaultCommandRegistry): PaletteCommand | undefined {
  return registry.get(id);
}

export function getCommand(id: string, registry: CommandRegistry = defaultCommandRegistry): PaletteCommand | undefined {
  return registry.get(id);
}

export function hasCommand(id: string, registry: CommandRegistry = defaultCommandRegistry): boolean {
  return registry.has(id);
}

export function filterCommands(query: string, registry: CommandRegistry = defaultCommandRegistry): PaletteCommand[] {
  return registry.filter(query);
}

export function searchCommands(query: string, registry: CommandRegistry = defaultCommandRegistry): PaletteCommand[] {
  return registry.filter(query);
}

export const commands: PaletteCommand[] = defaultCommandRegistry.list();
// Keep the exported array in sync with the shared registry for callers that
// read it directly. Registration after import updates both.
const syncExportedCommands = (): void => {
  const next = defaultCommandRegistry.list();
  commands.splice(0, commands.length, ...next);
};
defaultCommandRegistry.reset();
syncExportedCommands();
const originalRegister = defaultCommandRegistry.register.bind(defaultCommandRegistry);
defaultCommandRegistry.register = (command: PaletteCommand): (() => void) => {
  const unregister = originalRegister(command);
  syncExportedCommands();
  return () => {
    unregister();
    syncExportedCommands();
  };
};
const originalUnregister = defaultCommandRegistry.unregister.bind(defaultCommandRegistry);
defaultCommandRegistry.unregister = (id: string): void => {
  originalUnregister(id);
  syncExportedCommands();
};
const originalClear = defaultCommandRegistry.clear.bind(defaultCommandRegistry);
defaultCommandRegistry.clear = (): void => {
  originalClear();
  syncExportedCommands();
};
const originalReset = defaultCommandRegistry.reset.bind(defaultCommandRegistry);
defaultCommandRegistry.reset = (): void => {
  originalReset();
  syncExportedCommands();
};

export const COMMANDS = commands;
export const COMMAND_LIST = commands;
export const PALETTE_COMMANDS = commands;

export function commandTitle(command: PaletteCommand): string {
  return command.title ?? command.label ?? command.name ?? command.id;
}

export function commandLabel(command: PaletteCommand): string {
  return commandTitle(command);
}

export function commandName(command: PaletteCommand): string {
  return commandTitle(command);
}

export function commandShortcut(command: PaletteCommand): string {
  return command.shortcut ?? command.key ?? command.keybinding ?? '';
}

export function commandKeywords(command: PaletteCommand): string[] {
  return Array.isArray(command.keywords) ? command.keywords : [];
}

export function runCommand(command: PaletteCommand, context?: unknown): void | Promise<void> {
  const runner = command.run ?? command.action ?? command.execute;
  if (typeof runner === 'function') return runner(context);
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('comfyrizz:command', { detail: { id: command.id, command } }));
    }
  } catch {
    // Commands are metadata in tests; dispatch is best-effort.
  }
}

export function executeCommand(command: PaletteCommand, context?: unknown): void | Promise<void> {
  return runCommand(command, context);
}

export function invokeCommand(command: PaletteCommand, context?: unknown): void | Promise<void> {
  return runCommand(command, context);
}
