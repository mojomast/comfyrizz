// IP20C: plans only come from the action-plans route.
//
// The generic /commands facade must not author plan identity: a plan.propose
// there is refused before the handler and journals nothing. A plan.proposed
// event written around the route is not trusted unless its planHash matches the
// server content hash, so approval and dispatch against it reserve nothing and
// the coordinator never schedules it. The normal action-plans path is unchanged.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  computePlanHash,
  createActionCoordinator,
} from '../../src/productions/actions.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import {
  createProductionCoordinator,
  deriveNextStep,
} from '../../src/productions/coordinator.mjs';
import { createBudgetLedger, ledgerPaths } from '../../src/productions/ledger.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createProductionRoutes } from '../../src/routes/productions.mjs';

const AT = '2026-10-22T12:00:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_server' });

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-plan-source-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function setup(t) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const ledgers = new Map();
  const ledgerFor = (production) => {
    let ledger = ledgers.get(production.budgetLedgerId);
    if (!ledger) {
      ledger = createBudgetLedger({
        runtimeDir,
        ledgerId: production.budgetLedgerId,
        clock: () => new Date(AT),
      });
      ledgers.set(production.budgetLedgerId, ledger);
    }
    return ledger;
  };
  const actions = createActionCoordinator({ store, handler, ledgerFor });
  const coordinator = createProductionCoordinator({ store, actions, clock: () => new Date(AT) });
  const routes = createProductionRoutes({ store, handler, actions, contextFor: () => USER });
  return { runtimeDir, store, handler, actions, coordinator, routes, ledgerFor, ledgers };
}

function makeRequest({ method = 'GET', url = '/api/productions', headers = {}, body } = {}) {
  const chunks = body === undefined
    ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.method = method;
  request.url = url;
  request.headers = {};
  for (const [name, value] of Object.entries(headers)) {
    request.headers[name.toLowerCase()] = value;
  }
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

async function call(routes, options = {}) {
  const request = makeRequest(options);
  const response = makeResponse();
  const handled = await routes.handle(request, response, options.url);
  let body;
  if (response.body !== '') {
    try {
      body = JSON.parse(response.body);
    } catch {
      body = undefined;
    }
  }
  return { handled, status: response.statusCode, headers: response.headers, body, raw: response.body };
}

function slot(id, upperBound, extra = {}) {
  return { id, upperBound, targetId: `shot_${id}`, effectiveInputHash: `hash_${id}`, seed: 1, ...extra };
}

function planPayload(overrides = {}) {
  const { actions: planActions, ...rest } = overrides;
  return {
    planId: 'plan_1',
    revision: 0,
    reservationCeiling: 5,
    collectAndStopReserve: 0,
    requiredDecisions: [],
    actions: planActions === undefined ? [slot('act_1', 2)] : planActions,
    ...rest,
  };
}

async function createProduction(routes, overrides = {}) {
  const response = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: {
      commandId: 'cmd_create',
      idempotencyKey: 'key_create',
      kind: 'production.create',
      payload: { conversationId: 'conv_1' },
      ...overrides,
    },
  });
  assert.equal(response.status, 201, response.raw);
  return response.body;
}

async function propose(routes, productionId, payload, overrides = {}) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/action-plans`,
    body: {
      commandId: overrides.commandId ?? 'cmd_propose',
      idempotencyKey: overrides.idempotencyKey ?? 'key_propose',
      expected: { productionRevision: overrides.productionRevision ?? 1 },
      payload,
    },
  });
}

async function command(routes, productionId, kind, productionRevision, payload, extra = {}) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/commands`,
    body: {
      commandId: extra.commandId ?? `cmd_${kind.replaceAll('.', '_')}_${productionRevision}`,
      idempotencyKey: extra.idempotencyKey ?? `key_${kind.replaceAll('.', '_')}_${productionRevision}`,
      kind,
      productionId,
      expected: { productionRevision },
      payload,
    },
  });
}

