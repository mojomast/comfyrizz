// PO-3 (review): the Google Colab rate is per accelerator, the planning rate is a floor that a measured
// account rate can only raise, and there is one teardown reserve derived from the rate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLAB_RATE_TABLE, COLLECT_AND_STOP_RESERVE_MINUTES, DEFAULT_RATE_PER_HOUR, assessBudget, rateForGpu, reserveUnitsFor, resolveRatePerHour, spendingMinutes } from '../src/budget.mjs';

test('the rate table is keyed by accelerator and sourced from repo measurements', () => {
  assert.equal(COLAB_RATE_TABLE.G4.ratePerHour, 8.9);
  assert.equal(COLAB_RATE_TABLE.CPU.ratePerHour, 0.08);
  assert.equal(COLAB_RATE_TABLE.L4.ratePerHour, 4.8, 'L4 is a conservative unmeasured figure');
  assert.match(COLAB_RATE_TABLE.L4.source, /unmeasured/);
  for (const gpu of ['G4', 'CPU']) assert.match(COLAB_RATE_TABLE[gpu].source, /docs\//);
  assert.equal(DEFAULT_RATE_PER_HOUR, 8.9);
  assert.equal(rateForGpu('G4', { env: {} }).ratePerHour, 8.9);
  assert.equal(rateForGpu('cpu', { env: {} }).ratePerHour, 0.08);
  assert.equal(rateForGpu('G4', { env: {} }).origin, 'table');
});

test('overrides are per accelerator, and the legacy global variable only prices G4', () => {
  assert.equal(rateForGpu('G4', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR_G4: '12.5' } }).ratePerHour, 12.5);
  assert.equal(rateForGpu('G4', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR: '12.5' } }).ratePerHour, 12.5);
  assert.equal(rateForGpu('CPU', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR: '12.5' } }).ratePerHour, 0.08, 'a G4 override must not reprice CPU');
  assert.equal(rateForGpu('CPU', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR_CPU: '0.1' } }).ratePerHour, 0.1);
  assert.equal(rateForGpu('G4', { explicit: 10, env: { COMFYRIZZ_COLAB_RATE_PER_HOUR_G4: '12.5' } }).ratePerHour, 10);
  assert.equal(rateForGpu('H100', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR_H100: '15' } }).ratePerHour, 15);
});

test('an unpriced accelerator and a below-table override are refused unless deliberate', () => {
  assert.throws(() => rateForGpu('H100', { env: {} }), /COMFYRIZZ_COLAB_RATE_PER_HOUR_H100/);
  // an accelerator with no table entry may not be priced below the highest table rate (G4 8.9)
  assert.throws(() => rateForGpu('H100', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR_H100: '5' } }), /no measured rate.*below the highest table rate \(8\.9/);
  assert.equal(rateForGpu('H100', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR_H100: '5', COMFYRIZZ_COLAB_ALLOW_LOW_RATE: '1' } }).ratePerHour, 5);
  assert.equal(rateForGpu('H100', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR_H100: '8.9' } }).ratePerHour, 8.9);
  assert.throws(() => rateForGpu('G4', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR_G4: '4' } }), /below its measured 8.9.*COMFYRIZZ_COLAB_ALLOW_LOW_RATE=1/);
  assert.throws(() => rateForGpu('G4', { explicit: 0.08, env: {} }), /below its measured/);
  assert.equal(rateForGpu('G4', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR_G4: '4', COMFYRIZZ_COLAB_ALLOW_LOW_RATE: '1' } }).ratePerHour, 4);
  for (const value of ['abc', '0', '-1', 'NaN']) {
    assert.throws(() => rateForGpu('G4', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR_G4: value } }), /positive number/, value);
  }
  assert.equal(rateForGpu('G4', { env: { COMFYRIZZ_COLAB_RATE_PER_HOUR_G4: '' } }).ratePerHour, 8.9);
});

test('a measured pre-allocation rate can raise the price but never lower it', () => {
  assert.equal(resolveRatePerHour({ gpu: 'G4', measured: 0, env: {} }), 8.9, 'an idle account (0.00/h) must not price G4 at zero');
  assert.equal(resolveRatePerHour({ gpu: 'G4', measured: 0.08, env: {} }), 8.9, 'a CPU session must not price G4 at 0.08');
  assert.equal(resolveRatePerHour({ gpu: 'G4', measured: 17.8, env: {} }), 17.8, 'another live session raises the price');
  assert.equal(resolveRatePerHour({ gpu: 'G4', measured: null, env: {} }), 8.9);
  assert.equal(resolveRatePerHour({ gpu: 'CPU', measured: 0.05, env: {} }), 0.08);
});

test('one reserve: COLLECT_AND_STOP_RESERVE_MINUTES of the rate, in assessBudget and the deadline alike', () => {
  assert.equal(COLLECT_AND_STOP_RESERVE_MINUTES, 6);
  assert.equal(reserveUnitsFor(8.9), 0.89);
  assert.equal(reserveUnitsFor(0.08), 0.008);
  const admission = assessBudget({ budgetUnits: 5, nextJobUpperEstimate: 1, ratePerHour: 8.9 });
  assert.equal(admission.reserve, reserveUnitsFor(8.9));
  assert.equal(spendingMinutes(5, 8.9), Math.floor(((5 - 0.89) / 8.9) * 60));
  assert.equal(spendingMinutes(4, 8.9), 20);
  assert.ok(spendingMinutes(5, 8.9) < Math.floor((5 / 8.9) * 60));
  // a CPU ceiling is not eaten by a GPU-sized reserve
  assert.equal(spendingMinutes(1, 0.08), Math.floor(((1 - 0.008) / 0.08) * 60));
});

test('a too-small or invalid allocation still gets the 1-minute floor', () => {
  assert.equal(spendingMinutes(0.89, 8.9), 1);
  assert.equal(spendingMinutes(0, 8.9), 1);
  assert.equal(spendingMinutes(-4, 8.9), 1);
  assert.equal(spendingMinutes(5, 0), 1);
  assert.equal(spendingMinutes(5, Number.NaN), 1);
});
