// IP20R: a required decision is met only by an approving choice.
//
// Resolving a required decision with Reject used to satisfy the plan because
// every decision.resolved id was treated as resolved. These tests pin the
// closed rule: the latest resolution for an id must name a non-empty option,
// a rejection never approves, and the coordinator blocks a rejected required
// decision instead of admitting the next paid slot.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createActionCoordinator,
  decisionApproved,
  REJECTING_OPTION_IDS,
} from '../../src/productions/actions.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import { createProductionCoordinator } from '../../src/productions/coordinator.mjs';
import { createBudgetLedger, ledgerPaths } from '../../src/productions/ledger.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createProductionRoutes } from '../../src/routes/productions.mjs';

const AT = '2026-10-22T12:00:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_server' });

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-decision-approval-'));
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

function slot(id, upperBound) {
  return { id, upperBound, targetId: `shot_${id}`, effectiveInputHash: `hash_${id}`, seed: 1 };
}

function planPayload(requiredDecisions, overrides = {}) {
  return {
    planId: 'plan_1',
    revision: 0,
    reservationCeiling: 5,
    collectAndStopReserve: 0,
    requiredDecisions,
    actions: [slot('act_1', 2)],
    ...overrides,
  };
}

async function createProduction(routes) {
  const response = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: {
      commandId: 'cmd_create',
      idempotencyKey: 'key_create',
      kind: 'production.create',
      payload: { conversationId: 'conv_1' },
    },
  });
  assert.equal(response.status, 201, response.raw);
  return response.body.productionId;
}

async function propose(routes, productionId, payload) {
  const response = await call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/action-plans`,
    body: {
      commandId: 'cmd_propose',
      idempotencyKey: 'key_propose',
      expected: { productionRevision: 1 },
      payload,
    },
  });
  assert.equal(response.status, 201, response.raw);
  return response.body;
}

async function command(routes, productionId, kind, revision, payload, suffix) {
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/commands`,
    body: {
      commandId: `cmd_${suffix}`,
      idempotencyKey: `key_${suffix}`,
      kind,
      productionId,
      expected: { productionRevision: revision },
      payload,
    },
  });
}

async function setIterationLevel(routes, productionId, suffix) {
  const production = await call(routes, {
    method: 'GET',
    url: `/api/productions/${productionId}`,
  });
  assert.equal(production.status, 200, production.raw);
  const response = await command(routes, productionId, 'iteration.set', production.body.revision, {
    policy: structuredClone(ITERATION_PRESETS.balanced),
  }, suffix);
  assert.equal(response.status, 200, response.raw);
}

async function approvePlan(routes, productionId, plan, suffix = 'approve') {
  await setIterationLevel(routes, productionId, `iteration_${suffix}`);
  const production = await call(routes, {
    method: 'GET',
    url: `/api/productions/${productionId}`,
  });
  assert.equal(production.status, 200, production.raw);
  const response = await command(routes, productionId, 'plan.approve', production.body.revision, {
    planId: plan.id,
    planHash: plan.planHash,
  }, suffix);
  assert.equal(response.status, 200, response.raw);
}

async function resolveDecision(routes, productionId, payload, suffix) {
  const production = await call(routes, {
    method: 'GET',
    url: `/api/productions/${productionId}`,
  });
  assert.equal(production.status, 200, production.raw);
  const response = await command(
    routes,
    productionId,
    'decision.resolve',
    production.body.production.revision,
    payload,
    suffix,
  );
  assert.equal(response.status, 200, response.raw);
  return response;
}

async function dispatch(routes, productionId, suffix = 'dispatch') {
  const production = await call(routes, {
    method: 'GET',
    url: `/api/productions/${productionId}`,
  });
  assert.equal(production.status, 200, production.raw);
  return call(routes, {
    method: 'POST',
    url: `/api/productions/${productionId}/actions`,
    body: {
      commandId: `cmd_${suffix}`,
      idempotencyKey: `key_${suffix}`,
      expected: { productionRevision: production.body.production.revision },
      payload: { planId: 'plan_1', planRevision: 0, actionId: 'act_1' },
    },
  });
}

