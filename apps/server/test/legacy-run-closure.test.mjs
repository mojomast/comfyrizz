// IP24: legacy run closure. A production-bound package may only start through
// the IP20 authority it was dispatched with, and the action slot is consumed
// durably before any paid backend work. The legacy /api/run approval cannot
// bless a plan that lives in a production journal.
//
// Local only: the backend is a fake that implements the runPackage contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.mjs';
import { createRunController } from '../src/run.mjs';
import { createProductionStore } from '../src/productions/store.mjs';
import { createCommandHandler } from '../src/productions/commands.mjs';
import { createActionCoordinator } from '../src/productions/actions.mjs';
import { createBudgetLedger } from '../src/productions/ledger.mjs';

const USER = Object.freeze({ actor: 'user', userEventId: 'ue_ip24_user' });
let productionSeq = 0;

function tempRuntime(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ip24-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function boundPackage(productionId, id = 'pkg_ip24') {
  return { id, schema: 'comfyrizz.package/1', productionId, assets: {}, scenes: [] };
}

function fakeBackend({ gpuMinutes = 60, resultSpend = null } = {}) {
  const state = { realCalls: 0, entered: null, release: null };
  state.entered = new Promise(resolve => { state.resolveEntered = resolve; });
  state.gate = new Promise(resolve => { state.release = resolve; });
  const jobsDoc = { jobs: [{ id: 'j1' }] };
  const estimate = { gpuMinutes, overheadMinutes: 5, ratePerHour: 8.9 };
  const backend = {
    id: 'colab',
    async describe() {
      return { label: 'Google Colab G4', costVisibility: 'account-estimate' };
    },
    async runPackage(_pkg, opts = {}) {
      if (opts.dryRun) return { jobsDoc, estimate, teardown: null };
      state.realCalls += 1;
      state.resolveEntered();
      if (opts.hold !== false) await state.gate;
      return {
        ok: true,
        jobsDoc,
        estimate,
        manifest: { complete: true, counts: { succeeded: 1 } },
        counts: { succeeded: 1 },
        applied: [],
        teardown: { state: 'stopped' },
        ...(resultSpend === null ? {} : { spend: { units: resultSpend } }),
      };
    },
    async teardown() {
      return { state: 'stopped', evidence: 'fake teardown' };
    },
  };
  return { backend, state };
}

function failingBackend() {
  const jobsDoc = { jobs: [{ id: 'j1' }] };
  const estimate = { gpuMinutes: 60, overheadMinutes: 5, ratePerHour: 8.9 };
  return {
    id: 'colab',
    async describe() {
      return { label: 'Google Colab G4', costVisibility: 'account-estimate' };
    },
    async runPackage(_pkg, opts = {}) {
      if (opts.dryRun) return { jobsDoc, estimate, teardown: null };
      opts.onEvent?.({ v: 1, event: 'run_phase', phase: 'allocating' });
      const error = new Error('job blew up');
      error.code = 'JOB_FAILED';
      error.spend = { units: 4.5 };
      error.runPackage = {
        jobsDoc,
        estimate,
        up: { state: 'created' },
        teardown: { state: 'stopped' },
        spend: { units: 4.5 },
        manifest: null,
        counts: null,
      };
      throw error;
    },
    async teardown() {
      return { state: 'stopped', evidence: 'fake teardown' };
    },
  };
}

function settleEntries(ledger, reservationId) {
  return ledger.entries().filter((entry) => entry.kind === 'settle' && entry.reservationId === reservationId);
}

function makeProduction(t, { upperBound = 30, packageId = null } = {}) {
  productionSeq += 1;
  const suffix = String(productionSeq);
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir });
  const handler = createCommandHandler({ store });
  const ledgers = new Map();
  const ledgerFor = (target) => {
    const productionId = target?.productionId ?? target?.id ?? null;
    if (!productionId) return null;
    let ledger = ledgers.get(productionId);
    if (!ledger) {
      const production = store.read(productionId);
      if (!production) return null;
      ledger = createBudgetLedger({ runtimeDir, ledgerId: production.budgetLedgerId });
      ledgers.set(productionId, ledger);
    }
    return ledger;
  };
  const actions = createActionCoordinator({ store, handler, ledgerFor });

  const created = handler.execute({
    commandId: `cmd_ip24_create_${suffix}`,
    idempotencyKey: `key_ip24_create_${suffix}`,
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: { conversationId: 'conv_ip24', ...(packageId ? { packageId } : {}) },
  }, USER);
  const productionId = created.productionId;

  const proposed = actions.propose({
    productionId,
    context: USER,
    body: {
      commandId: `cmd_ip24_plan_${suffix}`,
      idempotencyKey: `key_ip24_plan_${suffix}`,
      expected: { productionRevision: store.read(productionId).revision },
      payload: {
        planId: 'plan_ip24',
        revision: 0,
        reservationCeiling: upperBound,
        collectAndStopReserve: 0,
        requiredDecisions: [],
        actions: [{ id: 'act_ip24', upperBound, targetId: 'shot_1', effectiveInputHash: 'hash_ip24' }],
      },
    },
  });
  const planHash = proposed.planHash;

  handler.execute({
    commandId: `cmd_ip24_approve_${suffix}`,
    idempotencyKey: `key_ip24_approve_${suffix}`,
    kind: 'plan.approve',
    productionId,
    expected: { productionRevision: store.read(productionId).revision },
    payload: { planId: 'plan_ip24', planHash },
  }, USER);

  const dispatched = actions.dispatch({
    productionId,
    context: USER,
    body: {
      commandId: `cmd_ip24_dispatch_${suffix}`,
      idempotencyKey: `key_ip24_dispatch_${suffix}`,
      expected: { productionRevision: store.read(productionId).revision },
      payload: { planId: 'plan_ip24', planRevision: 0, actionId: 'act_ip24' },
    },
  });

  return {
    runtimeDir,
    store,
    handler,
    actions,
    ledgerFor,
    ledgers,
    productionId,
    planHash,
    action: dispatched.action,
    ledger: ledgerFor({ productionId }),
  };
}

