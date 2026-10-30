import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runQwenColab } from '../../../scripts/tts/qwen_colab.mjs';
import { sessionNameFor } from '../../../packages/backends/src/colab-plan.mjs';
import { spendingMinutes, resolveRatePerHour } from '../../../packages/backends/src/budget.mjs';

function fixture(t, { before = 100, after = 90, teardown = null, allocateError = null, execOutput = 'COMFYRIZZ_OK qwen-narrate' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-accounting-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/data-story/package.json', import.meta.url)));
  pkg.voice = { enabled: true, engine: 'qwen3-tts', voice: 'fixture', strict: true };
  const packagePath = join(dir, 'package.json'), out = join(dir, 'out');
  writeFileSync(packagePath, JSON.stringify(pkg));
  const calls = [], events = [], options = [];
  let usageCalls = 0, allocationCalls = 0;
  const input = { packagePath, out, units: 2, runId: 'pipe_qwen_fixture', onEvent: event => events.push(event) };
  const adapters = {
    cliFactory: () => ({ run: async (args, limits) => {
      calls.push({ kind: args[0], args, limits });
      return { code: 0, output: args[0] === 'exec' ? execOutput : '' };
    } }),
    backendFactory: opts => {
      options.push(opts);
      return {
        usage: async () => { calls.push({ kind: 'usage' }); return { balance: ++usageCalls === 1 ? before : after }; },
        ensureUp: async ({ approved }) => {
          assert.equal(approved, true); allocationCalls++; calls.push({ kind: 'allocate' });
          if (allocateError) throw new Error(allocateError);
          return { session: sessionNameFor(`${pkg.id}_qwen`) };
        },
        teardown: async () => {
          calls.push({ kind: 'teardown' });
          return teardown ?? (allocationCalls ? { state: 'stopped', shutdownVerified: true }
            : { state: 'not_owned', allocation: 'not_attempted', shutdownVerified: true });
        },
      };
    },
  };
  return { input, adapters, calls, events, options,
    report: () => JSON.parse(readFileSync(join(out, 'run.json'))),
    run: (mode = 'invite-reserved') => runQwenColab({ ...input, accountingMode: mode }, adapters) };
}

test('hosted Qwen succeeds under overlapping account usage while retaining an unresolved CU hold', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.spent, null);
  assert.equal(result.accountBalanceDeltaUnits, 10);
  assert.equal(result.accounting.status, 'unresolved');
  assert.equal(result.accounting.actualSpendCu, null);
  assert.equal(result.accounting.shutdownVerified, true);
  assert.equal(result.accounting.reason, 'session_usage_unavailable');
  const end = f.events.find(event => event.event === 'qwen_finished');
  assert.equal(end.spentUnits, null);
  assert.equal(end.costSource, 'account_balance_delta_unattributed');
  assert.equal(end.accountBalanceDeltaUnits, 10);
  const options = f.options[0], minutes = spendingMinutes(2, resolveRatePerHour());
  assert.equal(options.budgetUnits, 2);
  assert.equal(options.watchdogMinutes, minutes);
  assert.equal(options.wallClockCapMinutes, minutes);
  assert.ok(minutes > 1);
  const execution = f.calls.find(call => call.kind === 'exec');
  assert.equal(execution.limits.wallMs, minutes * 60000);
  assert.equal(Number(execution.args.at(-1)), minutes * 60 - 60);
  assert.deepEqual(f.calls.map(call => call.kind), ['usage', 'allocate', 'upload', 'exec', 'download', 'teardown', 'usage']);
});

test('owner sequential Qwen retains its account-delta overspend rejection', async t => {
  const f = fixture(t);
  await assert.rejects(f.run('owner-account'), /Run spend 10 exceeds ceiling 2/);
  assert.equal(f.report().spent, 10);
  assert.equal(f.report().accounting.costSource, 'account_balance_delta');
  assert.equal(f.report().accounting.actualSpendCu, null, 'account delta remains labeled an estimate');
  assert.ok(f.calls.some(call => call.kind === 'teardown'));
});

test('owner Qwen retains its successful under-cap path and default accounting mode', async t => {
  const f = fixture(t, { after: 99.5 });
  const result = await runQwenColab(f.input, f.adapters);
  assert.equal(result.accountingMode, 'owner-account');
  assert.equal(result.spent, 0.5);
  assert.equal(result.stopped.state, 'stopped');
});

test('missing final account usage stays unresolved in hosted mode but rejects owner sequential mode', async t => {
  const hosted = fixture(t, { after: null });
  assert.equal((await hosted.run()).accounting.status, 'unresolved');
  assert.equal(hosted.report().accountBalanceDeltaUnits, null);
  const owner = fixture(t, { after: null });
  await assert.rejects(owner.run('owner-account'), /Run spend null exceeds ceiling/);
});

test('hosted Qwen still refuses insufficient or unreadable credit before allocation', async t => {
  for (const before of [null, 0, 1.9]) {
    const f = fixture(t, { before });
    await assert.rejects(f.run(), /Insufficient or unreadable balance/);
    assert.equal(f.calls.some(call => call.kind === 'allocate'), false);
    assert.equal(f.calls.some(call => call.kind === 'upload'), false);
    assert.equal(f.report().accounting.actualSpendCu, 0);
    assert.equal(f.report().accounting.costSource, 'verified_no_allocation');
  }
});

test('hosted Qwen cannot report success with unconfirmed or unproven teardown', async t => {
  for (const state of ['stop_unconfirmed', 'not_owned']) {
    const f = fixture(t, { teardown: { state } });
    await assert.rejects(f.run(), /Runtime teardown/);
    assert.equal(f.report().accounting.shutdownVerified, false);
    assert.equal(f.report().accounting.reason, 'shutdown_unconfirmed');
    assert.equal(f.report().spent, null);
  }
});

test('attempted allocation with verified cleanup preserves unknown usage and the allocation error', async t => {
  const f = fixture(t, { allocateError: 'Capacity refused', teardown: { state: 'not_owned', allocation: 'attempted', shutdownVerified: true } });
  await assert.rejects(f.run(), /Capacity refused/);
  assert.equal(f.report().accounting.status, 'unresolved');
  assert.equal(f.report().accounting.shutdownVerified, true);
  assert.equal(f.calls.some(call => call.kind === 'exec'), false);
});

test('hosted accounting does not mask narration execution failure', async t => {
  const f = fixture(t, { execOutput: 'Worker failed without a completion sentinel' });
  await assert.rejects(f.run(), /Qwen worker did not finish/);
  assert.ok(f.calls.some(call => call.kind === 'teardown'));
  assert.equal(f.report().accounting.actualSpendCu, null);
});

test('invalid mode, missing identity, or a budget without shutdown headroom allocates nothing', async t => {
  const f = fixture(t);
  await assert.rejects(f.run('client-selected-mode'), /Unknown Qwen accounting mode/);
  await assert.rejects(runQwenColab({ ...f.input, accountingMode: 'invite-reserved', runId: undefined }, f.adapters), /run identity/);
  await assert.rejects(runQwenColab({ ...f.input, units: 0.001 }, f.adapters), /shutdown reserve/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.options, []);
});
