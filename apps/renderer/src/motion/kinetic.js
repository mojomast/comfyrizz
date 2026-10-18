// MS3 step 3: kinetic type (waterfall words, highlight sweep) and SVG draw-on.
//
// Same licence note as `./index.js`: the shapes are re-expressed from public motion-skill
// material (whaleyxbt/claude-motion, MIT; HyperFrames motion skills, Apache-2.0); no code was
// copied. Everything is a pure function of the local frame, so a still is a truthful preview.
import { clamp, prog, staggerFrames, STAGGER_SECONDS } from './index.js';

/* ------------------------------------------------------------------ *
 * Waterfall: the headword waterfall (research 4.4). The first and last
 * words, plus any shouted/number word, are anchors and travel further.
 * ------------------------------------------------------------------ */

/** @param {string} word @param {number} index @param {number} count */
export function isAnchorWord(word, index, count) {
  if (index === 0 || index === count - 1) return true;
  const letters = String(word ?? '').replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase() && /\p{L}/u.test(letters)) return true;
  return /\d/.test(String(word ?? ''));
}

/**
 * Split headline copy into waterfall units. `phrase` (a scene's `motion.highlight`) marks the
 * words the sweep sits behind.
 * @returns {Array<{word: string, anchor: boolean, highlight: boolean}>}
 */
export function waterfallPlan(text, phrase = '') {
  const source = String(text ?? '');
  const words = source.split(/\s+/).filter(Boolean);
  const target = typeof phrase === 'string' && phrase.trim() ? phrase.trim() : '';
  let cursor = 0;
  const spans = words.map(word => {
    const start = source.indexOf(word, cursor);
    const end = start + word.length;
    cursor = end;
    return { word, start, end };
  });
  const matchStart = target ? source.indexOf(target) : -1;
  const matchEnd = matchStart >= 0 ? matchStart + target.length : -1;
  return spans.map((span, index) => ({
    word: span.word,
    anchor: isAnchorWord(span.word, index, words.length),
    highlight: matchStart >= 0 && span.start < matchEnd && span.end > matchStart,
  }));
}

/**
 * @param {{frame?: number, fps?: number, index?: number, anchor?: boolean, delay?: number, distance?: number}} [options]
 * @returns {{opacity: number, translateY: number, rotate: number}}
 */
export function waterfallEntry({ frame = 0, fps = 30, index = 0, anchor = false, delay = 0, distance = 34 } = {}) {
  const start = delay + staggerFrames(index, STAGGER_SECONDS.word, fps);
  const enter = clamp(prog(frame, start, 20, 'enter'));
  const travel = distance * (anchor ? 1.5 : 1);
  return {
    opacity: enter,
    translateY: (1 - enter) * travel,
    rotate: (1 - enter) * (anchor ? 3 : 1.2),
  };
}

/* ------------------------------------------------------------------ *
 * Highlight sweep: one accent band per scene (research 4.4). A single
 * left-to-right pass behind the matched phrase; it never restates.
 * ------------------------------------------------------------------ */

export const SWEEP_SECONDS = 0.6;
export const SWEEP_FADE_IN_SECONDS = 0.12;
export const SWEEP_FADE_OUT_SECONDS = 0.3;

/**
 * @param {{frame?: number, fps?: number, at?: number, duration?: number, direction?: string}} [options]
 * @returns {{progress: number, scaleX: number, opacity: number, active: boolean}}
 */
export function highlightSweep({ frame = 0, fps = 30, at = 8, duration, direction = 'left' } = {}) {
  const span = Math.max(1, Math.round((duration ?? SWEEP_SECONDS * fps)));
  const fadeIn = clamp(prog(frame, at, Math.max(1, Math.round(SWEEP_FADE_IN_SECONDS * fps)), 'enter'));
  const sweep = clamp(prog(frame, at, span, 'move'));
  const fadeOut = clamp(prog(frame, at + span, Math.max(1, Math.round(SWEEP_FADE_OUT_SECONDS * fps)), 'exit'));
  return {
    progress: sweep,
    scaleX: direction === 'right' ? sweep : sweep,
    opacity: fadeIn * (1 - fadeOut),
    active: frame >= at,
  };
}

/** Split copy around a highlight phrase; an absent/unknown phrase is a no-op. */
export function splitHighlight(text, phrase) {
  const source = String(text ?? '');
  const target = typeof phrase === 'string' ? phrase.trim() : '';
  if (!target) return { before: source, match: '', after: '', found: false };
  const index = source.indexOf(target);
  if (index < 0) return { before: source, match: '', after: '', found: false };
  return { before: source.slice(0, index), match: target, after: source.slice(index + target.length), found: true };
}

