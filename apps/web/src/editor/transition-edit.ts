import { compileTimeline, projectFps, type MeasuredInput } from '../../../../packages/planner/dist/src/browser.js';
import { resolveFrames } from '../../../../packages/jobs/src/dims.mjs';
import type { ApplyResult, EditableScene, ProjectDoc, SetTransition } from './commands.ts';

type Plate = { asset?: string; trim?: { startSeconds: number; endSeconds?: number } | null; speed?: number; loop?: boolean };
type Source = { kind?: string; status?: string; media?: { fps?: number; frames?: number; durationSeconds?: number }; gen?: { generator?: string; inputs?: { fps?: number; frames?: number } } };

/** Coverage of the existing source at its authored speed; never count looping or auto-stretch. */
export function transitionSourceCeiling(doc: ProjectDoc, scene: EditableScene): number {
  const fps = projectFps(doc.package.format);
  const plates = [scene.background, ...(scene.media ?? []), ...((scene.foreground ?? []) as Plate[])].filter(Boolean) as Plate[];
  let ceiling = Infinity;
  for (const plate of plates) {
    if (!plate.asset) continue;
    const asset = doc.package.assets?.[plate.asset] as Source | undefined;
    if (!asset) return 0;
    if (asset.kind !== 'video') continue;
    const media = asset.media;
    const durations: number[] = [];
    if (media?.frames && media.fps && media.fps > 0) durations.push(media.frames / media.fps);
    if (media?.durationSeconds && media.durationSeconds > 0) durations.push(media.durationSeconds);
    // A pending reference is a plan, not measured footage. Only its already-authored
    // frame count is available; media metadata must not promise more than that job.
    if (asset.status === 'pending') {
      const inputs = asset.gen?.inputs;
      if (asset.gen?.generator !== 'ltx25' || !inputs?.frames || !inputs.fps || inputs.fps <= 0) return 0;
      // Use the same 8n+1 normalization as the job planner, which can round down.
      durations.push(resolveFrames(inputs.frames) / inputs.fps);
    }
    if (!durations.length) return 0;
    const seconds = Math.min(...durations);
    const start = plate.trim?.startSeconds ?? 0;
    const end = Math.min(seconds, plate.trim?.endSeconds ?? seconds);
    const speed = plate.speed ?? 1;
    if (!(speed > 0) || !Number.isFinite(speed)) return 0;
    const window = Math.max(0, Math.floor((end - start) * fps / speed + 1e-8));
    // MediaFill's default loop restarts one project frame before the full source.
    const loopWindow = plate.loop === false ? Infinity : Math.max(0, Math.floor(Math.round(seconds * fps) / speed) - 1);
    ceiling = Math.min(ceiling, window, loopWindow);
  }
  return ceiling;
}

/** Apply overlap and source-backed duration compensation before the canonical compile. */
export function editExactTransition(
  doc: ProjectDoc,
  sceneId: string,
  transition: SetTransition['transitionOut'] | undefined,
  measured: MeasuredInput,
  sceneFrames?: Record<string, number>,
): ApplyResult | null {
  if (!(doc.package.duration as { exact?: boolean } | undefined)?.exact) return null;
  const reject = (error: string): ApplyResult => ({ ok: false, code: 'transition-coverage', error });
  try {
    const before = compileTimeline(doc, measured);
    const index = doc.package.scenes.findIndex(scene => scene.id === sceneId);
    const neighbour = doc.package.scenes[index + 1];
    if (!neighbour) return reject('The last scene has no outgoing transition.');
    const oldOverlap = before.scenes[index]!.transitionOutFrames;
    const overlap = transition && !['none', 'cut'].includes(transition.type) ? transition.frames : 0;
    const previous = doc.editor.transitionCompensation?.[sceneId] ?? {};
    const base = before.scenes.map(scene => scene.durationInFrames - (previous[scene.id] ?? 0));
    const change = overlap - oldOverlap + Object.values(previous).reduce((sum, n) => sum + n, 0);
    const candidates: number[][] = [];
    if (sceneFrames) {
      if (Object.entries(sceneFrames).some(([id, frames]) => !doc.package.scenes.some(scene => scene.id === id) || !Number.isInteger(frames) || frames < 1 || frames > 108000)) {
        return reject('Combined durations need existing scene IDs and whole project-frame counts from 1 to 108000.');
      }
      candidates.push(before.scenes.map(scene => sceneFrames[scene.id] ?? scene.durationInFrames));
    } else {
      // Prefer the selected outgoing scene, then share the needed handles with its neighbour.
      for (let share = Math.abs(change); share >= 0; share--) {
        const frames = base.slice();
        frames[index] += Math.sign(change) * share;
        frames[index + 1] += change - Math.sign(change) * share;
        candidates.push(frames);
      }
    }
    let reason = '';
    for (const frames of candidates) {
      const next = structuredClone(doc);
      const offsets: Record<string, number> = {};
      let invalid = false;
      for (let i = 0; i < frames.length; i++) {
        const scene = next.package.scenes[i]!;
        const old = before.scenes[i]!.durationInFrames;
        if (frames[i] !== old) {
          if (scene.locked || ((scene.drawing || scene.audio_trim) && frames[i]! < old)) {
            reason = `Scene ${scene.id} has locked or timed content.`; invalid = true; break;
          }
          const ceiling = transitionSourceCeiling(doc, scene);
          if (frames[i]! > old && frames[i]! > ceiling) {
            reason = `Scene ${scene.id} has only ${ceiling} source-backed project frames at its current trim and playback speed.`; invalid = true; break;
          }
          scene.preferredFrames = frames[i];
        }
        if (frames[i] !== base[i]) offsets[scene.id] = frames[i]! - base[i]!;
      }
      if (invalid) continue;
      const target = next.package.scenes[index]!;
      if (transition === undefined) delete target.transitionOut;
      else target.transitionOut = transition && !['cut', 'none'].includes(transition.type)
        ? structuredClone(transition) : { type: 'cut', frames: 0 };
      try {
        const compiled = compileTimeline(next, measured);
        if (compiled.durationInFrames !== before.durationInFrames || compiled.scenes.some((scene, i) => scene.durationInFrames !== frames[i])) {
          reason = 'The requested scene durations do not preserve the exact total and timing floors.'; continue;
        }
        next.editor.transitionCompensation = { ...next.editor.transitionCompensation };
        if (Object.keys(offsets).length) next.editor.transitionCompensation[sceneId] = offsets;
        else delete next.editor.transitionCompensation[sceneId];
        if (!Object.keys(next.editor.transitionCompensation).length) delete next.editor.transitionCompensation;
        return { ok: true, doc: next };
      } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    }
    return reject(`Cannot change this overlap while preserving the exact ${before.durationInFrames}-frame duration. ${reason} Use “Transition + scene durations” to redistribute available scene time, or supply longer source footage. No edit was applied.`);
  } catch (error) { return reject(error instanceof Error ? error.message : String(error)); }
}