function controllerFor(ctx, backend, extra = {}) {
  return createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => backend,
    productionStore: ctx.store,
    ledgerFor: ctx.ledgerFor,
    isBusy: () => false,
    ...extra,
  });
}

function authorityFor(ctx) {
  return {
    productionId: ctx.productionId,
    planId: 'plan_ip24',
    planHash: ctx.planHash,
    actionId: 'act_ip24',
  };
}

function actionFrom(store, productionId) {
  let action = null;
  for (const event of store.readEvents(productionId)) {
    if (event.type === 'action.state_changed' && event.data?.id === 'act_ip24') action = event.data;
  }
  return action;
}

function holds(ledger) {
  return ledger.status().openReservations.map(reservation => reservation.hold).sort((a, b) => a - b);
}

test('IP24: an unbound package keeps the legacy run flow', async t => {
  const runtimeDir = tempRuntime(t);
  const { backend, state } = fakeBackend({ gpuMinutes: 0 });
  state.gate = Promise.resolve();
  const controller = createRunController({ runtimeDir, backendFactory: async () => backend });
  const started = await controller.start({
    backendId: 'colab',
    pkg: { id: 'pkg_unbound', assets: {}, scenes: [] },
    budgetUnits: 100,
    approved: true,
  });
  assert.equal(started.status, 'starting');
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'done');
});

test('IP24: a bound package refuses bare approved:true with BOUND_AUTHORITY_REQUIRED', async t => {
  const ctx = makeProduction(t);
  const { backend, state } = fakeBackend();
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, backend);

  const refused = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    approved: true,
  });

  assert.equal(refused.status, 400);
  assert.equal(refused.code, 'BOUND_AUTHORITY_REQUIRED');
  assert.equal(state.realCalls, 0);
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'queued');
  assert.deepEqual(holds(ctx.ledger), [30]);
});

test('IP24: a bound start consumes the queued action and uses the single slot hold', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend({ resultSpend: 25 });
  const controller = controllerFor(ctx, backend);

  const started = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
  });
  assert.equal(started.status, 'starting');

  await state.entered;
  assert.deepEqual(actionStates(ctx.store, ctx.productionId), ['queued', 'dispatching', 'running'], 'the action walks every step before running');
  const running = actionFrom(ctx.store, ctx.productionId);
  assert.equal(running.state, 'running');
  assert.equal(running.runId, started.runId);
  assert.deepEqual(holds(ctx.ledger), [30], 'no second admission hold is opened');

  state.release();
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'done');
  assert.equal(done.settled.kind, 'actual');
  assert.equal(done.settled.units, 25, 'the ledger records the real usage, not a capped estimate');
  assert.equal(ctx.ledger.status().spent, 25);
  assert.deepEqual(holds(ctx.ledger), []);
});

