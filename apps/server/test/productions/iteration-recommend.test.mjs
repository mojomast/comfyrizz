// IL07: recommendation of an iteration level from length, shots, characters
// and cap. Pure; no backend, no clock, no network, no Google Colab.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ITERATION_PRESETS, validateIterationPolicy } from '../../src/productions/iteration.mjs';
import { estimateIteration } from '../../src/productions/iteration-estimate.mjs';
import { recommendIteration } from '../../src/productions/iteration-recommend.mjs';

function clone(value) {
  return structuredClone(value);
}

function policy(level, overrides = {}) {
  const base = clone(ITERATION_PRESETS[level]);
  return validateIterationPolicy({ ...base, ...overrides, shotOverrides: overrides.shotOverrides ?? {} });
}

function fakeEstimate(policy) {
  const base = { draft: 1, balanced: 4, director: 8, custom: 5 }[policy.level] ?? 5;
  const auditions = policy.stages.voice.auditions;
  return { units: { high: base + auditions } };
}

function input(overrides = {}) {
  return {
    durationSeconds: 60,
    shotCount: 5,
    characterCount: 2,
    newCharacterCount: 0,
    ceiling: null,
    userDefault: null,
    estimate: fakeEstimate,
    ...overrides,
  };
}

const cases = [
  { name: 'boundary 90s (not long) -> balanced', durationSeconds: 90, shotCount: 2, expectedLevel: 'balanced', expectedAuditions: 2, reason: 'no history: balanced' },
  { name: 'boundary 90.5s (long) -> balanced', durationSeconds: 90.5, shotCount: 2, expectedLevel: 'balanced', expectedAuditions: 2, reason: 'no history: balanced' },
  { name: 'boundary 11 shots -> balanced', durationSeconds: 10, shotCount: 11, expectedLevel: 'balanced', expectedAuditions: 2, reason: 'no history: balanced' },
  { name: 'boundary 12 shots (long) -> balanced', durationSeconds: 10, shotCount: 12, expectedLevel: 'balanced', expectedAuditions: 2, reason: 'no history: balanced' },
  { name: 'boundary 19.5s (short) -> director', durationSeconds: 19.5, shotCount: 2, expectedLevel: 'director', expectedAuditions: 3, reason: 'director' },
  { name: 'boundary 20s (middle) -> balanced', durationSeconds: 20, shotCount: 2, expectedLevel: 'balanced', expectedAuditions: 2, reason: 'no history: balanced' },
  { name: 'boundary 3 shots (short) -> director', durationSeconds: 10, shotCount: 3, expectedLevel: 'director', expectedAuditions: 3, reason: 'director' },
  { name: 'boundary 4 shots (middle) -> balanced', durationSeconds: 10, shotCount: 4, expectedLevel: 'balanced', expectedAuditions: 2, reason: 'no history: balanced' },
  { name: 'long -> balanced', durationSeconds: 120, shotCount: 5, expectedLevel: 'balanced', expectedAuditions: 2, reason: 'no history: balanced' },
  { name: 'long + cap -> draft', durationSeconds: 120, shotCount: 5, ceiling: 2, expectedLevel: 'draft', expectedAuditions: 0, reason: 'exceeds the cap' },
  { name: 'short -> director', durationSeconds: 10, shotCount: 2, expectedLevel: 'director', expectedAuditions: 3, reason: 'director' },
  { name: 'short + cap -> balanced', durationSeconds: 10, shotCount: 2, ceiling: 6, expectedLevel: 'balanced', expectedAuditions: 2, reason: 'exceeds the cap' },
  { name: 'short + tight cap -> draft', durationSeconds: 10, shotCount: 2, ceiling: 2, expectedLevel: 'draft', expectedAuditions: 0, reason: 'exceeds the cap' },
  { name: 'middle -> balanced', durationSeconds: 60, shotCount: 5, expectedLevel: 'balanced', expectedAuditions: 2, reason: 'no history: balanced' },
  { name: 'userDefault fits', userDefault: policy('balanced'), ceiling: 10, expectedLevel: 'balanced', expectedAuditions: 2, reason: 'using your saved default' },
  { name: 'userDefault exceeds -> fallback', userDefault: policy('director'), ceiling: 2, expectedLevel: 'draft', expectedAuditions: 0, reason: 'your saved default exceeds the cap' },
  { name: 'new characters on draft -> custom with auditions', userDefault: policy('draft'), newCharacterCount: 2, expectedLevel: 'custom', expectedAuditions: 2, reason: 'voice auditions on for 2 new character(s)' },
  { name: 'auditions push over cap -> plain draft', userDefault: policy('draft'), newCharacterCount: 1, ceiling: 1, expectedLevel: 'draft', expectedAuditions: 0, reason: 'voice auditions would exceed the cap' },
  { name: 'nothing fits -> draft', durationSeconds: 120, shotCount: 5, ceiling: 0, expectedLevel: 'draft', expectedAuditions: 0, reason: 'no level fits the cap' },
];

