/**
 * Editor commands. Pure: `applyCommand` clones and returns the next document.
 * Undo stores a before/after patch of `package` + `editor` (see PHASE0.md).
 *
 * CA-2 and CA-3 should construct the seven command types below. `text: null`
 * and `startSeconds: null` clear a caption override or a source trim.
 */
import {
  normalizeMeasured,
  projectFps,
  speechFloorFrames,
  type MeasuredInput,
} from '../../../../packages/planner/dist/src/browser.js';

export type { MeasuredInput };

export interface CaptionOverride {
  sceneId: string;
  index: number;
  text: string;
}

export interface EditorSidecar {
  version: 1;
  captionOverrides: CaptionOverride[];
}

export interface EditableScene {
  id: string;
  layout: string;
  preferredFrames?: number;
  copy?: Record<string, unknown>;
  background?: { asset?: string; trim?: { startSeconds: number; endSeconds?: number } | null; [key: string]: unknown } | null;
  media?: Array<{ asset?: string; trim?: { startSeconds: number; endSeconds?: number } | null; [key: string]: unknown } | null>;
  narration?: string;
  locked?: boolean;
  [key: string]: unknown;
}

export interface EditablePackage {
  id?: string;
  revision?: number;
  format?: { fps?: number; width?: number; height?: number };
  scenes: EditableScene[];
  assets?: Record<string, { kind?: string; media?: { fps?: number; frames?: number } } | undefined>;
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

export type Command =
  | MoveScene
  | TrimScene
  | SetSceneCopy
  | SetMediaRange
  | SetCaptionText
  | DuplicateScene
  | DeleteScene;

export type ApplyResult =
  | { ok: true; doc: ProjectDoc }
  | { ok: false; code: string; error: string };

export function emptyEditor(): EditorSidecar {
  return { version: 1, captionOverrides: [] };
}

const SCENE_ID = /^s[A-Za-z0-9_-]{0,63}$/;
const LOCKED = new Set(['MoveScene', 'TrimScene', 'DeleteScene', 'DuplicateScene', 'SetMediaRange']);

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
  return { ok: true, doc };
}

function deleteScene(doc: ProjectDoc, index: number, command: DeleteScene): ApplyResult {
  if (doc.package.scenes.length < 2) return fail('last-scene', 'A package keeps at least one scene.');
  doc.package.scenes.splice(index, 1);
  doc.editor.captionOverrides = doc.editor.captionOverrides.filter(item => item.sceneId !== command.sceneId);
  return { ok: true, doc };
}
