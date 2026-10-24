// IP24C: a bound legacy /api/run action that is cancel_requested when its run
// ends must be settled to `cancelled` exactly once, and its IP20 slot must be
// settled with what really happened (IP06): actual units when reported, zero
// only when no GPU could have been allocated, and the full reservation when
// usage is unknown.
//
// Local only: the backend is a fake that implements the runPackage contract,
// and the runtime directory is a temp directory. No network, no real Google
// Colab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunController } from '../src/run.mjs';
import { createProductionStore } from '../src/productions/store.mjs';
import { createCommandHandler } from '../src/productions/commands.mjs';
import { createActionCoordinator } from '../src/productions/actions.mjs';
import { createBudgetLedger } from '../src/productions/ledger.mjs';
import { ITERATION_PRESETS } from '../src/productions/iteration.mjs';
import { canTransition } from '../src/productions/contract.mjs';

const USER = Object.freeze({ actor: 'user', userEventId: 'ue_ip24c_user' });
const UPPER_BOUND = 30;
let productionSeq = 0;

function tempRuntime(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ip24c-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function boundPackage(productionId, id = 'pkg_ip24c') {
  return { id, schema: 'comfyrizz.package/1', productionId, assets: {}, scenes: [] };
}

function jobsAndEstimate() {
  return {
    jobsDoc: { jobs: [{ id: 'j1' }] },
    estimate: { gpuMinutes: 60, overheadMinutes: 5, ratePerHour: 8.9 },
  };
}

/**
 * A fake Google Colab-shaped backend whose real run waits on a promise the test
 * resolves. `behavior` decides how the real run ends.
 */
function fakeBackend({ resultSpend = null, behavior = 'complete' } = {}) {
  const state = { realCalls: 0, entered: null, release: null };
  state.entered = new Promise(resolve => { state.resolveEntered = resolve; });
  state.gate = new Promise(resolve => { state.release = resolve; });
  const { jobsDoc, estimate } = jobsAndEstimate();
  const backend = {
    id: 'colab',
    async describe() {
      return { label: 'Google Colab G4', costVisibility: 'account-estimate' };
    },
    async runPackage(_pkg, opts = {}) {
      if (opts.dryRun) return { jobsDoc, estimate, teardown: null };
      state.realCalls += 1;
      state.resolveEntered();
      await state.gate;
      if (behavior === 'fail-before-allocating') {
        const error = new Error('job failed before allocation');
        error.code = 'JOB_FAILED';
        error.runPackage = { jobsDoc, estimate, up: null, session: null, teardown: null, manifest: null, counts: null };
        throw error;
      }
      if (behavior === 'fail-after-allocating') {
        opts.onEvent?.({ v: 1, event: 'allocating' });
        const error = new Error('job blew up after allocation');
        error.code = 'JOB_FAILED';
        throw error;
      }
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

function makeProduction(t, { upperBound = UPPER_BOUND } = {}) {
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
    commandId: `cmd_ip24c_create_${suffix}`,
    idempotencyKey: `key_ip24c_create_${suffix}`,
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: { conversationId: 'conv_ip24c' },
  }, USER);
  const productionId = created.productionId;

  const proposed = actions.propose({
    productionId,
    context: USER,
    body: {
      commandId: `cmd_ip24c_plan_${suffix}`,
      idempotencyKey: `key_ip24c_plan_${suffix}`,
      expected: { productionRevision: store.read(productionId).revision },
      payload: {
        planId: 'plan_ip24c',
        revision: 0,
        reservationCeiling: upperBound,
        collectAndStopReserve: 0,
        requiredDecisions: [],
        actions: [{ id: 'act_ip24c', upperBound, targetId: 'shot_1', effectiveInputHash: 'hash_ip24c' }],
      },
    },
  });
  const planHash = proposed.planHash;

  handler.execute({
    commandId: `cmd_ip24c_iteration_${suffix}`,
    idempotencyKey: `key_ip24c_iteration_${suffix}`,
    kind: 'iteration.set',
    productionId,
    expected: { productionRevision: store.read(productionId).revision },
    payload: { policy: structuredClone(ITERATION_PRESETS.balanced) },
  }, USER);

  handler.execute({
    commandId: `cmd_ip24c_approve_${suffix}`,
    idempotencyKey: `key_ip24c_approve_${suffix}`,
    kind: 'plan.approve',
    productionId,
    expected: { productionRevision: store.read(productionId).revision },
    payload: { planId: 'plan_ip24c', planHash },
  }, USER);

  const dispatched = actions.dispatch({
    productionId,
    context: USER,
    body: {
      commandId: `cmd_ip24c_dispatch_${suffix}`,
      idempotencyKey: `key_ip24c_dispatch_${suffix}`,
      expected: { productionRevision: store.read(productionId).revision },
      payload: { planId: 'plan_ip24c', planRevision: 0, actionId: 'act_ip24c' },
    },
  });

  return {
    suffix,
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
    planId: 'plan_ip24c',
    planHash: ctx.planHash,
    actionId: 'act_ip24c',
  };
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

function actionFrom(store, productionId) {
  let action = null;
  for (const event of store.readEvents(productionId)) {
    if (event.type === 'action.state_changed' && event.data?.id === 'act_ip24c') action = event.data;
  }
  return action;
}

function actionStateEvents(store, productionId) {
  return store.readEvents(productionId)
    .filter((event) => event.type === 'action.state_changed' && event.data?.id === 'act_ip24c')
    .map((event) => event.data);
}

function actionStates(store, productionId) {
  return actionStateEvents(store, productionId).map((data) => data.state);
}

function holds(ledger) {
  return ledger.status().openReservations.map(reservation => reservation.hold).sort((a, b) => a - b);
}

function journalCancel(ctx, label) {
  const production = ctx.store.read(ctx.productionId);
  const action = actionFrom(ctx.store, ctx.productionId);
  assert.ok(action, 'the action exists before a cancel is journaled');
  const commandId = `cmd_ip24c_${label}_${ctx.suffix}`;
  ctx.store.commit(ctx.productionId, {
    commandId,
    idempotencyKey: commandId,
    baseRevision: production.revision,
    events: [{
      type: 'action.state_changed',
      data: { ...action, state: 'cancel_requested' },
    }],
  });
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'cancel_requested');
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

function assertLegalStates(states) {
  for (let index = 1; index < states.length; index += 1) {
    assert.equal(
      canTransition(states[index - 1], states[index]),
      true,
      `illegal journaled pair ${states[index - 1]} -> ${states[index]}`,
    );
  }
}

function freshLedger(ctx, store = createProductionStore({ runtimeDir: ctx.runtimeDir })) {
  const production = store.read(ctx.productionId);
  return {
    store,
    ledger: createBudgetLedger({ runtimeDir: ctx.runtimeDir, ledgerId: production.budgetLedgerId }),
  };
}

test('IP24C (a): cancel while the run is in flight ends cancelled once and settles the reported usage', async t => {
  const ctx = makeProduction(t);
  const { backend, state } = fakeBackend({ resultSpend: 7 });
  const controller = controllerFor(ctx, async () => backend);

  const started = await controller.start(startParams(ctx));
  await state.entered;
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'running');
  journalCancel(ctx, 'inflight');
  state.release();

  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'done');

  const action = actionFrom(ctx.store, ctx.productionId);
  assert.equal(action.state, 'cancelled');
  assert.equal(action.runId, started.runId);
  assert.equal(action.lastError, null, 'a completed run has no cancel error');
  assert.equal(action.runOutcome, 'completed');

  const states = actionStates(ctx.store, ctx.productionId);
  assert.deepEqual(states, ['queued', 'dispatching', 'running', 'cancel_requested', 'cancelled']);
  assert.equal(states.filter(s => s === 'cancelled').length, 1, 'exactly one cancelled event');
  assertLegalStates(states);

  assert.equal(ctx.ledger.status().spent, 7);
  const settlements = settleEntries(ctx.ledger, ctx.action.reservationId);
  assert.equal(settlements.length, 1, 'the slot is settled exactly once');
  assert.equal(settlements[0].settlementKind, 'actual');
  assert.equal(settlements[0].charged, 7);
  assert.deepEqual(holds(ctx.ledger), []);
});

test('IP24C (b): a cancelled run that may have allocated with unknown usage charges the full reservation', async t => {
  const ctx = makeProduction(t);
  const { backend, state } = fakeBackend({ behavior: 'fail-after-allocating' });
  const controller = controllerFor(ctx, async () => backend);

  const started = await controller.start(startParams(ctx));
  await state.entered;
  journalCancel(ctx, 'unverified');
  state.release();

  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'failed');

  const action = actionFrom(ctx.store, ctx.productionId);
  assert.equal(action.state, 'cancelled');
  assert.equal(action.lastError.code, 'CANCELLED');
  assert.equal(action.runOutcome, 'failed');

  const states = actionStates(ctx.store, ctx.productionId);
  assertLegalStates(states);
  assert.equal(states.filter(s => s === 'cancelled').length, 1);

  assert.equal(ctx.ledger.status().spent, UPPER_BOUND, 'unknown usage charges the full hold, never zero');
  const settlements = settleEntries(ctx.ledger, ctx.action.reservationId);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].settlementKind, 'reservation_unverified');
  assert.equal(settlements[0].charged, UPPER_BOUND);
  assert.deepEqual(holds(ctx.ledger), []);
});

