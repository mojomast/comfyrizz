import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LRC_LIMITS, LrcParseError, parseLRC, parseLrc } from '../src/index.js';
import { parseLrc as parseInBrowser } from '../src/browser.js';

function issues(input: string): LrcParseError {
  try {
    parseLrc(input);
  } catch (error) {
    assert.ok(error instanceof LrcParseError, String(error));
    return error;
  }
  assert.fail(`expected LRC input to be rejected: ${JSON.stringify(input.slice(0, 100))}`);
}

test('standard LRC expands leading timestamps, sorts lines, and preserves exact text', () => {
  const cues = parseLrc('\ufeff[ti:Exact text]\r[00:01][01:02.3]  [Chorus] <b>שלום</b>  \r\n[60:00.04]never');
  assert.deepEqual(cues, [
    { startSeconds: 1, text: '  [Chorus] <b>שלום</b>  ' },
    { startSeconds: 62.3, text: '  [Chorus] <b>שלום</b>  ' },
    { startSeconds: 3600.04, text: 'never' },
  ]);
  for (const cue of cues) {
    assert.equal('endSeconds' in cue, false, 'standard LRC must not fabricate an end');
    assert.equal('words' in cue, false, 'standard LRC must not fabricate word timing');
  }
});

test('optional hours, one-to-three fraction digits, CR/LF and metadata are supported', () => {
  assert.deepEqual(parseLrc('[ar:Artist]\n[01:02:03.004]hours\r[00:05.05]five\r\n[00:06]six'), [
    { startSeconds: 5.05, text: 'five' },
    { startSeconds: 6, text: 'six' },
    { startSeconds: 3723.004, text: 'hours' },
  ]);
});

test('enhanced LRC preserves literal segments and applies one signed offset exactly once', () => {
  const input = [
    '[offset:-100]',
    '[offset:-100]',
    '[00:01.100] <b>שָׁלוֹם</b> <00:01.100>Hello  <00:02.005>world!',
  ].join('\n');
  assert.deepEqual(parseLrc(input), [{
    startSeconds: 1,
    text: ' <b>שָׁלוֹם</b> Hello  world!',
    words: [
      { startSeconds: 1, text: 'Hello  ' },
      { startSeconds: 1.905, text: 'world!' },
    ],
  }]);
});

test('untimed enhanced prefix remains visible without receiving synthetic timing', () => {
  const [cue] = parseLrc('[00:01]untimed <i>markup</i> <00:01.25>timed');
  assert.equal(cue.text, 'untimed <i>markup</i> timed');
  assert.deepEqual(cue.words, [{ startSeconds: 1.25, text: 'timed' }]);
  assert.equal(cue.endSeconds, undefined);
});

test('browser and node entry points export the same parser', () => {
  const input = '[00:01]same';
  assert.deepEqual(parseInBrowser(input), parseLrc(input));
  assert.deepEqual(parseLRC(input), parseLrc(input));
});

test('malformed, signed, comma, over-precise and nonmonotonic timestamps are rejected', () => {
  const invalid = [
    'plain lyric',
    '[00:01.1234]too precise',
    '[00:01,5]comma',
    '[+00:01]signed',
    '[-00:01]signed',
    '[00:60]seconds',
    '[01:60:00]minutes',
    '[00:01][00:01]duplicate leading',
    '[00:02][00:01]decreasing leading',
    '[00:01]same\n[00:01]duplicate expanded',
    '[00:02]<00:02>a<00:02>b',
    '[00:02]<00:02>a<00:01>b',
    '[00:02]<00:01>before line',
    '[00:01]<00:01unterminated',
    '[00:01]literal <b unterminated',
    '[00:01]empty <> angle',
    '[00:01]<<00:01>>nested',
    '[1:02:03]single-digit hour',
    '[00:01][00:02]<00:01>enhanced expansion',
    '[00:01]nul\u0000character',
    '[00:01]tab\tcharacter',
    '[offset:100]\n[00:01]unsigned offset',
    '[offset:-1000]\n[00:00.500]negative after offset',
    '[offset:+100]\n[offset:-100]\n[00:01]conflict',
    '[600:00.001]above ten hours',
  ];
  for (const input of invalid) {
    const error = issues(input);
    assert.ok(error.errors.length > 0, input);
    assert.match(error.message, /line \d+:/, input);
  }
});

test('all parser resource and text bounds fail closed', () => {
  assert.equal(issues('x'.repeat(LRC_LIMITS.rawChars + 1)).errors[0].code, 'LRC_RAW_TOO_LONG');
  assert.equal(issues(Array.from({ length: LRC_LIMITS.cues + 1 }, (_, i) => `[${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}]x`).join('\n')).errors[0].code, 'LRC_TOO_MANY_CUES');
  assert.equal(issues(`${Array.from({ length: LRC_LIMITS.leadingTimestamps + 1 }, (_, i) => `[00:${String(i).padStart(2, '0')}]`).join('')}x`).errors[0].code, 'LRC_TOO_MANY_LEADING_TIMESTAMPS');
  assert.equal(issues('[00:01]' + 'x'.repeat(LRC_LIMITS.cueChars + 1)).errors[0].code, 'LRC_CUE_TOO_LONG');
  assert.equal(issues('[00:01]<00:01>' + 'x'.repeat(LRC_LIMITS.wordChars + 1)).errors[0].code, 'LRC_WORD_TOO_LONG');
  const manyWords = Array.from({ length: LRC_LIMITS.wordsPerCue + 1 }, (_, i) => `<${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}>x`).join('');
  assert.equal(issues(`[00:00]${manyWords}`).errors[0].code, 'LRC_TOO_MANY_WORDS');
});

test('diagnostics are bounded and every diagnostic is line numbered', () => {
  const error = issues(Array.from({ length: 100 }, () => 'untimed').join('\n'));
  assert.equal(error.errors.length, LRC_LIMITS.errors);
  assert.ok(error.errors.every((issue, index) => issue.line === index + 1));
});
