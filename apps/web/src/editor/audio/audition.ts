/**
 * Audition uses the renderer's mix. Mute and solo stay on the session and are
 * not written into this result or into an export.
 */
import { resolveAudioMix } from '../../../../../apps/renderer/src/audio-mix-model.js';
import type { AuditionMix, EditorTimeline } from '../types.ts';

export function auditionParams(pkg: unknown, timeline: EditorTimeline): AuditionMix {
  const mix = resolveAudioMix(pkg as never, timeline as never);
  return {
    enabled: Boolean(mix.enabled),
    narrationGain: 1,
    musicGainDb: mix.music ? mix.music.gainDb : null,
    musicLoop: mix.music ? mix.music.loop : null,
    musicDuck: mix.music ? mix.music.duck : null,
    musicGains: mix.music ? mix.music.gains : null,
    ambience: (mix.ambience ?? []).map(item => ({
      sceneId: item.sceneId,
      gainDb: item.gainDb,
      from: item.from,
      durationInFrames: item.durationInFrames,
      gains: item.gains,
    })),
    sfx: (mix.sfx ?? []).map(item => ({
      sceneId: item.sceneId,
      gainDb: item.gainDb,
      from: item.from,
      durationInFrames: item.durationInFrames,
    })),
  };
}