test('IP24C (c): a cancelled run that provably never allocated releases the slot', async t => {
  const ctx = makeProduction(t);
  const { backend, state } = fakeBackend({ behavior: 'fail-before-allocating' });
  const controller = controllerFor(ctx, async () => backend);

  const started = await controller.start(startParams(ctx));
  await state.entered;
  journalCancel(ctx, 'noallocation');
  state.release();

  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'failed');

  const action = actionFrom(ctx.store, ctx.productionId);
  assert.equal(action.state, 'cancelled');
  assert.equal(action.lastError.code, 'CANCELLED');
  assert.equal(action.runOutcome, 'failed');

  const states = actionStates(ctx.store, ctx.productionId);
  assertLegalStates(states);
  assert.equal(states.filter(s => s === 'cancelled').length, 1);

  assert.equal(ctx.ledger.status().spent, 0);
  const settlements = settleEntries(ctx.ledger, ctx.action.reservationId);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].settlementKind, 'no_allocation');
  assert.equal(settlements[0].charged, 0);
  assert.deepEqual(holds(ctx.ledger), []);
});

test('IP24C (d): a cancel while dispatching never calls runPackage and settles zero', async t => {
  const ctx = makeProduction(t);
  const { backend, state } = fakeBackend();
  state.gate = Promise.resolve();
  let factoryCalls = 0;
  let releaseFactory;
  const factoryGate = new Promise(resolve => { releaseFactory = resolve; });
  const controller = controllerFor(ctx, async () => {
    factoryCalls += 1;
    if (factoryCalls > 1) await factoryGate;
    return backend;
  });

  const started = await controller.start(startParams(ctx));
  await waitForAction(ctx, 'dispatching');
  journalCancel(ctx, 'dispatching');
  releaseFactory();

  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'cancelled');

  assert.equal(state.realCalls, 0, 'runPackage is never called for a cancelled dispatching action');
  const states = actionStates(ctx.store, ctx.productionId);
  assert.deepEqual(states, ['queued', 'dispatching', 'cancel_requested', 'cancelled']);
  assert.equal(states.includes('running'), false, 'a cancelled dispatch never claims running');
  assertLegalStates(states);
  assert.equal(states.filter(s => s === 'cancelled').length, 1);

  assert.equal(ctx.ledger.status().spent, 0);
  const settlements = settleEntries(ctx.ledger, ctx.action.reservationId);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].settlementKind, 'no_allocation');
  assert.equal(settlements[0].charged, 0);
  assert.deepEqual(holds(ctx.ledger), []);
});

