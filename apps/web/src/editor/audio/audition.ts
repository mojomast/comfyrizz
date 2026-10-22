/**
 * Audition uses the renderer's mix. Mute and solo stay on the session and are
 * not written into this result or into an export.
 */
import { resolveAudioMix } from '../../../../../apps/renderer/src/audio-mix-model.js';
import type { AuditionMix } from '../types.ts';

export function auditionParams(pkg: unknown, timeline: { fps?: number; durationInFrames?: number; scenes?: unknown[] }): AuditionMix {
  const mix = resolveAudioMix(pkg as never, timeline as never);
  return {
    enabled: Boolean(mix.enabled),
    narrationGain: 1,
    musicGainDb: mix.music ? mix.music.gainDb : null,
    musicLoop: mix.music ? mix.music.loop : null,
    musicDuck: mix.music ? mix.music.duck : null,
    musicGains: mix.music ? mix.music.gains : null,
    ambience: (mix.ambience ?? []).map(raw => {
      const item = raw as typeof raw & { startSeconds?: number; endSeconds?: number };
      return {
        sceneId: item.sceneId,
        gainDb: item.gainDb,
        from: item.from,
        durationInFrames: item.durationInFrames,
        gains: item.gains,
        ...(typeof item.startSeconds === 'number' ? { startSeconds: item.startSeconds } : {}),
        ...(typeof item.endSeconds === 'number' ? { endSeconds: item.endSeconds } : {}),
      };
    }),
    sfx: (mix.sfx ?? []).map(item => ({
      sceneId: item.sceneId,
      gainDb: item.gainDb,
      from: item.from,
      durationInFrames: item.durationInFrames,
    })),
  };
}
