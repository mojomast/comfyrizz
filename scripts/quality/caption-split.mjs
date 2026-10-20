/**
 * Q14: Caption presentation pass.
 *
 * Source: docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md section 4
 * ("Add a caption presentation pass over the immutable dialogue timings") and
 * docs/specs/QUALITY_FIXES.md Q14.
 *
 * `presentCaptions(cues, opts)` returns `{ cues, needsEdit }`:
 *   - every returned cue is wrapped to at most `maxLines` lines of at most
 *     `maxLine` characters, counting the `Speaker: ` label;
 *   - long text is split at phrase boundaries (sentence/clause punctuation and
 *     conjunctions) and falls back to word boundaries only when a phrase is
 *     too long;
 *   - the measured source span is distributed across the sub-cues in
 *     proportion to their displayed character counts (speaker label included);
 *   - split sub-cues carry `provenance: 'estimated'` (and `timing`) and never
 *     carry invented word timings;
 *   - a cue that still exceeds `maxCps` after splitting, or whose text cannot
 *     be laid out in the requested lines (for example a single over-long
 *     word), is copied to `needsEdit` for an explicit caption edit. Its text is
 *     kept verbatim, never silently shortened;
 *   - the input cues are not mutated and no sub-cue span leaves the source
 *     cue's [start, end] range.
 *
 * Pure module: no I/O, no clock, no network, no side effects at import time.
 */

import { captionMetrics } from './caption-metrics.mjs';

export const CAPTION_PRESENTATION_SCHEMA = 'comfyrizz.caption-presentation/v1';

const DEFAULT_MAX_CPS = 20;
const DEFAULT_MAX_LINE = 42;
const DEFAULT_MAX_LINES = 2;

const CONJUNCTIONS = new Set([
  'and',
  'but',
  'or',
  'nor',
  'so',
  'yet',
  'because',
  'while',
  'when',
  'then',
  'though',
  'although',
  'if',
  'since',
]);