test('IP24C (e): a restart after the run record but before the journal commits cancelled once', async t => {
  const ctx = makeProduction(t);
  const { backend, state } = fakeBackend({ resultSpend: 7 });
  state.gate = Promise.resolve();
  const crashingStore = {
    ...ctx.store,
    commit(productionId, input) {
      if (typeof input?.commandId === 'string' && input.commandId.startsWith('run-end:')) {
        // A production cancel lands after the run record was persisted but
        // before the end commit; then the process dies.
        const action = actionFrom(ctx.store, ctx.productionId);
        const production = ctx.store.read(ctx.productionId);
        const commandId = `cmd_ip24c_late_cancel_${ctx.suffix}`;
        ctx.store.commit(ctx.productionId, {
          commandId,
          idempotencyKey: commandId,
          baseRevision: production.revision,
          events: [{
            type: 'action.state_changed',
            data: { ...action, state: 'cancel_requested' },
          }],
        });
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

  const started = await controller.start(startParams(ctx));
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'done');
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'cancel_requested');
  assert.equal(ctx.ledger.status().spent, 7, 'the run reservation settled with the real usage before the crash');
  const record = JSON.parse(readFileSync(join(ctx.runtimeDir, 'runs', started.runId, 'state.json'), 'utf8'));
  assert.equal(record.finished, true);

  const first = freshLedger(ctx);
  let backendCalls = 0;
  createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => { backendCalls += 1; throw new Error('a recovery must not start a backend'); },
    productionStore: first.store,
    ledgerFor: ({ productionId }) => (productionId === ctx.productionId ? first.ledger : null),
    isBusy: () => false,
  });

  const recovered = actionFrom(first.store, ctx.productionId);
  assert.equal(recovered.state, 'cancelled');
  assert.equal(recovered.runOutcome, 'completed');
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.runId, started.runId);
  assert.equal(first.ledger.status().spent, 7, 'recovery never double-charges');
  assert.equal(settleEntries(first.ledger, ctx.action.reservationId).length, 1);
  assert.deepEqual(holds(first.ledger), []);
  assert.equal(backendCalls, 0);
  assert.equal(actionStates(first.store, ctx.productionId).filter(s => s === 'cancelled').length, 1);
  assertLegalStates(actionStates(first.store, ctx.productionId));

  const second = freshLedger(ctx);
  const eventsBefore = second.store.readEvents(ctx.productionId).length;
  createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => { backendCalls += 1; throw new Error('a recovery must not start a backend'); },
    productionStore: second.store,
    ledgerFor: ({ productionId }) => (productionId === ctx.productionId ? second.ledger : null),
    isBusy: () => false,
  });
  assert.equal(second.store.readEvents(ctx.productionId).length, eventsBefore, 'a second restart writes nothing');
  assert.equal(second.ledger.status().spent, 7);
  assert.equal(settleEntries(second.ledger, ctx.action.reservationId).length, 1);
  assert.equal(actionFrom(second.store, ctx.productionId).state, 'cancelled');
  assert.equal(backendCalls, 0);
});

