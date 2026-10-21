// PO-3 (REVIEW.md concern 3): the Colab rate was the literal 8.9 in six places and the media deadline
// spent the whole allocation, leaving nothing for teardown. These tests hold the pipeline to the three
// things the review asked for: one configurable rate, a deadline that reserves teardown headroom, and a
// ceiling checked before anything is allocated rather than after the balance delta proves it was spent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executePipeline } from '../src/pipeline-worker.mjs';
import { reserveUnitsFor, spendingMinutes } from '../../../packages/backends/src/budget.mjs';
import { fixture } from './pipeline-fixture.mjs';

const RATE_VARS = ['COMFYRIZZ_COLAB_RATE_PER_HOUR', 'COMFYRIZZ_COLAB_RATE_PER_HOUR_G4', 'COMFYRIZZ_COLAB_ALLOW_LOW_RATE'];
/** Clear every rate variable for the test, then put the environment back. */
function cleanRateEnv(t, values = {}) {
  const saved = Object.fromEntries(RATE_VARS.map(name => [name, process.env[name]]));
  for (const name of RATE_VARS) delete process.env[name];
  Object.assign(process.env, values);
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
}
const withUsage = (f, usage) => { const base = f.adapters.colabFactory; f.adapters.colabFactory = opts => { f.factoryCalls = [...(f.factoryCalls ?? []), opts]; return { ...base(), usage: async () => usage }; }; };

test('a per-gpu override prices admission and both media deadlines', async t => {
  cleanRateEnv(t, { COMFYRIZZ_COLAB_RATE_PER_HOUR_G4: '12.5' });
  const f = fixture(t);
  withUsage(f, { balance: 100, ratePerHour: 0 });
  assert.equal(await executePipeline(f.spec, f.adapters), 0, JSON.stringify(f.events.at(-1)));
  const seen = f.factoryCalls.at(-1);
  assert.equal(seen.ratePerHour, 12.5, 'the worker must pass the configured rate to the backend');
  assert.equal(seen.gpu, 'G4');
  // mediaCeilingUnits is 5 in the fixture, so the deadline is what 5 units buy minus the 6-minute reserve.
  const expected = spendingMinutes(5, 12.5, { reserveUnits: reserveUnitsFor(12.5) });
  assert.equal(seen.watchdogMinutes, expected);
  assert.equal(seen.wallClockCapMinutes, expected);
  assert.ok(expected < Math.floor((5 / 12.5) * 60), `${expected} should reserve teardown headroom`);
  const plan = f.events.find(event => event.detail?.event === 'media_plan');
  assert.equal(plan.detail.spend.ratePerHour, 12.5);
  assert.equal(plan.detail.spend.rateSource, 'configured');
  assert.equal(plan.detail.spend.deadlineMinutes, expected);
  assert.equal(plan.detail.spend.reserveUnits, reserveUnitsFor(12.5));
  assert.equal(plan.detail.admission.reserve, reserveUnitsFor(12.5), 'admission and deadline use the same reserve');
});

// PO-3 review (BLOCKER 5): pre-allocation `colab usage` is the account's *existing* burn. 0.00/h used to
// throw and a CPU session's ~0.08/h priced a G4 run at 0.08/h. The price is max(table for the gpu, measured).
for (const [label, measured] of [['an idle account (0.00/h)', 0], ['a running CPU session (0.08/h)', 0.08], ['no reported rate', undefined]]) {
  test(`with ${label} a G4 run is priced at the G4 table rate`, async t => {
    cleanRateEnv(t);
    const f = fixture(t);
    withUsage(f, { balance: 100, ...(measured === undefined ? {} : { ratePerHour: measured }) });
    assert.equal(await executePipeline(f.spec, f.adapters), 0, JSON.stringify(f.events.at(-1)));
    const ceilingEvent = f.events.find(event => event.detail?.event === 'media_spend_ceiling');
    assert.equal(ceilingEvent.detail.ratePerHour, 8.9);
    assert.equal(ceilingEvent.detail.rateSource, 'table');
    assert.equal(f.factoryCalls.at(-1).ratePerHour, 8.9);
  });
}

