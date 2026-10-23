// IL06: the iteration estimator.
//
// The estimate is pure planning maths. It reads the measured Google Colab
// constants from packages/backends read-only and never starts a backend, reads
// a clock or reaches the network. It reports a range because only the first
// round is known in advance and the account is shared with other sessions.
//
// D2/D3/D8: choosing a level is not a spend approval, money is shown only when
// the user supplied a price per unit, script drafts are free, keyframe
// auditions are stills, and a presenter clip is priced per video-second.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOOTSTRAP_OVERHEAD_MINUTES,
  COLLECT_AND_STOP_RESERVE_MINUTES,
  NEXT_JOB_MARGIN,
  WARN_FRACTION,
  rateForGpu,
} from '../../../../packages/backends/src/index.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { estimateIteration } from '../../src/productions/iteration-estimate.mjs';

const ROUND = (value) => Math.round(value * 1000) / 1000;

function policy(overrides = {}) {
  const base = structuredClone(ITERATION_PRESETS.balanced);
  base.level = 'custom';
  return { ...base, ...overrides, stages: { ...base.stages, ...(overrides.stages ?? {}) } };
}

function stage(overrides = {}) {
  return { takes: 1, rounds: 1, auditions: 0, pick: 'auto', ...overrides };
}

function presenter(seconds = 10, id = 'shot-1') {
  return { id, durationSeconds: seconds, kind: 'presenter' };
}

function input(overrides = {}) {
  return {
    policy: policy(),
    shots: [presenter()],
    characters: 2,
    gpu: 'G4',
    ceiling: null,
    ...overrides,
  };
}

function unitsFor(minutes, gpu = 'G4') {
  const rate = rateForGpu(gpu, { env: {} }).ratePerHour;
  return ROUND(((minutes + BOOTSTRAP_OVERHEAD_MINUTES) / 60) * rate);
}

test('the estimate is a labelled range with no cap and no money by default', () => {
  const result = estimateIteration(input());

  assert.deepEqual(Object.keys(result).sort(), ['gpuMinutes', 'labels', 'units', 'vsCap', 'wallMinutes']);

  for (const field of ['gpuMinutes', 'units', 'wallMinutes']) {
    assert.ok(result[field].low <= result[field].expected, `${field}.low <= expected`);
    assert.ok(result[field].expected <= result[field].high, `${field}.expected <= high`);
  }

  assert.equal(result.gpuMinutes.low, 1.55);
  assert.equal(result.gpuMinutes.expected, 1.55);
  assert.equal(result.gpuMinutes.high, ROUND(1.55 * NEXT_JOB_MARGIN + COLLECT_AND_STOP_RESERVE_MINUTES));
  assert.equal(result.wallMinutes.low, ROUND(1.55 + BOOTSTRAP_OVERHEAD_MINUTES));
  assert.equal(result.wallMinutes.expected, ROUND(1.55 + BOOTSTRAP_OVERHEAD_MINUTES));
  assert.equal(result.wallMinutes.high, ROUND(1.55 * NEXT_JOB_MARGIN + COLLECT_AND_STOP_RESERVE_MINUTES + BOOTSTRAP_OVERHEAD_MINUTES));
  assert.equal(result.units.low, unitsFor(1.55));
  assert.equal(result.units.expected, unitsFor(1.55));
  assert.equal(result.units.high, unitsFor(ROUND(1.55 * NEXT_JOB_MARGIN + COLLECT_AND_STOP_RESERVE_MINUTES)));

  assert.deepEqual(result.vsCap, { ceiling: null, fraction: null, status: 'no_cap' });
  assert.deepEqual(result.labels, ['estimate; other sessions may be running']);
  assert.equal(Object.hasOwn(result, 'money'), false);
  assert.equal(Object.hasOwn(result, 'suggestedLevel'), false);
});

test('low is the first round, expected is every round, and high adds the margin and reserve', () => {
  const result = estimateIteration(input({
    policy: policy({
      stages: {
        script: stage({ takes: 1, rounds: 1 }),
        voice: stage({ takes: 1, rounds: 1, linesPerVoice: 1 }),
        keyframe: stage({ takes: 1, rounds: 1, auditions: 2 }),
        video: stage({ takes: 2, rounds: 2 }),
      },
    }),
  }));

  assert.equal(result.gpuMinutes.low, 1.55);
  assert.equal(result.gpuMinutes.expected, 2.65);
  assert.equal(result.gpuMinutes.high, ROUND(2.65 * NEXT_JOB_MARGIN + COLLECT_AND_STOP_RESERVE_MINUTES));
  assert.ok(result.gpuMinutes.low < result.gpuMinutes.expected);
  assert.ok(result.gpuMinutes.expected < result.gpuMinutes.high);

  assert.equal(result.wallMinutes.low, ROUND(1.55 + BOOTSTRAP_OVERHEAD_MINUTES));
  assert.equal(result.wallMinutes.expected, ROUND(2.65 + BOOTSTRAP_OVERHEAD_MINUTES));
  assert.equal(result.wallMinutes.high, ROUND(result.gpuMinutes.high + BOOTSTRAP_OVERHEAD_MINUTES));

  assert.equal(result.units.low, unitsFor(1.55));
  assert.equal(result.units.expected, unitsFor(2.65));
  assert.equal(result.units.high, unitsFor(result.gpuMinutes.high));
});

