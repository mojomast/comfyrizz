#!/usr/bin/env node
// Q10 - Dialogue tail and padding report.
//
// Source: docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md section 3 (P1
// dialogue-led editing) and section 7 ("Sum trailingPaddingSamples / 24000 over
// its 20 segments for the trailing-padding total").
//
// Measured evidence from the review:
//   - trailing zero padding across 20 dialogue segments totals 86.96 s
//     (14.49% of the 600 s film)
//   - chapter 5 carries 8.45 s of trailing padding, chapter 19 carries 7.95 s
//   - chapter 17 is synthesized at 1.15x to fit its slot
//
// The report is a presentation/timing measurement only: a long tail is not
// proof of a bad performance, it is a signal that the tail needs an editorial
// reason (a deliberate pause, a silent gag) or an edit.
//
// Pure module: no imports with side effects, no I/O, no clock, no network.

export const DEFAULT_SAMPLE_RATE = 24000;
export const DEFAULT_FLAG_S = 2;
export const DEFAULT_FILM_S = 600;

// Editorial reasons that legitimately explain a long dialogue tail.
export const EDITORIAL_REASONS = Object.freeze([
  'deliberate_pause',
  'silent_gag',
]);

export const FLAG_CODES = Object.freeze({
  TAIL_UNEXPLAINED: 'TAIL_UNEXPLAINED',
  TAIL_UNMEASURED: 'TAIL_UNMEASURED',
  SPEED_UP: 'SPEED_UP',
});

const SPEED_EPSILON = 1e-9;

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Normalize the editorial reason of a segment.
 * Accepts a plain string ("deliberate_pause") or an object
 * ({reason, note}). Returns null when the segment carries no reason.
 */
export function editorialReasonOf(segment) {
  if (!segment || typeof segment !== 'object') return null;
  const raw = segment.editorialReason ?? segment.reason ?? null;
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof raw === 'object') {
    const type = raw.reason ?? raw.type ?? raw.kind;
    if (typeof type === 'string' && type.trim().length > 0) return type.trim();
    return null;
  }
  return null;
}

/** Derive a chapter number from a segment, falling back to its id. */
function chapterOf(segment, index) {
  if (isFiniteNumber(segment?.chapter)) return segment.chapter;
  const id = typeof segment?.id === 'string' ? segment.id : '';
  const match = /(?:ch|chapter)[-_ ]?(\d+)/i.exec(id);
  if (match) return Number(match[1]);
  return index + 1;
}

function resolveSampleRate(manifest, options) {
  const candidate = options.sampleRate ?? manifest?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  if (!isFiniteNumber(candidate) || candidate <= 0) {
    throw new TypeError('sampleRate must be a positive finite number');
  }
  return candidate;
}

/**
 * Build the dialogue tail and padding report.
 *
 * @param {object} manifest voice manifest with a `segments` array; each segment
 *   carries `trailingPaddingSamples` (int), optional `speed` (multiplier),
 *   optional `editorialReason`, `id` and `chapter`.
 * @param {object} [options]
 * @param {number} [options.sampleRate=24000] samples per second
 * @param {number} [options.flagS=2] unexplained tail threshold in seconds
 * @param {number} [options.filmS=600] film length in seconds
 * @returns {object} report
 */
export function tailReport(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError('voice manifest must be an object');
  }
  if (!Array.isArray(manifest.segments)) {
    throw new TypeError('voice manifest must contain a segments array');
  }

  const sampleRate = resolveSampleRate(manifest, options);
  const flagS = isFiniteNumber(options.flagS) ? options.flagS : DEFAULT_FLAG_S;
  const filmS = isFiniteNumber(options.filmS)
    ? options.filmS
    : isFiniteNumber(manifest.filmS)
      ? manifest.filmS
      : DEFAULT_FILM_S;
  if (filmS <= 0) throw new TypeError('filmS must be a positive finite number');

  const segments = [];
  const flagged = [];
  let totalSamples = 0;
  let measuredCount = 0;

  manifest.segments.forEach((raw, index) => {
    const segment = raw && typeof raw === 'object' ? raw : {};
    const id = typeof segment.id === 'string' && segment.id.length > 0 ? segment.id : `segment-${index + 1}`;
    const chapter = chapterOf(segment, index);
    const speed = isFiniteNumber(segment.speed) ? segment.speed : 1;
    const reason = editorialReasonOf(segment);
    const samples = segment.trailingPaddingSamples;

    let trailingS = null;
    if (isFiniteNumber(samples)) {
      trailingS = round(samples / sampleRate, 3);
      totalSamples += samples;
      measuredCount += 1;
    }

    const entry = {
      id,
      chapter,
      trailingS,
      speed,
      editorialReason: reason,
    };
    segments.push(entry);

    if (trailingS === null) {
      flagged.push({
        id,
        chapter,
        code: FLAG_CODES.TAIL_UNMEASURED,
        message: `${id} has no trailing padding measurement; it is not_reviewed, not clean.`,
      });
    } else if (trailingS > flagS && reason === null) {
      flagged.push({
        id,
        chapter,
        code: FLAG_CODES.TAIL_UNEXPLAINED,
        trailingS,
        message: `${id} has ${trailingS.toFixed(2)} s of unexplained trailing padding (over ${flagS} s).`,
      });
    }

    if (speed > 1 + SPEED_EPSILON) {
      flagged.push({
        id,
        chapter,
        code: FLAG_CODES.SPEED_UP,
        speed,
        message: `${id} is synthesized at ${speed.toFixed(2)}x to fit its slot; shorten or rewrite instead.`,
      });
    }
  });

  const totalTrailingS = round(totalSamples / sampleRate, 2);
  const shareOfFilm = filmS > 0 ? round(totalTrailingS / filmS, 4) : 0;

  return {
    schema: 'comfyrizz.dialogue-tails/v1',
    sampleRate,
    filmS,
    flagS,
    segments,
    totalTrailingS,
    shareOfFilm,
    shareOfFilmPct: round(shareOfFilm * 100, 2),
    measuredSegments: measuredCount,
    flagged,
  };
}

export default tailReport;
