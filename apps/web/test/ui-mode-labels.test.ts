// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE_BUTTON_LABELS,
  MODE_LABELS,
  MODE_LIVE_TEXT,
  MODE_SHORTCUT,
} from '../src/ui/mode.ts';

test('the mode labels name the studio and the editor exactly', () => {
  assert.deepEqual({ ...MODE_LABELS }, { easy: 'Studio', advanced: 'Editor' });
  assert.equal(MODE_LABELS.easy, 'Studio');
  assert.equal(MODE_LABELS.advanced, 'Editor');
});

test('the toggle button labels name their destination exactly', () => {
  assert.deepEqual(
    { ...MODE_BUTTON_LABELS },
    { easy: 'Back to studio', advanced: 'Open in editor' },
  );
  assert.equal(MODE_BUTTON_LABELS.easy, 'Back to studio');
  assert.equal(MODE_BUTTON_LABELS.advanced, 'Open in editor');
});

test('the live text keeps the exact studio and editor wording', () => {
  assert.deepEqual(
    { ...MODE_LIVE_TEXT },
    {
      easy: 'Studio view.',
      advanced: 'Editor view. All controls are visible.',
    },
  );
  assert.equal(MODE_LIVE_TEXT.easy, 'Studio view.');
  assert.equal(MODE_LIVE_TEXT.advanced, 'Editor view. All controls are visible.');
});

test('the mode shortcut is unchanged', () => {
  assert.equal(MODE_SHORTCUT, 'Ctrl/Cmd+Shift+A');
});
