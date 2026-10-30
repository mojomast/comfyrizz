// RW11: keyframe staleness, the still-regeneration dependency closure.
//
// The known failure: a chat edit changed a shot prompt, the approval plan still
// covered only the video shot, and LTX re-animated the old Klein keyframe. The
// still inputs are now compared explicitly, a stale plan grows the missing
// "regen still -> review -> video" steps with one combined estimate, and a
// video job carrying a stale keyframe sha is refused.
//
// Pure: no network, clock or disk. The estimator is injected by the caller.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  keyframeStaleness,
  planWithKeyframes,
  refuseStaleVideo,
} from '../../src/productions/keyframe-staleness.mjs';

const SHA_CURRENT = 'a'.repeat(64);
const SHA_STALE = 'b'.repeat(64);

function stillInputs(overrides = {}) {
  return {
    prompt: 'Mara in a yellow coat on a calm blue ocean at dusk',
    refs: ['ref_hero', 'ref_boat'],
    characters: [{ characterId: 'chr_mara', identityLock: 'Mara, 30s, red hair', wardrobeState: 'yellow coat' }],
    wardrobe: { chr_mara: 'yellow coat' },
    seed: 4417,
    ...overrides,
  };
}

function videoPlan(overrides = {}) {
  return {
    productionId: 'prod_incident',
    steps: [
      {
        id: 'video_s4',
        kind: 'video',
        shotId: 's4',
        keyframeSha256: SHA_CURRENT,
        estimate: 5,
      },
    ],
    estimate: { units: 5, label: 'estimate' },
    ...overrides,
  };
}

function scriptedEstimator(byKind = { still: 2, review: 1 }) {
  const calls = [];
  const estimateStep = (step) => {
    calls.push(step);
    return { units: byKind[step.kind] ?? 0, label: 'estimate' };
  };
  return { estimateStep, calls };
}

test('RW11: identical still inputs are fresh', () => {
  const result = keyframeStaleness({ before: stillInputs(), after: stillInputs() });

  assert.deepEqual(result, { stale: false, reasons: [] });
});

test('RW11: the incident prompt edit marks the keyframe stale', () => {
  const result = keyframeStaleness({
    before: stillInputs(),
    after: stillInputs({ prompt: 'Mara in a red coat on a stormy ocean at night' }),
  });

  assert.deepEqual(result, { stale: true, reasons: ['prompt'] });
});

test('RW11: every still input is compared, in a stable reason order', () => {
  const before = stillInputs();
  const after = stillInputs({
    seed: 9001,
    wardrobe: { chr_mara: 'red coat' },
    characters: [{ characterId: 'chr_mara', identityLock: 'Mara, 30s, red hair', wardrobeState: 'red coat' }],
    refs: ['ref_boat', 'ref_hero'],
    prompt: 'Mara in a red coat on a stormy ocean at night',
  });

  assert.deepEqual(keyframeStaleness({ before, after }), {
    stale: true,
    reasons: ['prompt', 'refs', 'characters', 'wardrobe', 'seed'],
  });
});

test('RW11: refs, characters, wardrobe and seed each mark a keyframe stale on their own', () => {
  const cases = [
    ['refs', { refs: ['ref_hero'] }],
    ['characters', { characters: [{ characterId: 'chr_mara', identityLock: 'Mara, 30s, red hair' }] }],
    ['wardrobe', { wardrobe: { chr_mara: 'red coat' } }],
    ['seed', { seed: 4418 }],
  ];

  for (const [reason, change] of cases) {
    assert.deepEqual(
      keyframeStaleness({ before: stillInputs(), after: stillInputs(change) }),
      { stale: true, reasons: [reason] },
      reason,
    );
  }
});

test('RW11: non-still fields do not mark a keyframe stale', () => {
  const before = { ...stillInputs(), durationSeconds: 6, cameraMove: 'slow push' };
  const after = { ...stillInputs(), durationSeconds: 9, cameraMove: 'crane up' };

  assert.deepEqual(keyframeStaleness({ before, after }), { stale: false, reasons: [] });
});

test('RW11: keyframeStaleness rejects missing before/after inputs', () => {
  assert.throws(() => keyframeStaleness({ after: stillInputs() }), /before/);
  assert.throws(() => keyframeStaleness({ before: stillInputs() }), /after/);
  assert.throws(() => keyframeStaleness({ before: null, after: stillInputs() }), /before/);
});

test('RW11: the incident plan grows regen still -> review -> video with a combined estimate', () => {
  const plan = videoPlan();
  const { estimateStep, calls } = scriptedEstimator();

  const planned = planWithKeyframes(
    plan,
    { s4: { stale: true, reasons: ['prompt'] } },
    { estimateStep },
  );

  assert.deepEqual(planned.steps.map((step) => step.kind), ['still', 'review', 'video']);
  assert.equal(planned.steps[0].action, 'regen');
  assert.equal(planned.steps[0].label, 'regen still');
  assert.equal(planned.steps[0].shotId, 's4');
  assert.deepEqual(planned.steps[0].reasons, ['prompt']);
  assert.equal(planned.steps[1].label, 'review');
  assert.equal(planned.steps[1].shotId, 's4');
  assert.equal(planned.steps[2].id, 'video_s4', 'the original video step is preserved last');

  assert.deepEqual(calls.map((step) => step.kind), ['still', 'review']);
  assert.equal(planned.estimate.label, 'estimate');
  assert.equal(planned.estimate.units, 8);
  assert.equal(planned.steps[0].estimate, 2);
  assert.equal(planned.steps[1].estimate, 1);
  assert.equal(plan.steps.length, 1, 'the caller plan is never mutated');
});