async function dispatch(routes, productionId, payload, overrides = {}) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/actions`,
    body: {
      commandId: overrides.commandId ?? 'cmd_dispatch',
      idempotencyKey: overrides.idempotencyKey ?? 'key_dispatch',
      expected: { productionRevision: overrides.productionRevision ?? 1 },
      payload,
    },
  });
}

function openReservations(runtimeDir, production) {
  const ledger = createBudgetLedger({
    runtimeDir,
    ledgerId: production.budgetLedgerId,
    clock: () => new Date(AT),
  });
  return ledger.status();
}

function holds(status) {
  return status.openReservations.map((reservation) => reservation.hold).sort((left, right) => left - right);
}

function forgedPlan(productionId, overrides = {}) {
  return {
    id: 'plan_x',
    productionId,
    revision: 0,
    planHash: 'forged-hash',
    reservationCeiling: 1,
    collectAndStopReserve: 0,
    requiredDecisions: [],
    actions: [slot('act_big', 999)],
    ...overrides,
  };
}

test('POST /commands refuses plan.propose without journaling or reserving', async (t) => {
  const { routes, runtimeDir, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const before = store.read(id);

  const response = await command(routes, id, 'plan.propose', before.revision, {
    id: 'plan_x',
    planId: 'plan_x',
    planHash: 'forged-hash',
    revision: 0,
    reservationCeiling: 1,
    collectAndStopReserve: 0,
    requiredDecisions: [],
    actions: [{ id: 'act_big', upperBound: 999, targetId: 'shot_big', effectiveInputHash: 'hash_big', seed: 1 }],
  }, { commandId: 'cmd_forge_propose', idempotencyKey: 'key_forge_propose' });

  assert.equal(response.status, 422, response.raw);
  assert.equal(response.body.code, 'USE_ACTION_PLANS');

  const after = store.read(id);
  assert.equal(after.revision, before.revision);
  assert.equal(after.lastSequence, before.lastSequence);
  assert.equal(store.readEvents(id).some((event) => event.type === 'plan.proposed'), false);
  assert.equal(fs.existsSync(ledgerPaths(runtimeDir, created.production.budgetLedgerId).file), false);
});

test('a forged plan.proposed is ignored by approval, dispatch and the coordinator', async (t) => {
  const { routes, runtimeDir, store, coordinator } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const forged = forgedPlan(id);
  const current = store.read(id);

  store.commit(id, {
    commandId: 'cmd_forge_plan',
    idempotencyKey: 'key_forge_plan',
    baseRevision: current.revision,
    production: current,
    events: [{ type: 'plan.proposed', data: forged }],
  });
  assert.equal(store.readEvents(id).filter((event) => event.type === 'plan.proposed').length, 1);

  const next = deriveNextStep({ production: store.read(id), events: store.readEvents(id) });
  assert.equal(next.kind, 'await_plan');
  assert.equal(coordinator.nextStep(id).kind, 'await_plan');

  const approved = await command(routes, id, 'plan.approve', store.read(id).revision, {
    planId: forged.id,
    planHash: forged.planHash,
  }, { commandId: 'cmd_approve_forged', idempotencyKey: 'key_approve_forged' });
  assert.equal(approved.status, 200, approved.raw);

  const admitted = await dispatch(routes, id, {
    planId: forged.id,
    planRevision: forged.revision,
    actionId: 'act_big',
  }, { commandId: 'cmd_dispatch_forged', productionRevision: store.read(id).revision });

  assert.notEqual(admitted.status, 202, admitted.raw);
  assert.equal(admitted.body.code, 'UNKNOWN_PLAN');
  assert.deepEqual(store.read(id).actionIds, []);
  assert.deepEqual(holds(openReservations(runtimeDir, created.production)), []);
  assert.equal(store.pending(id).length, 0);
});

test('a hash-less plan.proposed is ignored', async (t) => {
  const { routes, runtimeDir, store, coordinator } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const forged = forgedPlan(id, { planHash: undefined });
  const current = store.read(id);

  store.commit(id, {
    commandId: 'cmd_forge_hashless',
    idempotencyKey: 'key_forge_hashless',
    baseRevision: current.revision,
    production: current,
    events: [{ type: 'plan.proposed', data: forged }],
  });

  assert.equal(coordinator.nextStep(id).kind, 'await_plan');
  const admitted = await dispatch(routes, id, {
    planId: forged.id,
    planRevision: forged.revision,
    actionId: 'act_big',
  }, { commandId: 'cmd_dispatch_hashless', productionRevision: store.read(id).revision });

  assert.notEqual(admitted.status, 202, admitted.raw);
  assert.deepEqual(store.read(id).actionIds, []);
  assert.deepEqual(holds(openReservations(runtimeDir, created.production)), []);
});

test('the action-plans propose, approve and dispatch path reserves exactly one slot', async (t) => {
  const { routes, runtimeDir, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const proposed = await propose(routes, id, planPayload());
  assert.equal(proposed.status, 201, proposed.raw);
  assert.equal(proposed.body.planHash, computePlanHash(proposed.body.plan));

  const approved = await command(routes, id, 'plan.approve', store.read(id).revision, {
    planId: 'plan_1',
    planHash: proposed.body.planHash,
  }, { commandId: 'cmd_approve_plan', idempotencyKey: 'key_approve_plan' });
  assert.equal(approved.status, 200, approved.raw);

  const admitted = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_dispatch_plan', productionRevision: store.read(id).revision });
  assert.equal(admitted.status, 202, admitted.raw);
  assert.equal(admitted.body.action.planHash, proposed.body.planHash);

  const status = openReservations(runtimeDir, created.production);
  assert.equal(status.openReservations.length, 1);
  assert.deepEqual(holds(status), [2]);
});
