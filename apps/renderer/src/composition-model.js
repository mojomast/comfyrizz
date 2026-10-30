import { narrationAudio } from './audio-model.js';
import { resolveAudioMix } from './audio-mix-model.js';
import { clipLyricCues, normalizeLyricsStyle, normalizeLyricsTrim } from './lyrics-model.js';

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
  const mix = resolveAudioMix(pkg, timeline);
  // A supplied music-video master is the only audible source. Legacy music beds
  // continue to coexist with narration and native dialogue exactly as before.
  const audio = mixAudio !== false && mix.music?.master === true ? null : narrationAudio(pkg);
  const missing = new Set(missingMedia ?? []);
  const narration = audio
    ? { assetId: audio.assetId, file: audio.file, missing: missing.has(audio.file) }
    : null;
  const measured = (timeline?.captions ?? []).some(cue => !cue.estimated);
  const masterMusic = mixAudio !== false && mix.music?.master === true;
  const lyricsStyle = normalizeLyricsStyle(pkg?.audio?.lyricsStyle);
  const lyricsTrim = normalizeLyricsTrim(mix.music
    ? { startSeconds: mix.music.startSeconds, endSeconds: mix.music.endSeconds }
    : null);
  const lyrics = mixAudio !== false && mix.music && lyricsStyle !== 'off' && lyricsTrim
    ? {
        style: lyricsStyle,
        cues: clipLyricCues(pkg.audio.lyrics, lyricsTrim),
        trim: lyricsTrim,
        avoidReactiveCard: Boolean(mix.music.reactive),
      }
    : null;
  return {
    narration,
    // A master song replaces narration, so its old narration captions are stale
    // too. mixAudio:false deliberately retains the legacy narration/caption path.
    captions: !masterMusic && measured ? timeline.captions : null,
    lyrics,
    mix,
    mixAudio: mixAudio !== false && mix.enabled === true,
  };
}