test('IP24L: a completed bound run journals action completion and settles the slot once', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend({ resultSpend: 25 });
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, backend);

  const started = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
  });
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'done');

  const action = actionFrom(ctx.store, ctx.productionId);
  assert.equal(action.state, 'completed');
  assert.equal(action.runId, started.runId);
  assert.equal(action.lastError, null);
  assert.deepEqual(holds(ctx.ledger), []);

  const settlements = settleEntries(ctx.ledger, ctx.action.reservationId);
  assert.equal(settlements.length, 1, 'the IP20 slot is settled exactly once');
  assert.equal(settlements[0].charged, 25, 'the ledger records the real usage, never the slot cap');

  await controller.wait(started.runId);
  assert.equal(settleEntries(ctx.ledger, ctx.action.reservationId).length, 1, 'a second wait does not settle again');
});

test('IP24L: a failed bound run journals the failure with lastError', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const controller = controllerFor(ctx, failingBackend());

  const started = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
  });
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'failed');

  const action = actionFrom(ctx.store, ctx.productionId);
  assert.equal(action.state, 'failed');
  assert.equal(action.runId, started.runId);
  assert.equal(action.lastError.code, 'JOB_FAILED');
  assert.match(action.lastError.message, /job blew up/);

  const settlements = settleEntries(ctx.ledger, ctx.action.reservationId);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].charged, 4.5);
  assert.deepEqual(holds(ctx.ledger), []);
});

test('IP24L: a restart after the run ends but before the journal completes the action once', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend({ resultSpend: 25 });
  state.gate = Promise.resolve();
  const crashingStore = {
    ...ctx.store,
    commit(productionId, input) {
      if (typeof input?.commandId === 'string' && input.commandId.startsWith('run-end:')) {
        const error = new Error('injected crash before the end journal write');
        error.code = 'ECRASH';
        throw error;
      }
      return ctx.store.commit(productionId, input);
    },
  };
  const controller = createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => backend,
    productionStore: crashingStore,
    ledgerFor: ctx.ledgerFor,
    isBusy: () => false,
  });

  const started = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
  });
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'done');
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'running', 'the journal never wrote the end');
  assert.equal(settleEntries(ctx.ledger, ctx.action.reservationId).length, 1, 'the ledger settled before the crash');
  assert.deepEqual(holds(ctx.ledger), []);

  const restartedStore = createProductionStore({ runtimeDir: ctx.runtimeDir });
  const restartedLedger = createBudgetLedger({
    runtimeDir: ctx.runtimeDir,
    ledgerId: restartedStore.read(ctx.productionId).budgetLedgerId,
  });
  createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => { throw new Error('a recovery must not start a backend'); },
    productionStore: restartedStore,
    ledgerFor: ({ productionId }) => (productionId === ctx.productionId ? restartedLedger : null),
    isBusy: () => false,
  });

  const recovered = actionFrom(restartedStore, ctx.productionId);
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.runId, started.runId);
  assert.equal(settleEntries(restartedLedger, ctx.action.reservationId).length, 1, 'recovery does not settle twice');
  assert.deepEqual(holds(restartedLedger), []);

  createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => { throw new Error('a recovery must not start a backend'); },
    productionStore: createProductionStore({ runtimeDir: ctx.runtimeDir }),
    ledgerFor: ({ productionId }) => (productionId === ctx.productionId ? restartedLedger : null),
    isBusy: () => false,
  });
  assert.equal(settleEntries(restartedLedger, ctx.action.reservationId).length, 1, 'a second restart is a no-op');
  assert.equal(actionFrom(restartedStore, ctx.productionId).state, 'completed');
});

