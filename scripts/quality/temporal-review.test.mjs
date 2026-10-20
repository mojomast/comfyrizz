import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  reviewTake,
  formatClock,
  parseTime,
  FAILURE_CODES,
} from './temporal-review.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/leak-take.json', import.meta.url), 'utf8'),
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function basicObservation(t, overrides = {}) {
  return {
    t,
    bodyCount: 2,
    characters: ['nell', 'ada'],
    feetGrounded: true,
    scale: 1,
    propHolder: { leak_bucket: 'nell' },
    cameraMove: 'static',
    ...overrides,
  };
}

test('the leak fixture fails UNGROUNDED over 04:34-04:38', () => {
  const result = reviewTake(fixture.take, fixture.observations);

  assert.equal(result.status, 'failed');
  assert.equal(result.reviewedSamples, fixture.observations.length);

  const ungrounded = result.failures.filter((failure) => failure.code === FAILURE_CODES.UNGROUNDED);
  assert.equal(ungrounded.length, 1);
  assert.equal(ungrounded[0].startS, 4);
  assert.equal(ungrounded[0].endS, 8);
  assert.equal(ungrounded[0].startClock, '04:34');
  assert.equal(ungrounded[0].endClock, '04:38');
  assert.equal(ungrounded[0].filmStartS, 274);
  assert.equal(ungrounded[0].filmEndS, 278);
  assert.deepEqual(ungrounded[0].samples, [4, 6.5, 8]);
  assert.match(ungrounded[0].message, /04:34/);
  assert.match(ungrounded[0].message, /04:38/);

  assert.ok(result.failures.every((failure) => failure.code === FAILURE_CODES.UNGROUNDED));
});

test('the leak fixture marks 04:36.5 for inspection without making it a failure', () => {
  const result = reviewTake(fixture.take, fixture.observations);

  const peak = result.inspection.find((sample) => sample.clock === '04:36.5');
  assert.ok(peak);
  assert.ok(peak.reasons.includes('pixelDiff'));
  assert.ok(peak.reasons.includes('flowDiff'));
  assert.ok(result.failures.every((failure) => failure.code !== 'PIXEL_DIFF'));
});

test('a large pixel diff alone does not fail a reviewed take', () => {
  const take = { startS: 0, durationS: 8 };
  const observations = [
    basicObservation(0, { pixelDiff: 0.99, flowDiff: 0.99 }),
    basicObservation(2, { pixelDiff: 0.98, flowDiff: 0.97 }),
    basicObservation(4, { pixelDiff: 0.96, flowDiff: 0.95 }),
  ];

  const result = reviewTake(take, observations);

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.failures, []);
  assert.equal(result.inspection.length, 3);
  assert.ok(result.inspection.every((sample) => sample.signals.length === 2));
});

test('no observations is not_reviewed, never passed', () => {
  assert.equal(reviewTake({ durationS: 10 }, []).status, 'not_reviewed');
  assert.equal(reviewTake({ durationS: 10 }).status, 'not_reviewed');
  assert.equal(reviewTake({ durationS: 10 }, undefined).status, 'not_reviewed');
  assert.equal(reviewTake({ durationS: 10 }, [{}]).status, 'not_reviewed');
});

test('triage-only observations are not_reviewed', () => {
  const result = reviewTake({ durationS: 4 }, [{ t: 0, pixelDiff: 0.99 }]);

  assert.equal(result.status, 'not_reviewed');
  assert.deepEqual(result.failures, []);
  assert.equal(result.inspection.length, 1);
});

test('BODY_COUNT_CHANGE is reported between adjacent samples', () => {
  const result = reviewTake({ durationS: 4 }, [
    basicObservation(0, { bodyCount: 2 }),
    basicObservation(2, { bodyCount: 3 }),
  ]);

  assert.equal(result.status, 'failed');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, FAILURE_CODES.BODY_COUNT_CHANGE);
  assert.equal(result.failures[0].startClock, '00:00');
  assert.equal(result.failures[0].endClock, '00:02');
});

test('a declared body count is checked on a single sample', () => {
  const result = reviewTake({ durationS: 4, expectedBodyCount: 1 }, [
    basicObservation(1, { bodyCount: 2 }),
  ]);

  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, FAILURE_CODES.BODY_COUNT_CHANGE);
  assert.equal(result.failures[0].startClock, '00:01');
});

test('IDENTITY_CHANGE is reported when the visible cast changes', () => {
  const result = reviewTake({ durationS: 4 }, [
    basicObservation(0, { characters: ['nell', 'ada'] }),
    basicObservation(2, { characters: ['nell', 'reporter'] }),
  ]);

  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, FAILURE_CODES.IDENTITY_CHANGE);
  assert.match(result.failures[0].message, /entered: reporter/);
  assert.match(result.failures[0].message, /left: ada/);
});

