/** Demo document for the script/audio panel. Synthetic tone, no model call. */
import { conditioningHash, narrationInputFingerprint, textFingerprint } from '../audio/speech.ts';
import { createEditorStore, type StandInEditorStore } from '../store.ts';
import type { ProjectDoc } from '../types.ts';

export const DEMO_SOURCE = 'demo-narration-tone';

export function demoSamples(): Float32Array {
  const samples = new Float32Array(8000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * 220 * index) / 8000) * (index < 4000 ? 0.4 : 0.15);
  }
  return samples;
}

export function demoDocument(): ProjectDoc {
  const scene = {
    id: 's1',
    layout: 'title',
    preferredFrames: 90,
    copy: { headline: 'Opening' },
    transitionOut: { type: 'cut', frames: 0 },
    narration: 'One clear sentence. Another sentence follows.',
    narration_asset: 'a_voice',
  };
  const other = {
    id: 's2',
    layout: 'title',
    preferredFrames: 90,
    copy: { headline: 'Next' },
    transitionOut: { type: 'cut', frames: 0 },
    narration: 'The second scene keeps its own take.',
    narration_asset: 'a_voice2',
  };
  const doc: ProjectDoc = {
    pkg: {
      id: 'pkg_editoraudio',
      title: 'Script and audio',
      revision: 1,
      format: { width: 1920, height: 1080, fps: 30 },
      duration: { mode: 'flexible' },
      voice: { enabled: true, engine: 'kokoro', voice: 'af_heart', speed: 1 },
      scenes: [scene, other],
      presenter: { enabled: true, scenes: 'all', portrait: 'a_face' },
      assets: {
        a_voice: { kind: 'audio', status: 'ready', file: 'audio/s1.wav' },
        a_voice2: { kind: 'audio', status: 'ready', file: 'audio/s2.wav' },
        a_bed: { kind: 'audio', status: 'ready', file: 'audio/bed.wav' },
        a_still: { kind: 'image', status: 'ready', file: 'assets/still.png' },
        a_face: { kind: 'image', status: 'ready', file: 'assets/face.png' },
        a_pres: { kind: 'video', status: 'ready', file: 'assets/presenter.mp4' },
      },
      audio: { music: { asset: 'a_bed', fade_in_seconds: 0, fade_out_seconds: 0 } },
    },
    takes: {},
    alignment: {},
    captions: {},
    presenterClips: {},
    editSeq: 0,
  };
  const take = {
    takeId: 'take-s1',
    assetId: 'a_voice',
    sourceHash: DEMO_SOURCE,
    inputFingerprint: narrationInputFingerprint(scene, doc.pkg.voice),
    sampleRate: 8000,
    sampleCount: 8000,
    range: { inSample: 0, outSample: 8000 },
  };
  doc.takes.s1 = take;
  doc.alignment.s1 = {
    sourceHash: DEMO_SOURCE,
    textFingerprint: textFingerprint(scene.narration),
    chunks: [
      { text: 'One clear sentence.', seconds: 0.5, words: [{ text: 'One', start: 0, end: 0.15 }, { text: 'clear', start: 0.15, end: 0.3 }, { text: 'sentence.', start: 0.3, end: 0.5 }] },
      { text: 'Another sentence follows.', seconds: 0.5, words: [{ text: 'Another', start: 0, end: 0.2 }, { text: 'sentence', start: 0.2, end: 0.4 }, { text: 'follows.', start: 0.4, end: 0.5 }] },
    ],
  };
  doc.presenterClips.s1 = { assetId: 'a_pres', conditioningHash: conditioningHash(take) };
  const take2 = {
    takeId: 'take-s2',
    assetId: 'a_voice2',
    sourceHash: 'demo-narration-scene-2',
    inputFingerprint: narrationInputFingerprint(other, doc.pkg.voice),
    sampleRate: 8000,
    sampleCount: 4000,
    range: { inSample: 0, outSample: 4000 },
  };
  doc.takes.s2 = take2;
  doc.alignment.s2 = {
    sourceHash: take2.sourceHash,
    textFingerprint: textFingerprint(other.narration ?? ''),
    chunks: [{ text: other.narration ?? '', seconds: 0.5 }],
  };
  return doc;
}

export function demoStore(): StandInEditorStore {
  return createEditorStore(demoDocument());
}
