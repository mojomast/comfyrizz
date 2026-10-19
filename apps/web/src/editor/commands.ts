/**
 * TEMPORARY STAND-IN for CA-1 (`apps/web/src/editor/commands.ts`).
 *
 * Command union and pure apply/invert boundary, matching the CA-1 contract:
 * MoveScene, TrimScene, SetSceneCopy, SetMediaRange, SetCaptionText,
 * DuplicateScene, DeleteScene. `SetTransition` is a CA-2 extension the
 * transition inspector needs; remove it if CA-1 folds transitions into
 * another command.
 *
 * Replace this file with CA-1's module. The timeline dispatches these
 * objects and does not apply them itself.
 *
 * `preferredFrames` is a preference. Speech length and source bounds clamp it.
 * The compiled timeline (not this preference) is the duration the UI reports.
 */
import type { PackageV1 } from '../../../../packages/schema/types';
import type { NarrationChunk } from '../../../../packages/planner/src/package-types.ts';
import type { MediaRange, ProjectDoc } from './types.ts';

/** Layout floors/ceilings in frames, same table as planner `LAYOUT_LIMITS` (not scaled by fps). */
export const LAYOUT_LIMITS: Record<string, { min: number; max: number }> = {
  title: { min: 30, max: 450 },
  hero: { min: 45, max: 600 },
  stat: { min: 30, max: 300 },
  chart: { min: 45, max: 450 },
  list: { min: 45, max: 600 },
  split: { min: 45, max: 600 },
  compare: { min: 45, max: 600 },
  code: { min: 45, max: 600 },
};

/** Planner defaults. Tests check compiled captions against these. */
export const NARRATION_GAP_SECONDS = 0.15;
export const NARRATION_PADDING_SECONDS = 0.25;

const SCENE_ID = /^s[A-Za-z0-9_-]{0,63}$/;
const MAX_PREFERRED = 108000;

export type Command =
  | { type: 'MoveScene'; sceneId: string; toIndex: number }
  | { type: 'TrimScene'; sceneId: string; preferredFrames: number }
  | { type: 'SetSceneCopy'; sceneId: string; copy: Record<string, unknown> }
  | { type: 'SetMediaRange'; sceneId: string; assetId: string; inFrame: number; outFrame: number }
  | { type: 'SetCaptionText'; sceneId: string; index: number; text: string }
  | { type: 'DuplicateScene'; sceneId: string; newId: string }
  | { type: 'DeleteScene'; sceneId: string }
  | { type: 'SetTransition'; sceneId: string; transitionOut: { type: string; frames: number; direction?: string } | null };

export type Applied =
  | { ok: true; doc: ProjectDoc; note?: string; changed: boolean }
  | { ok: false; reason: string };

interface SceneLike {
  id: string;
  layout: string;
  preferredFrames?: number;
  copy?: Record<string, unknown>;
  transitionOut?: { type: string; frames?: number; direction?: string };
  narration?: string;
  background?: { asset?: string; loop?: boolean; trim?: { startSeconds?: number; endSeconds?: number } } | null;
  locked?: boolean;
  [key: string]: unknown;
}

export function scenesOf(doc: ProjectDoc): SceneLike[] {
  return doc.package.scenes as unknown as SceneLike[];
}

export function narrationFloorFrames(chunks: NarrationChunk[] | undefined, fps: number): number | null {
  if (!chunks || chunks.length === 0) return null;
  const spoken = chunks.reduce((sum, chunk) => sum + Math.max(0, chunk.seconds), 0);
  const gaps = NARRATION_GAP_SECONDS * Math.max(0, chunks.length - 1);
  return Math.max(0, Math.ceil((spoken + gaps + NARRATION_PADDING_SECONDS) * fps));
}

function assetMedia(doc: ProjectDoc, assetId: string): { fps?: number; frames?: number } | null {
  const asset = doc.package.assets?.[assetId] as { media?: { fps?: number; frames?: number } } | undefined;
  return asset?.media ?? null;
}

