// IP24D: a bound legacy /api/run action walks queued -> dispatching -> running
// before any backend work exists. The journal may never skip a step, and a
// crash after consumption is submission_unknown, never a run that looks started.
//
// Local only: the backend is a fake that implements the runPackage contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunController } from '../src/run.mjs';
import { createProductionStore } from '../src/productions/store.mjs';
import { createCommandHandler } from '../src/productions/commands.mjs';
import { createActionCoordinator } from '../src/productions/actions.mjs';
import { createBudgetLedger } from '../src/productions/ledger.mjs';
import { ITERATION_PRESETS } from '../src/productions/iteration.mjs';
import { canTransition } from '../src/productions/contract.mjs';

const USER = Object.freeze({ actor: 'user', userEventId: 'ue_ip24d_user' });
let productionSeq = 0;

function tempRuntime(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ip24d-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function boundPackage(productionId, id = 'pkg_ip24d') {
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

function settleEntries(ledger, reservationId) {
  return ledger.entries().filter((entry) => entry.kind === 'settle' && entry.reservationId === reservationId);
}

function makeProduction(t, { upperBound = 30 } = {}) {
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
    commandId: `cmd_ip24d_create_${suffix}`,
    idempotencyKey: `key_ip24d_create_${suffix}`,
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: { conversationId: 'conv_ip24d' },
  }, USER);
  const productionId = created.productionId;

  const proposed = actions.propose({
    productionId,
    context: USER,
    body: {
      commandId: `cmd_ip24d_plan_${suffix}`,
      idempotencyKey: `key_ip24d_plan_${suffix}`,
      expected: { productionRevision: store.read(productionId).revision },
      payload: {
        planId: 'plan_ip24d',
        revision: 0,
        reservationCeiling: upperBound,
        collectAndStopReserve: 0,
        requiredDecisions: [],
        actions: [{ id: 'act_ip24d', upperBound, targetId: 'shot_1', effectiveInputHash: 'hash_ip24d' }],
      },
    },
  });
  const planHash = proposed.planHash;

  handler.execute({
    commandId: `cmd_ip24d_iteration_${suffix}`,
    idempotencyKey: `key_ip24d_iteration_${suffix}`,
    kind: 'iteration.set',
    productionId,
    expected: { productionRevision: store.read(productionId).revision },
    payload: { policy: structuredClone(ITERATION_PRESETS.balanced) },
  }, USER);

  handler.execute({
    commandId: `cmd_ip24d_approve_${suffix}`,
    idempotencyKey: `key_ip24d_approve_${suffix}`,
    kind: 'plan.approve',
    productionId,
    expected: { productionRevision: store.read(productionId).revision },
    payload: { planId: 'plan_ip24d', planHash },
  }, USER);

  const dispatched = actions.dispatch({
    productionId,
    context: USER,
    body: {
      commandId: `cmd_ip24d_dispatch_${suffix}`,
      idempotencyKey: `key_ip24d_dispatch_${suffix}`,
      expected: { productionRevision: store.read(productionId).revision },
      payload: { planId: 'plan_ip24d', planRevision: 0, actionId: 'act_ip24d' },
    },
  });

  return {
    runtimeDir,
    store,
    handler,
    actions,
    ledgerFor,
    productionId,
    planHash,
    action: dispatched.action,
    ledger: ledgerFor({ productionId }),
  };
}

function controllerFor(ctx, backendFactory, extra = {}) {
  return createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory,
    productionStore: ctx.store,
    ledgerFor: ctx.ledgerFor,
    isBusy: () => false,
    ...extra,
  });
}

function authorityFor(ctx) {
  return {
    productionId: ctx.productionId,
    planId: 'plan_ip24d',
    planHash: ctx.planHash,
    actionId: 'act_ip24d',
  };
}

function actionFrom(store, productionId) {
  let action = null;
  for (const event of store.readEvents(productionId)) {
    if (event.type === 'action.state_changed' && event.data?.id === 'act_ip24d') action = event.data;
  }
  return action;
}

function actionStateEvents(store, productionId) {
  return store.readEvents(productionId)
    .filter((event) => event.type === 'action.state_changed' && event.data?.id === 'act_ip24d')
    .map((event) => event.data);
}

function actionStates(store, productionId) {
  return actionStateEvents(store, productionId).map((data) => data.state);
}

function holds(ledger) {
  return ledger.status().openReservations.map(reservation => reservation.hold).sort((a, b) => a - b);
}

function startParams(ctx, extra = {}) {
  return {
    backendId: 'colab',
    pkg: boundPackage(ctx.productionId),
    budgetUnits: 1000,
    authority: authorityFor(ctx),
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
    ...extra,
  };
}

async function waitForAction(ctx, state, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const action = actionFrom(ctx.store, ctx.productionId);
    if (action?.state === state) return action;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`action never reached ${state}; last was ${actionFrom(ctx.store, ctx.productionId)?.state}`);
}

test('IP24D (a): a successful bound run journals queued -> dispatching -> running -> collecting -> verifying -> completed', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend({ resultSpend: 25 });
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, async () => backend);

  const started = await controller.start(startParams(ctx));
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'done');

  const states = actionStates(ctx.store, ctx.productionId);
  assert.deepEqual(states, ['queued', 'dispatching', 'running', 'collecting', 'verifying', 'completed']);
  for (let index = 1; index < states.length; index += 1) {
    assert.equal(canTransition(states[index - 1], states[index]), true, `${states[index - 1]} -> ${states[index]}`);
  }
});

