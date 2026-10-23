// IP20: action plans and dispatch.
//
// Propose records an immutable plan and does not touch the budget ledger.
// Dispatch re-reads the latest plan, the matching approval and the production
// snapshot, then reserves exactly one slot. Spend authority is single-use:
// a (planHash, actionId) slot is admitted at most once, and only an action
// id that the approved plan lists can be admitted.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createCommandHandler } from '../../src/productions/commands.mjs';
import {
  computePlanHash,
  createActionCoordinator,
} from '../../src/productions/actions.mjs';
import { createBudgetLedger, ledgerPaths } from '../../src/productions/ledger.mjs';
import { ProductionLedgerError } from '../../src/productions/ledger.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { ProductionStoreError } from '../../src/productions/store.mjs';
import {
  createProductionRoutes,
} from '../../src/routes/productions.mjs';

const AT = '2026-10-22T12:00:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_server' });

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-actions-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function setup(t, contextFor = () => USER) {
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
  const routes = createProductionRoutes({ store, handler, actions, contextFor });
  return { runtimeDir, store, handler, actions, routes, ledgerFor, ledgers };
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

function envelope(commandId, payload, overrides = {}) {
  return {
    commandId,
    idempotencyKey: `key_${commandId}`,
    expected: { productionRevision: overrides.productionRevision ?? 2 },
    payload,
    ...overrides,
    payload,
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
  const level = await call(routes, {
    method: 'POST',
    url: `/api/productions/${response.body.productionId}/commands`,
    body: {
      commandId: `cmd_level_${response.body.productionId}`,
      idempotencyKey: `key_level_${response.body.productionId}`,
      kind: 'iteration.set',
      productionId: response.body.productionId,
      expected: { productionRevision: response.body.revision },
      payload: { policy: structuredClone(ITERATION_PRESETS.balanced) },
    },
  });
  assert.equal(level.status, 200, level.raw);
  return response.body;
}

async function propose(routes, productionId, payload, overrides = {}) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/action-plans`,
    headers: overrides.headers,
    body: envelope(overrides.commandId ?? 'cmd_propose', payload, {
      expected: { productionRevision: overrides.productionRevision ?? 2 },
      ...(overrides.idempotencyKey ? { idempotencyKey: overrides.idempotencyKey } : {}),
    }),
  });
}

async function approve(routes, productionId, payload, productionRevision) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/commands`,
    body: {
      commandId: `cmd_approve_${payload.planHash ?? 'none'}_${productionRevision}`,
      idempotencyKey: `key_approve_${payload.planHash ?? 'none'}_${productionRevision}`,
      kind: 'plan.approve',
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
    headers: overrides.headers,
    body: envelope(overrides.commandId ?? 'cmd_dispatch', payload, {
      expected: { productionRevision: overrides.productionRevision ?? 2 },
      ...(overrides.idempotencyKey ? { idempotencyKey: overrides.idempotencyKey } : {}),
    }),
  });
}

