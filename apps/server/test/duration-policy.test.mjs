import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durationAcceptance, durationRangeText, durationWithinTarget } from '../src/duration-policy.mjs';

test('duration targets use bounded fifteen-percent tolerance', () => {
  assert.deepEqual(durationAcceptance(20), { targetSeconds: 20, toleranceSeconds: 3, minSeconds: 17, maxSeconds: 23 });
  assert.equal(durationRangeText(24), '20.40–27.60 seconds');
  assert.equal(durationAcceptance(6)?.toleranceSeconds, 2);
  assert.equal(durationAcceptance(120)?.toleranceSeconds, 6);
});

test('duration acceptance includes boundaries and rejects larger misses', () => {
  assert.equal(durationWithinTarget(18.533, 20), true);
  assert.equal(durationWithinTarget(17, 20), true);
  assert.equal(durationWithinTarget(23, 20), true);
  assert.equal(durationWithinTarget(16.99, 20), false);
  assert.equal(durationWithinTarget(23.01, 20), false);
  assert.equal(durationWithinTarget(30, null), true);
});
