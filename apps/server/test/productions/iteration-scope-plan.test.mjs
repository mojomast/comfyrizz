// AV14: action plans honour the turn's iteration scope.
//
// A plan may carry the turn's iteration scope and every paid slot may carry the
// normalized scope. A paid slot in a scoped turn must keep exactly that scope
// and target its shot or clip. Widening, moving or dropping the scope is
// refused before the plan is journaled. The server plan hash covers the scope,
// and the IL04/IL05 iteration gates still run on the same slots.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createCommandHandler } from '../../src/productions/commands.mjs';
import { computePlanHash, createActionCoordinator } from '../../src/productions/actions.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createProductionRoutes } from '../../src/routes/productions.mjs';

const AT = '2026-10-23T11:30:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_scope_plan' });

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-scope-plan-'));
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
  const routes = createProductionRoutes({ store, handler, actions, contextFor: () => USER });
  return { runtimeDir, store, handler, actions, routes };
}

function makeRequest({ method = 'GET', url = '/api/productions', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.method = method;
  request.url = url;
  request.headers = {};
  for (const [name, value] of Object.entries(headers)) request.headers[name.toLowerCase()] = value;
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
  await routes.handle(request, response, options.url);
  let body;
  if (response.body !== '') {
    try {
      body = JSON.parse(response.body);
    } catch {
      body = undefined;
    }
  }
  return { status: response.statusCode, headers: response.headers, body, raw: response.body };
}

function scope(overrides = {}) {
  return {
    target: { packageId: 'pkg_1', shotId: 'shot_1' },
    element: 'background',
    note: 'warmer sunset light',
    preserve: ['character', 'voice'],
    ...overrides,
  };
}

function slot(id, upperBound, extra = {}) {
  return {
    id,
    upperBound,
    targetId: 'shot_1',
    effectiveInputHash: `hash_${id}`,
    seed: 1,
    ...extra,
  };
}

function planPayload(overrides = {}) {
  const { actions: planActions, ...rest } = overrides;
  return {
    planId: 'plan_1',
    revision: 0,
    reservationCeiling: 20,
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
      payload: { conversationId: 'conv_1', shotIds: ['shot_1', 'shot_2'] },
      ...overrides,
    },
  });
  assert.equal(response.status, 201, response.raw);
  return response.body;
}

