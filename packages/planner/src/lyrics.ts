/**
 * Strict, browser-safe LRC and enhanced-LRC parsing.
 *
 * Times in the returned cues are seconds in the original song, not in the
 * trimmed video. All arithmetic before that final conversion is integer
 * milliseconds, so fractions cannot accumulate floating-point rounding error.
 */

export const LRC_LIMITS = Object.freeze({
  rawChars: 128 * 1024,
  cues: 512,
  leadingTimestamps: 16,
  wordsPerCue: 64,
  cueChars: 160,
  wordChars: 80,
  maxSeconds: 36000,
  errors: 32,
});

const MAX_TIME_MS = BigInt(LRC_LIMITS.maxSeconds * 1000);

export interface LyricWord {
  startSeconds: number;
  text: string;
}

export interface LyricCue {
  startSeconds: number;
  endSeconds?: number;
  text: string;
  words?: LyricWord[];
}

/** Plural aliases are kept for callers that name the package field `lyrics`. */
export type LyricsWord = LyricWord;
export type LyricsCue = LyricCue;

export type LrcErrorCode =
  | 'LRC_INVALID_INPUT'
  | 'LRC_RAW_TOO_LONG'
  | 'LRC_CONTROL_CHARACTER'
  | 'LRC_UNTIMED_LINE'
  | 'LRC_MALFORMED_TIMESTAMP'
  | 'LRC_DUPLICATE_TIMESTAMP'
  | 'LRC_NONMONOTONIC_TIMESTAMP'
  | 'LRC_TIME_RANGE'
  | 'LRC_BAD_ANGLE'
  | 'LRC_BAD_OFFSET'
  | 'LRC_CONFLICTING_OFFSET'
  | 'LRC_TOO_MANY_CUES'
  | 'LRC_TOO_MANY_LEADING_TIMESTAMPS'
  | 'LRC_TOO_MANY_WORDS'
  | 'LRC_CUE_TOO_LONG'
  | 'LRC_WORD_TOO_LONG'
  | 'LRC_ENHANCED_MULTIPLE_LEADING';

export interface LrcParseIssue {
  /** One-based source line. Input-wide failures are reported on line 1. */
  line: number;
  code: LrcErrorCode;
  message: string;
}

export class LrcParseError extends Error {
  readonly errors: readonly LrcParseIssue[];

  constructor(errors: readonly LrcParseIssue[]) {
    super(errors.map(issue => `line ${issue.line}: ${issue.message}`).join('\n'));
    this.name = 'LrcParseError';
    this.errors = errors;
  }
}

/** Short alias for consumers that use `LrcError` in a catch/type guard. */
export { LrcParseError as LrcError };

class IssueCollector {
  readonly items: LrcParseIssue[] = [];

  add(line: number, code: LrcErrorCode, message: string): void {
    if (this.items.length < LRC_LIMITS.errors) this.items.push({ line, code, message });
  }

  get full(): boolean {
    return this.items.length >= LRC_LIMITS.errors;
  }

  throwIfAny(): void {
    if (this.items.length) throw new LrcParseError(this.items);
  }
}

type TimestampResult =
  | { ok: true; milliseconds: bigint }
  | { ok: false; reason: 'malformed' | 'range' };

/** Parse an unsigned LRC timestamp without going through binary floating point. */
function timestampMilliseconds(token: string): TimestampResult {
  const match = /^(?:(\d{2,}):(\d{2})|(\d{2,}):(\d{2}):(\d{2}))(?:\.(\d{1,3}))?$/.exec(token);
  if (!match) return { ok: false, reason: 'malformed' };

  const minutes = match[1] !== undefined ? BigInt(match[1]) : match[3] !== undefined ? BigInt(match[3]) * 60n + BigInt(match[4]) : 0n;
  const seconds = BigInt(match[2] ?? match[5]);
  if (seconds > 59n || (match[3] !== undefined && BigInt(match[4]) > 59n)) {
    return { ok: false, reason: 'malformed' };
  }
  const fraction = (match[6] ?? '').padEnd(3, '0');
  const milliseconds = (minutes * 60n + seconds) * 1000n + BigInt(fraction || '0');
  if (milliseconds > MAX_TIME_MS) return { ok: false, reason: 'range' };
  return { ok: true, milliseconds };
}

