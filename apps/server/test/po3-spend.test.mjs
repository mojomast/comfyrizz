// PO-3 (REVIEW.md concern 3): the Colab rate was the literal 8.9 in six places and the media deadline
// spent the whole allocation, leaving nothing for teardown. These tests hold the pipeline to the three
// things the review asked for: one configurable rate, a deadline that reserves teardown headroom, and a
// ceiling checked before anything is allocated rather than after the balance delta proves it was spent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executePipeline } from '../src/pipeline-worker.mjs';
import { spendingMinutes } from '../../../packages/backends/src/budget.mjs';
import { fixture } from './pipeline-fixture.mjs';

/** Run the pipeline with the rate from the environment, then put the environment back. */
async function withRate(t, rate, run) {
  const before = process.env.COMFYRIZZ_COLAB_RATE_PER_HOUR;
  process.env.COMFYRIZZ_COLAB_RATE_PER_HOUR = String(rate);
  t.after(() => { if (before === undefined) delete process.env.COMFYRIZZ_COLAB_RATE_PER_HOUR; else process.env.COMFYRIZZ_COLAB_RATE_PER_HOUR = before; });
  return run();
}

test('the configured rate prices admission and both media deadlines', async t => {
  const f = fixture(t), base = f.adapters.colabFactory, seen = {};
  // A factory that records what the worker asked for, then behaves like the fixture's stub.
  f.adapters.colabFactory = opts => { Object.assign(seen, opts); return base(); };
  await withRate(t, 12.5, () => executePipeline(f.spec, f.adapters));
  assert.equal(seen.ratePerHour, 12.5, 'the worker must pass the configured rate to the backend');
  // mediaCeilingUnits is 5 in the fixture, so the deadline is what 5 units buy minus the reserve.
  const expected = spendingMinutes(5, 12.5);
  assert.equal(seen.watchdogMinutes, expected);
  assert.equal(seen.wallClockCapMinutes, expected);
  // The deadline must be shorter than the naive ceiling/rate would allow, or teardown has no headroom.
  assert.ok(expected < Math.floor((5 / 12.5) * 60), `${expected} should reserve teardown headroom`);
  // And the decision is recorded in the event stream, so a run can be explained after the fact.
  const plan = f.events.find(event => event.detail?.event === 'media_plan');
  assert.equal(plan.detail.spend.ratePerHour, 12.5);
  assert.equal(plan.detail.spend.rateSource, 'configured');
  assert.equal(plan.detail.spend.deadlineMinutes, expected);
  const ceilingEvent = f.events.find(event => event.detail?.event === 'media_spend_ceiling');
  assert.equal(ceilingEvent.detail.ratePerHour, 12.5);
  assert.equal(ceilingEvent.detail.rateSource, 'configured');
});

test("without a pinned rate the account's own reported rate is what the ceiling is priced with", async t => {
  const f = fixture(t), before = process.env.COMFYRIZZ_COLAB_RATE_PER_HOUR;
  delete process.env.COMFYRIZZ_COLAB_RATE_PER_HOUR;
  t.after(() => { if (before !== undefined) process.env.COMFYRIZZ_COLAB_RATE_PER_HOUR = before; });
  const base = f.adapters.colabFactory;
  f.adapters.colabFactory = () => ({ ...base(), usage: async () => ({ balance: 100, ratePerHour: 12 }) });
  assert.equal(await executePipeline(f.spec, f.adapters), 0, JSON.stringify(f.events.at(-1)));
  const ceilingEvent = f.events.find(event => event.detail?.event === 'media_spend_ceiling');
  assert.equal(ceilingEvent.detail.ratePerHour, 12, 'the measured rate must win over the 8.9 default');
  assert.equal(ceilingEvent.detail.rateSource, 'measured');
  // The pre-allocation deadline still had to be planned before the account was read, so it is the default.
  assert.equal(f.events.find(event => event.detail?.event === 'media_plan').detail.spend.rateSource, 'default');
});

test('an account that cannot cover the run and its teardown is refused before anything is allocated', async t => {
  const f = fixture(t);
  f.adapters.colabFactory = () => ({
    preflight: async () => ({ ok: true, ready: true }),
    estimate: async () => ({ gpuMinutes: 1 }),
    // Enough to look plausible, far too little for the estimate plus the collect-and-stop reserve.
    usage: async () => ({ balance: 0.5 }),
    runPackage: async () => { f.calls.push('media'); throw new Error('must not be reached'); },
    teardown: async () => ({ state: 'stopped' }),
  });
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.ok(!f.calls.includes('media'), 'nothing may be allocated when the balance cannot cover the run');
  const failure = f.events.filter(event => event.kind === 'failed').at(-1);
  assert.match(failure?.message ?? '', /does not cover the estimated/);
  assert.match(failure?.message ?? '', /Nothing was allocated/);
  assert.match(failure?.message ?? '', /teardown reserve/);
});

test('a balance that covers the estimate still runs, so the guard is not a blanket refusal', async t => {
  const f = fixture(t);
  f.adapters.colabFactory = () => ({
    preflight: async () => ({ ok: true, ready: true }),
    estimate: async () => ({ gpuMinutes: 1 }),
    usage: async () => ({ balance: 50 }),
    runPackage: async () => {
      f.calls.push('media'); f.calls.push('stopped');
      return { ok: true, package: JSON.parse(readFileSync(join(f.spec.workDir, 'package.json'))), teardown: { state: 'stopped' } };
    },
    teardown: async () => { f.calls.push('cleanup'); return { state: 'stopped' }; },
  });
  // A funded account must run all the way through, so the ceiling is a ceiling and not a wall.
  assert.equal(await executePipeline(f.spec, f.adapters), 0, JSON.stringify(f.events.at(-1)));
  assert.ok(f.calls.includes('media'), JSON.stringify(f.calls));
  assert.ok(!f.events.some(event => /does not cover the estimated/.test(event.message ?? '')));
});
