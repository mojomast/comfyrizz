/** Derived timeline, freshness and the renderer mix. */
import { auditionParams } from './audio/audition.ts';
import { sentenceCues, placeScenes } from './audio/speech.ts';
import { sceneStatus, staleAssets, staleWork } from './audio/status.ts';
import { waveformSnapshot } from './audio/waveform-cache.ts';
import type { AlignmentChunk, DerivedState, EditorTimeline, ProjectDoc, SentenceCue } from './types.ts';

export function derive(doc: ProjectDoc): DerivedState {
  const chunks: Record<string, AlignmentChunk[] | undefined> = {};
  for (const [id, align] of Object.entries(doc.alignment)) chunks[id] = align.chunks;
  const placed = placeScenes(doc.pkg, chunks);
  const diagnostics: string[] = [];
  const sentences: Record<string, SentenceCue[]> = {};
  let timeline: EditorTimeline = { fps: 30, durationInFrames: 0, scenes: [], captions: [] };
  if (!placed.ok) diagnostics.push(placed.reason);
  else {
    const scenes = placed.scenes.map(scene => ({
      id: scene.id,
      from: scene.from,
      durationInFrames: scene.duration,
      transitionOutFrames: scene.transitionOut,
    }));
    const captions: SentenceCue[] = [];
    for (const scene of placed.scenes) {
      const align = doc.alignment[scene.id];
      const cues = align ? sentenceCues(align.chunks, scene.from, scene.id, placed.fps, doc.captions[scene.id]) : [];
      sentences[scene.id] = cues;
      captions.push(...cues);
    }
    const last = placed.scenes[placed.scenes.length - 1];
    timeline = {
      fps: placed.fps,
      durationInFrames: last ? last.from + last.duration : 0,
      scenes,
      captions,
    };
  }
  const status: DerivedState['status'] = {};
  for (const scene of doc.pkg.scenes) status[scene.id] = sceneStatus(doc, scene.id);
  return {
    timeline,
    placed: placed.ok ? placed.scenes : [],
    status,
    staleWork: staleWork(doc),
    staleAssets: staleAssets(doc),
    sentences,
    audition: auditionParams(doc.pkg, timeline),
    waveforms: waveformSnapshot(),
    diagnostics,
  };
}