test('IP24: an estimate above the slot is refused before consumption', async t => {
  const ctx = makeProduction(t, { upperBound: 5 });
  const { backend, state } = fakeBackend({ gpuMinutes: 60 });
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, backend);

  const refused = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
  });

  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'SLOT_BOUND_EXCEEDED');
  assert.equal(state.realCalls, 0);
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'queued');
  assert.deepEqual(holds(ctx.ledger), [5]);
});

test('IP24: a stale expected revision is REVISION_CONFLICT and consumes nothing', async t => {
  const ctx = makeProduction(t);
  const { backend, state } = fakeBackend();
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, backend);
  const current = ctx.store.read(ctx.productionId).revision;

  const refused = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: current - 1 },
  });

  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'REVISION_CONFLICT');
  assert.equal(refused.currentRevision, current);
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'queued');
});

test('IP24: a rejection wins over an earlier approval', async t => {
  const ctx = makeProduction(t);
  ctx.handler.execute({
    commandId: 'cmd_ip24_reject',
    idempotencyKey: 'key_ip24_reject',
    kind: 'plan.reject',
    productionId: ctx.productionId,
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
    payload: { planId: 'plan_ip24', planHash: ctx.planHash },
  }, USER);
  const { backend, state } = fakeBackend();
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, backend);

  const refused = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
  });

  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'PLAN_REJECTED');
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'queued');
});

test('IP24: a fresh controller over the same runtime refuses a consumed action', async t => {
  const ctx = makeProduction(t);
  const first = fakeBackend({ gpuMinutes: 0 });
  first.state.gate = Promise.resolve();
  const controller = controllerFor(ctx, first.backend);
  const started = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
  });
  await controller.wait(started.runId);

  const restartedStore = createProductionStore({ runtimeDir: ctx.runtimeDir });
  const restartedLedgers = new Map();
  const restartedLedgerFor = (target) => {
    const productionId = target?.productionId ?? target?.id ?? null;
    if (!productionId) return null;
    if (!restartedLedgers.has(productionId)) {
      const production = restartedStore.read(productionId);
      if (!production) return null;
      restartedLedgers.set(productionId, createBudgetLedger({
        runtimeDir: ctx.runtimeDir,
        ledgerId: production.budgetLedgerId,
      }));
    }
    return restartedLedgers.get(productionId);
  };
  const second = fakeBackend({ gpuMinutes: 0 });
  second.state.gate = Promise.resolve();
  const restarted = createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => second.backend,
    productionStore: restartedStore,
    ledgerFor: restartedLedgerFor,
  });

  const refused = await restarted.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: restartedStore.read(ctx.productionId).revision },
  });

  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'ACTION_CONSUMED');
  assert.equal(second.state.realCalls, 0);
  assert.equal(actionFrom(restartedStore, ctx.productionId).runId, started.runId);
});

test('IP24: a prepare failure after consumption marks the action failed and closes the hold', async t => {
  const ctx = makeProduction(t);
  const { backend, state } = fakeBackend();
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, backend, {
    prepareWorkDir: async (_pkg, _dir, context) => {
      if (!context?.dryRun) {
        const error = new Error('package staging failed');
        error.code = 'PREPARE_FAILED';
        throw error;
      }
    },
  });

  await assert.rejects(() => controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
  }), /package staging failed/);

  const action = actionFrom(ctx.store, ctx.productionId);
  assert.equal(action.state, 'failed');
  assert.equal(action.lastError.code, 'PREPARE_FAILED');
  assert.equal(state.realCalls, 0);
  assert.deepEqual(holds(ctx.ledger), []);
  assert.equal(ctx.ledger.status().spent, 0);
});

test('IP24: the authority production must match the bound package', async t => {
  const ctx = makeProduction(t);
  const other = makeProduction(t);
  const { backend, state } = fakeBackend();
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, backend);

  const refused = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: { ...authorityFor(ctx), productionId: other.productionId },
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
  });

  assert.equal(refused.status, 403);
  assert.equal(refused.code, 'PRODUCTION_MISMATCH');
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'queued');
});