async function setPolicy(routes, productionId, revision, policy) {
  const response = await call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/commands`,
    body: {
      commandId: 'cmd_iteration',
      idempotencyKey: 'key_iteration',
      kind: 'iteration.set',
      productionId,
      expected: { productionRevision: revision },
      payload: { policy },
    },
  });
  assert.equal(response.status, 200, response.raw);
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

function assertMismatch(response) {
  assert.equal(response.status, 400, response.raw);
  assert.equal(response.body.code, 'ITERATION_SCOPE_MISMATCH');
}

test('a scoped paid plan is accepted and keeps the normalized slot scope', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const turnScope = scope();
  const slotScope = scope();

  const response = await propose(routes, id, planPayload({
    scope: turnScope,
    actions: [slot('act_1', 2, { scope: slotScope })],
  }));

  assert.equal(response.status, 201, response.raw);
  assert.deepEqual(response.body.plan.scope, turnScope);
  assert.deepEqual(response.body.plan.actions[0].scope, slotScope);
  assert.equal(response.body.planHash, computePlanHash(response.body.plan));
  assert.equal(store.readEvents(id).filter((event) => event.type === 'plan.proposed').length, 1);
});

test('the plan hash changes when the slot scope changes', async (t) => {
  const { routes } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const first = await propose(routes, id, planPayload({
    scope: scope(),
    actions: [slot('act_1', 2, { scope: scope() })],
  }), { commandId: 'cmd_propose_first', idempotencyKey: 'key_propose_first' });
  assert.equal(first.status, 201, first.raw);

  const second = await propose(routes, id, planPayload({
    planId: 'plan_2',
    scope: scope({ element: 'lighting' }),
    actions: [slot('act_1', 2, { scope: scope({ element: 'lighting' }) })],
  }), { commandId: 'cmd_propose_second', idempotencyKey: 'key_propose_second', productionRevision: 2 });
  assert.equal(second.status, 201, second.raw);

  assert.notEqual(second.body.planHash, first.body.planHash);
  const base = {
    id: 'plan_1',
    productionId: id,
    revision: 0,
    reservationCeiling: 20,
    collectAndStopReserve: 0,
    requiredDecisions: [],
    scope: scope(),
    actions: [slot('act_1', 2, { scope: scope() })],
  };
  assert.notEqual(
    computePlanHash(base),
    computePlanHash({ ...base, actions: [slot('act_1', 2, { scope: scope({ element: 'lighting' }) })] }),
  );
});

test('a widened slot target is refused before journaling', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const response = await propose(routes, id, planPayload({
    scope: scope(),
    actions: [slot('act_1', 2, { targetId: 'shot_2', scope: scope({ target: { packageId: 'pkg_1', shotId: 'shot_2' } }) })],
  }));

  assertMismatch(response);
  assert.equal(store.readEvents(id).some((event) => event.type === 'plan.proposed'), false);
});

test('a package-only (widened) slot scope is refused', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const response = await propose(routes, id, planPayload({
    scope: scope(),
    actions: [slot('act_1', 2, { scope: scope({ target: { packageId: 'pkg_1' } }) })],
  }));

  assertMismatch(response);
  assert.equal(store.readEvents(id).some((event) => event.type === 'plan.proposed'), false);
});

test('a dropped paid slot scope is refused', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const response = await propose(routes, id, planPayload({
    scope: scope(),
    actions: [slot('act_1', 2)],
  }));

  assertMismatch(response);
  assert.equal(store.readEvents(id).some((event) => event.type === 'plan.proposed'), false);
});

test('a slot scope that targets another shot than the slot is refused', async (t) => {
  const { routes } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const response = await propose(routes, id, planPayload({
    actions: [slot('act_1', 2, { scope: scope({ target: { packageId: 'pkg_1', shotId: 'shot_2' } }) })],
  }));

  assertMismatch(response);
});

test('a clip slot scope matches a clip target', async (t) => {
  const { routes } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const clipScope = scope({ target: { packageId: 'pkg_1', clipId: 'clip_1' } });

  const response = await propose(routes, id, planPayload({
    scope: clipScope,
    actions: [slot('act_1', 2, { targetId: 'clip_1', scope: clipScope })],
  }));

  assert.equal(response.status, 201, response.raw);
});

test('an invalid slot scope is refused as a scope error', async (t) => {
  const { routes } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const response = await propose(routes, id, planPayload({
    actions: [slot('act_1', 2, { scope: scope({ element: 'camera' }) })],
  }));

  assert.equal(response.status, 400, response.raw);
  assert.equal(response.body.code, 'ITERATION_SCOPE_INVALID');
});

test('unpaid slots do not need the turn scope', async (t) => {
  const { routes } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const response = await propose(routes, id, planPayload({
    scope: scope(),
    actions: [
      slot('act_1', 2, { scope: scope() }),
      slot('act_audition', 1, {
        kind: 'audition',
        characterId: 'basil',
        voice: 'warm',
        line: 'shot_1:line_1',
        engine: 'kokoro',
      }),
    ],
  }));

  assert.equal(response.status, 201, response.raw);
});

test('IL05 take limits still apply to scoped slots', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const policy = await setPolicy(routes, id, created.revision, structuredClone(ITERATION_PRESETS.balanced));

  const response = await propose(routes, id, planPayload({
    scope: scope(),
    actions: [
      slot('act_1', 2, { kind: 'take', scope: scope() }),
      slot('act_2', 2, { kind: 'take', scope: scope() }),
      slot('act_3', 2, { kind: 'take', scope: scope() }),
    ],
  }), { productionRevision: policy.revision });

  assert.equal(response.status, 400, response.raw);
  assert.equal(response.body.code, 'ITERATION_EXCEEDED');
  assert.equal(store.readEvents(id).some((event) => event.type === 'plan.proposed'), false);
});

test('IL04 still gates approval of a scoped paid plan', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const turnScope = scope();

  const proposed = await propose(routes, id, planPayload({
    scope: turnScope,
    actions: [slot('act_1', 2, { scope: turnScope })],
  }));
  assert.equal(proposed.status, 201, proposed.raw);

  const approved = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/commands`,
    body: {
      commandId: 'cmd_approve_scope',
      idempotencyKey: 'key_approve_scope',
      kind: 'plan.approve',
      productionId: id,
      expected: { productionRevision: store.read(id).revision },
      payload: { planId: 'plan_1', planHash: proposed.body.planHash },
    },
  });

  assert.equal(approved.status, 409, approved.raw);
  assert.equal(approved.body.code, 'ITERATION_LEVEL_REQUIRED');
  assert.equal(store.readEvents(id).some((event) => event.type === 'plan.approved'), false);
});