function ledgerStatus(runtimeDir, production) {
  const ledger = createBudgetLedger({
    runtimeDir,
    ledgerId: production.budgetLedgerId,
    clock: () => new Date(AT),
  });
  return ledger.status();
}

test('a rejected required decision cannot dispatch and blocks the coordinator', async (t) => {
  const { routes, runtimeDir, store, coordinator } = setup(t);
  const id = await createProduction(routes);
  const proposed = await propose(routes, id, planPayload([{ decisionId: 'dec_cast' }]));
  await approvePlan(routes, id, proposed.plan);

  await resolveDecision(routes, id, { decisionId: 'dec_cast', optionId: 'reject' }, 'resolve_reject');

  const refused = await dispatch(routes, id, 'dispatch_rejected');
  assert.equal(refused.status, 409, refused.raw);
  assert.equal(refused.body.code, 'DECISION_REQUIRED');

  const status = ledgerStatus(runtimeDir, store.read(id));
  assert.deepEqual(status.openReservations, []);
  assert.equal(fs.existsSync(ledgerPaths(runtimeDir, store.read(id).budgetLedgerId).file), true);
  assert.deepEqual(store.read(id).actionIds, []);

  const next = coordinator.nextStep(id);
  assert.equal(next.kind, 'blocked');
  assert.equal(next.reason, 'decision_rejected');

  const drained = coordinator.continue(id, { force: true });
  assert.equal(drained.executed, 0);
  assert.deepEqual(store.read(id).actionIds, []);
  assert.deepEqual(ledgerStatus(runtimeDir, store.read(id)).openReservations, []);
});

test('an approving required decision still dispatches exactly one reservation', async (t) => {
  const { routes, runtimeDir, store, coordinator } = setup(t);
  const id = await createProduction(routes);
  const proposed = await propose(routes, id, planPayload([{ decisionId: 'dec_cast' }]));
  await approvePlan(routes, id, proposed.plan);

  await resolveDecision(routes, id, { decisionId: 'dec_cast', optionId: 'approve' }, 'resolve_approve');

  const admitted = await dispatch(routes, id, 'dispatch_approved');
  assert.equal(admitted.status, 202, admitted.raw);
  assert.equal(admitted.body.action.id, 'act_1');
  assert.deepEqual(store.read(id).actionIds, ['act_1']);

  const status = ledgerStatus(runtimeDir, store.read(id));
  assert.equal(status.openReservations.length, 1);
  assert.deepEqual(status.openReservations.map((entry) => entry.hold), [2]);
  assert.equal(coordinator.nextStep(id).kind, 'wait');
});

test('the latest resolution wins: an approval followed by a rejection is unmet', async (t) => {
  const { routes, runtimeDir, store, coordinator } = setup(t);
  const id = await createProduction(routes);
  const proposed = await propose(routes, id, planPayload([{ decisionId: 'dec_cast' }]));
  await approvePlan(routes, id, proposed.plan);

  await resolveDecision(routes, id, { decisionId: 'dec_cast', optionId: 'approve' }, 'resolve_approve');
  await resolveDecision(routes, id, { decisionId: 'dec_cast', optionId: 'reject' }, 'resolve_reject');

  const refused = await dispatch(routes, id, 'dispatch_latest_reject');
  assert.equal(refused.status, 409, refused.raw);
  assert.equal(refused.body.code, 'DECISION_REQUIRED');
  assert.deepEqual(ledgerStatus(runtimeDir, store.read(id)).openReservations, []);
  assert.equal(coordinator.nextStep(id).kind, 'blocked');
  assert.equal(coordinator.nextStep(id).reason, 'decision_rejected');
});

