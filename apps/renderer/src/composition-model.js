import { narrationAudio } from './audio-model.js';
import { resolveAudioMix } from './audio-mix-model.js';

/**
 * Shared narration, caption and mix decisions for the web Player and the MP4
 * composition. Media URLs are not resolved here.
 *
 * Estimated captions stay off the burn-in. Measured cues are passed through.
 * A missing narration file is reported and not played.
 *
 * @typedef {import('../../../packages/schema/types').PackageV1} PackageV1
 * @typedef {import('../../../packages/planner/dist/src/index.js').Timeline} Timeline
 *
 * @param {PackageV1} pkg
 * @param {Timeline} timeline
 * @param {{ missingMedia?: string[], mixAudio?: boolean }} [options]
 */
export function resolvePackageComposition(pkg, timeline, { missingMedia = [], mixAudio = true } = {}) {
  const audio = narrationAudio(pkg);
  const missing = new Set(missingMedia ?? []);
  const narration = audio
    ? { assetId: audio.assetId, file: audio.file, missing: missing.has(audio.file) }
    : null;
  const measured = (timeline?.captions ?? []).some(cue => !cue.estimated);
  const mix = resolveAudioMix(pkg, timeline);
  return {
    narration,
    captions: measured ? timeline.captions : null,
    mix,
    mixAudio: mixAudio !== false && mix.enabled === true,
  };
}
