declare module '../../../../../apps/renderer/src/audio-mix-model.js' {
  export function resolveAudioMix(pkg: unknown, timeline: unknown): {
    enabled: boolean;
    music: null | {
      gainDb: number;
      loop: boolean;
      duck: { enabled: boolean; reductionDb: number; attackMs: number; releaseMs: number };
      gains: number[];
    };
    dialogue: Array<{ sceneId: string; gainDb: number; from: number; durationInFrames: number; gains: number[]; startSeconds?: number; endSeconds?: number }>;
    ambience: Array<{ sceneId: string; gainDb: number; from: number; durationInFrames: number; gains: number[]; startSeconds?: number; endSeconds?: number }>;
    sfx: Array<{ sceneId: string; gainDb: number; from: number; durationInFrames: number }>;
  };
}
