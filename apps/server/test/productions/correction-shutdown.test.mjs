import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { correctionShutdownStatus, hasUnresolvedCorrectionShutdown, reconcileCorrectionShutdown } from '../../src/productions/correction-shutdown.mjs';

test('an interrupted correction blocks further managed work until shutdown is evidenced', t => {
  const runtime = mkdtempSync(join(tmpdir(), 'correction-shutdown-'));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const runId = 'run_123456789abc';
  const events = [
    { type: 'plan.proposed', data: { id: 'plan_1', planHash: 'hash_1', actions: [{ id: 'act_1', executor: 'chat-correction-take' }] } },
    { type: 'action.state_changed', data: { id: 'act_1', planId: 'plan_1', planHash: 'hash_1', state: 'dispatching', runId } },
  ];
  const store = { list: () => [{ id: 'prod_1' }], readEvents: () => events };
  assert.equal(hasUnresolvedCorrectionShutdown(store, runtime), true);
  const dir = join(runtime, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ runId, productionId: 'prod_1', actionId: 'act_1', finished: true, teardown: { state: 'stop_unconfirmed' } }));
  assert.equal(hasUnresolvedCorrectionShutdown(store, runtime), true);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ runId, productionId: 'prod_1', actionId: 'act_1', finished: true, teardown: { state: 'stopped' } }));
  assert.equal(hasUnresolvedCorrectionShutdown(store, runtime), false);
});

test('only a finished attributed run plus a clean provider listing releases the latch', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'correction-check-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const runId = 'run_123456789abc';
  const events = [
    { type: 'plan.proposed', data: { id: 'plan_1', planHash: 'hash_1', actions: [{ id: 'act_1', executor: 'chat-correction-take' }] } },
    { type: 'action.state_changed', data: { id: 'act_1', planId: 'plan_1', planHash: 'hash_1', state: 'failed', runId } },
  ];
  const store = { list: () => [{ id: 'prod_1', packageId: 'pkg_1' }], readEvents: () => events };
  let listings = 0;
  let sessions = { sessions: [], empty: true };
  const backendFactory = async () => ({ sessions: async () => { listings++; return sessions; }, teardown: () => { throw new Error('must never stop'); } });
  const check = () => reconcileCorrectionShutdown({ store, runtimeDir, runId, backendFactory });
  assert.equal((await check()).confirmed, false, 'an allocation without a finished record stays unknown');
  assert.equal(listings, 0);
  const dir = join(runtimeDir, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  const record = { runId, productionId: 'prod_1', packageId: 'pkg_1', actionId: 'act_1', finished: true, teardown: { state: 'stop_unconfirmed' } };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(record));
  const blocker = correctionShutdownStatus(store, runtimeDir).blockers[0];
  sessions = { sessions: [{ name: blocker.session }], empty: false };
  assert.equal((await check()).confirmed, false, 'a listed session remains blocked');
  sessions = { sessions: [{ name: null, orphan: true }], empty: false };
  assert.equal((await check()).confirmed, false, 'an orphan remains ambiguous');
  sessions = { sessions: [], empty: false };
  assert.equal((await check()).confirmed, false, 'an unparseable listing proves nothing');
  const active = await reconcileCorrectionShutdown({ store, runtimeDir, runId, backendFactory, active: () => true });
  assert.equal(active.confirmed, false, 'a live run is never reconciled');
  sessions = { sessions: [], empty: true };
  const changedWhileChecking = await reconcileCorrectionShutdown({ store, runtimeDir, runId,
    backendFactory: async () => ({ sessions: async () => {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...record, error: 'changed during listing' }));
      return sessions;
    } }) });
  assert.equal(changedWhileChecking.confirmed, false);
  writeFileSync(join(dir, 'state.json'), JSON.stringify(record));
  assert.equal((await check()).confirmed, true);
  assert.equal(hasUnresolvedCorrectionShutdown(store, runtimeDir), false);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...record, error: 'changed after check' }));
  assert.equal(hasUnresolvedCorrectionShutdown(store, runtimeDir), true, 'evidence is bound to the exact record');
});