async function command(routes, productionId, kind, productionRevision, extra = {}) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/commands`,
    body: {
      commandId: extra.commandId ?? `cmd_${kind.replaceAll('.', '_')}_${productionRevision}`,
      idempotencyKey: extra.idempotencyKey ?? `key_${kind.replaceAll('.', '_')}_${productionRevision}`,
      kind,
      productionId,
      expected: { productionRevision },
      payload: extra.payload ?? {},
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

test('computePlanHash is the server content hash and ignores client hash fields', () => {
  const plan = {
    id: 'plan_1',
    productionId: 'prod_1',
    revision: 0,
    reservationCeiling: 5,
    collectAndStopReserve: 0,
    requiredDecisions: [],
    actions: [slot('act_1', 2)],
  };
  const hash = computePlanHash(plan);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(computePlanHash({ ...plan, planHash: 'not-a-hash', contentHash: 'also-not', allocation: null }), hash);
  assert.notEqual(computePlanHash({ ...plan, reservationCeiling: 6 }), hash);
  assert.notEqual(computePlanHash({ ...plan, actions: [slot('act_1', 3)] }), hash);
  const reordered = {
    actions: plan.actions,
    id: plan.id,
    reservationCeiling: plan.reservationCeiling,
    productionId: plan.productionId,
    requiredDecisions: plan.requiredDecisions,
    revision: plan.revision,
    collectAndStopReserve: plan.collectAndStopReserve,
  };
  assert.equal(computePlanHash(reordered), hash);
});

test('propose stores a server planHash, allocates nothing, and never reads actor headers', async (t) => {
  const { routes, runtimeDir, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const response = await propose(routes, id, planPayload(), {
    headers: {
      'x-comfyrizz-actor': 'agent',
      'x-comfyrizz-user-event-id': 'ue_forged',
    },
  });

  assert.equal(response.status, 201, response.raw);
  assert.equal(response.body.duplicate, false);
  assert.equal(response.body.allocation, null);
  assert.equal(response.body.plan.allocation, null);
  assert.equal(response.body.command.actor, 'user');
  assert.equal(response.body.command.userEventId, 'ue_server');
  assert.equal('contentHash' in response.body.plan, false);
  assert.equal(response.body.planHash, response.body.plan.planHash);
  assert.equal(response.body.planHash, computePlanHash(response.body.plan));
  assert.notEqual(response.body.planHash, 'not-a-hash');

  const proposed = store.readEvents(id).filter((event) => event.type === 'plan.proposed');
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].data.planHash, response.body.planHash);
  assert.equal(proposed[0].userEventId, 'ue_server');
  assert.equal(fs.existsSync(ledgerPaths(runtimeDir, created.production.budgetLedgerId).file), false);

  const replay = await propose(routes, id, planPayload());
  assert.equal(replay.status, 200, replay.raw);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.planHash, response.body.planHash);
  assert.equal(store.read(id).revision, 3);
});

test('a client planHash is rejected unless it is the server hash, and contentHash is dropped', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const forged = await propose(routes, id, planPayload({ planHash: 'not-a-hash', contentHash: 'client-content' }));
  assert.equal(forged.status, 400, forged.raw);
  assert.equal(forged.body.code, 'INVALID_PLAN');
  assert.equal(store.readEvents(id).some((event) => event.type === 'plan.proposed'), false);

  const matching = computePlanHash({
    id: 'plan_1',
    productionId: id,
    revision: 0,
    reservationCeiling: 5,
    collectAndStopReserve: 0,
    requiredDecisions: [],
    actions: [slot('act_1', 2)],
  });
  const accepted = await propose(routes, id, planPayload({ planHash: matching, contentHash: 'ignored' }));
  assert.equal(accepted.status, 201, accepted.raw);
  assert.equal(accepted.body.planHash, matching);
  assert.equal('contentHash' in accepted.body.plan, false);
});

test('planId and commandId are required and are never invented', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const before = store.read(id).revision;

  const missingPlan = await propose(routes, id, planPayload({ planId: undefined }));
  assert.equal(missingPlan.status, 400, missingPlan.raw);
  assert.equal(missingPlan.body.code, 'INVALID_PLAN');

  const missingCommand = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/action-plans`,
    body: { idempotencyKey: 'key_only', expected: { productionRevision: 2 }, payload: planPayload() },
  });
  assert.equal(missingCommand.status, 400);
  assert.equal(missingCommand.body.code, 'MISSING_COMMAND_ID');

  const missingDispatchCommand = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/actions`,
    body: { expected: { productionRevision: 2 }, payload: { planId: 'plan_1', planRevision: 0, actionId: 'act_1' } },
  });
  assert.equal(missingDispatchCommand.status, 400);
  assert.equal(missingDispatchCommand.body.code, 'MISSING_COMMAND_ID');
  assert.equal(store.read(id).revision, before);
});

test('reusing a commandId with a different payload is a 409', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const first = await propose(routes, id, planPayload());
  assert.equal(first.status, 201, first.raw);

  const conflict = await propose(routes, id, planPayload({ reservationCeiling: 9, actions: [slot('act_1', 4)] }), {
    productionRevision: store.read(id).revision,
  });
  assert.equal(conflict.status, 409, conflict.raw);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(store.readEvents(id).filter((event) => event.type === 'plan.proposed').length, 1);
});

test('reservationCeiling bounds every slot at propose time', async (t) => {
  const { routes, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  const missingBound = await propose(routes, id, planPayload({
    actions: [{ id: 'act_a' }, { id: 'act_b' }, { id: 'act_c' }, slot('act_d', 999)],
  }));
  assert.equal(missingBound.status, 400, missingBound.raw);
  assert.equal(missingBound.body.code, 'INVALID_PLAN');

  const overSlot = await propose(routes, id, planPayload({ actions: [slot('act_1', 999)] }));
  assert.equal(overSlot.status, 400, overSlot.raw);
  assert.equal(overSlot.body.code, 'INVALID_PLAN');

  const overSum = await propose(routes, id, planPayload({
    actions: [slot('act_1', 2), slot('act_2', 2), slot('act_3', 2)],
  }));
  assert.equal(overSum.status, 400, overSum.raw);
  assert.equal(overSum.body.code, 'INVALID_PLAN');

  const overStop = await propose(routes, id, planPayload({
    collectAndStopReserve: 4,
    actions: [slot('act_1', 2)],
  }));
  assert.equal(overStop.status, 400, overStop.raw);
  assert.equal(overStop.body.code, 'INVALID_PLAN');

  assert.equal(store.readEvents(id).some((event) => event.type === 'plan.proposed'), false);

  const valid = await propose(routes, id, planPayload({
    actions: [slot('act_1', 2), slot('act_2', 3)],
  }));
  assert.equal(valid.status, 201, valid.raw);
  assert.equal(valid.body.plan.actions[0].upperBound, 2);
  assert.equal(valid.body.plan.actions[1].upperBound, 3);
});

test('an empty plan cannot be dispatched and a client actionId is not synthesized', async (t) => {
  const { routes, runtimeDir, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const proposed = await propose(routes, id, planPayload({ actions: [] }));
  assert.equal(proposed.status, 201, proposed.raw);
  const approved = await approve(routes, id, {
    planId: 'plan_1',
    planHash: proposed.body.planHash,
  }, store.read(id).revision);
  assert.equal(approved.status, 200, approved.raw);

  for (const actionId of ['act_x1', 'act_x2', 'act_x3']) {
    const response = await dispatch(routes, id, {
      planId: 'plan_1',
      planRevision: 0,
      actionId,
    }, {
      commandId: `cmd_${actionId}`,
      productionRevision: store.read(id).revision,
    });
    assert.equal(response.status, 409, response.raw);
    assert.equal(response.body.code, 'NO_DISPATCHABLE_ACTIONS');
  }

  assert.equal(fs.existsSync(ledgerPaths(runtimeDir, created.production.budgetLedgerId).file), false);
  assert.deepEqual(store.read(id).actionIds, []);
});

test('dispatch admits an approved slot once, reserves its upperBound, and replays the same command', async (t) => {
  const { routes, runtimeDir, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const proposed = await propose(routes, id, planPayload({
    actions: [slot('act_1', 2), slot('act_2', 3)],
  }));
  assert.equal(proposed.status, 201, proposed.raw);
  const approved = await approve(routes, id, {
    planId: 'plan_1',
    planHash: proposed.body.planHash,
  }, store.read(id).revision);
  assert.equal(approved.status, 200, approved.raw);

  const admittedRevision = store.read(id).revision;
  const first = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_act_1', productionRevision: admittedRevision });
  assert.equal(first.status, 202, first.raw);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.action.id, 'act_1');
  assert.equal(first.body.action.state, 'queued');
  assert.equal(first.body.action.planHash, proposed.body.planHash);
  assert.equal(first.body.action.reservationId !== null, true);

  let status = openReservations(runtimeDir, created.production);
  assert.deepEqual(holds(status), [2]);
  assert.equal(status.ceiling, null);
  assert.equal(status.capped, false);

  const replay = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_act_1', productionRevision: admittedRevision });
  assert.equal(replay.status, 202, replay.raw);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.action.id, 'act_1');
  assert.equal(replay.body.action.reservationId, first.body.action.reservationId);
  assert.deepEqual(holds(openReservations(runtimeDir, created.production)), [2]);

  const second = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_2',
  }, { commandId: 'cmd_act_2', productionRevision: store.read(id).revision });
  assert.equal(second.status, 202, second.raw);
  assert.deepEqual(holds(openReservations(runtimeDir, created.production)), [2, 3]);

  const again = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_act_1_again', productionRevision: store.read(id).revision });
  assert.equal(again.status, 409, again.raw);
  assert.equal(again.body.code, 'SLOT_CONSUMED');
  assert.deepEqual(holds(openReservations(runtimeDir, created.production)), [2, 3]);

  const unknown = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_missing',
  }, { commandId: 'cmd_missing', productionRevision: store.read(id).revision });
  assert.equal(unknown.status, 404, unknown.raw);
  assert.equal(unknown.body.code, 'UNKNOWN_ACTION');
  assert.deepEqual(holds(openReservations(runtimeDir, created.production)), [2, 3]);

  const loaded = await call(routes, { method: 'GET', url: `/api/productions/${id}/actions/act_1` });
  assert.equal(loaded.status, 200, loaded.raw);
  assert.equal(loaded.body.action.id, 'act_1');
  assert.equal(loaded.body.action.planHash, proposed.body.planHash);
  assert.equal(loaded.body.action.state, 'queued');
  assert.equal(store.pending(id).length, 2);
});

test('a finished slot cannot be admitted again', async (t) => {
  for (const terminal of ['completed', 'failed', 'cancelled']) {
    const ctx = setup(t);
    const created = await createProduction(ctx.routes);
    const id = created.productionId;
    const proposed = await propose(ctx.routes, id, planPayload());
    assert.equal(proposed.status, 201, proposed.raw);
    const approved = await approve(ctx.routes, id, {
      planId: 'plan_1',
      planHash: proposed.body.planHash,
    }, ctx.store.read(id).revision);
    assert.equal(approved.status, 200, approved.raw);
    const admitted = await dispatch(ctx.routes, id, {
      planId: 'plan_1',
      planRevision: 0,
      actionId: 'act_1',
    }, { commandId: `cmd_${terminal}`, productionRevision: ctx.store.read(id).revision });
    assert.equal(admitted.status, 202, admitted.raw);

    const current = ctx.store.read(id);
    ctx.store.commit(id, {
      commandId: `cmd_finish_${terminal}`,
      idempotencyKey: `key_finish_${terminal}`,
      baseRevision: current.revision,
      production: current,
      events: [{
        type: 'action.state_changed',
        data: {
          id: 'act_1',
          planId: 'plan_1',
          planHash: proposed.body.planHash,
          state: terminal,
        },
      }],
    });

    const retry = await dispatch(ctx.routes, id, {
      planId: 'plan_1',
      planRevision: 0,
      actionId: 'act_1',
    }, { commandId: `cmd_retry_${terminal}`, productionRevision: ctx.store.read(id).revision });
    assert.equal(retry.status, 409, retry.raw);
    assert.equal(retry.body.code, 'SLOT_CONSUMED');
    assert.deepEqual(holds(openReservations(ctx.runtimeDir, created.production)), [2]);
  }
});

test('an approval without planHash approves nothing, and a later revision needs its own approval', async (t) => {
  const { routes, runtimeDir, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const first = await propose(routes, id, planPayload({ actions: [slot('act_1', 5)] }));
  assert.equal(first.status, 201, first.raw);
  const second = await propose(routes, id, planPayload({
    revision: 1,
    reservationCeiling: 50,
    actions: [slot('act_1', 50)],
  }), {
    commandId: 'cmd_propose_rev2',
    productionRevision: store.read(id).revision,
  });
  assert.equal(second.status, 201, second.raw);
  assert.notEqual(second.body.planHash, first.body.planHash);

  const bare = await approve(routes, id, { planId: 'plan_1' }, store.read(id).revision);
  assert.equal(bare.status, 200, bare.raw);

  const dispatched = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 1,
    actionId: 'act_1',
  }, { commandId: 'cmd_bare', productionRevision: store.read(id).revision });
  assert.equal(dispatched.status, 409, dispatched.raw);
  assert.equal(dispatched.body.code, 'APPROVAL_REQUIRED');
  assert.equal(fs.existsSync(ledgerPaths(runtimeDir, created.production.budgetLedgerId).file), false);

  const stale = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_stale_rev', productionRevision: store.read(id).revision });
  assert.equal(stale.status, 409, stale.raw);
  assert.equal(stale.body.code, 'PLAN_CHANGED');
});

test('a plan change after approval refuses dispatch of the approved revision', async (t) => {
  const { routes, runtimeDir, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const first = await propose(routes, id, planPayload());
  assert.equal(first.status, 201, first.raw);
  const approved = await approve(routes, id, {
    planId: 'plan_1',
    planHash: first.body.planHash,
  }, store.read(id).revision);
  assert.equal(approved.status, 200, approved.raw);
  const second = await propose(routes, id, planPayload({
    revision: 1,
    actions: [slot('act_1', 1)],
  }), {
    commandId: 'cmd_propose_2',
    productionRevision: store.read(id).revision,
  });
  assert.equal(second.status, 201, second.raw);

  const oldRevision = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_old', productionRevision: store.read(id).revision });
  assert.equal(oldRevision.status, 409, oldRevision.raw);
  assert.equal(oldRevision.body.code, 'PLAN_CHANGED');

  const newRevision = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 1,
    actionId: 'act_1',
  }, { commandId: 'cmd_new', productionRevision: store.read(id).revision });
  assert.equal(newRevision.status, 409, newRevision.raw);
  assert.equal(newRevision.body.code, 'APPROVAL_REQUIRED');
  assert.equal(fs.existsSync(ledgerPaths(runtimeDir, created.production.budgetLedgerId).file), false);
  assert.deepEqual(store.read(id).actionIds, []);
});

test('paused, cancelled and archived productions do not admit or consume a slot', async (t) => {
  const cases = [
    ['production.pause', 'PRODUCTION_PAUSED'],
    ['production.cancel', 'PRODUCTION_NOT_ACTIVE'],
    ['production.archive', 'PRODUCTION_NOT_ACTIVE'],
  ];
  for (const [kind, code] of cases) {
    const ctx = setup(t);
    const created = await createProduction(ctx.routes);
    const id = created.productionId;
    const proposed = await propose(ctx.routes, id, planPayload());
    assert.equal(proposed.status, 201, proposed.raw);
    const approved = await approve(ctx.routes, id, {
      planId: 'plan_1',
      planHash: proposed.body.planHash,
    }, ctx.store.read(id).revision);
    assert.equal(approved.status, 200, approved.raw);
    const changed = await command(ctx.routes, id, kind, ctx.store.read(id).revision);
    assert.equal(changed.status, 200, changed.raw);

    const refused = await dispatch(ctx.routes, id, {
      planId: 'plan_1',
      planRevision: 0,
      actionId: 'act_1',
    }, { commandId: `cmd_${code}`, productionRevision: ctx.store.read(id).revision });
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body.code, code);
    assert.equal(fs.existsSync(ledgerPaths(ctx.runtimeDir, created.production.budgetLedgerId).file), false);
    assert.deepEqual(ctx.store.read(id).actionIds, []);

    const resumed = await command(ctx.routes, id, 'production.resume', ctx.store.read(id).revision, {
      commandId: `cmd_resume_${code}`,
    });
    assert.equal(resumed.status, 200, resumed.raw);
    const admitted = await dispatch(ctx.routes, id, {
      planId: 'plan_1',
      planRevision: 0,
      actionId: 'act_1',
    }, { commandId: `cmd_after_${code}`, productionRevision: ctx.store.read(id).revision });
    assert.equal(admitted.status, 202, admitted.raw);
    assert.deepEqual(holds(openReservations(ctx.runtimeDir, created.production)), [2]);
  }
});

test('dispatch synonyms are not accepted and a stale revision reserves nothing', async (t) => {
  const { routes, runtimeDir, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const proposed = await propose(routes, id, planPayload());
  assert.equal(proposed.status, 201, proposed.raw);
  const approved = await approve(routes, id, {
    planId: 'plan_1',
    planHash: proposed.body.planHash,
  }, store.read(id).revision);
  assert.equal(approved.status, 200, approved.raw);
  const revision = store.read(id).revision;

  const aliased = await dispatch(routes, id, {
    plan_id: 'plan_1',
    revision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_alias', productionRevision: revision });
  assert.equal(aliased.status, 400, aliased.raw);
  assert.equal(aliased.body.code, 'INVALID_PLAN');

  const stale = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_stale', productionRevision: revision + 20 });
  assert.equal(stale.status, 409, stale.raw);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
  assert.equal(stale.body.currentRevision, revision);
  assert.equal(fs.existsSync(ledgerPaths(runtimeDir, created.production.budgetLedgerId).file), false);
});

test('a rejected plan and an unresolved decision do not reserve', async (t) => {
  const { routes, runtimeDir, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const proposed = await propose(routes, id, planPayload({
    requiredDecisions: [{ kind: 'voice_selection', decisionId: 'dec_voice' }],
  }));
  assert.equal(proposed.status, 201, proposed.raw);
  let revision = store.read(id).revision;
  const approved = await approve(routes, id, {
    planId: 'plan_1',
    planHash: proposed.body.planHash,
  }, revision);
  assert.equal(approved.status, 200, approved.raw);
  revision = store.read(id).revision;

  const needsDecision = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_needs_decision', productionRevision: revision });
  assert.equal(needsDecision.status, 409, needsDecision.raw);
  assert.equal(needsDecision.body.code, 'DECISION_REQUIRED');

  const resolved = await command(routes, id, 'decision.resolve', revision, {
    commandId: 'cmd_resolve_voice',
    payload: { decisionId: 'dec_voice' },
  });
  assert.equal(resolved.status, 200, resolved.raw);
  revision = store.read(id).revision;

  const rejected = await command(routes, id, 'plan.reject', revision, {
    commandId: 'cmd_reject_plan',
    payload: { planId: 'plan_1', planHash: proposed.body.planHash },
  });
  assert.equal(rejected.status, 200, rejected.raw);
  const afterReject = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_after_reject', productionRevision: store.read(id).revision });
  assert.equal(afterReject.status, 409, afterReject.raw);
  assert.equal(afterReject.body.code, 'PLAN_REJECTED');
  assert.equal(fs.existsSync(ledgerPaths(runtimeDir, created.production.budgetLedgerId).file), false);
});

test('an agent may propose and dispatch an approved plan but cannot approve it', async (t) => {
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
  const userRoutes = createProductionRoutes({
    store,
    handler,
    actions,
    contextFor: () => USER,
  });
  const agentRoutes = createProductionRoutes({
    store,
    handler,
    actions,
    contextFor: () => ({ actor: 'agent', userEventId: 'ue_agent' }),
  });

  const created = await createProduction(userRoutes);
  const id = created.productionId;
  const proposed = await propose(agentRoutes, id, planPayload(), {
    headers: { 'x-comfyrizz-actor': 'user', 'x-comfyrizz-user-event-id': 'ue_forged' },
  });
  assert.equal(proposed.status, 201, proposed.raw);
  assert.equal(proposed.body.command.actor, 'agent');
  assert.equal(proposed.body.command.userEventId, 'ue_agent');

  const selfApproval = await approve(agentRoutes, id, {
    planId: 'plan_1',
    planHash: proposed.body.planHash,
  }, store.read(id).revision);
  assert.equal(selfApproval.status, 403, selfApproval.raw);
  assert.equal(selfApproval.body.code, 'AGENT_CANNOT_APPROVE');
  assert.equal(store.readEvents(id).some((event) => event.type === 'plan.approved'), false);

  const approved = await approve(userRoutes, id, {
    planId: 'plan_1',
    planHash: proposed.body.planHash,
  }, store.read(id).revision);
  assert.equal(approved.status, 200, approved.raw);

  const admitted = await dispatch(agentRoutes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, {
    commandId: 'cmd_agent_dispatch',
    productionRevision: store.read(id).revision,
    headers: { 'x-comfyrizz-actor': 'user' },
  });
  assert.equal(admitted.status, 202, admitted.raw);
  const approvals = store.readEvents(id).filter((event) => event.type === 'plan.approved');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].userEventId, 'ue_server');
  assert.deepEqual(holds(openReservations(runtimeDir, created.production)), [2]);
});

test('the user spend cap is enforced by the ledger and is not a default', async (t) => {
  const { routes, runtimeDir, store } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const proposed = await propose(routes, id, planPayload({ actions: [slot('act_1', 4)] }));
  assert.equal(proposed.status, 201, proposed.raw);
  await approve(routes, id, { planId: 'plan_1', planHash: proposed.body.planHash }, store.read(id).revision);

  const ledger = createBudgetLedger({
    runtimeDir,
    ledgerId: created.production.budgetLedgerId,
    clock: () => new Date(AT),
  });
  ledger.setCeiling({ ceiling: 3, actor: 'user', userEventId: 'ue_cap', idempotencyKey: 'cap_3' });

  const refused = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_over_cap', productionRevision: store.read(id).revision });
  assert.equal(refused.status, 409, refused.raw);
  assert.equal(refused.body.code, 'BUDGET_EXCEEDED');
  assert.deepEqual(holds(ledger.status()), []);
  assert.deepEqual(store.read(id).actionIds, []);
});

test('a refused commit releases the reservation and RESERVATION_EXISTS is RUN_BUSY', async (t) => {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const ledger = { reserve: null, release: null, status: null, inner: null };
  const actions = createActionCoordinator({
    store,
    handler,
    ledgerFor: (production) => {
      if (!ledger.inner) {
        ledger.inner = createBudgetLedger({
          runtimeDir,
          ledgerId: production.budgetLedgerId,
          clock: () => new Date(AT),
        });
        ledger.reserve = (input) => ledger.inner.reserve(input);
        ledger.release = (input) => ledger.inner.release(input);
        ledger.status = () => ledger.inner.status();
      }
      return ledger;
    },
  });
  const routes = createProductionRoutes({
    store,
    handler,
    actions,
    contextFor: () => USER,
  });
  const created = await createProduction(routes);
  const id = created.productionId;
  const proposed = await propose(routes, id, planPayload({
    actions: [slot('act_1', 2), slot('act_2', 2)],
  }));
  assert.equal(proposed.status, 201, proposed.raw);
  await approve(routes, id, { planId: 'plan_1', planHash: proposed.body.planHash }, store.read(id).revision);

  const originalCommit = store.commit.bind(store);
  let armed = true;
  store.commit = (productionId, input) => {
    if (armed && input?.commandId === 'cmd_refuse') {
      armed = false;
      throw new ProductionStoreError('REVISION_CONFLICT', 'baseRevision does not match the committed revision', {
        currentRevision: store.read(productionId).revision,
        baseRevision: input.baseRevision,
      });
    }
    return originalCommit(productionId, input);
  };

  const refused = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_refuse', productionRevision: store.read(id).revision });
  assert.equal(refused.status, 409, refused.raw);
  assert.equal(refused.body.code, 'REVISION_CONFLICT');
  assert.deepEqual(holds(ledger.status()), []);
  assert.deepEqual(store.read(id).actionIds, []);

  store.commit = originalCommit;
  const recoveredRevision = store.read(id).revision;
  const recovered = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_refuse', productionRevision: recoveredRevision });
  assert.equal(recovered.status, 202, recovered.raw);
  assert.deepEqual(holds(ledger.status()), [2]);

  const replay = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_refuse', productionRevision: recoveredRevision });
  assert.equal(replay.status, 202, replay.raw);
  assert.equal(replay.body.duplicate, true);
  assert.deepEqual(holds(ledger.status()), [2]);

  ledger.reserve = () => {
    throw new ProductionLedgerError('RESERVATION_EXISTS', 'reservation is already open', { reservationId: 'slot_busy' });
  };
  const busy = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_2',
  }, { commandId: 'cmd_busy', productionRevision: store.read(id).revision });
  assert.equal(busy.status, 409, busy.raw);
  assert.equal(busy.body.code, 'RUN_BUSY');
  assert.deepEqual(holds(ledger.status()), [2]);
});

test('a same-command retry recovers an open reservation left by a crash before commit', async (t) => {
  const { routes, runtimeDir, store, ledgerFor } = setup(t);
  const created = await createProduction(routes);
  const id = created.productionId;
  const proposed = await propose(routes, id, planPayload());
  assert.equal(proposed.status, 201, proposed.raw);
  await approve(routes, id, { planId: 'plan_1', planHash: proposed.body.planHash }, store.read(id).revision);

  const reservationId = `slot_${createHash('sha256').update(`${proposed.body.planHash}\0act_1`).digest('hex').slice(0, 32)}`;
  const ledger = ledgerFor(created.production);
  ledger.reserve({
    reservationId,
    upperBound: 2,
    collectAndStopReserve: 0,
    idempotencyKey: 'reserve:cmd_crash',
    evidence: { source: 'action.dispatch', commandId: 'cmd_crash', planHash: proposed.body.planHash, actionId: 'act_1' },
  });
  assert.deepEqual(holds(ledger.status()), [2]);

  const recovered = await dispatch(routes, id, {
    planId: 'plan_1',
    planRevision: 0,
    actionId: 'act_1',
  }, { commandId: 'cmd_crash', productionRevision: store.read(id).revision });
  assert.equal(recovered.status, 202, recovered.raw);
  assert.equal(recovered.body.action.reservationId, reservationId);
  assert.deepEqual(holds(openReservations(runtimeDir, created.production)), [2]);
});

test('action routes are mounted on the server and ignore actor headers', async (t) => {
  const { createApp } = await import('../../src/app.mjs');
  const runtimeDir = tempRuntime(t);
  const token = 'ip20-test-token-0123456789';
  const app = createApp({
    token,
    runtimeDir,
    render: async () => ({ bytes: 0, frames: 0, hash: '0' }),
  });
  t.after(() => app.close());
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const call = httpRequest({
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-comfyrizz-token': token,
          'x-comfyrizz-actor': 'agent',
          'x-comfyrizz-user-event-id': 'ue_forged',
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: response.statusCode, json, text });
        });
      });
      call.on('error', reject);
      call.end(payload);
    });
  }

  const created = await request('POST', '/api/productions', {
    commandId: 'cmd_http_create',
    idempotencyKey: 'key_http_create',
    kind: 'production.create',
    payload: { conversationId: 'conv_http' },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.command.actor, 'user');
  assert.notEqual(created.json.command.userEventId, 'ue_forged');

  const proposed = await request('POST', `/api/productions/${created.json.productionId}/action-plans`, {
    commandId: 'cmd_http_propose',
    idempotencyKey: 'key_http_propose',
    expected: { productionRevision: 1 },
    payload: planPayload(),
  });
  assert.equal(proposed.status, 201, proposed.text);
  assert.equal(proposed.json.allocation, null);
  assert.match(proposed.json.planHash, /^[0-9a-f]{64}$/);
  assert.equal(proposed.json.command.actor, 'user');
});

test('the action module does not export rejected aliases', () => {
  const source = fs.readFileSync(new URL('../../src/productions/actions.mjs', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../../src/routes/productions.mjs', import.meta.url), 'utf8');
  for (const name of [
    'planHashFor',
    'createProductionActions',
    'createProductionActionCoordinator',
    'createActions',
    'ACTION_PLAN_ROUTE_PATTERN',
    'ACTION_ROUTE_PATTERN',
  ]) {
    assert.equal(source.includes(name), false, name);
    assert.equal(routes.includes(name), false, name);
  }
  assert.equal(source.includes('Google Colab') || !source.includes('Colab'), true);
});
