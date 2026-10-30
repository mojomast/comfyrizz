import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { ITERATION_PRESETS } from '../src/productions/iteration.mjs';

const TOKEN = 'final-plan-cap-token-0123456789';

test('final pricing uses the saved production cap, not the easy-plan placeholder', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-final-cap-'));
  const seenBudgets = [];
  const backend = {
    id: 'colab',
    async describe() { return { id: 'colab', costVisibility: 'colab-account-estimate' }; },
    async runPackage(_pkg, { dryRun }) {
      assert.equal(dryRun, true);
      return { jobsDoc: { jobs: [] }, estimate: { gpuMinutes: 1, overheadMinutes: 0 } };
    },
  };
  const app = createApp({
    token: TOKEN,
    runtimeDir,
    backendFactory: async (_id, options) => { seenBudgets.push(options.budgetUnits); return backend; },
    providers: { available: [] },
  });
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url)));
  pkg.scenes = [pkg.scenes[0]];
  pkg.scenes[0].background = null;
  pkg.scenes[0].foreground = [];
  pkg.assets = {};
  app.store.write(pkg);
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    app.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const call = async (path, body) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { origin: base, 'x-comfyrizz-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: JSON.parse(text), text };
  };
  const created = await call('/api/productions', {
    commandId: 'cmd_final_cap_create', idempotencyKey: 'cmd_final_cap_create', kind: 'production.create',
    payload: { conversationId: 'conv_final_cap', packageId: pkg.id, shotIds: [pkg.scenes[0].id] },
  });
  assert.equal(created.status, 201, created.text);
  const productionId = created.json.productionId;
  const iteration = await call(`/api/productions/${productionId}/commands`, {
    commandId: 'cmd_final_cap_iteration', idempotencyKey: 'cmd_final_cap_iteration', kind: 'iteration.set',
    expected: { productionRevision: created.json.revision }, payload: { policy: structuredClone(ITERATION_PRESETS.balanced) },
  });
  assert.equal(iteration.status, 200, iteration.text);
  const cap = await call(`/api/productions/${productionId}/spend-cap`, {
    commandId: 'cmd_final_cap_ceiling', idempotencyKey: 'cmd_final_cap_ceiling', ceiling: 10,
    expected: { productionRevision: iteration.json.revision },
  });
  assert.ok([200, 201].includes(cap.status), cap.text);
  const proposed = await call(`/api/productions/${productionId}/action-plans`, {
    commandId: 'cmd_final_cap_plan', idempotencyKey: 'cmd_final_cap_plan',
    expected: { productionRevision: cap.json.revision },
    payload: {
      planId: 'plan_final_cap', revision: 0, reservationCeiling: 0.12,
      collectAndStopReserve: 0, requiredDecisions: [],
      actions: [{ id: 'act_super_easy_final', kind: 'final', upperBound: 0.12 }],
    },
  });
  assert.equal(proposed.status, 201, proposed.text);
  assert.deepEqual(seenBudgets, [10]);
  assert.ok(proposed.json.plan.reservationCeiling > 0.12 && proposed.json.plan.reservationCeiling <= 10);
  assert.equal(proposed.json.plan.actions[0].upperBound, proposed.json.plan.reservationCeiling);
});
