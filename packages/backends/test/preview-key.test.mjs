// Google Colab e2e 2026-10-30: regenerated stills keep their job id and were never re-reviewed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewKey } from '../src/colab-backend.mjs';

test('a regenerated still gets a new preview key; the same output keeps its key', () => {
  const first = { job: 'a_d2_still.still', outputs: [{ sha256: 'a'.repeat(64) }] };
  const regen = { job: 'a_d2_still.still', outputs: [{ sha256: 'b'.repeat(64) }] };
  assert.notEqual(previewKey(first), previewKey(regen));
  assert.equal(previewKey(first), previewKey({ ...first }));
});