for (const c of cases) {
  test(c.name, () => {
    const overrides = {};
    if (c.durationSeconds !== undefined) overrides.durationSeconds = c.durationSeconds;
    if (c.shotCount !== undefined) overrides.shotCount = c.shotCount;
    if (c.ceiling !== undefined) overrides.ceiling = c.ceiling;
    if (c.userDefault !== undefined) overrides.userDefault = c.userDefault;
    if (c.newCharacterCount !== undefined) overrides.newCharacterCount = c.newCharacterCount;
    const i = input(overrides);
    const result = recommendIteration(i);
    assert.equal(result.level, c.expectedLevel, `${c.name}: level`);
    assert.equal(result.policy.stages.voice.auditions, c.expectedAuditions, `${c.name}: auditions`);
    assert.ok(
      Array.isArray(result.reasons) && result.reasons.length > 0,
      `${c.name}: reasons non-empty`,
    );
    assert.ok(
      result.reasons.some((r) => String(r).includes(c.reason)),
      `${c.name}: reasons ${JSON.stringify(result.reasons)} should include ${c.reason}`,
    );
  });
}

test('uses the real default estimator when no estimate fn', () => {
  const result = recommendIteration({
    durationSeconds: 10,
    shotCount: 2,
    characterCount: 2,
    newCharacterCount: 0,
    ceiling: 100,
  });
  assert.equal(result.level, 'director');
  assert.equal(result.policy.stages.voice.auditions, 3);
});

test('TypeError for numeric estimate', () => {
  assert.throws(
    () => recommendIteration(input({ estimate: 5 })),
    TypeError,
  );
});

test('TypeError for object estimate', () => {
  assert.throws(
    () => recommendIteration(input({ estimate: {} })),
    TypeError,
  );
});

test('TypeError for string userDefault', () => {
  assert.throws(
    () => recommendIteration(input({ userDefault: 'balanced' })),
    TypeError,
  );
});

test('TypeError for ceiling -1', () => {
  assert.throws(
    () => recommendIteration(input({ ceiling: -1 })),
    TypeError,
  );
});

test('input object and presets unchanged', () => {
  const i = input({ userDefault: policy('balanced'), newCharacterCount: 1 });
  const beforeInput = clone({ ...i, estimate: undefined });
  const beforePresets = clone(ITERATION_PRESETS);
  recommendIteration(i);
  assert.deepEqual({ ...i, estimate: undefined }, beforeInput);
  assert.deepEqual(ITERATION_PRESETS, beforePresets);
});

test('deterministic', () => {
  const i = input({ userDefault: policy('draft'), newCharacterCount: 1, ceiling: 5 });
  const a = recommendIteration(i);
  const b = recommendIteration(i);
  assert.deepEqual(a, b);
});
