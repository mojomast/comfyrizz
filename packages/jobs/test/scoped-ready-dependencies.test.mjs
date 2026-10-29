import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planJobs } from '../src/index.mjs';

test('regenerating a ready plate reuses its ready still, but exposes pending dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../schema/fixtures/valid/variants.json', import.meta.url)));
  const ready = planJobs(pkg, { assets: ['a_plate1'], includeReady: true });
  assert.ok(ready.jobs.some(job => job.asset === 'a_plate1'));
  assert.ok(ready.jobs.every(job => job.asset === 'a_plate1'));
  pkg.assets.a_plate1_still.status = 'pending';
  const pending = planJobs(pkg, { assets: ['a_plate1'], includeReady: true });
  assert.ok(pending.jobs.some(job => job.asset === 'a_plate1_still'));
});