// Punctuation that closes a phrase. Trailing quotes/brackets stay attached.
const SENTENCE_END = /[.!?\u2026]["'\u201d\u2019)\]]*$/;
const CLAUSE_END = /[,;:\u2014\u2013]["'\u201d\u2019)\]]*$/;

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeOptions(opts = {}) {
  const maxCps = isPositiveNumber(opts.maxCps) ? opts.maxCps : DEFAULT_MAX_CPS;
  const maxLine = isPositiveNumber(opts.maxLine)
    ? Math.max(1, Math.floor(opts.maxLine))
    : DEFAULT_MAX_LINE;
  const maxLines = isPositiveNumber(opts.maxLines)
    ? Math.max(1, Math.floor(opts.maxLines))
    : DEFAULT_MAX_LINES;
  return { maxCps, maxLine, maxLines };
}

// Kept byte-for-byte equivalent to caption-metrics' label formatting so the
// pass and the validator always measure the same characters.
function titleCase(value) {
  return String(value)
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function speakerPrefix(speaker) {
  return `${titleCase(speaker ?? '')}: `;
}

function cueIdOf(cue, index) {
  if (typeof cue.id === 'string' && cue.id.trim()) return cue.id;
  if (typeof cue.id === 'number' && Number.isFinite(cue.id)) return String(cue.id);
  return `cue_${index}`;
}

function tokenize(text) {
  const words = [];
  const re = /\S+/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    words.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return words;
}

function bareWord(word) {
  return String(word)
    .toLowerCase()
    .replace(/^[^a-z0-9']+/, '')
    .replace(/[^a-z0-9']+$/, '');
}

function phraseBoundaries(words) {
  const boundaries = new Set();
  for (let i = 0; i < words.length; i += 1) {
    if (i === 0) continue;
    const previous = words[i - 1].text;
    if (SENTENCE_END.test(previous) || CLAUSE_END.test(previous)) {
      boundaries.add(i);
    }
    if (CONJUNCTIONS.has(bareWord(words[i].text))) {
      boundaries.add(i);
    }
  }
  return boundaries;
}

/**
 * Lay words out into at most maxLines visual lines of at most maxLine chars.
 * The first line also carries the speaker label, so it has less room. Returns
 * null when the text cannot fit; callers then report it for an explicit edit.
 */
function layoutWords(wordTexts, prefixLen, maxLine, maxLines, rawLength) {
  const textLength = rawLength ?? wordTexts.join(' ').length;
  if (prefixLen + textLength > maxLine * maxLines) return null;
  if (wordTexts.length === 0) return [''];

  const capacities = [maxLine - prefixLen];
  for (let i = 1; i < maxLines; i += 1) capacities.push(maxLine);
  if (capacities[0] < 1) return null;

  const lines = [];
  let index = 0;
  for (let lineIndex = 0; lineIndex < capacities.length && index < wordTexts.length; lineIndex += 1) {
    const capacity = capacities[lineIndex];
    const lineWords = [];
    let length = 0;
    while (index < wordTexts.length) {
      const word = wordTexts[index];
      const added = (lineWords.length ? 1 : 0) + word.length;
      if (length + added > capacity) break;
      lineWords.push(word);
      length += added;
      index += 1;
    }
    if (lineWords.length === 0) return null;
    lines.push(lineWords.join(' '));
  }
  if (index < wordTexts.length) return null;
  return lines;
}

function wrapUnlimited(wordTexts, maxLine) {
  if (wordTexts.length === 0) return [''];
  const lines = [];
  let lineWords = [];
  let length = 0;
  for (const word of wordTexts) {
    if (lineWords.length === 0) {
      lineWords.push(word);
      length = word.length;
      continue;
    }
    if (length + 1 + word.length <= maxLine) {
      lineWords.push(word);
      length += 1 + word.length;
    } else {
      lines.push(lineWords.join(' '));
      lineWords = [word];
      length = word.length;
    }
  }
  if (lineWords.length) lines.push(lineWords.join(' '));
  return lines;
}

function segmentText(sourceText, words, from, to) {
  if (to <= from) return '';
  return sourceText.slice(words[from].start, words[to - 1].end);
}

/**
 * Greedily pack words into segments. A segment is accepted only when its full
 * displayed length and its wrapped lines fit. When the maximum fitting run ends
 * before the next phrase, cut at the last phrase boundary inside the run so a
 * sub-cue never breaks a phrase in the middle if a boundary is available.
 */
function segmentWords(sourceText, words, prefixLen, maxLine, maxLines) {
  if (words.length === 0) {
    return [{ words: [], text: '', unfit: false }];
  }

  const boundaries = phraseBoundaries(words);
  const segments = [];
  let from = 0;

  while (from < words.length) {
    let end = from + 1;
    while (end <= words.length) {
      const rawLength = words[end - 1].end - words[from].start;
      const candidate = words.slice(from, end).map((word) => word.text);
      if (layoutWords(candidate, prefixLen, maxLine, maxLines, rawLength) === null) break;
      end += 1;
    }

    let fitEnd = end - 1;
    if (fitEnd <= from) {
      const word = words[from];
      segments.push({ words: [word], text: word.text, unfit: true });
      from += 1;
      continue;
    }

    if (fitEnd < words.length) {
      for (let boundary = fitEnd; boundary > from; boundary -= 1) {
        if (boundaries.has(boundary)) {
          fitEnd = boundary;
          break;
        }
      }
    }

    const slice = words.slice(from, fitEnd);
    segments.push({
      words: slice,
      text: segmentText(sourceText, words, from, fitEnd),
      unfit: false,
    });
    from = fitEnd;
  }

  return segments;
}

function round(value, digits = 9) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function displayLinesFor(lines, prefix) {
  if (lines.length === 0) return [prefix.trimEnd()];
  return lines.map((line, index) => {
    if (index !== 0) return line;
    return line.length > 0 ? `${prefix}${line}` : prefix.trimEnd();
  });
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

/**
 * @param {Array<object>} cues Caption cues: { speaker, text, start, end, id?, ... }
 * @param {{maxCps?:number, maxLine?:number, maxLines?:number}} [opts]
 * @returns {{
 *   schema:string,
 *   cues:Array<object>,
 *   needsEdit:Array<object>,
 *   stats:object,
 *   options:{maxCps:number, maxLine:number, maxLines:number}
 * }}
 */
export function presentCaptions(cues = [], opts = {}) {
  const { maxCps, maxLine, maxLines } = normalizeOptions(opts);
  const input = Array.isArray(cues) ? cues : [];
  const output = [];
  const needsEdit = [];
  let splitCueCount = 0;
  let estimatedCueCount = 0;

  input.forEach((source, sourceIndex) => {
    const cue =
      source && typeof source === 'object' && !Array.isArray(source)
        ? source
        : { text: String(source ?? '') };
    const speaker = cue.speaker ?? '';
    const text = String(cue.text ?? '');
    const sourceId = cueIdOf(cue, sourceIndex);
    const prefix = speakerPrefix(speaker);
    const prefixLen = prefix.length;
    const words = tokenize(text);
    const segments = segmentWords(text, words, prefixLen, maxLine, maxLines);
    const isSplit = segments.length > 1;
    if (isSplit) splitCueCount += 1;

    const sourceStart = Number(cue.start ?? 0);
    const sourceEnd = Number(cue.end ?? 0);
    const validSpan =
      Number.isFinite(sourceStart) &&
      Number.isFinite(sourceEnd) &&
      sourceEnd > sourceStart;
    const span = validSpan ? sourceEnd - sourceStart : 0;

    const weights = segments.map((segment) => prefixLen + segment.text.length);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    let cumulative = 0;

    segments.forEach((segment, partIndex) => {
      const wordTexts = segment.words.map((word) => word.text);
      const rawLength = segment.text.length;
      const layout = layoutWords(wordTexts, prefixLen, maxLine, maxLines, rawLength);
      const lines = layout ?? wrapUnlimited(wordTexts, maxLine);
      const displayLines = displayLinesFor(lines, prefix);
      const lastPart = partIndex === segments.length - 1;

      let start;
      let end;
      if (!isSplit) {
        start = cue.start ?? sourceStart;
        end = cue.end ?? sourceEnd;
      } else if (!validSpan) {
        start = cue.start ?? sourceStart;
        end = cue.end ?? sourceEnd;
      } else {
        const before = cumulative;
        cumulative += weights[partIndex];
        const rawStart =
          partIndex === 0
            ? sourceStart
            : sourceStart + (span * before) / totalWeight;
        const rawEnd = lastPart
          ? sourceEnd
          : sourceStart + (span * cumulative) / totalWeight;
        start = partIndex === 0 ? sourceStart : round(clamp(rawStart, sourceStart, sourceEnd));
        end = lastPart ? sourceEnd : round(clamp(rawEnd, sourceStart, sourceEnd));
        if (end < start) end = start;
      }

      const outputCue = { ...cue };
      outputCue.speaker = speaker;
      outputCue.text = segment.text;
      outputCue.start = start;
      outputCue.end = end;
      outputCue.lines = lines;
      outputCue.displayLines = displayLines;
      outputCue.wrappedText = lines.join('\n');
      outputCue.sourceId = sourceId;
      outputCue.sourceIndex = sourceIndex;
      outputCue.part = partIndex + 1;
      outputCue.parts = segments.length;
      outputCue.split = isSplit;

      if (isSplit) {
        outputCue.id = `${sourceId}~${partIndex + 1}`;
        outputCue.provenance = 'estimated';
        outputCue.timing = 'estimated';
        outputCue.estimated = true;
        // Never attach the source's word timings to a re-timed sub-cue.
        delete outputCue.words;
        delete outputCue.wordTimings;
        estimatedCueCount += 1;
      }

      const index = output.length;
      output.push(outputCue);

      const metrics = captionMetrics([outputCue], { maxCps, maxLine, maxLines });
      const duration = Number(outputCue.end) - Number(outputCue.start);
      const reasons = [];
      if (!(Number.isFinite(duration) && duration > 0)) pushUnique(reasons, 'DURATION');
      if (metrics.overCps.length > 0) pushUnique(reasons, 'CPS');
      if (metrics.overLength.length > 0) pushUnique(reasons, 'LENGTH');
      if (lines.length > maxLines) pushUnique(reasons, 'LINES');
      if (lines.some((line) => line.length > maxLine)) pushUnique(reasons, 'LINE_LENGTH');
      if (displayLines.length > maxLines) pushUnique(reasons, 'LINES');
      if (displayLines.some((line) => line.length > maxLine)) {
        pushUnique(reasons, 'LINE_LENGTH');
      }
      if (layout === null && !lines.some((line) => line.length > maxLine)) {
        pushUnique(reasons, 'LINE_LENGTH');
      }

      if (reasons.length > 0) {
        needsEdit.push({
          index,
          cueId: sourceId,
          sourceIndex,
          part: partIndex + 1,
          parts: segments.length,
          speaker,
          text: segment.text,
          sourceText: text,
          start: outputCue.start,
          end: outputCue.end,
          duration: Number.isFinite(duration) ? round(duration, 6) : null,
          chars: metrics.maxChars,
          cps: metrics.maxCps,
          lines,
          displayLines,
          reasons,
          action: 'caption-edit-required',
          maxCps,
          maxLine,
          maxLines,
        });
      }
    });
  });

  return {
    schema: CAPTION_PRESENTATION_SCHEMA,
    cues: output,
    needsEdit,
    stats: {
      inputCues: input.length,
      outputCues: output.length,
      splitCues: splitCueCount,
      estimatedCues: estimatedCueCount,
      needsEdit: needsEdit.length,
    },
    options: { maxCps, maxLine, maxLines },
  };
}