test('script takes are free, presenter clips scale with video seconds, and keyframe auditions are stills', () => {
  const draft = structuredClone(ITERATION_PRESETS.draft);
  draft.level = 'custom';

  const tenSeconds = estimateIteration(input({ policy: draft, shots: [presenter(10)] }));
  const twentySeconds = estimateIteration(input({ policy: draft, shots: [presenter(20)] }));
  assert.equal(ROUND(twentySeconds.gpuMinutes.expected - tenSeconds.gpuMinutes.expected), 0.55);

  const noAuditions = estimateIteration(input({ policy: draft, shots: [presenter(10)] }));
  const auditionPolicy = structuredClone(ITERATION_PRESETS.draft);
  auditionPolicy.level = 'custom';
  auditionPolicy.stages.keyframe = stage({ auditions: 2 });
  const auditions = estimateIteration(input({ policy: auditionPolicy, shots: [presenter(10)] }));
  assert.equal(ROUND(auditions.gpuMinutes.expected - noAuditions.gpuMinutes.expected), 0.3);

  const oneDraft = estimateIteration(input({ policy: draft, shots: [presenter(10)] }));
  const manyDrafts = structuredClone(ITERATION_PRESETS.draft);
  manyDrafts.level = 'custom';
  manyDrafts.stages.script = stage({ takes: 4, rounds: 1 });
  const fourDrafts = estimateIteration(input({ policy: manyDrafts, shots: [presenter(10)] }));
  assert.equal(fourDrafts.gpuMinutes.expected, oneDraft.gpuMinutes.expected);
});

test('a shot override changes only that shot', () => {
  const shots = [presenter(10, 'shot-1'), presenter(10, 'shot-2')];
  const base = estimateIteration(input({ policy: policy({ stages: { ...structuredClone(ITERATION_PRESETS.balanced.stages), video: stage({ takes: 2 }) } }), shots }));
  const overridden = estimateIteration(input({
    policy: policy({
      stages: { ...structuredClone(ITERATION_PRESETS.balanced.stages), video: stage({ takes: 2 }) },
      shotOverrides: { 'shot-2': { stages: { video: { takes: 4 } } } },
    }),
    shots,
  }));

  assert.equal(ROUND(overridden.gpuMinutes.expected - base.gpuMinutes.expected), 1.1);
});

test('a cap is classified as fits, warn or exceeds, and only exceeds suggests a lower preset', () => {
  const shots = Array.from({ length: 10 }, (_, index) => presenter(10, `shot-${index + 1}`));
  const director = structuredClone(ITERATION_PRESETS.director);
  director.level = 'custom';
  const uncapped = estimateIteration(input({ policy: director, shots }));
  const expected = uncapped.units.expected;

  const fits = estimateIteration(input({ policy: director, shots, ceiling: ROUND(expected * 2) }));
  assert.equal(fits.vsCap.status, 'fits');
  assert.equal(Object.hasOwn(fits, 'suggestedLevel'), false);

  const warnCeiling = ROUND(expected * 1.05);
  const warn = estimateIteration(input({ policy: director, shots, ceiling: warnCeiling }));
  assert.equal(warn.vsCap.status, 'warn');
  assert.equal(warn.vsCap.ceiling, warnCeiling);
  assert.equal(warn.vsCap.fraction, ROUND(expected / warnCeiling));
  assert.ok(expected < warnCeiling);
  assert.ok(expected >= warnCeiling * WARN_FRACTION);

  const exceeds = estimateIteration(input({ policy: director, shots, ceiling: ROUND(expected * 0.9) }));
  assert.equal(exceeds.vsCap.status, 'exceeds');
  assert.equal(exceeds.vsCap.fraction, ROUND(expected / ROUND(expected * 0.9)));
  assert.equal(exceeds.suggestedLevel, 'balanced');

  const tooSmall = estimateIteration(input({ policy: director, shots, ceiling: 0.5 }));
  assert.equal(tooSmall.vsCap.status, 'exceeds');
  assert.equal(tooSmall.suggestedLevel, null);
});

test('money appears only when the user supplied a price per unit', () => {
  const plain = estimateIteration(input());
  assert.equal(Object.hasOwn(plain, 'money'), false);

  const priced = estimateIteration(input({ pricePerUnit: 0.25 }));
  assert.deepEqual(priced.money, {
    low: ROUND(plain.units.low * 0.25),
    expected: ROUND(plain.units.expected * 0.25),
    high: ROUND(plain.units.high * 0.25),
  });

  const free = estimateIteration(input({ pricePerUnit: 0 }));
  assert.deepEqual(free.money, { low: 0, expected: 0, high: 0 });
  assert.throws(() => estimateIteration(input({ pricePerUnit: -1 })), TypeError);
});

test('an L4 estimate is labelled unmeasured and priced at the L4 table rate', () => {
  const g4 = estimateIteration(input({ gpu: 'G4' }));
  const l4 = estimateIteration(input({ gpu: 'L4' }));

  assert.deepEqual(l4.labels, ['estimate; other sessions may be running', 'unmeasured estimate']);
  assert.equal(l4.units.expected, unitsFor(l4.gpuMinutes.expected, 'L4'));
  assert.ok(l4.units.expected < g4.units.expected);
});

test('the estimator does not mutate its input and is deterministic', () => {
  const options = input({ shots: [presenter(10), { id: 'shot-2', durationSeconds: 5, kind: 'plate' }] });
  Object.freeze(options.shots[0]);
  Object.freeze(options.shots);
  const before = JSON.stringify(options);
  const first = estimateIteration(options);
  const second = estimateIteration(options);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(options), before);
});
