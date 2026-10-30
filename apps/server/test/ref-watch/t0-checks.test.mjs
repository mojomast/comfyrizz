import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REF_VERDICT_SCHEMA,
  validateRefVerdict,
} from '../../../../packages/schema/src/ref-review.mjs';
import { runT0Checks } from '../../src/ref-watch/t0-checks.mjs';

const SHA = 'a'.repeat(64);

function request(overrides = {}) {
  return {
    schema: 'comfyrizz.ref-review.request/v1',
    productionId: 'prod_1',
    runId: 'run_1',
    jobId: 'job_1',
    shotId: 'shot_1',
    prompt: 'a lighthouse at dusk',
    keyframeSha256: SHA,
    imagePath: 'refs/shot_1.png',
    width: 1280,
    height: 720,
    plannedWidth: 1280,
    plannedHeight: 720,
    attempt: 0,
    characters: [{ characterId: 'char_1', identityLock: 'lock_1' }],
    ...overrides,
  };
}

const GOOD_STATS = { mean: 128, stddev: 42 };
const GOOD_IDENTITY = async () => ({ cosine: 0.91, threshold: 0.75 });

const failedHard = verdict => verdict.checks.filter(check => check.pass === false && check.severity === 'hard');

function assertValid(verdict) {
  const result = validateRefVerdict(verdict);
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(verdict.schema, REF_VERDICT_SCHEMA);
  assert.equal(verdict.reviewer, 't0');
}

test('a planned, sharp still passes every check', async () => {
  const verdict = await runT0Checks(request(), { stats: GOOD_STATS, identity: GOOD_IDENTITY });
  assertValid(verdict);
  assert.equal(verdict.overall, 'pass');
  assert.equal(verdict.jobId, 'job_1');
  assert.equal(verdict.keyframeSha256, SHA);
  assert.deepEqual(verdict.fixHints, []);
  assert.equal(verdict.checks.length, 4);
  assert.ok(verdict.checks.every(check => check.pass === true));
  assert.deepEqual(failedHard(verdict), []);
  assert.ok(verdict.checks.some(check => check.dimension === 'technical' && /1280x720/.test(check.evidence)));
  assert.ok(verdict.checks.some(check => check.dimension === 'identity' && check.evidence === 'cosine 0.91 >= 0.75'));
});

test('a wrong aspect ratio fails the technical hard checks', async () => {
  const verdict = await runT0Checks(request({ width: 1024, height: 1024 }), {
    stats: GOOD_STATS,
    identity: GOOD_IDENTITY,
  });
  assertValid(verdict);
  assert.equal(verdict.overall, 'fail');
  const technical = failedHard(verdict).filter(check => check.dimension === 'technical');
  assert.equal(technical.length, 2);
  assert.ok(technical.some(check => /1024x1024/.test(check.evidence) && /1280x720/.test(check.evidence)));
  assert.ok(technical.some(check => /aspect/.test(check.evidence)));
  assert.ok(verdict.fixHints.length > 0);
});

test('an aspect that drifts just over one percent fails even when the pixels are sane', async () => {
  const verdict = await runT0Checks(request({ width: 1300, height: 720 }), {
    stats: GOOD_STATS,
    identity: GOOD_IDENTITY,
  });
  assertValid(verdict);
  assert.equal(verdict.overall, 'fail');
  const technical = failedHard(verdict).filter(check => check.dimension === 'technical');
  assert.equal(technical.length, 2);
  assert.ok(technical.some(check => /aspect/.test(check.evidence) && /1%/.test(check.evidence)));
});

test('an aspect that drifts within one percent only fails the dimension equality check', async () => {
  const verdict = await runT0Checks(request({ width: 1290, height: 720 }), {
    stats: GOOD_STATS,
    identity: GOOD_IDENTITY,
  });
  assertValid(verdict);
  assert.equal(verdict.overall, 'fail');
  const technical = failedHard(verdict).filter(check => check.dimension === 'technical');
  assert.equal(technical.length, 1);
  assert.ok(/1290x720/.test(technical[0].evidence));
  assert.ok(verdict.checks.some(check => check.dimension === 'technical' && check.pass && /aspect/.test(check.evidence)));
});

test('a flat grey still fails the blank-image hard check', async () => {
  const verdict = await runT0Checks(request(), {
    stats: { mean: 128, stddev: 0.5 },
    identity: GOOD_IDENTITY,
  });
  assertValid(verdict);
  assert.equal(verdict.overall, 'fail');
  const failed = failedHard(verdict);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].dimension, 'technical');
  assert.match(failed[0].evidence, /stddev 0\.50 < 4/);
});

test('missing pixel statistics fail closed', async () => {
  const verdict = await runT0Checks(request(), { identity: GOOD_IDENTITY });
  assertValid(verdict);
  assert.equal(verdict.overall, 'fail');
  const failed = failedHard(verdict);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].dimension, 'technical');
  assert.match(failed[0].evidence, /stats/);
});

test('a low identity cosine fails with readable evidence', async () => {
  const verdict = await runT0Checks(request(), {
    stats: GOOD_STATS,
    identity: async () => ({ cosine: 0.62, threshold: 0.75 }),
  });
  assertValid(verdict);
  assert.equal(verdict.overall, 'fail');
  const failed = failedHard(verdict);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].dimension, 'identity');
  assert.equal(failed[0].evidence, 'cosine 0.62 < 0.75');
  assert.ok(verdict.fixHints.some(hint => /identity lock/.test(hint)));
});

test('identity is optional and receives the request characters and still', async () => {
  const seen = [];
  const verdict = await runT0Checks(request(), {
    stats: GOOD_STATS,
    identity: async args => {
      seen.push(args);
      return { cosine: 0.88, threshold: 0.75 };
    },
  });
  assertValid(verdict);
  assert.equal(verdict.overall, 'pass');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    primary: [{ characterId: 'char_1', identityLock: 'lock_1' }],
    take: 'refs/shot_1.png',
  });

  const withoutIdentity = await runT0Checks(request(), { stats: GOOD_STATS });
  assertValid(withoutIdentity);
  assert.equal(withoutIdentity.overall, 'pass');
  assert.equal(withoutIdentity.checks.some(check => check.dimension === 'identity'), false);
});

test('every fixture verdict validates and never passes with a failed hard check', async () => {
  const cases = [
    { stats: GOOD_STATS, identity: GOOD_IDENTITY },
    { width: 1024, height: 1024 },
    { stats: { mean: 128, stddev: 0.5 } },
    { identity: async () => ({ cosine: 0.62, threshold: 0.75 }) },
  ];
  for (const options of cases) {
    const verdict = await runT0Checks(request(options), {
      stats: options.stats ?? GOOD_STATS,
      identity: options.identity ?? GOOD_IDENTITY,
    });
    assertValid(verdict);
    if (verdict.overall === 'pass') assert.deepEqual(failedHard(verdict), []);
    if (failedHard(verdict).length > 0) assert.equal(verdict.overall, 'fail');
  }
});