interface AdjustedTimestamp {
  sourceMilliseconds: bigint;
  milliseconds: number;
}

function adjustTimestamp(
  parsed: { milliseconds: bigint },
  offsetMilliseconds: bigint,
  line: number,
  issues: IssueCollector,
): AdjustedTimestamp | null {
  const adjusted = parsed.milliseconds + offsetMilliseconds;
  if (adjusted < 0n || adjusted > MAX_TIME_MS) {
    issues.add(line, 'LRC_TIME_RANGE', `timestamp after offset must be between 0 and ${LRC_LIMITS.maxSeconds} seconds`);
    return null;
  }
  return { sourceMilliseconds: parsed.milliseconds, milliseconds: Number(adjusted) };
}

interface EnhancedResult {
  text: string;
  enhanced: boolean;
  words?: LyricWord[];
}

interface InlineMarker extends AdjustedTimestamp {
  from: number;
  to: number;
}

function looksLikeAngleTimestamp(contents: string): boolean {
  // Tags such as <b>, </b>, < RTL > and other literal markup are text. A
  // numeric angle token is unambiguously intended as an enhanced timestamp,
  // including malformed numeric tokens which must not silently become text.
  return /^[+-]?\s*\d/.test(contents);
}

function parseEnhanced(
  content: string,
  cueStart: AdjustedTimestamp,
  offsetMilliseconds: bigint,
  line: number,
  issues: IssueCollector,
): EnhancedResult {
  const markers: InlineMarker[] = [];
  let index = 0;
  while (index < content.length) {
    if (content[index] !== '<') {
      index += 1;
      continue;
    }
    const close = content.indexOf('>', index + 1);
    const contents = content.slice(index + 1, close < 0 ? undefined : close);
    if (close < 0) {
      issues.add(line, 'LRC_BAD_ANGLE', 'angle segment is missing its closing >');
      break;
    }
    if (contents.length === 0) {
      issues.add(line, 'LRC_BAD_ANGLE', 'empty angle segment');
      index = close + 1;
      continue;
    }
    if (!looksLikeAngleTimestamp(contents)) {
      index += 1;
      continue;
    }
    if (content[index - 1] === '<' || content[close + 1] === '>') {
      issues.add(line, 'LRC_BAD_ANGLE', 'nested or repeated angle brackets around an inline timestamp');
    }
    const parsed = timestampMilliseconds(contents);
    if (!parsed.ok) {
      issues.add(
        line,
        parsed.reason === 'range' ? 'LRC_TIME_RANGE' : 'LRC_BAD_ANGLE',
        parsed.reason === 'range'
          ? `inline timestamp must be between 0 and ${LRC_LIMITS.maxSeconds} seconds`
          : `malformed inline timestamp <${contents}>`,
      );
      index = close + 1;
      continue;
    }
    const adjusted = adjustTimestamp(parsed, offsetMilliseconds, line, issues);
    if (adjusted) markers.push({ ...adjusted, from: index, to: close + 1 });
    index = close + 1;
  }

  if (!markers.length) return { text: content, enhanced: false };

  if (markers.length > LRC_LIMITS.wordsPerCue) {
    issues.add(line, 'LRC_TOO_MANY_WORDS', `enhanced line has more than ${LRC_LIMITS.wordsPerCue} word timestamps`);
  }

  const textParts: string[] = [];
  let cursor = 0;
  for (const marker of markers) {
    textParts.push(content.slice(cursor, marker.from));
    cursor = marker.to;
  }
  textParts.push(content.slice(cursor));

  const words: LyricWord[] = [];
  let previous: InlineMarker | undefined;
  for (let wordIndex = 0; wordIndex < markers.length; wordIndex += 1) {
    const marker = markers[wordIndex];
    if (marker.milliseconds < cueStart.milliseconds) {
      issues.add(line, 'LRC_NONMONOTONIC_TIMESTAMP', 'inline word timestamp precedes its line timestamp');
    }
    if (previous) {
      if (marker.milliseconds === previous.milliseconds) {
        issues.add(line, 'LRC_DUPLICATE_TIMESTAMP', 'duplicate inline word timestamp');
      } else if (marker.milliseconds < previous.milliseconds) {
        issues.add(line, 'LRC_NONMONOTONIC_TIMESTAMP', 'inline word timestamps must be strictly increasing');
      }
    }
    const text = content.slice(marker.to, markers[wordIndex + 1]?.from ?? content.length);
    if (text.length > LRC_LIMITS.wordChars) {
      issues.add(line, 'LRC_WORD_TOO_LONG', `word segment exceeds ${LRC_LIMITS.wordChars} characters`);
    }
    words.push({ startSeconds: marker.milliseconds / 1000, text });
    previous = marker;
  }

  // Prefix text and literal markup are deliberately not assigned a synthetic
  // word start. They remain in cue.text, while words contains only real cues.
  return { text: textParts.join(''), enhanced: true, words };
}

