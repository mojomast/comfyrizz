// UR22: deterministic Easy plan proposer.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createActionCoordinator } from '../../src/productions/actions.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import { planFromPackage } from '../../src/productions/plan-from-package.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createProductionRoutes } from '../../src/routes/productions.mjs';
import { BOOTSTRAP_OVERHEAD_MINUTES, MEASURED_JOB_MINUTES } from '../../../../packages/backends/src/colab-backend.mjs';
import { nextJobUpperEstimate, rateForGpu, reserveUnitsFor } from '../../../../packages/backends/src/budget.mjs';

const AT = '2026-10-23T12:00:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_easy_plan' });

function packageFixture() {
  return {
    id: 'pkg_easy',
    scenes: [
      { id: 's1', background: { asset: 'a1' } },
      { id: 's2', background: { asset: 'a2' } },
      { id: 's3', background: { asset: 'a3' } },
    ],
    assets: {
      a1: { gen: { generator: 'flux3-klein', inputs: { prompt: 'nebula' } } },
      a2: { gen: { generator: 'ltx25', inputs: { prompt: 'counter' } } },
      a3: { gen: { generator: 'llm-svg', inputs: { prompt: 'title card' } } },
    },
  };
}

test('balanced gives one action per GPU scene, each with 2 takes', () => {
  const plan = planFromPackage({ pkg: packageFixture(), level: 'balanced', compute: 'colab' });
  assert.equal(plan.actions.length, 2);
  assert.deepEqual(plan.actions.map((action) => action.targetId), ['s1', 's2']);
  assert.deepEqual(plan.actions.map((action) => action.takes), [2, 2]);
  assert.equal(plan.requiredDecisions.length, 0);
  assert.equal(plan.reservationCeiling, plan.actions[0].upperBound + plan.actions[1].upperBound);
  for (const action of plan.actions) {
    assert.equal(action.kind, 'shot.generate');
    assert.equal(action.id, `act_${action.targetId}`);
    assert.equal(action.reuse, false);
    assert.match(action.effectiveInputHash, /^[0-9a-f]{64}$/);
    assert.equal(typeof action.upperBound, 'number');
    assert.ok(action.upperBound > 0);
  }
});

test('draft gives takes 1', () => {
  const plan = planFromPackage({ pkg: packageFixture(), level: 'draft', compute: 'colab' });
  assert.deepEqual(plan.actions.map((action) => action.takes), [1, 1]);
  const rate = rateForGpu('G4', { env: {} }).ratePerHour;
  const required = nextJobUpperEstimate({ gpuMinutes: MEASURED_JOB_MINUTES.still, overheadMinutes: BOOTSTRAP_OVERHEAD_MINUTES, ratePerHour: rate }) + reserveUnitsFor(rate);
  assert.ok(plan.actions[0].upperBound >= required - 1e-9);
});

test('CPU compute gives zero actions and a ceiling of 0', () => {
  const plan = planFromPackage({ pkg: packageFixture(), level: 'balanced', compute: 'cpu' });
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.reservationCeiling, 0);
});

test('the same inputs give the same effectiveInputHash', () => {
  const first = planFromPackage({ pkg: packageFixture(), level: 'balanced', compute: 'colab' });
  const second = planFromPackage({ pkg: packageFixture(), level: 'balanced', compute: 'colab' });
  assert.deepEqual(
    first.actions.map((action) => action.effectiveInputHash),
    second.actions.map((action) => action.effectiveInputHash),
  );
  assert.deepEqual(
    first.actions.map((action) => action.seed),
    second.actions.map((action) => action.seed),
  );
});

test('onlyShotIds limits the plan to that scene', () => {
  const plan = planFromPackage({
    pkg: packageFixture(),
    level: 'balanced',
    compute: 'colab',
    onlyShotIds: ['s2'],
    chip: 'warmer',
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].targetId, 's2');
  assert.equal(plan.actions[0].note, 'warmer');
});

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-easy-plan-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function setup(t) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const actions = createActionCoordinator({
    store,
    handler,
    ledgerFor: () => { throw new Error('easy-plan must not touch the ledger'); },
  });
  const pkg = packageFixture();
  const routes = createProductionRoutes({
    store,
    handler,
    actions,
    contextFor: () => USER,
    readPackage: (packageId) => (packageId === pkg.id ? pkg : null),
  });
  return { store, routes, pkg };
}

function makeRequest({ method = 'POST', url, body } = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = url;
  request.headers = {};
  return request;
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(chunk = '') {
      if (chunk) this.body += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    },
    destroy() {},
  };
}

async function call(routes, options) {
  const response = makeResponse();
  await routes.handle(makeRequest(options), response, options.url);
  let body;
  if (response.body !== '') {
    try { body = JSON.parse(response.body); } catch { body = undefined; }
  }
  return { status: response.statusCode, body, raw: response.body };
}

test('the route stores a server-minted plan.proposed event', async (t) => {
  const { routes, store } = setup(t);
  const created = await call(routes, {
    url: '/api/productions',
    body: {
      commandId: 'cmd_create',
      idempotencyKey: 'key_create',
      kind: 'production.create',
      payload: { conversationId: 'conv_easy', packageId: 'pkg_easy' },
    },
  });
  assert.equal(created.status, 201, created.raw);
  const id = created.body.productionId;
  const response = await call(routes, {
    url: `/api/productions/${id}/easy-plan`,
    body: { level: 'balanced', compute: 'colab', planId: 'plan_from_client' },
  });
  assert.equal(response.status, 201, response.raw);
  const events = store.readEvents(id).filter((event) => event.type === 'plan.proposed');
  assert.equal(events.length, 1);
  assert.match(events[0].data.id, /^plan_[0-9a-f]+$/);
  assert.notEqual(events[0].data.id, 'plan_from_client');
  assert.equal(events[0].data.actions.length, 2);
  assert.equal(response.body.plan.id, events[0].data.id);
});
