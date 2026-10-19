/**
 * LP2 code/terminal layout maths. Pure: the same frame always yields the same
 * count, and nothing here touches the network. The renderer and the agent tool
 * both call this so the lint and the typing clock cannot drift.
 *
 * Typing default is 0.035 s/char (expose chars/s). After the last character,
 * hold at least 1 s, plus 0.25 s for every word past the third, before any exit.
 * The caret blinks at 2.4 Hz. Text that is meant to be read does not move.
 */

/** 1 / 0.035 s per character. */
export const DEFAULT_CHARS_PER_SECOND = 1 / 0.035;
export const CARET_HZ = 2.4;
/** Monospace size at a 1080-wide frame. Scales with width, never below 14 px. */
export const CODE_FONT_AT_1080 = 22;
export const CODE_MIN_FONT_PX = 14;
/** Headline and supporting floors at 1080-wide, from the motion guidance. */
export const HEADLINE_PX_AT_1080 = 84;
export const SUPPORT_PX_AT_1080 = 44;

/**
 * @param {number} width
 * @param {number} minAt1080
 */
export function readablePx(width, minAt1080) {
  const px = Math.round((minAt1080 * width) / 1080);
  return Math.max(minAt1080, px);
}

/**
 * Safe padding scaled from 80 px sides / 100 px top-bottom at 1080 wide.
 * @param {number} width
 */
export function frameSafePx(width) {
  const scale = width / 1080;
  return { x: 80 * scale, y: 100 * scale };
}

/**
 * In 9:16 the readable band is the centre square. Other aspects use the full frame.
 * @param {number} width
 * @param {number} height
 */
export function textBand(width, height) {
  if (height > width * 1.2) {
    const top = (height - width) / 2;
    return { top, bottom: top + width };
  }
  return { top: 0, bottom: height };
}

/** @param {number} width */
export function codeFontPx(width) {
  return Math.max(CODE_MIN_FONT_PX, (CODE_FONT_AT_1080 * width) / 1080);
}

/**
 * The box the monospace block may occupy, inside the safe area and (in 9:16)
 * inside the centre square. Chrome is the terminal header.
 * @param {number} width
 * @param {number} height
 */
export function codeTextBox(width, height) {
  const safe = frameSafePx(width);
  const band = textBand(width, height);
  const scale = width / 1080;
  const chrome = 56 * scale;
  const pad = 28 * scale;
  const top = Math.max(safe.y, band.top) + chrome + pad;
  const bottom = Math.min(height - safe.y, band.bottom) - pad;
  return {
    x: safe.x + pad,
    y: top,
    width: Math.max(1, width - 2 * (safe.x + pad)),
    height: Math.max(1, bottom - top),
  };
}

/**
 * @param {string} code
 * @param {number} width
 * @param {number} height
 */
export function measureCode(code, width, height) {
  const font = codeFontPx(width);
  const box = codeTextBox(width, height);
  const charW = font * 0.62;
  const lineH = font * 1.45;
  const lines = String(code ?? '').split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    font,
    maxChars: Math.max(1, Math.floor(box.width / charW)),
    maxLines: Math.max(1, Math.floor(box.height / lineH)),
    lines: lines.length,
    longest,
  };
}

/**
 * Overflow findings for this frame, plus the same source shrunk to 360 px wide
 * (code must stay legible there). Empty when the block fits.
 * @param {string} code
 * @param {number} width
 * @param {number} height
 * @returns {{code:string, width:number, height:number, lines?:number, maxLines?:number, longest?:number, maxChars?:number}[]}
 */
export function lintCodeScene(code, width, height) {
  const findings = [];
  const frames = [{ width, height }];
  if (width !== 360) {
    const shrunkHeight = Math.max(64, Math.round((360 * height) / width));
    frames.push({ width: 360, height: shrunkHeight });
  }
  for (const frame of frames) {
    const fit = measureCode(code, frame.width, frame.height);
    if (fit.lines > fit.maxLines) {
      findings.push({ code: 'CODE_TOO_MANY_LINES', width: frame.width, height: frame.height, lines: fit.lines, maxLines: fit.maxLines });
    }
    if (fit.longest > fit.maxChars) {
      findings.push({ code: 'CODE_LINE_TOO_LONG', width: frame.width, height: frame.height, longest: fit.longest, maxChars: fit.maxChars });
    }
  }
  return findings;
}

/** @param {number} charsPerSecond */
export function charsPerSecond(charsPerSecond) {
  return typeof charsPerSecond === 'number' && charsPerSecond > 0 ? charsPerSecond : DEFAULT_CHARS_PER_SECOND;
}

/**
 * How many source characters (including newlines) are visible at `frame`.
 * Frame 0 reveals nothing; the terminal chrome is the non-empty first frame.
 * @param {number} frame
 * @param {number} fps
 * @param {number} rate
 * @param {number} length
 */
export function typedCount(frame, fps, rate, length) {
  const safeFps = fps > 0 ? fps : 30;
  const count = Math.floor((Math.max(0, frame) / safeFps) * charsPerSecond(rate));
  return Math.min(Math.max(0, length), Math.max(0, count));
}

/**
 * Caret on/off at 2.4 Hz. A pure function of the frame: no CSS animation.
 * @param {number} frame
 * @param {number} fps
 * @param {number} [hz]
 */
export function caretVisible(frame, fps, hz = CARET_HZ) {
  const safeFps = fps > 0 ? fps : 30;
  const half = safeFps / (hz * 2);
  if (!(half > 0)) return true;
  return Math.floor(Math.max(0, frame) / half) % 2 === 0;
}

/** Hold after typing: 1 s, plus 0.25 s per word beyond three. */
export function codeHoldSeconds(source) {
  const words = String(source).trim().split(/\s+/).filter(Boolean).length;
  return 1 + 0.25 * Math.max(0, words - 3);
}

/**
 * Frame at which an exit may start: typing duration plus the hold.
 * @param {string} source
 * @param {number} fps
 * @param {number} rate
 */
export function codeExitStart(source, fps, rate) {
  const safeFps = fps > 0 ? fps : 30;
  const typingFrames = (String(source).length / charsPerSecond(rate)) * safeFps;
  return typingFrames + codeHoldSeconds(source) * safeFps;
}

/**
 * Scene length that covers typing, the hold, and a short exit (60% of a
 * 0.8 s entry, the motion-token exit ratio).
 * @param {string} source
 * @param {number} fps
 * @param {number} rate
 */
export function codeTimelineFrames(source, fps, rate) {
  const safeFps = fps > 0 ? fps : 30;
  const exitFrames = Math.ceil(0.6 * Math.min(safeFps * 0.8, 24));
  return Math.max(1, Math.ceil(codeExitStart(source, safeFps, rate) + exitFrames));
}