interface ExpandedCue extends LyricCue {
  sourceLine: number;
  expansionIndex: number;
}

function metadataLine(line: string): { key: string; value: string } | null {
  const match = /^\[([A-Za-z][A-Za-z0-9_-]*):([^\]]*)\] *$/.exec(line);
  return match ? { key: match[1], value: match[2] } : null;
}

/**
 * Parse LRC text into sorted canonical cues.
 *
 * The parser is all-or-nothing: malformed input throws LrcParseError and no
 * partial cue list escapes. Standard LRC lines never acquire words or an end;
 * enhanced lines only contain the word timings explicitly present in the file.
 */
export function parseLrc(input: string): LyricCue[] {
  const issues = new IssueCollector();
  if (typeof input !== 'string') {
    throw new LrcParseError([{ line: 1, code: 'LRC_INVALID_INPUT', message: 'LRC input must be a string' }]);
  }
  if (input.length > LRC_LIMITS.rawChars) {
    throw new LrcParseError([
      { line: 1, code: 'LRC_RAW_TOO_LONG', message: `LRC input exceeds ${LRC_LIMITS.rawChars} characters` },
    ]);
  }

  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const lines = text.split(/\r\n|\r|\n/);
  const rejectedLines = new Set<number>();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (/[\u0000-\u001f\u007f-\u009f]/.test(lines[lineIndex])) {
      issues.add(lineIndex + 1, 'LRC_CONTROL_CHARACTER', 'NUL and control characters are not allowed in lyric text');
      rejectedLines.add(lineIndex);
      if (issues.full) break;
    }
  }
  issues.throwIfAny();

  // Find the one global offset before constructing any cues. Repeating the
  // same value is harmless; conflicting values are not. It is applied below
  // once to each line and inline timestamp, never once per metadata occurrence.
  let offsetMilliseconds = 0n;
  let sawOffset = false;
  for (let lineIndex = 0; lineIndex < lines.length && !issues.full; lineIndex += 1) {
    if (rejectedLines.has(lineIndex)) continue;
    const metadata = metadataLine(lines[lineIndex]);
    if (!metadata || metadata.key.toLowerCase() !== 'offset') continue;
    const match = /^([+-])(\d+)$/.exec(metadata.value);
    if (!match) {
      issues.add(lineIndex + 1, 'LRC_BAD_OFFSET', 'offset must be one signed integer number of milliseconds, for example [offset:+250]');
      continue;
    }
    const value = BigInt(match[2]) * (match[1] === '-' ? -1n : 1n);
    if (sawOffset && value !== offsetMilliseconds) {
      issues.add(lineIndex + 1, 'LRC_CONFLICTING_OFFSET', 'conflicting offset metadata');
      continue;
    }
    offsetMilliseconds = value;
    sawOffset = true;
  }

  const cues: ExpandedCue[] = [];
  let tooManyCuesReported = false;
  for (let lineIndex = 0; lineIndex < lines.length && !issues.full; lineIndex += 1) {
    if (rejectedLines.has(lineIndex)) continue;
    const source = lines[lineIndex];
    const lineNumber = lineIndex + 1;
    if (!source.trim() || metadataLine(source)) continue;

    const leading: AdjustedTimestamp[] = [];
    let cursor = 0;
    let malformedLeading = false;
    while (source[cursor] === '[') {
      const close = source.indexOf(']', cursor + 1);
      const token = source.slice(cursor + 1, close < 0 ? undefined : close);
      // After at least one real timestamp, non-numeric bracketed text belongs
      // to the lyric (for example "[00:01][Chorus]"). Numeric bracketed text
      // is still parsed strictly so a malformed extra timestamp cannot hide.
      if (leading.length > 0 && !/^[+-]?\s*\d/.test(token)) break;
      if (close < 0) {
        issues.add(lineNumber, 'LRC_MALFORMED_TIMESTAMP', 'line timestamp is missing its closing ]');
        malformedLeading = true;
        break;
      }
      const parsed = timestampMilliseconds(token);
      if (!parsed.ok) {
        issues.add(
          lineNumber,
          parsed.reason === 'range' ? 'LRC_TIME_RANGE' : 'LRC_MALFORMED_TIMESTAMP',
          parsed.reason === 'range'
            ? `line timestamp must be between 0 and ${LRC_LIMITS.maxSeconds} seconds`
            : `malformed line timestamp [${token}]`,
        );
        malformedLeading = true;
        break;
      }
      const adjusted = adjustTimestamp(parsed, offsetMilliseconds, lineNumber, issues);
      if (adjusted) leading.push(adjusted);
      if (leading.length > LRC_LIMITS.leadingTimestamps) {
        issues.add(
          lineNumber,
          'LRC_TOO_MANY_LEADING_TIMESTAMPS',
          `line has more than ${LRC_LIMITS.leadingTimestamps} leading timestamps`,
        );
      }
      cursor = close + 1;
    }
    if (malformedLeading) continue;
    if (!leading.length) {
      issues.add(lineNumber, 'LRC_UNTIMED_LINE', 'plain lyric line has no leading timestamp');
      continue;
    }

    for (let stampIndex = 1; stampIndex < leading.length; stampIndex += 1) {
      if (leading[stampIndex].milliseconds === leading[stampIndex - 1].milliseconds) {
        issues.add(lineNumber, 'LRC_DUPLICATE_TIMESTAMP', 'duplicate leading timestamp');
      } else if (leading[stampIndex].milliseconds < leading[stampIndex - 1].milliseconds) {
        issues.add(lineNumber, 'LRC_NONMONOTONIC_TIMESTAMP', 'leading timestamps on a line must be strictly increasing');
      }
    }

    const content = source.slice(cursor);
    const enhanced = parseEnhanced(content, leading[0], offsetMilliseconds, lineNumber, issues);
    if (enhanced.enhanced && leading.length > 1) {
      issues.add(
        lineNumber,
        'LRC_ENHANCED_MULTIPLE_LEADING',
        'an enhanced LRC line may have only one leading timestamp',
      );
    }
    if (enhanced.text.length > LRC_LIMITS.cueChars) {
      issues.add(lineNumber, 'LRC_CUE_TOO_LONG', `lyric cue exceeds ${LRC_LIMITS.cueChars} characters`);
    }

    for (let expansionIndex = 0; expansionIndex < leading.length; expansionIndex += 1) {
      if (cues.length >= LRC_LIMITS.cues) {
        if (!tooManyCuesReported) {
          issues.add(lineNumber, 'LRC_TOO_MANY_CUES', `LRC input expands to more than ${LRC_LIMITS.cues} cues`);
          tooManyCuesReported = true;
        }
        continue;
      }
      cues.push({
        startSeconds: leading[expansionIndex].milliseconds / 1000,
        text: enhanced.text,
        ...(enhanced.words ? { words: enhanced.words.map(word => ({ ...word })) } : {}),
        sourceLine: lineNumber,
        expansionIndex,
      });
    }
  }

  cues.sort((a, b) => a.startSeconds - b.startSeconds || a.sourceLine - b.sourceLine || a.expansionIndex - b.expansionIndex);
  for (let index = 1; index < cues.length && !issues.full; index += 1) {
    if (cues[index].startSeconds === cues[index - 1].startSeconds) {
      issues.add(cues[index].sourceLine, 'LRC_DUPLICATE_TIMESTAMP', 'duplicate expanded cue start');
    }
  }
  issues.throwIfAny();
  return cues.map(({ sourceLine: _sourceLine, expansionIndex: _expansionIndex, ...cue }) => cue);
}

/** Conventional all-caps spelling, for callers that prefer the file-format name. */
export const parseLRC = parseLrc;