test('IP24C (f): a restart with cancel_requested and no run record charges the reservation once', async t => {
  const ctx = makeProduction(t);
  const { backend, state } = fakeBackend({ resultSpend: 7 });
  const controller = controllerFor(ctx, async () => backend);

  const started = await controller.start(startParams(ctx));
  await state.entered;
  assert.equal(actionFrom(ctx.store, ctx.productionId).state, 'running');
  journalCancel(ctx, 'no_record');
  assert.deepEqual(holds(ctx.ledger), [UPPER_BOUND], 'the slot is still held when the process stops');

  let backendCalls = 0;
  const first = freshLedger(ctx);
  createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => { backendCalls += 1; throw new Error('a recovery must not start a backend'); },
    productionStore: first.store,
    ledgerFor: ({ productionId }) => (productionId === ctx.productionId ? first.ledger : null),
    isBusy: () => false,
  });

  const recovered = actionFrom(first.store, ctx.productionId);
  assert.equal(recovered.state, 'cancelled');
  assert.equal(recovered.runOutcome, 'unknown');
  assert.equal(recovered.lastError.code, 'CANCELLED');
  assert.equal(first.ledger.status().spent, UPPER_BOUND, 'unknown usage charges the full reservation, never zero');
  const settlements = settleEntries(first.ledger, ctx.action.reservationId);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].settlementKind, 'reservation_unverified');
  assert.equal(settlements[0].charged, UPPER_BOUND);
  assert.deepEqual(holds(first.ledger), []);
  assert.equal(backendCalls, 0, 'recovery never restarts the run');
  assertLegalStates(actionStates(first.store, ctx.productionId));

  const second = freshLedger(ctx);
  const eventsBefore = second.store.readEvents(ctx.productionId).length;
  createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => { backendCalls += 1; throw new Error('a recovery must not start a backend'); },
    productionStore: second.store,
    ledgerFor: ({ productionId }) => (productionId === ctx.productionId ? second.ledger : null),
    isBusy: () => false,
  });
  assert.equal(second.store.readEvents(ctx.productionId).length, eventsBefore, 'a second restart writes nothing');
  assert.equal(second.ledger.status().spent, UPPER_BOUND, 'a second restart does not charge twice');
  assert.equal(settleEntries(second.ledger, ctx.action.reservationId).length, 1);
  assert.equal(actionFrom(second.store, ctx.productionId).state, 'cancelled');
  assert.equal(backendCalls, 0);
  // The simulated process is gone: its in-flight backend never resumes.
});

test('IP24C (g): running the cancelled end path twice journals exactly one cancelled event', async t => {
  const ctx = makeProduction(t);
  const { backend, state } = fakeBackend({ resultSpend: 7 });
  state.gate = Promise.resolve();
  const crashingStore = {
    ...ctx.store,
    commit(productionId, input) {
      if (typeof input?.commandId === 'string' && input.commandId.startsWith('run-end:')) {
        const action = actionFrom(ctx.store, ctx.productionId);
        const production = ctx.store.read(ctx.productionId);
        const commandId = `cmd_ip24c_twice_cancel_${ctx.suffix}`;
        ctx.store.commit(ctx.productionId, {
          commandId,
          idempotencyKey: commandId,
          baseRevision: production.revision,
          events: [{ type: 'action.state_changed', data: { ...action, state: 'cancel_requested' } }],
        });
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
  const started = await controller.start(startParams(ctx));
  await controller.wait(started.runId);

  const first = freshLedger(ctx);
  const recover = () => createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => { throw new Error('a recovery must not start a backend'); },
    productionStore: first.store,
    ledgerFor: ({ productionId }) => (productionId === ctx.productionId ? first.ledger : null),
    isBusy: () => false,
  });
  recover();
  assert.equal(actionStates(first.store, ctx.productionId).filter(s => s === 'cancelled').length, 1);
  recover();
  assert.equal(actionStates(first.store, ctx.productionId).filter(s => s === 'cancelled').length, 1, 'a second end path is a no-op');
  assert.equal(first.ledger.status().spent, 7);
  assert.equal(settleEntries(first.ledger, ctx.action.reservationId).length, 1);
  assertLegalStates(actionStates(first.store, ctx.productionId));
});
