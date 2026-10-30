import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprint } from '../../src/pipeline-contract.mjs';
import { createCorrectionAdapter } from '../../src/productions/correction-adapter.mjs';

test('a changed project cannot redeem a correction slot or invoke a backend', async () => {
  const baseline = { id: 'pkg_1', revision: 1, assets: { a_1: { gen: { prompt: 'old' } } } };
  const stagedAsset = { gen: { prompt: 'corrected' } };
  const action = { id: 'act_1', planId: 'plan_1', planHash: 'hash_1', state: 'queued' };
  const slot = { id: action.id, executor: 'chat-correction-take', assetIds: ['a_1'], stagedAsset,
    basePackageFingerprint: fingerprint(baseline), backendId: 'colab', upperBound: 1, correction: {} };
  let starts = 0;
  const adapter = createCorrectionAdapter({
    store: { readEvents: () => [{ type: 'plan.proposed', data: { id: action.planId, planHash: action.planHash, actions: [slot] } },
      { type: 'action.state_changed', data: action }], read: () => ({ revision: 3 }) },
    runs: { start: async () => { starts++; return { runId: 'run_1' }; } },
    pipeline: {},
  });
  const changed = structuredClone(baseline);
  changed.assets.a_1.gen.prompt = 'owner edit';
  await assert.rejects(adapter.admit({ productionId: 'prod_1', actionId: 'act_1', pkg: changed }), { code: 'SHOT_PLAN_CHANGED' });
  assert.equal(starts, 0);
});

test('correction lookup, observation and cancellation require the run to match its journal authority', async () => {
  const action = { id: 'act_1', planId: 'plan_1', planHash: 'hash_1', state: 'running', runId: 'run_1' };
  const slot = { id: action.id, executor: 'chat-correction-take' };
  const own = { runId: 'run_1', productionId: 'prod_1', actionId: action.id, packageId: 'pkg_1',
    actionPlanHash: action.planHash, planHash: 'backend_hash', status: 'running' };
  let record = own;
  const cancellations = [];
  const adapter = createCorrectionAdapter({
    store: { readEvents: () => [{ type: 'plan.proposed', data: { id: action.planId, planHash: action.planHash, actions: [slot] } },
      { type: 'action.state_changed', data: action }], read: () => ({ packageId: 'pkg_1' }) },
    runs: { get: id => { assert.equal(id, action.runId); return record; }, cancel: id => cancellations.push(id) },
    pipeline: { runForAction() { assert.fail('correction lookup must not fall back to a pipeline run'); }, cancel() {} },
  });
  const args = { productionId: 'prod_1', actionId: action.id };
  assert.equal(adapter.runForAction(args.productionId, args.actionId), own);
  assert.equal((await adapter.observe(args)).run, own);
  adapter.cancel(args);
  assert.deepEqual(cancellations, ['run_1']);

  for (const patch of [{ runId: 'run_foreign' }, { productionId: 'prod_foreign' }, { actionId: 'act_foreign' },
    { packageId: 'pkg_foreign' }, { actionPlanHash: 'foreign_hash' },
    { productionId: undefined }, { actionId: undefined }, { actionPlanHash: undefined }]) {
    record = { ...own, ...patch };
    assert.equal(adapter.runForAction(args.productionId, args.actionId), null, JSON.stringify(patch));
    assert.equal((await adapter.observe(args)).observed, false);
    adapter.cancel(args);
  }
  record = null;
  assert.equal(adapter.runForAction(args.productionId, args.actionId), null);
  action.runId = null;
  assert.equal(adapter.runForAction(args.productionId, args.actionId), null);
  assert.deepEqual(cancellations, ['run_1'], 'foreign or missing runs must never be cancelled');
});