/** Project-frame ceiling from an explicit source range, or a non-looping plate. */
export function sourceCeilingFrames(doc: ProjectDoc, sceneId: string): number | null {
  const scene = scenesOf(doc).find(item => item.id === sceneId);
  if (!scene) return null;
  const range = doc.mediaRanges.find(item => item.sceneId === sceneId);
  const assetId = range?.assetId ?? scene.background?.asset;
  if (!assetId) return null;
  const media = assetMedia(doc, assetId);
  const fps = doc.package.format?.fps > 0 ? Math.floor(doc.package.format.fps) : 30;
  if (range) {
    const span = range.outFrame - range.inFrame;
    if (span <= 0) return null;
    const sourceFps = media?.fps && media.fps > 0 ? media.fps : fps;
    return Math.max(1, Math.ceil(span * (fps / sourceFps)));
  }
  if (!media?.frames || scene.background?.loop !== false) return null;
  const sourceFps = media.fps && media.fps > 0 ? media.fps : fps;
  return Math.max(1, Math.ceil(media.frames * (fps / sourceFps)));
}

export interface TrimBounds {
  min: number;
  max: number;
  speech: number | null;
  source: number | null;
}

export function trimBounds(doc: ProjectDoc, sceneId: string): TrimBounds | null {
  const scene = scenesOf(doc).find(item => item.id === sceneId);
  if (!scene) return null;
  const fps = doc.package.format?.fps > 0 ? Math.floor(doc.package.format.fps) : 30;
  const limit = LAYOUT_LIMITS[scene.layout] ?? LAYOUT_LIMITS.hero;
  const speech = narrationFloorFrames(doc.measured[sceneId], fps);
  const min = Math.max(limit.min, speech ?? 0);
  const source = sourceCeilingFrames(doc, sceneId);
  const max = Math.min(MAX_PREFERRED, source ?? MAX_PREFERRED);
  return { min, max, speech, source };
}

/** Clamp a requested preference. The compiler may still land on a different duration. */
export function clampTrim(doc: ProjectDoc, sceneId: string, requested: number): { preferredFrames: number; note?: string } | { error: string } {
  const bounds = trimBounds(doc, sceneId);
  if (!bounds) return { error: `Unknown scene ${sceneId}.` };
  if (!Number.isFinite(requested)) return { error: 'Duration has to be a whole number of frames.' };
  if (bounds.source !== null && bounds.source < bounds.min) {
    return { error: `Source is ${bounds.source} frames, shorter than the ${bounds.min}-frame speech minimum.` };
  }
  const floored = Math.floor(requested);
  let preferred = floored;
  let note: string | undefined;
  if (preferred < bounds.min) {
    preferred = bounds.min;
    note = bounds.speech !== null && bounds.speech >= (LAYOUT_LIMITS[scenesOf(doc).find(item => item.id === sceneId)?.layout ?? 'hero']?.min ?? 0)
      ? `Held at ${preferred} frames so the narration is not cut.`
      : `Held at the ${preferred}-frame readable minimum.`;
  }
  if (preferred > bounds.max) {
    preferred = bounds.max;
    note = bounds.source !== null && bounds.max === bounds.source
      ? `Held at ${preferred} frames, the end of the source.`
      : `Held at ${preferred} frames.`;
  }
  return { preferredFrames: preferred, note: preferred === floored ? undefined : note };
}

/** Duration the planner will assign before target-mode growth. Mirrors `planScenes`. */
export function expectedSceneFrames(doc: ProjectDoc, sceneId: string, preferredFrames: number): number {
  const scene = scenesOf(doc).find(item => item.id === sceneId);
  if (!scene) return preferredFrames;
  const fps = doc.package.format?.fps > 0 ? Math.floor(doc.package.format.fps) : 30;
  const limit = LAYOUT_LIMITS[scene.layout] ?? LAYOUT_LIMITS.hero;
  const spoken = narrationFloorFrames(doc.measured[sceneId], fps);
  const base = spoken === null ? preferredFrames : Math.max(preferredFrames, spoken);
  const max = Math.max(limit.max, spoken ?? 0);
  return Math.min(max, Math.max(limit.min, base));
}

