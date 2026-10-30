import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REF_POLICY_DEFAULTS,
  refRegenJobCap,
} from '../../../../packages/schema/src/ref-review.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { estimateIteration } from '../../src/productions/iteration-estimate.mjs';
import { estimateRegen } from '../../src/ref-watch/estimate.mjs';

const SHOT = Object.freeze({ id: 'shot-1', kind: 'still' });
const ITERATION = Object.freeze({ policy: ITERATION_PRESETS.balanced, gpu: 'G4', ceiling: null });

function decision(action, attempt = 0) {
  return { action, attempt, jobId: 'still_shot-1', reason: 'test' };
}

function expectedFor(iteration = ITERATION) {
  return estimateIteration({ ...iteration, shots: [{ ...SHOT, kind: 'still' }] });
}

test('reprompt gets an estimate labelled estimate', () => {
  const expected = expectedFor();
  const result = estimateRegen({
    decision: decision('reprompt'),
    shot: SHOT,
    regenJobsUsed: 0,
    stillCount: 8,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });

  assert.ok(result);
  assert.match(result.label, /estimate/);
  assert.equal(result.label, expected.labels.join('; '));
  assert.deepEqual(result.units, expected.units);
  assert.equal(result.blocked, false);
  assert.equal(typeof result.reason, 'string');
});

test('replace_ref gets an estimate labelled estimate', () => {
  const result = estimateRegen({
    decision: decision('replace_ref'),
    shot: SHOT,
    regenJobsUsed: 0,
    stillCount: 8,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });

  assert.ok(result);
  assert.match(result.label, /estimate/);
  assert.equal(result.blocked, false);
});

test('accept, escalate and override return null', () => {
  for (const action of ['accept', 'escalate', 'override']) {
    assert.equal(estimateRegen({
      decision: decision(action),
      shot: SHOT,
      regenJobsUsed: 0,
      stillCount: 8,
      policy: REF_POLICY_DEFAULTS,
      iteration: ITERATION,
    }), null, action);
  }
});

test('accept and escalate return null even when the caps are exhausted', () => {
  for (const action of ['accept', 'escalate', 'override']) {
    assert.equal(estimateRegen({
      decision: decision(action, REF_POLICY_DEFAULTS.maxRegensPerStill),
      shot: SHOT,
      regenJobsUsed: 99,
      stillCount: 8,
      policy: REF_POLICY_DEFAULTS,
      iteration: ITERATION,
    }), null, action);
  }
});

test('the result is never an approval', () => {
  const result = estimateRegen({
    decision: decision('reprompt'),
    shot: SHOT,
    regenJobsUsed: 0,
    stillCount: 8,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });

  const keys = Object.keys(result);
  assert.equal(keys.includes('approved'), false);
  assert.equal(keys.includes('approval'), false);
  assert.deepEqual(keys.sort(), ['blocked', 'label', 'reason', 'units']);
});

test('the per-still cap blocks at maxRegensPerStill attempts', () => {
  const blocked = estimateRegen({
    decision: decision('reprompt', REF_POLICY_DEFAULTS.maxRegensPerStill),
    shot: SHOT,
    regenJobsUsed: 0,
    stillCount: 8,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /per-still/);

  const open = estimateRegen({
    decision: decision('reprompt', REF_POLICY_DEFAULTS.maxRegensPerStill - 1),
    shot: SHOT,
    regenJobsUsed: 0,
    stillCount: 8,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });
  assert.equal(open.blocked, false);
});

test('the production cap blocks when the next job would exceed refRegenJobCap', () => {
  const cap = refRegenJobCap(8, REF_POLICY_DEFAULTS);
  assert.equal(cap, 2);

  const open = estimateRegen({
    decision: decision('reprompt'),
    shot: SHOT,
    regenJobsUsed: cap - 1,
    stillCount: 8,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });
  assert.equal(open.blocked, false);

  const blocked = estimateRegen({
    decision: decision('reprompt'),
    shot: SHOT,
    regenJobsUsed: cap,
    stillCount: 8,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /production/);
});

test('both caps exhausted names both reasons', () => {
  const result = estimateRegen({
    decision: decision('reprompt', REF_POLICY_DEFAULTS.maxRegensPerStill),
    shot: SHOT,
    regenJobsUsed: refRegenJobCap(8, REF_POLICY_DEFAULTS),
    stillCount: 8,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /per-still/);
  assert.match(result.reason, /production/);
});

test('money appears only when pricePerUnit is given', () => {
  const plain = estimateRegen({
    decision: decision('reprompt'),
    shot: SHOT,
    regenJobsUsed: 0,
    stillCount: 8,
    policy: REF_POLICY_DEFAULTS,
    iteration: ITERATION,
  });
  assert.equal(Object.hasOwn(plain, 'money'), false);

  const pricedIteration = { ...ITERATION, pricePerUnit: 0.25 };
  const priced = estimateRegen({
    decision: decision('reprompt'),
    shot: SHOT,
    regenJobsUsed: 0,
    stillCount: 8,
    policy: REF_POLICY_DEFAULTS,
    iteration: pricedIteration,
  });
  assert.deepEqual(priced.money, expectedFor(pricedIteration).money);
  assert.ok(priced.money && priced.money.low <= priced.money.expected);
});

test('an unknown or missing action returns null', () => {
  for (const action of ['bogus', undefined]) {
    assert.equal(estimateRegen({
      decision: { action, attempt: 0 },
      shot: SHOT,
      regenJobsUsed: 0,
      stillCount: 8,
      policy: REF_POLICY_DEFAULTS,
      iteration: ITERATION,
    }), null);
  }
  assert.equal(estimateRegen(), null);
});
