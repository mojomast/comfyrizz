/**
 * Pure music-lyric timing and presentation. Canonical cues use original-song
 * seconds; the composition trim is applied here, once, for every render path.
 * No parser, media API, React state or speech synthesis lives in this module.
 */

export const LYRICS_STYLES = Object.freeze(['off', 'caption', 'reel']);
export const LYRIC_POP_SECONDS = 0.14;
export const LYRIC_POP_SCALE = 1.08;

/** @typedef {{ startSeconds: number, endSeconds: number }} LyricsTrim */

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Absent and unknown styles are deliberately inert for legacy packages. */
export function normalizeLyricsStyle(style) {
  return LYRICS_STYLES.includes(style) ? style : 'off';
}

/** A finite half-open source window. Invalid windows do not invent a trim. */
export function normalizeLyricsTrim(trim) {
  if (!finite(trim?.startSeconds) || !finite(trim?.endSeconds)) return null;
  if (trim.startSeconds < 0 || trim.endSeconds <= trim.startSeconds) return null;
  return { startSeconds: trim.startSeconds, endSeconds: trim.endSeconds };
}

/**
 * Resolve effective ends and clip cues/words to the master-song source window.
 * An omitted cue end is the next cue start (or trim end); an omitted word end
 * is the next real word start (or its containing cue end). Explicit cue ends
 * retain intentional gaps. Standard LRC cues never acquire a `words` array.
 *
 * The original start is retained as `sourceStartSeconds` so a word which was
 * already playing at the trim boundary does not receive a new entrance pop.
 */
export function clipLyricCues(cues, trim = null) {
  const window = normalizeLyricsTrim(trim);
  const trimStart = window?.startSeconds ?? 0;
  const trimEnd = window?.endSeconds ?? Number.POSITIVE_INFINITY;
  const source = (Array.isArray(cues) ? cues : [])
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => finite(cue?.startSeconds) && typeof cue?.text === 'string')
    .sort((a, b) => a.cue.startSeconds - b.cue.startSeconds || a.index - b.index);

  const clipped = [];
  for (let index = 0; index < source.length; index += 1) {
    const { cue } = source[index];
    const sourceStart = cue.startSeconds;
    const nextCueStart = source[index + 1]?.cue.startSeconds;
    const explicitEnd = finite(cue.endSeconds) && cue.endSeconds > sourceStart ? cue.endSeconds : null;
    const sourceEnd = explicitEnd ?? (finite(nextCueStart) ? nextCueStart : trimEnd);
    const startSeconds = Math.max(trimStart, sourceStart);
    const endSeconds = Math.min(trimEnd, sourceEnd);
    if (!(endSeconds > startSeconds)) continue;

    const sourceWords = Array.isArray(cue.words)
      ? cue.words
          .map((word, wordIndex) => ({ word, wordIndex }))
          .filter(({ word }) => finite(word?.startSeconds) && typeof word?.text === 'string')
          .sort((a, b) => a.word.startSeconds - b.word.startSeconds || a.wordIndex - b.wordIndex)
      : null;
    const words = [];
    if (sourceWords) {
      for (let wordIndex = 0; wordIndex < sourceWords.length; wordIndex += 1) {
        const { word } = sourceWords[wordIndex];
        const realStart = word.startSeconds;
        const nextWordStart = sourceWords[wordIndex + 1]?.word.startSeconds;
        const wordSourceEnd = finite(nextWordStart) ? nextWordStart : sourceEnd;
        const boundedStart = Math.max(sourceStart, realStart);
        const boundedEnd = Math.min(sourceEnd, wordSourceEnd);
        const wordStart = Math.max(trimStart, boundedStart);
        const wordEnd = Math.min(trimEnd, boundedEnd);
        if (!(wordEnd > wordStart)) continue;
        words.push({
          text: word.text,
          startSeconds: wordStart,
          endSeconds: wordEnd,
          sourceStartSeconds: realStart,
        });
      }
    }

    clipped.push({
      text: cue.text,
      startSeconds,
      endSeconds,
      sourceStartSeconds: sourceStart,
      sourceEndSeconds: sourceEnd,
      // Absent stays absent: an empty synthetic word track would make standard
      // LRC indistinguishable from genuinely enhanced lyrics downstream.
      ...(sourceWords ? { words } : {}),
    });
  }
  return clipped;
}

/** Exact composition-frame to original-song clock conversion (no frame rounding). */
export function lyricSongTime(frame, fps, trim = null) {
  const start = normalizeLyricsTrim(trim)?.startSeconds ?? 0;
  const rate = finite(fps) && fps > 0 ? fps : 30;
  return start + frame / rate;
}

/** Active cue and real word at songTime, using half-open [start, end) intervals. */
export function activeLyricAt(cues, songTime) {
  const empty = { cue: null, cueIndex: -1, word: null, wordIndex: -1 };
  if (!finite(songTime)) return empty;
  const list = Array.isArray(cues) ? cues : [];
  for (let cueIndex = 0; cueIndex < list.length; cueIndex += 1) {
    const cue = list[cueIndex];
    if (songTime < cue.startSeconds) break;
    if (songTime < cue.startSeconds || songTime >= cue.endSeconds) continue;
    let word = null;
    let wordIndex = -1;
    for (let index = 0; index < (cue.words?.length ?? 0); index += 1) {
      const candidate = cue.words[index];
      if (songTime < candidate.startSeconds) break;
      if (songTime >= candidate.startSeconds && songTime < candidate.endSeconds) {
        word = candidate;
        wordIndex = index;
        break;
      }
    }
    return { cue, cueIndex, word, wordIndex };
  }
  return empty;
}

