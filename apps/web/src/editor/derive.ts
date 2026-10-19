/** Freshness and sentence cues beside the compiled timeline. The store owns compile. */
import type { CompiledTimeline } from '../../../../packages/planner/dist/src/browser.js';
import { auditionParams } from './audio/audition.ts';
import { sceneStatus, staleAssets, staleWork } from './audio/status.ts';
import type { ProjectDoc } from './commands.ts';
import type { SceneFreshness, SentenceCue } from './types.ts';

export interface ScriptView {
  status: Record<string, SceneFreshness>;
  staleWork: string[];
  staleAssets: string[];
  sentences: Record<string, SentenceCue[]>;
  diagnostics: string[];
}

export function scriptView(doc: ProjectDoc, timeline: CompiledTimeline | null): ScriptView {
  const status: Record<string, SceneFreshness> = {};
  for (const scene of doc.package.scenes) status[scene.id] = sceneStatus(doc, scene.id);
  const sentences: Record<string, SentenceCue[]> = {};
  for (const scene of doc.package.scenes) {
    const cues = (timeline?.captions ?? []).filter(cue => cue.sceneId === scene.id);
    sentences[scene.id] = cues.map((cue, index) => ({
      index,
      text: cue.text,
      from: cue.from,
      to: cue.to,
      sceneId: cue.sceneId,
      estimated: cue.estimated,
    }));
  }
  return {
    status,
    staleWork: staleWork(doc),
    staleAssets: staleAssets(doc),
    sentences,
    diagnostics: timeline?.warnings ?? [],
  };
}

export function exportAudition(doc: ProjectDoc, timeline: CompiledTimeline | null) {
  if (!timeline) {
    return auditionParams(doc.package, { fps: 30, durationInFrames: 0, scenes: [] });
  }
  return auditionParams(doc.package, timeline);
}
