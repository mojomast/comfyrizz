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
