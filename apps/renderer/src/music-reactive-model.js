import { getWaveformPortion } from '@remotion/media-utils';

/** Decode a few seconds, never the whole song, and retain only adjacent windows. */
export const MUSIC_ANALYSIS_WINDOW_SECONDS = 2;
/** A restrained amplitude envelope around the current playhead. */
export const MUSIC_VISUALIZATION_SECONDS = 0.48;

/** @typedef {{ startSeconds: number, endSeconds: number }} MusicTrim */

/** @param {any} value */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {number} value */
export function clamp01(value) {
  return finite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/**
 * Timeline frame -> source-media seconds, including the master trim offset.
 * @param {number} frame
 * @param {number} fps
 * @param {MusicTrim | null} [trim]
 */
export function musicSourceTime(frame, fps, trim = null) {
  const start = finite(trim?.startSeconds) ? Math.max(0, trim.startSeconds) : 0;
  const time = start + Math.max(0, frame) / Math.max(1, fps);
  return finite(trim?.endSeconds) ? Math.min(time, trim.endSeconds) : time;
}

/**
 * The real source span to reduce; audio outside the trim is never sampled.
 * @param {number} sourceTime
 * @param {MusicTrim | null} [trim]
 */
export function musicAmplitudeRange(sourceTime, trim = null) {
  const trimStart = finite(trim?.startSeconds) ? Math.max(0, trim.startSeconds) : 0;
  const start = Math.max(trimStart, sourceTime - MUSIC_VISUALIZATION_SECONDS * 0.25);
  const unboundedEnd = sourceTime + MUSIC_VISUALIZATION_SECONDS * 0.75;
  const end = finite(trim?.endSeconds) ? Math.min(trim.endSeconds, unboundedEnd) : unboundedEnd;
  return { startTimeInSeconds: start, endTimeInSeconds: Math.max(start, end) };
}

/**
 * Absolute source windows needed for one visualization range.
 * @param {{ startTimeInSeconds: number, endTimeInSeconds: number }} range
 * @param {number} [windowInSeconds]
 */
export function requiredMusicAnalysisWindows(range, windowInSeconds = MUSIC_ANALYSIS_WINDOW_SECONDS) {
  if (!finite(range?.startTimeInSeconds) || !finite(range?.endTimeInSeconds) || range.endTimeInSeconds <= range.startTimeInSeconds) return [];
  const first = Math.floor(Math.max(0, range.startTimeInSeconds) / windowInSeconds);
  const last = Math.floor(Math.max(0, range.endTimeInSeconds - 1e-9) / windowInSeconds);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/**
 * Media-utils measures mean absolute PCM in each bucket. Normalization stays off
 * so two genuinely different recordings cannot both be inflated to full scale.
 * Null data is an explicit unavailable state, never an invented flat waveform.
 * @param {{
 *   audioData: import('@remotion/media-utils').MediaUtilsAudioData | null,
 *   dataOffsetInSeconds?: number,
 *   sourceTime: number,
 *   trim?: MusicTrim | null,
 *   numberOfSamples?: number,
 * }} input
 * @returns {number[] | null}
 */
export function reduceMusicAmplitudes({ audioData, dataOffsetInSeconds = 0, sourceTime, trim = null, numberOfSamples = 56 }) {
  if (!audioData) return null;
  const range = musicAmplitudeRange(sourceTime, trim);
  const durationInSeconds = range.endTimeInSeconds - range.startTimeInSeconds;
  if (durationInSeconds <= 0) return null;
  const bars = getWaveformPortion({
    audioData,
    dataOffsetInSeconds,
    startTimeInSeconds: range.startTimeInSeconds,
    durationInSeconds,
    numberOfSamples,
    outputRange: 'zero-to-one',
    normalize: false,
  });
  if (bars.length !== numberOfSamples || bars.some(bar => !finite(bar.amplitude))) return null;
  return bars.map(bar => bar.amplitude);
}

/** Bounded visual response. Zero intensity is intentionally static, not fallback data. */
/** @param {number[]} amplitudes @param {number} intensity */
export function scaleMusicAmplitudes(amplitudes, intensity) {
  const amount = clamp01(intensity);
  return amplitudes.map(amplitude => clamp01(Math.sqrt(clamp01(amplitude)) * amount));
}
