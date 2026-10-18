// LP2: typing clock and layout lint. Pure functions, no Remotion and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHARS_PER_SECOND,
  caretVisible,
  codeExitStart,
  codeHoldSeconds,
  codeTimelineFrames,
  lintCodeScene,
  typedCount,
} from '../../../packages/schema/src/code-layout.mjs';

const SHORT = "export function hello() {\n  return 'ok';\n}\n";

test('frame 0 reveals no characters and the count is a pure function of the frame', () => {
  const rate = DEFAULT_CHARS_PER_SECOND;
  assert.equal(typedCount(0, 30, rate, SHORT.length), 0);
  assert.equal(typedCount(-4, 30, rate, SHORT.length), 0);
  const once = typedCount(30, 30, rate, SHORT.length);
  assert.equal(typedCount(30, 30, rate, SHORT.length), once);
  assert.equal(once, Math.min(SHORT.length, Math.floor(rate)));
  assert.equal(typedCount(10_000, 30, rate, SHORT.length), SHORT.length);
});

test('the caret blinks at 2.4 Hz as a function of the frame', () => {
  assert.equal(caretVisible(0, 30), true);
  assert.equal(caretVisible(6, 30), true);
  assert.equal(caretVisible(7, 30), false);
  assert.equal(caretVisible(7, 30), caretVisible(7, 30));
});

test('the hold is 1 s plus 0.25 s per word past three, and the exit waits for it', () => {
  assert.equal(codeHoldSeconds('one two three'), 1);
  assert.equal(codeHoldSeconds('one two three four'), 1.25);
  const source = 'alpha beta gamma delta';
  const rate = 20;
  const exit = codeExitStart(source, 30, rate);
  const typingFrames = (source.length / rate) * 30;
  assert.ok(exit >= typingFrames + 1.25 * 30);
  const frames = codeTimelineFrames(source, 30, rate);
  assert.ok(frames > exit);
});

test('a short snippet fits 16:9, 9:16 and 1:1', () => {
  assert.deepEqual(lintCodeScene(SHORT, 1920, 1080), []);
  assert.deepEqual(lintCodeScene(SHORT, 1080, 1920), []);
  assert.deepEqual(lintCodeScene(SHORT, 1080, 1080), []);
});

test('lint flags a line that only overflows once the frame is 360 px wide', () => {
  const line = 'x'.repeat(80);
  const findings = lintCodeScene(line, 1920, 1080);
  assert.ok(findings.some(item => item.code === 'CODE_LINE_TOO_LONG' && item.width === 360));
  assert.ok(findings.every(item => item.code === 'CODE_LINE_TOO_LONG'));
});

test('lint flags too many lines for the aspect', () => {
  const many = Array.from({ length: 40 }, () => 'const n = 1;').join('\n');
  const findings = lintCodeScene(many, 1920, 1080);
  assert.ok(findings.some(item => item.code === 'CODE_TOO_MANY_LINES' && item.width === 1920));
  assert.ok(findings.some(item => item.code === 'CODE_TOO_MANY_LINES' && item.width === 360));
});
