/**
 * Gesture clamps for the timeline. The command still rejects an illegal trim.
 * These helpers keep a drag inside the speech floor and a known source range.
 */
import { projectFps, speechFloorFrames, type MeasuredInput } from '../../../../../packages/planner/dist/src/browser.js';
import type { ProjectDoc } from '../commands.ts';

/** Same table as planner LAYOUT_LIMITS. Tests compare the two. */
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

const MAX_PREFERRED = 108000;

export interface TrimBounds {
  min: number;
  max: number;
  speech: number | null;
  source: number | null;
}

function assetMedia(doc: ProjectDoc, assetId: string): { fps?: number; frames?: number } | null {
  const asset = doc.package.assets?.[assetId];
  return asset?.media ?? null;
}

/** Project-frame ceiling from a non-looping plate, or from a source trim already on the scene. */
export function sourceCeilingFrames(doc: ProjectDoc, sceneId: string): number | null {
  const scene = doc.package.scenes.find(item => item.id === sceneId);
  if (!scene) return null;
  const assetId = scene.background?.asset;
  if (!assetId) return null;
  const media = assetMedia(doc, assetId);
  const fps = projectFps(doc.package.format);
  const trim = scene.background?.trim;
  if (trim && typeof trim.startSeconds === 'number') {
    const sourceFps = media?.fps && media.fps > 0 ? media.fps : fps;
    const end = trim.endSeconds ?? (media?.frames != null ? media.frames / sourceFps : undefined);
    if (end == null) return null;
    const span = Math.max(0, end - trim.startSeconds);
    return Math.max(1, Math.ceil(span * fps));
  }
  if (!media?.frames || (scene.background as { loop?: boolean } | null)?.loop !== false) return null;
  const sourceFps = media.fps && media.fps > 0 ? media.fps : fps;
  return Math.max(1, Math.ceil(media.frames * (fps / sourceFps)));
}

export function trimBounds(doc: ProjectDoc, measured: MeasuredInput, sceneId: string): TrimBounds | null {
  const scene = doc.package.scenes.find(item => item.id === sceneId);
  if (!scene) return null;
  const fps = projectFps(doc.package.format);
  const limit = LAYOUT_LIMITS[scene.layout] ?? LAYOUT_LIMITS.hero!;
  const floor = speechFloorFrames(
    { id: scene.id, layout: scene.layout as 'title' },
    { narration: measured.narration },
    fps,
  );
  const speech = floor.measured ? floor.frames : null;
  const min = Math.max(limit.min, speech ?? 0);
  const source = sourceCeilingFrames(doc, sceneId);
  const max = Math.min(MAX_PREFERRED, source ?? MAX_PREFERRED, limit.max);
  return { min, max: Math.max(min, max), speech, source };
}

/** Clamp a requested preference. The compiler may still land on a different duration. */
export function clampTrim(
  doc: ProjectDoc,
  measured: MeasuredInput,
  sceneId: string,
  requested: number,
): { preferredFrames: number; note?: string } | { error: string } {
  const bounds = trimBounds(doc, measured, sceneId);
  if (!bounds) return { error: `Unknown scene ${sceneId}.` };
  if (!Number.isFinite(requested)) return { error: 'Duration has to be a whole number of frames.' };
  if (bounds.source !== null && bounds.source < bounds.min) {
    return { error: `Source is ${bounds.source} frames, shorter than the ${bounds.min}-frame speech minimum.` };
  }
  const floored = Math.floor(requested);
  let preferred = floored;
  let note: string | undefined;
  const layoutMin = LAYOUT_LIMITS[doc.package.scenes.find(item => item.id === sceneId)?.layout ?? 'hero']?.min ?? 0;
  if (preferred < bounds.min) {
    preferred = bounds.min;
    note = bounds.speech !== null && bounds.speech >= layoutMin
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

/** Build a CA-1 SetMediaRange from source frames. Rejects a range past a known asset. */
export function mediaRangeCommand(
  doc: ProjectDoc,
  sceneId: string,
  assetId: string,
  inFrame: number,
  outFrame: number,
): { type: 'SetMediaRange'; sceneId: string; target: 'background' | { mediaIndex: number }; startSeconds: number; endSeconds: number } | { error: string } {
  const start = Math.floor(inFrame);
  const end = Math.floor(outFrame);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return { error: 'A source range needs a start frame and a later end frame.' };
  }
  const media = doc.package.assets?.[assetId]?.media;
  if (media?.frames != null && end > media.frames) {
    return { error: `Source out frame ${end} is past the asset (${media.frames} frames).` };
  }
  const fps = media?.fps && media.fps > 0 ? media.fps : projectFps(doc.package.format);
  const scene = doc.package.scenes.find(item => item.id === sceneId);
  const target = scene?.background?.asset === assetId
    ? 'background' as const
    : { mediaIndex: Math.max(0, scene?.media?.findIndex(item => item?.asset === assetId) ?? 0) };
  return { type: 'SetMediaRange', sceneId, target, startSeconds: start / fps, endSeconds: end / fps };
}
