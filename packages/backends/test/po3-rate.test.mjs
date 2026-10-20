// PO-3: one rate and one deadline formula. The 8.9 units/hour figure was copied into worker admission,
// the media watchdog, the wall-clock cap, the Qwen watchdog and two defaults, so changing it for a
// different account rate meant finding six literals. These tests pin the precedence and the arithmetic
// (including what the old formulas produced) rather than the literal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RATE_PER_HOUR, TEARDOWN_RESERVE_UNITS, resolveRatePerHour, spendingMinutes } from '../src/budget.mjs';

test('the rate is configurable and the default stays the pessimistic measured one', () => {
  assert.equal(DEFAULT_RATE_PER_HOUR, 8.9);
  assert.equal(resolveRatePerHour({ env: {} }), 8.9);
  assert.equal(resolveRatePerHour({ env: { COMFYRIZZ_COLAB_RATE_PER_HOUR: '12.5' } }), 12.5);
  // An explicit option beats the environment, which beats a measured rate, which beats the default.
  assert.equal(resolveRatePerHour({ explicit: 4, env: { COMFYRIZZ_COLAB_RATE_PER_HOUR: '12.5' } }), 4);
  assert.equal(resolveRatePerHour({ measured: 6, env: { COMFYRIZZ_COLAB_RATE_PER_HOUR: '12.5' } }), 12.5);
  assert.equal(resolveRatePerHour({ measured: 6, env: {} }), 6);
  assert.equal(resolveRatePerHour({ explicit: null, measured: null, env: {} }), 8.9);
});

test('an unusable rate is refused instead of becoming NaN in a spend calculation', () => {
  for (const value of ['abc', '0', '-2']) {
    assert.throws(() => resolveRatePerHour({ env: { COMFYRIZZ_COLAB_RATE_PER_HOUR: value } }), /positive number/, value);
  }
  assert.throws(() => resolveRatePerHour({ explicit: Number.NaN, env: {} }), /positive number/);
  // An empty variable means "not set", which is a fallback, not an error.
  assert.equal(resolveRatePerHour({ env: { COMFYRIZZ_COLAB_RATE_PER_HOUR: '' } }), DEFAULT_RATE_PER_HOUR);
});

test('a deadline buys the units minus teardown headroom, and keeps the old Qwen formula', () => {
  // The reserve Qwen has always used: (units - 0.3) / rate * 60, floored, never below a minute.
  for (const units of [0.5, 1, 2, 4]) {
    assert.equal(spendingMinutes(units, 8.9), Math.max(1, Math.floor(((units - TEARDOWN_RESERVE_UNITS) / 8.9) * 60)), `units ${units}`);
  }
  assert.equal(spendingMinutes(4, 8.9), 24);
  // The media path used to divide the whole ceiling by the rate, which left nothing for collect-and-stop.
  assert.ok(spendingMinutes(5, 8.9) < Math.floor((5 / 8.9) * 60));
  assert.equal(spendingMinutes(5, 8.9), 31);
});

test('a budget smaller than the reserve is still bounded by the one-minute floor', () => {
  assert.equal(spendingMinutes(0.3, 8.9), 1);
  assert.equal(spendingMinutes(0.1, 8.9), 1);
  assert.equal(spendingMinutes(0, 8.9), 1);
  assert.equal(spendingMinutes(-4, 8.9), 1);
  assert.equal(spendingMinutes(5, 0), 1);
  assert.equal(spendingMinutes(5, Number.NaN), 1);
  // A different rate moves the deadline with it; nothing is divided by the old literal.
  assert.equal(spendingMinutes(5, 12.5), Math.floor(((5 - 0.3) / 12.5) * 60));
});
