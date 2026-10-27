import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionRoutes } from '../../src/routes/productions.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';

test('the server prices the whole-production final action and leaves other plans untouched', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-final-pricing-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = createProductionStore({ runtimeDir });
  const bodies = [];
  const routes = createProductionRoutes({
    store,
    handler: { execute() { throw new Error('not used'); } },
    actions: {
      propose({ body }) {
        bodies.push(body);
        return { duplicate: false, plan: body.payload };
      },
      dispatch() {},
      getAction() {},
    },
    contextFor: () => ({ actor: 'user', userEventId: 'ue_test' }),
    estimateFinalRun: async ({ budgetUnits }) => {
      assert.equal(budgetUnits, 10);
      return 1.25;
    },
  });
  const server = createServer((request, response) => routes.handle(request, response, request.url));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/productions/prod_test/action-plans`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = kind => ({
    commandId: `cmd_${kind}`, idempotencyKey: `cmd_${kind}`,
    expected: { productionRevision: 1 },
    payload: {
      planId: `plan_${kind}`, revision: 0, reservationCeiling: 10,
      collectAndStopReserve: 0, requiredDecisions: [],
      actions: [{ id: `act_${kind}`, kind, upperBound: 0.12 }],
    },
  });
  assert.equal((await post(payload('final'))).status, 201);
  assert.equal((await post(payload('shot.generate'))).status, 201);
  assert.equal(bodies[0].payload.reservationCeiling, 1.25);
  assert.equal(bodies[0].payload.actions[0].upperBound, 1.25);
  assert.equal(bodies[1].payload.reservationCeiling, 10);
  assert.equal(bodies[1].payload.actions[0].upperBound, 0.12);
});