test('Super Easy final mode runs once, renders once and settles its reservation once', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend({ resultSpend: 25 });
  state.gate = Promise.resolve();
  let renders = 0;
  const controller = controllerFor(ctx, async () => backend, {
    onComplete: async () => {
      renders += 1;
      return { render: { output: 'final.mp4', bytes: 1000, frames: 2880, hash: 'final-hash' } };
    },
  });
  const started = await controller.start(startParams(ctx, { mode: 'final' }));
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'done');
  assert.equal(state.realCalls, 1);
  assert.equal(renders, 1);
  assert.equal(done.render.frames, 2880);
  assert.equal(settleEntries(ctx.ledger, ctx.action.reservationId).length, 1);
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'completed');
});

test('IP24D (b): the journal never contains a queued -> running pair for the action', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend({ resultSpend: 25 });
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, async () => backend);

  const started = await controller.start(startParams(ctx));
  await controller.wait(started.runId);

  const events = actionStateEvents(ctx.store, ctx.productionId);
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1].state;
    const next = events[index].state;
    assert.equal(previous === 'queued' && next === 'running', false, `illegal pair ${previous} -> ${next}`);
    assert.equal(canTransition(previous, next), true, `illegal pair ${previous} -> ${next}`);
  }
});

test('IP24D (c): a prepare failure walks dispatching -> failed and closes the slot', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend();
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, async () => backend, {
    prepareWorkDir: async (_pkg, _dir, context) => {
      if (!context?.dryRun) {
        const error = new Error('package staging failed');
        error.code = 'PREPARE_FAILED';
        throw error;
      }
    },
  });

  await assert.rejects(() => controller.start(startParams(ctx)), /package staging failed/);

  const states = actionStates(ctx.store, ctx.productionId);
  assert.deepEqual(states, ['queued', 'dispatching', 'failed']);
  const action = actionFrom(ctx.store, ctx.productionId);
  assert.equal(action.state, 'failed');
  assert.equal(action.lastError.code, 'PREPARE_FAILED');
  assert.equal(state.realCalls, 0, 'no backend real run happened');
  assert.deepEqual(holds(ctx.ledger), []);
  assert.equal(ctx.ledger.status().spent, 0);
});

test('IP24D (d): a backend factory failure walks dispatching -> failed', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend();
  state.gate = Promise.resolve();
  let constructions = 0;
  const controller = controllerFor(ctx, async (backendId, opts) => {
    constructions += 1;
    if (constructions === 1) return backend;
    void backendId;
    void opts;
    throw new Error('backend factory boom');
  });

  const started = await controller.start(startParams(ctx));
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'failed');

  const states = actionStates(ctx.store, ctx.productionId);
  assert.deepEqual(states, ['queued', 'dispatching', 'failed']);
  const action = actionFrom(ctx.store, ctx.productionId);
  assert.equal(action.state, 'failed');
  assert.equal(action.lastError.code, 'BACKEND_UNAVAILABLE');
  assert.equal(state.realCalls, 0, 'no backend real run happened');
  assert.deepEqual(holds(ctx.ledger), []);
});

test('IP24D (e): a crash right after the dispatching commit recovers as submission_unknown with the slot still open', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend();
  state.gate = Promise.resolve();
  const hanging = controllerFor(ctx, async () => backend, {
    prepareWorkDir: async (_pkg, _dir, context) => {
      if (context?.dryRun) return;
      await new Promise(() => {});
    },
  });

  // Deliberately not awaited: the "process" stops while staging, after the
  // durable dispatching commit and before any backend instance exists.
  hanging.start(startParams(ctx));
  await waitForAction(ctx, 'dispatching');

  let backendCalls = 0;
  const restartedStore = createProductionStore({ runtimeDir: ctx.runtimeDir });
  const restartedLedger = createBudgetLedger({
    runtimeDir: ctx.runtimeDir,
    ledgerId: restartedStore.read(ctx.productionId).budgetLedgerId,
  });
  createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => { backendCalls += 1; throw new Error('a recovery must not start a backend'); },
    productionStore: restartedStore,
    ledgerFor: ({ productionId }) => (productionId === ctx.productionId ? restartedLedger : null),
    isBusy: () => false,
  });

  const states = actionStates(restartedStore, ctx.productionId);
  assert.deepEqual(states, ['queued', 'dispatching', 'submission_unknown']);
  const recovered = actionFrom(restartedStore, ctx.productionId);
  assert.equal(recovered.state, 'submission_unknown');
  assert.equal(recovered.lastError.code, 'SUBMISSION_UNKNOWN');
  assert.equal(backendCalls, 0);
  assert.deepEqual(holds(restartedLedger), [30], 'an unknown submission keeps its reservation open');
  assert.equal(settleEntries(restartedLedger, ctx.action.reservationId).length, 0);
});

test('IP24D (f): a second start for the same action is ACTION_CONSUMED', async t => {
  const ctx = makeProduction(t, { upperBound: 30 });
  const { backend, state } = fakeBackend({ resultSpend: 25 });
  state.gate = Promise.resolve();
  const controller = controllerFor(ctx, async () => backend);

  const started = await controller.start(startParams(ctx));
  await controller.wait(started.runId);

  let secondCalls = 0;
  const second = fakeBackend({ resultSpend: 25 });
  second.state.gate = Promise.resolve();
  const restartedStore = createProductionStore({ runtimeDir: ctx.runtimeDir });
  const restartedController = createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => { secondCalls += 1; return second.backend; },
    productionStore: restartedStore,
    ledgerFor: ctx.ledgerFor,
    isBusy: () => false,
  });

  const refused = await restartedController.start({
    ...startParams(ctx),
    authority: authorityFor(ctx),
    expected: { productionRevision: restartedStore.read(ctx.productionId).revision },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'ACTION_CONSUMED');
  assert.equal(secondCalls, 0);
  assert.equal(second.state.realCalls, 0);
});
