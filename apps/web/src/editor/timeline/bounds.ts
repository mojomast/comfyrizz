/**
 * Gesture limits for the timeline. A request below the speech floor or the
 * layout minimum is still dispatched: TrimScene keeps it as a preference and
 * the compiler floors the duration. These helpers only reject a range the
 * source cannot cover, and they cap a drag at a known source or layout max.
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
    { id: scene.id, layout: scene.layout as 'title', media_only: scene.media_only === true },
    { narration: measured.narration },
    fps,
  );
  const speech = floor.measured ? floor.frames : null;
  const min = Math.max(scene.media_only ? 1 : limit.min, speech ?? 0);
  const source = sourceCeilingFrames(doc, sceneId);
  const max = Math.min(MAX_PREFERRED, source ?? MAX_PREFERRED, limit.max);
  return { min, max: Math.max(min, max), speech, source };
}

/** What the compiler will do with a preference that is shorter than speech or the layout minimum. */
export function trimFloorMessage(requested: number, effective: number, bounds?: TrimBounds | null): string {
  const reason = bounds?.speech != null && effective === bounds.speech
    ? ' to measured narration'
    : bounds != null && (bounds.speech == null || effective === bounds.min)
      ? ' to the readable minimum'
      : '';
  return `Requested ${requested}, effective ${effective} (floored${reason}).`;
}

/**
 * Keep a gesture inside a known source or layout maximum.
 * A shorter request stays as the preference; `effective` is the floor the compiler applies.
 */
export function clampTrim(
  doc: ProjectDoc,
  measured: MeasuredInput,
  sceneId: string,
  requested: number,
): { preferredFrames: number; effective: number; floored: boolean; note?: string } | { error: string } {
  const bounds = trimBounds(doc, measured, sceneId);
  if (!bounds) return { error: `Unknown scene ${sceneId}.` };
  if (!Number.isFinite(requested)) return { error: 'Duration has to be a whole number of frames.' };
  if (bounds.source !== null && bounds.source < bounds.min) {
    return { error: `Source is ${bounds.source} frames, shorter than the ${bounds.min}-frame speech minimum.` };
  }
  const whole = Math.floor(requested);
  let preferred = Math.max(1, Math.min(MAX_PREFERRED, whole));
  let note: string | undefined;
  if (preferred > bounds.max) {
    preferred = bounds.max;
    note = bounds.source !== null && bounds.max === bounds.source
      ? `Held at ${preferred} frames, the end of the source.`
      : `Held at ${preferred} frames.`;
  }
  const effective = Math.max(preferred, bounds.min);
  const floored = effective > preferred;
  if (floored) note = trimFloorMessage(preferred, effective, bounds);
  return { preferredFrames: preferred, effective, floored, note };
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