test('SCALE_JUMP uses the configurable ratio and passes below it', () => {
  const observations = [
    basicObservation(0, { scale: 1 }),
    basicObservation(2, { scale: 1.3 }),
  ];

  const strict = reviewTake({ durationS: 4, thresholds: { scaleJumpRatio: 0.1 } }, observations);
  assert.equal(strict.status, 'failed');
  assert.equal(strict.failures.length, 1);
  assert.equal(strict.failures[0].code, FAILURE_CODES.SCALE_JUMP);
  assert.match(strict.failures[0].message, /10% limit/);

  const loose = reviewTake({ durationS: 4, thresholds: { scaleJumpRatio: 0.5 } }, observations);
  assert.equal(loose.status, 'passed');
  assert.deepEqual(loose.failures, []);
});

test('UNGROUNDED is licensed only by a covering action', () => {
  const observations = [
    basicObservation(2),
    basicObservation(4, { feetGrounded: false }),
    basicObservation(6, { feetGrounded: false }),
    basicObservation(8),
  ];

  const unlicensed = reviewTake({ durationS: 10 }, observations);
  assert.equal(unlicensed.failures.length, 1);
  assert.equal(unlicensed.failures[0].code, FAILURE_CODES.UNGROUNDED);
  assert.equal(unlicensed.failures[0].startClock, '00:04');
  assert.equal(unlicensed.failures[0].endClock, '00:06');

  const licensed = reviewTake(
    { durationS: 10, licensedActions: [{ kind: 'jump', startS: 3, endS: 7 }] },
    observations,
  );
  assert.equal(licensed.status, 'passed');
  assert.deepEqual(licensed.failures, []);
});

test('PROP_TELEPORT needs a licensed handoff', () => {
  const observations = [
    basicObservation(0, { propHolder: { sandwich_01: 'ada' } }),
    basicObservation(2, { propHolder: { sandwich_01: 'nell' } }),
  ];

  const teleported = reviewTake({ durationS: 4 }, observations);
  assert.equal(teleported.failures.length, 1);
  assert.equal(teleported.failures[0].code, FAILURE_CODES.PROP_TELEPORT);
  assert.match(teleported.failures[0].message, /sandwich_01/);

  const handed = reviewTake(
    {
      durationS: 4,
      licensedActions: [{ kind: 'handoff', prop: 'sandwich_01', startS: 0, endS: 2 }],
    },
    observations,
  );
  assert.equal(handed.status, 'passed');
  assert.deepEqual(handed.failures, []);
});

test('UNINTENDED_CAMERA is checked against the declared intent and allowances', () => {
  const observations = [
    basicObservation(0, { cameraMove: 'static' }),
    basicObservation(2, { cameraMove: 'push_in' }),
  ];

  const unintended = reviewTake({ durationS: 4, cameraIntent: 'static' }, observations);
  assert.equal(unintended.failures.length, 1);
  assert.equal(unintended.failures[0].code, FAILURE_CODES.UNINTENDED_CAMERA);
  assert.equal(unintended.failures[0].startClock, '00:02');
  assert.match(unintended.failures[0].message, /push_in/);

  const intended = reviewTake(
    { durationS: 4, cameraIntent: 'static', allowedCameraMoves: ['push_in'] },
    observations,
  );
  assert.equal(intended.status, 'passed');
  assert.deepEqual(intended.failures, []);
});

test('clock strings and film offsets are parsed for display timestamps', () => {
  const result = reviewTake({ startS: 270, durationS: 10 }, [
    { t: '00:04', bodyCount: 1, characters: ['nell'], feetGrounded: true },
    { t: '00:06.5', bodyCount: 2, characters: ['nell'], feetGrounded: true },
  ]);

  assert.equal(result.failures[0].code, FAILURE_CODES.BODY_COUNT_CHANGE);
  assert.equal(result.failures[0].startClock, '04:34');
  assert.equal(result.failures[0].endClock, '04:36.5');
});

test('formatClock and parseTime round-trip the review timestamps', () => {
  assert.equal(formatClock(274), '04:34');
  assert.equal(formatClock(276.5), '04:36.5');
  assert.equal(parseTime('04:36.5'), 276.5);
  assert.equal(parseTime(276.5), 276.5);
  assert.equal(parseTime('1:02:03.25'), 3723.25);
});

test('reviewTake does not mutate the take or observations', () => {
  const take = clone(fixture.take);
  const observations = clone(fixture.observations);
  const takeSnapshot = clone(take);
  const observationsSnapshot = clone(observations);

  reviewTake(take, observations);

  assert.deepEqual(take, takeSnapshot);
  assert.deepEqual(observations, observationsSnapshot);
});