function fail(reason: string): Applied {
  return { ok: false, reason };
}

function locked(scene: SceneLike): Applied | null {
  return scene.locked ? fail(`${scene.id} is locked.`) : null;
}

function transitionFrames(scene: SceneLike | undefined): number {
  if (!scene?.transitionOut) return 0;
  const type = scene.transitionOut.type;
  if (!type || type === 'none' || type === 'cut') return 0;
  return Math.max(0, Math.floor(scene.transitionOut.frames ?? 0));
}

function signature(doc: ProjectDoc): string {
  return JSON.stringify({
    scenes: doc.package.scenes,
    measured: doc.measured,
    mediaRanges: doc.mediaRanges,
  });
}

export function duplicateId(existing: string[], sourceId: string): string {
  const base = sourceId.replace(/_copy\d*$/, '');
  let n = 1;
  let id = `${base}_copy`;
  const taken = new Set(existing);
  while (taken.has(id)) {
    n += 1;
    id = `${base}_copy${n}`;
  }
  return id.slice(0, 64);
}

export function applyCommand(doc: ProjectDoc, command: Command): Applied {
  const next = structuredClone(doc) as ProjectDoc;
  const scenes = scenesOf(next);
  let note: string | undefined;
  const scene = scenes.find(item => item.id === command.sceneId);
  if (!scene) return fail(`Unknown scene ${command.sceneId}.`);

  if (command.type === 'MoveScene') {
    const blocked = locked(scene);
    if (blocked) return blocked;
    const from = scenes.findIndex(item => item.id === command.sceneId);
    const to = Math.max(0, Math.min(scenes.length - 1, Math.floor(command.toIndex)));
    if (from === to) return { ok: true, doc, changed: false };
    const [item] = scenes.splice(from, 1);
    scenes.splice(to, 0, item);
    const last = scenes[scenes.length - 1];
    if (transitionFrames(last) > 0) {
      last.transitionOut = { type: 'cut', frames: 0 };
      note = `${last.id} is now last, so its outgoing transition was removed.`;
    }
  } else if (command.type === 'TrimScene') {
    const blocked = locked(scene);
    if (blocked) return blocked;
    const clamped = clampTrim(next, command.sceneId, command.preferredFrames);
    if ('error' in clamped) return fail(clamped.error);
    const duration = expectedSceneFrames(next, command.sceneId, clamped.preferredFrames);
    const outgoing = transitionFrames(scene);
    const index = scenes.findIndex(item => item.id === command.sceneId);
    const incoming = index > 0 ? transitionFrames(scenes[index - 1]) : 0;
    if (outgoing > duration || incoming > duration) {
      return fail(`That trim is shorter than the ${Math.max(outgoing, incoming)}-frame transition. Shorten the transition first.`);
    }
    scene.preferredFrames = clamped.preferredFrames;
    const changed = signature(next) !== signature(doc);
    return { ok: true, doc: changed ? next : doc, changed, note: clamped.note };
  } else if (command.type === 'SetSceneCopy') {
    scene.copy = structuredClone(command.copy);
  } else if (command.type === 'SetMediaRange') {
    const blocked = locked(scene);
    if (blocked) return blocked;
    const inFrame = Math.floor(command.inFrame);
    const outFrame = Math.floor(command.outFrame);
    if (!Number.isFinite(inFrame) || !Number.isFinite(outFrame) || inFrame < 0 || outFrame <= inFrame) {
      return fail('A source range needs a start frame and a later end frame.');
    }
    const media = assetMedia(next, command.assetId);
    if (media?.frames != null && outFrame > media.frames) {
      return fail(`Source out frame ${outFrame} is past the asset (${media.frames} frames).`);
    }
    const ranges = next.mediaRanges.filter(item => !(item.sceneId === command.sceneId && item.assetId === command.assetId));
    const range: MediaRange = { sceneId: command.sceneId, assetId: command.assetId, inFrame, outFrame };
    ranges.push(range);
    next.mediaRanges = ranges;
  } else if (command.type === 'SetCaptionText') {
    const chunks = next.measured[command.sceneId];
    const chunk = chunks?.[command.index];
    if (!chunk) return fail(`Scene ${command.sceneId} has no measured caption ${command.index}.`);
    if (chunk.text === command.text) return { ok: true, doc, changed: false };
    // Wording only. `seconds` stays so speech is not time-stretched.
    chunks[command.index] = { ...chunk, text: command.text };
  } else if (command.type === 'DuplicateScene') {
    const blocked = locked(scene);
    if (blocked) return blocked;
    if (!SCENE_ID.test(command.newId)) return fail('A duplicated scene needs an id that starts with s.');
    if (scenes.some(item => item.id === command.newId)) return fail(`Scene id ${command.newId} already exists.`);
    const copy = structuredClone(scene);
    copy.id = command.newId;
    delete copy.locked;
    const index = scenes.findIndex(item => item.id === command.sceneId);
    scenes.splice(index + 1, 0, copy);
    const measured = next.measured[command.sceneId];
    if (measured) next.measured[command.newId] = structuredClone(measured);
    for (const range of doc.mediaRanges.filter(item => item.sceneId === command.sceneId)) {
      next.mediaRanges.push({ ...structuredClone(range), sceneId: command.newId });
    }
  } else if (command.type === 'DeleteScene') {
    const blocked = locked(scene);
    if (blocked) return blocked;
    if (scenes.length <= 1) return fail('A project needs at least one scene.');
    next.package.scenes = scenes.filter(item => item.id !== command.sceneId) as PackageV1['scenes'];
    delete next.measured[command.sceneId];
    next.mediaRanges = next.mediaRanges.filter(item => item.sceneId !== command.sceneId);
  } else if (command.type === 'SetTransition') {
    const blocked = locked(scene);
    if (blocked) return blocked;
    const index = scenes.findIndex(item => item.id === command.sceneId);
    const spec = command.transitionOut;
    if (!spec || spec.type === 'none' || spec.type === 'cut' || spec.frames <= 0) {
      scene.transitionOut = { type: 'cut', frames: 0 };
    } else {
      const frames = Math.floor(spec.frames);
      if (!Number.isFinite(frames) || frames < 0 || frames > 120) return fail('Transition length has to be from 0 to 120 frames.');
      const duration = expectedSceneFrames(next, scene.id, scene.preferredFrames ?? (LAYOUT_LIMITS[scene.layout]?.min ?? 30));
      const neighbour = scenes[index + 1];
      if (!neighbour) return fail('The last scene has no outgoing transition.');
      const neighbourDuration = expectedSceneFrames(next, neighbour.id, neighbour.preferredFrames ?? (LAYOUT_LIMITS[neighbour.layout]?.min ?? 30));
      if (frames > duration || frames > neighbourDuration) {
        return fail(`A ${frames}-frame transition does not fit (scene ${duration}, next ${neighbourDuration}).`);
      }
      scene.transitionOut = { type: spec.type, frames, ...(spec.direction ? { direction: spec.direction } : {}) };
    }
  }

  const changed = signature(next) !== signature(doc);
  return { ok: true, doc: changed ? next : doc, changed, note };
}

export function applyCommands(doc: ProjectDoc, commands: Command[]): Applied {
  let current = doc;
  let note: string | undefined;
  let changed = false;
  for (const command of commands) {
    const step = applyCommand(current, command);
    if (!step.ok) return step;
    current = step.doc;
    changed = changed || step.changed;
    if (step.note) note = step.note;
  }
  return { ok: true, doc: current, changed, note };
}