function httpClient(server, token) {
  const port = server.address().port;
  return (method, path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'x-comfyrizz-token': token,
        origin: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, json: text ? JSON.parse(text) : null });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test('IP24: the HTTP route rejects bare approved:true for a bound package with a code', async t => {
  const runtimeDir = tempRuntime(t);
  const app = createApp({
    token: 'ip24-token-0123456789abcdef',
    runtimeDir,
    backendFactory: async () => { throw new Error('no backend in this test'); },
    render: async () => ({ output: 'none', bytes: 0, frames: 0, hash: 'none' }),
  });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = httpClient(server, 'ip24-token-0123456789abcdef');
  try {
    const refused = await call('POST', '/api/run', {
      backendId: 'colab',
      package: boundPackage('prod_http_bound', 'pkg_http_bound'),
      budgetUnits: 100,
      approved: true,
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, 'BOUND_AUTHORITY_REQUIRED');
  } finally {
    app.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('IP24: /api/run/approve refuses a plan that lives in a production journal', async t => {
  const runtimeDir = tempRuntime(t);
  const app = createApp({
    token: 'ip24-token-0123456789abcdef',
    runtimeDir,
    backendFactory: async () => { throw new Error('no backend in this test'); },
    render: async () => ({ output: 'none', bytes: 0, frames: 0, hash: 'none' }),
  });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = httpClient(server, 'ip24-token-0123456789abcdef');
  try {
    const created = await call('POST', '/api/productions', {
      commandId: 'cmd_ip24_http_create',
      idempotencyKey: 'key_ip24_http_create',
      kind: 'production.create',
      expected: { productionRevision: 0 },
      payload: { conversationId: 'conv_ip24_http' },
    });
    assert.equal(created.status, 201);
    const productionId = created.json.productionId;
    const proposed = await call('POST', `/api/productions/${productionId}/action-plans`, {
      commandId: 'cmd_ip24_http_plan',
      idempotencyKey: 'key_ip24_http_plan',
      expected: { productionRevision: created.json.revision },
      payload: {
        planId: 'plan_ip24_http',
        revision: 0,
        reservationCeiling: 10,
        requiredDecisions: [],
        actions: [{ id: 'act_ip24_http', upperBound: 10 }],
      },
    });
    assert.equal(proposed.status, 201);
    const refused = await call('POST', '/api/run/approve', { planHash: proposed.json.planHash });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'PLAN_BOUND_TO_PRODUCTION');
  } finally {
    app.close();
    await new Promise(resolve => server.close(resolve));
  }
});

// IP24L review fix-up: the end commit must follow spec 6.4 (no running ->
// completed edge), and a running action whose run left no finished record is
// submission_unknown after a restart, never completed and never restarted.
function actionStates(store, productionId) {
  return store.readEvents(productionId)
    .filter((event) => event.type === 'action.state_changed')
    .map((event) => event.data.state);
}

test('IP24L fix-up: a completed run walks running -> collecting -> verifying -> completed', async t => {
  const { canTransition } = await import('../src/productions/contract.mjs');
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend({ resultSpend: 25 });
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, backend);
  const started = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
  });
  await controller.wait(started.runId);
  const states = actionStates(ctx.store, ctx.productionId);
  const tail = states.slice(states.lastIndexOf('running'));
  assert.deepEqual(tail, ['running', 'collecting', 'verifying', 'completed']);
  for (let index = 1; index < tail.length; index += 1) {
    assert.equal(canTransition(tail[index - 1], tail[index]), true, `${tail[index - 1]} -> ${tail[index]}`);
  }
});

test('IP24L fix-up: a running action with no finished run record is submission_unknown after a restart', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend({ resultSpend: 25 });
  const controller = controllerFor(ctx, backend);
  const started = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
  });
  await state.entered;
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'running');

  let backendCalls = 0;
  const restartedStore = createProductionStore({ runtimeDir: ctx.runtimeDir });
  createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => { backendCalls += 1; throw new Error('a recovery must not start a backend'); },
    productionStore: restartedStore,
    ledgerFor: ctx.ledgerFor,
    isBusy: () => false,
  });
  const recovered = actionFrom(restartedStore, ctx.productionId);
  assert.equal(recovered.state, 'submission_unknown');
  assert.equal(recovered.runId, started.runId);
  assert.equal(recovered.lastError.code, 'SUBMISSION_UNKNOWN');
  assert.equal(backendCalls, 0);
  assert.equal(settleEntries(ctx.ledger, ctx.action.reservationId).length, 0, 'an unknown submission keeps its reservation open');

  state.release();
  await controller.wait(started.runId);
});