test('a resolution without an optionId is not an approval and stays pending', async (t) => {
  const { routes, runtimeDir, store, coordinator } = setup(t);
  const id = await createProduction(routes);
  const proposed = await propose(routes, id, planPayload([{ decisionId: 'dec_cast' }]));
  await approvePlan(routes, id, proposed.plan);

  await resolveDecision(routes, id, { decisionId: 'dec_cast' }, 'resolve_no_option');

  const refused = await dispatch(routes, id, 'dispatch_no_option');
  assert.equal(refused.status, 409, refused.raw);
  assert.equal(refused.body.code, 'DECISION_REQUIRED');
  assert.deepEqual(ledgerStatus(runtimeDir, store.read(id)).openReservations, []);

  const next = coordinator.nextStep(id);
  assert.equal(next.kind, 'await_decision');
  assert.equal(next.reason, 'decisions_pending');
  assert.deepEqual(next.decisionIds, ['dec_cast']);
});

test('a requirement that names an option only accepts that option', async (t) => {
  const wrong = setup(t);
  const wrongId = await createProduction(wrong.routes);
  const wrongPlan = await propose(
    wrong.routes,
    wrongId,
    planPayload([{ decisionId: 'dec_cast', optionId: 'opt_b' }]),
  );
  await approvePlan(wrong.routes, wrongId, wrongPlan.plan);
  await resolveDecision(wrong.routes, wrongId, { decisionId: 'dec_cast', optionId: 'opt_a' }, 'resolve_a');

  const refused = await dispatch(wrong.routes, wrongId, 'dispatch_opt_a');
  assert.equal(refused.status, 409, refused.raw);
  assert.equal(refused.body.code, 'DECISION_REQUIRED');
  assert.deepEqual(ledgerStatus(wrong.runtimeDir, wrong.store.read(wrongId)).openReservations, []);
  const pendingStep = wrong.coordinator.nextStep(wrongId);
  assert.equal(pendingStep.kind, 'await_decision');
  assert.deepEqual(pendingStep.decisionIds, ['dec_cast']);

  const right = setup(t);
  const rightId = await createProduction(right.routes);
  const rightPlan = await propose(
    right.routes,
    rightId,
    planPayload([{ decisionId: 'dec_cast', optionId: 'opt_b' }]),
  );
  await approvePlan(right.routes, rightId, rightPlan.plan);
  await resolveDecision(right.routes, rightId, { decisionId: 'dec_cast', optionId: 'opt_b' }, 'resolve_b');

  const admitted = await dispatch(right.routes, rightId, 'dispatch_opt_b');
  assert.equal(admitted.status, 202, admitted.raw);
  const status = ledgerStatus(right.runtimeDir, right.store.read(rightId));
  assert.equal(status.openReservations.length, 1);
  assert.deepEqual(status.openReservations.map((entry) => entry.hold), [2]);
});

test('decisionApproved is the shared closed rule', () => {
  const production = { pendingDecisionIds: [] };
  const resolution = (optionId, extra = {}) => [{
    type: 'decision.resolved',
    data: { decisionId: 'dec_cast', optionId, ...extra },
  }];

  assert.equal(decisionApproved(resolution('approve'), production, 'dec_cast'), true);
  assert.equal(decisionApproved(resolution('reject'), production, 'dec_cast'), false);
  for (const id of REJECTING_OPTION_IDS) {
    assert.equal(decisionApproved(resolution(id), production, 'dec_cast'), false, id);
  }
  assert.equal(decisionApproved(resolution(undefined), production, 'dec_cast'), false);
  assert.equal(decisionApproved(resolution(''), production, 'dec_cast'), false);
  assert.equal(decisionApproved(resolution('approve'), { pendingDecisionIds: ['dec_cast'] }, 'dec_cast'), false);
  assert.equal(decisionApproved(resolution('reject', { status: 'rejected' }), production, 'dec_cast'), false);
  assert.equal(
    decisionApproved(resolution('opt_a'), production, { decisionId: 'dec_cast', optionId: 'opt_b' }),
    false,
  );
  assert.equal(
    decisionApproved(resolution('opt_b'), production, { decisionId: 'dec_cast', optionId: 'opt_b' }),
    true,
  );
  assert.equal(
    decisionApproved(resolution('opt_b'), production, { decisionId: 'dec_cast', approveOptionIds: ['opt_b'] }),
    true,
  );
  assert.equal(
    decisionApproved(resolution('opt_a'), production, { decisionId: 'dec_cast', approveOptionIds: ['opt_b'] }),
    false,
  );
});
