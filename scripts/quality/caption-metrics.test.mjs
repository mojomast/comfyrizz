import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { captionMetrics } from './caption-metrics.mjs';

const fix = JSON.parse(readFileSync(new URL('./fixtures/captions.json', import.meta.url), 'utf8'));

test('captionMetrics reproduces the 148-char cue and 28.70 cps cue', () => {
  const m = captionMetrics(fix.cues);
  assert.equal(m.maxChars, 148);
  assert.equal(m.maxCps, 28.7);
});

test('captionMetrics lists cues over 20 cps', () => {
  const m = captionMetrics(fix.cues);
  assert.ok(m.overCps.length >= 1);
  assert.ok(m.overCps.some((c) => c.cps > 20));
  const over20 = m.overCps.filter((c) => c.cps > 20);
  assert.ok(over20.some((c) => c.speaker === 'Nell' && Number(c.cps.toFixed(2)) === 28.7));
});

test('captionMetrics counts the speaker label in char count', () => {
  const m = captionMetrics(fix.cues);
  const ada = fix.cues[0];
  const full = 'Ada: ' + ada.text;
  assert.equal(full.length, 148);
  assert.equal(m.maxChars, 148);
});

test('captionMetrics returns count, medianChars, longestS', () => {
  const m = captionMetrics(fix.cues);
  assert.equal(m.count, 7);
  assert.equal(m.medianChars, 84);
  assert.equal(m.longestS, 8);
});

test('captionMetrics flags overLength cues beyond maxLine*maxLines', () => {
  const m = captionMetrics(fix.cues, { maxLine: 42, maxLines: 2 });
  assert.ok(m.overLength.length >= 1);
  assert.ok(m.overLength.some((c) => c.chars > 84));
});

test('captionMetrics uses defaults and handles empty input', () => {
  const m = captionMetrics([]);
  assert.equal(m.count, 0);
  assert.equal(m.maxChars, 0);
  assert.equal(m.maxCps, 0);
  assert.equal(m.longestS, 0);
});
