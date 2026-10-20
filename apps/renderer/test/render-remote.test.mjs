import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteConcurrency } from '../scripts/render-remote-entry.mjs';

test('a Google Colab render uses the VM CPUs up to 8', () => {
  assert.equal(remoteConcurrency(2), 2);
  assert.equal(remoteConcurrency(16), 8);
  assert.equal(remoteConcurrency(0), 1);
  assert.equal(remoteConcurrency(Number.NaN), 1);
});