test('a measured rate above the table raises the price, the deadlines and the reserve', async t => {
  cleanRateEnv(t);
  const f = fixture(t);
  withUsage(f, { balance: 100, ratePerHour: 17.8 });
  assert.equal(await executePipeline(f.spec, f.adapters), 0, JSON.stringify(f.events.at(-1)));
  const ceilingEvent = f.events.find(event => event.detail?.event === 'media_spend_ceiling');
  assert.equal(ceilingEvent.detail.ratePerHour, 17.8);
  assert.equal(ceilingEvent.detail.rateSource, 'measured');
  assert.equal(ceilingEvent.detail.reserveUnits, reserveUnitsFor(17.8));
  const used = f.factoryCalls.at(-1);
  assert.equal(used.ratePerHour, 17.8, 'the backend that runs is the one priced at the higher rate');
  assert.equal(used.watchdogMinutes, spendingMinutes(5, 17.8));
});

// Balance check (re-review): the account's existing burn keeps draining, so the balance must cover
// planned + measured, while the run's own watchdog/caps use max(planned, measured).
test('the balance must cover the run at planned + measured, not just max()', async t => {
  cleanRateEnv(t);
  const f = fixture(t);
  withUsage(f, { balance: 3, ratePerHour: 17.8 });
  const base = f.adapters.colabFactory;
  f.adapters.colabFactory = opts => ({ ...base(opts), runPackage: async () => { f.calls.push('media'); throw new Error('must not be reached'); } });
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.ok(!f.calls.includes('media'));
  const ceilingEvent = f.events.find(event => event.detail?.event === 'media_spend_ceiling');
  assert.equal(ceilingEvent.detail.ratePerHour, 17.8, 'per-run rate stays max(planned, measured)');
  assert.equal(ceilingEvent.detail.balanceRatePerHour, 26.7, 'balance priced at planned + measured');
  assert.match(f.events.filter(event => event.kind === 'failed').at(-1)?.message ?? '', /26\.7 units\/h on G4 \(planned 8\.9 \+ the account's current 17\.8\)/);
});

test('a G4 override below the table rate is refused unless explicitly allowed', async t => {
  cleanRateEnv(t, { COMFYRIZZ_COLAB_RATE_PER_HOUR_G4: '0.08' });
  const f = fixture(t);
  withUsage(f, { balance: 100 });
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.match(f.events.filter(event => event.kind === 'failed').at(-1)?.message ?? '', /below its measured 8.9/);
});

// PO-3 review (BLOCKER 6): a balance that could not be read used to skip the check and allocate anyway.
for (const balance of [null, undefined, Number.NaN, 'n/a']) {
  test(`an unreadable balance (${String(balance)}) refuses the run before anything is allocated`, async t => {
    cleanRateEnv(t);
    const f = fixture(t);
    withUsage(f, { balance });
    const runPackage = f.adapters.colabFactory;
    f.adapters.colabFactory = opts => ({ ...runPackage(opts), runPackage: async () => { f.calls.push('media'); throw new Error('must not be reached'); } });
    assert.equal(await executePipeline(f.spec, f.adapters), 1);
    assert.ok(!f.calls.includes('media'));
    assert.match(f.events.filter(event => event.kind === 'failed').at(-1)?.message ?? '', /balance could not be read.*Nothing was allocated/);
  });
}

test('an account that cannot cover the run and its teardown is refused before anything is allocated', async t => {
  cleanRateEnv(t);
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
  assert.match(failure?.message ?? '', /includes the 0\.89-unit collect-and-stop reserve \(6 min at 8\.9 units\/h\)/);
});

test('a balance that covers the estimate still runs, so the guard is not a blanket refusal', async t => {
  cleanRateEnv(t);
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