/* ------------------------------------------------------------------ *
 * SVG draw-on (research 4.4 / spec A5). `pathLength=1` plus an animated
 * `stroke-dashoffset` 1 -> 0 per path, in `data-draw-order` then document
 * order, then fills fade in. Unsafe mark-up falls back to `fadeUp`.
 * ------------------------------------------------------------------ */

const UNSAFE_SVG = /<(script|foreignObject|animate|animateTransform|animateMotion|set)\b/i;
const PATH_TAG = /<path\b([^>]*?)\/?>/gi;

/**
 * True when the mark-up can be drawn on rather than cross-faded: no SMIL/script/foreignObject,
 * at least one `<path>`, and every element that carries its own `stroke` is a path (a stroked
 * rect/circle/line has no trustworthy length to sweep).
 */
export function canDrawOn(svg) {
  if (typeof svg !== 'string' || !/<path\b/i.test(svg)) return false;
  if (UNSAFE_SVG.test(svg)) return false;
  const stroked = svg.match(/<([\w:-]+)\b[^>]*\bstroke\s*=\s*"(?!none)/gi) ?? [];
  if (stroked.length === 0) return false;
  return stroked.every(tag => /^<path\b/i.test(tag));
}

function attrValue(attrs, name) {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return match ? match[1] : null;
}

function setAttr(attrs, name, value) {
  const pattern = new RegExp(`\\s*${name}\\s*=\\s*"[^"]*"`, 'i');
  const cleaned = attrs.replace(pattern, '');
  return `${cleaned} ${name}="${value}"`;
}

function drawOrder(attrs, docIndex) {
  const declared = attrValue(attrs, 'data-draw-order');
  const number = declared === null ? NaN : Number(declared);
  return Number.isFinite(number) ? number : 1e6 + docIndex;
}

/**
 * The frame's version of a draw-on SVG. Pure and deterministic: the same frame always produces
 * the same mark-up. Returns the input unchanged when draw-on is not safe.
 * @param {string} svg
 * @param {{frame?: number, fps?: number, delay?: number, duration?: number, fillDuration?: number}} [options]
 * @returns {string}
 */
export function drawOnSvg(svg, { frame = 0, fps = 30, delay = 4, duration = 30, fillDuration = 14 } = {}) {
  if (!canDrawOn(svg)) return svg;
  const paths = [];
  let match;
  PATH_TAG.lastIndex = 0;
  while ((match = PATH_TAG.exec(svg))) {
    paths.push({
      start: match.index,
      end: match.index + match[0].length,
      attrs: match[1],
      docIndex: paths.length,
      selfClose: /\/>$/.test(match[0]),
    });
  }
  const ordered = paths
    .map(item => ({ item, order: drawOrder(item.attrs, item.docIndex) }))
    .sort((a, b) => a.order - b.order || a.item.docIndex - b.item.docIndex);
  let out = svg;
  const replacements = ordered.map(({ item, order }, rank) => {
    const stroked = /stroke\s*=\s*"(?!none)/i.test(item.attrs);
    const filled = !/fill\s*=\s*"none"/i.test(item.attrs);
    const start = delay + staggerFrames(rank, STAGGER_SECONDS.word, fps);
    const staggerBudget = Math.max(6, duration - Math.round(rank * STAGGER_SECONDS.word * fps));
    const drawn = stroked ? clamp(prog(frame, start, staggerBudget, 'enter')) : 1;
    const filledIn = filled ? clamp(prog(frame, start + staggerBudget, fillDuration, 'move')) : 0;
    let attrs = item.attrs;
    attrs = setAttr(attrs, 'data-draw-rank', String(rank));
    if (stroked) {
      attrs = setAttr(attrs, 'pathLength', '1');
      attrs = setAttr(attrs, 'stroke-dasharray', '1');
      attrs = setAttr(attrs, 'stroke-dashoffset', String(Number((1 - drawn).toFixed(4))));
    }
    if (filled) attrs = setAttr(attrs, 'fill-opacity', String(Number(filledIn.toFixed(4))));
    return { ...item, order, tag: `<path${attrs}${item.selfClose ? '/>' : '>'}` };
  });
  // Splice from the end of the document backwards so every offset stays valid.
  for (const item of [...replacements].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, item.start) + item.tag + out.slice(item.end);
  }
  return out;
}

/** Whether a scene asks for the draw-on entry. */
export function wantsDrawOn(scene) {
  return scene?.motion?.entry === 'drawOn';
}
