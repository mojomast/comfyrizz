/**
 * K1: pure caption-style logic, kept out of React so the suite can test it
 * without a DOM or a render. The renderer draws the styles; this module decides
 * which style is active and which word is being spoken.
 *
 * The default is `sentence` and its output must not change. A 9:16 video with no
 * explicit `captions.style` defaults to `big-word`; every other aspect defaults
 * to `sentence`.
 */
export const CAPTION_STYLES = ['sentence', 'karaoke', 'word-pop', 'big-word'];
export const CAPTION_STYLE_DEFAULT = 'sentence';
/** Frames a popped word takes to reach full scale. */
export const WORD_POP_FRAMES = 6;

/**
 * Resolve the caption style: an explicit `pkg.captions.style` wins; otherwise a
 * portrait (9:16) timeline defaults to `big-word`, everything else to `sentence`.
 */
export function resolveCaptionStyle(pkg, timeline) {
  const explicit = pkg?.captions?.style;
  if (typeof explicit === 'string' && CAPTION_STYLES.includes(explicit)) return explicit;
  const width = Number(timeline?.width) || 1920;
  const height = Number(timeline?.height) || 1080;
  return height > width ? 'big-word' : CAPTION_STYLE_DEFAULT;
}

/**
 * The word cues of a caption. A sentence without measured words is treated as a
 * single word spanning the whole cue, so every style still renders something.
 */
export function captionWords(cue) {
  if (Array.isArray(cue?.words) && cue.words.length > 0) return cue.words;
  return [{ text: cue?.text ?? '', from: cue?.from ?? 0, to: cue?.to ?? 0 }];
}

/** Index of the word being spoken at `frame`, or -1 when the frame is before the cue. */
export function activeWordIndex(words, frame) {
  for (let index = 0; index < words.length; index += 1) {
    if (frame >= words[index].from && frame < words[index].to) return index;
  }
  if (words.length > 0 && frame >= words[words.length - 1].to) return words.length - 1;
  return -1;
}

/** 0..1 pop progress for a word that entered at `word.from`. */
export function wordPopProgress(word, frame, frames = WORD_POP_FRAMES) {
  if (!word) return 1;
  if (frame <= word.from) return 0;
  return Math.min(1, (frame - word.from) / frames);
}

/** Scale for a popping word (word-pop): 0.6 -> 1. */
export function wordPopScale(progress) {
  return 0.6 + 0.4 * Math.max(0, Math.min(1, progress));
}
