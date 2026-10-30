import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  KLEIN_CAPTION_GUIDANCE,
  KLEIN_EDIT_GUIDANCE,
  LTX_SHOT_GUIDANCE,
  MODEL_NEGATIVE_GUIDANCE,
  MODEL_QUALITY_GUIDANCE,
  kleinPromptLint,
} from '../src/prompts/model-quality.js';

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
}

test('caption template carries the Kara-derived ordering, frame positions and word range', () => {
  for (const needle of [
    'medium and style first',
    'scene and setting',
    'lighting',
    'each subject',
    'colours',
    'materials',
    'frame-left',
    'frame-right',
    'foreground',
    'background',
    'upper third',
    'verbatim in double quotes',
    '100 to 350 words',
    'mood-only or abstract',
    'only what is visible',
  ]) {
    assert.ok(KLEIN_CAPTION_GUIDANCE.includes(needle), `caption guidance should include ${JSON.stringify(needle)}`);
  }
  assert.ok(MODEL_QUALITY_GUIDANCE.includes('100 to 350 words'));
});

test('edit template describes the finished frame with a keep-list and reference roles', () => {
  assert.ok(KLEIN_EDIT_GUIDANCE.includes('The final frame shows'));
  for (const needle of ['keep-list', 'pose', 'background', 'lighting', 'composition', '<ref_image_0>']) {
    assert.ok(KLEIN_EDIT_GUIDANCE.includes(needle), `edit guidance should include ${JSON.stringify(needle)}`);
  }
});

test('existing exports and guidance composition are preserved', () => {
  for (const value of [KLEIN_CAPTION_GUIDANCE, KLEIN_EDIT_GUIDANCE, MODEL_NEGATIVE_GUIDANCE, LTX_SHOT_GUIDANCE]) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0);
  }
  assert.equal(
    MODEL_QUALITY_GUIDANCE,
    [KLEIN_CAPTION_GUIDANCE, KLEIN_EDIT_GUIDANCE, MODEL_NEGATIVE_GUIDANCE, LTX_SHOT_GUIDANCE].join('\n'),
  );
});

test('kleinPromptLint flags word counts outside 100 to 350', () => {
  const short = kleinPromptLint(words(90));
  assert.ok(short.some((problem) => problem.includes('word count')), `90 words should be flagged: ${JSON.stringify(short)}`);
  const long = kleinPromptLint(words(351));
  assert.ok(long.some((problem) => problem.includes('word count')), `351 words should be flagged: ${JSON.stringify(long)}`);
  assert.deepEqual(kleinPromptLint(words(100)), []);
  assert.deepEqual(kleinPromptLint(words(350)), []);
});

test('kleinPromptLint passes a 120-word clean caption', () => {
  assert.deepEqual(kleinPromptLint(words(120)), []);
});

test('kleinPromptLint flags negative wording', () => {
  const problems = kleinPromptLint(`${words(119)} no blur`);
  assert.ok(problems.some((problem) => problem.includes('negative') && problem.includes('no')), JSON.stringify(problems));
  for (const negative of ['not', 'without', 'avoid', 'never']) {
    const flagged = kleinPromptLint(`${words(119)} ${negative} shadow`);
    assert.ok(flagged.some((problem) => problem.includes('negative')), `${negative} should be flagged: ${JSON.stringify(flagged)}`);
  }
});

test('kleinPromptLint requires an edit prompt to open with the finished-frame phrase', () => {
  const problems = kleinPromptLint(`${words(119)} change`, { edit: true });
  assert.ok(problems.some((problem) => problem.includes('The final frame shows')), JSON.stringify(problems));
  assert.deepEqual(kleinPromptLint(`The final frame shows ${words(117)}`, { edit: true }), []);
});

test('third-party licence file credits Kara under the MIT licence', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const licences = readFileSync(join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8');
  assert.match(licences, /Kara/);
  assert.match(licences, /MIT/);
  assert.match(licences, /Copyright \(c\) 2026 Greg Stern/);
  assert.match(licences, /text adapted, not code copied/i);
});