/**
 * Shared still/player/export resolver: trim.start + frame / fps, then half-open lookup.
 * @param {{ cues: any[], trim?: LyricsTrim | null, frame: number, fps: number }} input
 */
export function lyricAtFrame({ cues, trim = null, frame, fps }) {
  const songTime = lyricSongTime(frame, fps, trim);
  return { songTime, ...activeLyricAt(cues, songTime) };
}

/** Brief progress from the real source start, never from a trim/frame boundary. */
export function lyricWordPopProgress(word, songTime, reducedMotion = false) {
  if (reducedMotion) return 1;
  if (!word || !finite(songTime)) return 1;
  const start = finite(word.sourceStartSeconds) ? word.sourceStartSeconds : word.startSeconds;
  return clamp((songTime - start) / LYRIC_POP_SECONDS, 0, 1);
}

export function lyricWordPopScale(progress, reducedMotion = false) {
  if (reducedMotion) return 1;
  return LYRIC_POP_SCALE - (LYRIC_POP_SCALE - 1) * clamp(progress, 0, 1);
}

/**
 * Responsive safe areas and type. All dimensions derive from composition pixels,
 * not browser viewport units, so portrait/landscape stills and MP4s agree.
 */
export function lyricsLayout({ width = 1920, height = 1080, reducedMotion = false, avoidReactiveCard = false } = {}) {
  const w = finite(width) && width > 0 ? width : 1920;
  const h = finite(height) && height > 0 ? height : 1080;
  const portrait = h > w;
  const safeX = Math.round(clamp(w * 0.075, 16, 144));
  const safeY = Math.round(clamp(h * 0.085, 16, 120));
  const captionFontSize = Math.round(clamp(Math.min(w * 0.032, h * 0.044), 18, 46));
  const reelFontSize = Math.round(clamp(Math.min(w * 0.058, h * 0.075), 28, 88));
  const captionPaddingX = Math.round(clamp(captionFontSize * 0.65, 12, 30));
  const captionPaddingY = Math.round(clamp(captionFontSize * 0.4, 9, 18));
  const reactiveBottom = Math.max(22, Math.round(h * 0.04));
  const reactiveHeight = Math.max(58, Math.min(88, Math.round(h * 0.08)));
  const reactiveGap = Math.max(16, Math.round(h * 0.02));
  const captionBottom = avoidReactiveCard ? reactiveBottom + reactiveHeight + reactiveGap : safeY;
  // Reel copy stays above the whole lower-caption band even when this package
  // uses reel style and no caption is currently mounted.
  const reelBottom = Math.round(captionBottom + captionFontSize * 1.3 * 2 + captionPaddingY * 2 + reactiveGap);
  const reelTop = Math.max(safeY, Math.round(h * (portrait ? 0.26 : 0.28)));
  return {
    width: w,
    height: h,
    portrait,
    reducedMotion: reducedMotion === true,
    safeArea: { x: safeX, y: safeY },
    caption: {
      fontSize: captionFontSize,
      lineHeight: 1.28,
      paddingX: captionPaddingX,
      paddingY: captionPaddingY,
      bottom: captionBottom,
      maxWidth: Math.max(1, w - safeX * 2),
    },
    reel: {
      fontSize: reelFontSize,
      lineHeight: 1.08,
      top: reelTop,
      bottom: Math.min(reelBottom, Math.max(safeY, h - reelTop - 1)),
      maxWidth: Math.max(1, w - safeX * 2),
    },
    motion: {
      pop: reducedMotion !== true,
      popSeconds: reducedMotion === true ? 0 : LYRIC_POP_SECONDS,
      popScale: reducedMotion === true ? 1 : LYRIC_POP_SCALE,
    },
  };
}

/**
 * Split a cue for karaoke colouring while reproducing cue.text byte-for-byte.
 * Enhanced-LRC prefixes and inter-word whitespace stay as plain React text.
 * If a foreign cue's words cannot be aligned to its full text, fall back to one
 * stable plain segment rather than dropping/inserting characters.
 */
export function lyricTextSegments(cue) {
  const plain = [{ text: cue?.text ?? '', wordIndex: -1 }];
  if (!Array.isArray(cue?.words) || cue.words.length === 0) return plain;
  const segments = [];
  let cursor = 0;
  for (let wordIndex = 0; wordIndex < cue.words.length; wordIndex += 1) {
    const text = cue.words[wordIndex].text;
    if (text.length === 0) return plain;
    const at = cue.text.indexOf(text, cursor);
    if (at < 0) return plain;
    if (at > cursor) segments.push({ text: cue.text.slice(cursor, at), wordIndex: -1 });
    segments.push({ text, wordIndex });
    cursor = at + text.length;
  }
  if (cursor < cue.text.length) segments.push({ text: cue.text.slice(cursor), wordIndex: -1 });
  return segments;
}