test('RW11: a fresh keyframe leaves the video-only plan unchanged', () => {
  const plan = videoPlan();
  const { estimateStep, calls } = scriptedEstimator();

  const planned = planWithKeyframes(
    plan,
    { s4: { stale: false, reasons: [] } },
    { estimateStep },
  );

  assert.deepEqual(planned.steps, plan.steps);
  assert.deepEqual(planned.estimate, plan.estimate);
  assert.equal(calls.length, 0);
});

test('RW11: only stale shots grow steps, ahead of their own video step', () => {
  const plan = {
    steps: [
      { id: 'video_s1', kind: 'video', shotId: 's1', estimate: 4 },
      { id: 'video_s2', kind: 'video', shotId: 's2', estimate: 4 },
    ],
    estimate: { units: 8, label: 'estimate' },
  };
  const { estimateStep, calls } = scriptedEstimator();

  const planned = planWithKeyframes(
    plan,
    {
      s1: { stale: false, reasons: [] },
      s2: { stale: true, reasons: ['wardrobe'] },
    },
    { estimateStep },
  );

  assert.deepEqual(
    planned.steps.map((step) => `${step.kind}:${step.shotId}`),
    ['video:s1', 'still:s2', 'review:s2', 'video:s2'],
  );
  assert.deepEqual(planned.steps[1].reasons, ['wardrobe']);
  assert.equal(planned.estimate.units, 11);
  assert.equal(calls.length, 2);
});

test('RW11: a plan that already has a regen still for the shot is not doubled', () => {
  const plan = {
    steps: [
      { id: 'regen_s4', kind: 'still', action: 'regen', shotId: 's4', estimate: 2 },
      { id: 'review_s4', kind: 'review', shotId: 's4', estimate: 1 },
      { id: 'video_s4', kind: 'video', shotId: 's4', estimate: 5 },
    ],
    estimate: { units: 8, label: 'estimate' },
  };
  const { estimateStep, calls } = scriptedEstimator();

  const planned = planWithKeyframes(
    plan,
    { s4: { stale: true, reasons: ['prompt'] } },
    { estimateStep },
  );

  assert.deepEqual(planned.steps.map((step) => step.kind), ['still', 'review', 'video']);
  assert.equal(calls.length, 0);
  assert.equal(planned.estimate.units, 8);
});

test('RW11: the estimator is required because the combined estimate is never invented', () => {
  assert.throws(
    () => planWithKeyframes(videoPlan(), { s4: { stale: true, reasons: ['prompt'] } }),
    /estimateStep/,
  );
});

test('RW11: a video job with a stale keyframe sha is refused', () => {
  const videoJob = { id: 'job_video_s4', shotId: 's4', keyframeSha256: SHA_STALE };
  const refusal = refuseStaleVideo({
    videoJob,
    keyframeSha256: SHA_STALE,
    currentKeyframeSha256: SHA_CURRENT,
  });

  assert.equal(refusal.refused, true);
  assert.equal(refusal.code, 'KEYFRAME_STALE');
  assert.equal(refusal.jobId, 'job_video_s4');
  assert.equal(refusal.keyframeSha256, SHA_STALE);
  assert.equal(refusal.currentKeyframeSha256, SHA_CURRENT);
  assert.match(refusal.message, /regenerate the still/i);
});

test('RW11: a video job whose keyframe sha is current is not refused', () => {
  const refusal = refuseStaleVideo({
    videoJob: { id: 'job_video_s4', shotId: 's4', keyframeSha256: SHA_CURRENT },
    keyframeSha256: SHA_CURRENT,
    currentKeyframeSha256: SHA_CURRENT,
  });

  assert.equal(refusal, null);
});

test('RW11: refuseStaleVideo rejects a missing sha instead of guessing', () => {
  assert.throws(
    () => refuseStaleVideo({ videoJob: { id: 'job_video_s4' }, keyframeSha256: undefined, currentKeyframeSha256: SHA_CURRENT }),
    /keyframeSha256/,
  );
  assert.throws(
    () => refuseStaleVideo({ videoJob: { id: 'job_video_s4' }, keyframeSha256: SHA_STALE, currentKeyframeSha256: undefined }),
    /currentKeyframeSha256/,
  );
});

test('RW11: a list of shot entries and a numeric estimator are accepted', () => {
  const plan = {
    steps: [
      { id: 'video_s4', kind: 'video', shotId: 's4', estimate: 5 },
      { id: 'video_s5', kind: 'video', shotId: 's5', estimate: 5 },
    ],
  };

  const planned = planWithKeyframes(
    plan,
    [{ shotId: 's5', stale: true, reasons: ['seed'] }],
    { estimateStep: (step) => (step.kind === 'still' ? 2 : 1) },
  );

  assert.deepEqual(
    planned.steps.map((step) => `${step.kind}:${step.shotId}`),
    ['video:s4', 'still:s5', 'review:s5', 'video:s5'],
  );
  assert.equal(planned.estimate.label, 'estimate');
  assert.equal(planned.estimate.units, 13);
});
