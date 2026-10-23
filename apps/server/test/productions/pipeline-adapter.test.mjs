// IP22: the pipeline adapter.
//
// The production coordinator admits an action; this adapter is the only bridge
// to the existing video pipeline. It records a durable dispatch intent before
// invoking the worker, adopts an already-attributed run instead of starting a
// second paid run, and maps pipeline facts onto the closed action vocabulary.
//
// These tests use a fake pipeline controller plus one real
// createPipelineController restart. No Google Colab session, no network and no
// paid backend is touched.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPipelineController } from '../../src/pipeline.mjs';
import {
  attemptIdFor,
  actionStateForPipelineStatus,
  createPipelineAdapter,
  mapPipelineStatus,
} from '../../src/productions/pipeline-adapter.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';

const AT = '2026-10-23T12:00:00.000Z';
const PRODUCTION_ID = 'prod_ip22';
const ACTION_ID = 'act_video_render';
const PLAN_HASH = 'b'.repeat(64);
const PACKAGE = JSON.parse(
  readFileSync(new URL('../../../../examples/launch-demo/package.json', import.meta.url)),
);
const INPUT = Object.freeze({ backendId: 'cpu' });

function tempRuntime(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-pipeline-adapter-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeProduction(intent = 'active') {
  return {
    schema: 'comfyrizz.production/v1',
    id: PRODUCTION_ID,
    revision: 0,
    conversationId: 'conv_ip22',
    packageId: null,
    intent,
    briefVersionId: null,
    scriptVersionId: null,
    shotIds: [],
    characterBindings: [],
    reviewPolicy: { requireUserVerdict: true },
    budgetLedgerId: 'ledger_ip22',
    pendingDecisionIds: [],
    actionIds: [ACTION_ID],
    latestDeliveryId: null,
    lastSequence: 0,
  };
}

function makeAction(state = 'queued', extra = {}) {
  return {
    id: ACTION_ID,
    productionId: PRODUCTION_ID,
    planId: 'plan_ip22',
    planHash: PLAN_HASH,
    commandId: 'coord_action_ip22',
    idempotencyKey: 'coord_action_ip22',
    expected: { productionRevision: 0 },
    state,
    reservationId: 'slot_ip22',
    attemptId: null,
    jobId: null,
    runId: null,
    lastError: null,
    ...extra,
  };
}

function seed(t, options = {}) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const production = makeProduction(options.intent ?? 'active');
  store.create(production);
  const action = makeAction(options.actionState ?? 'queued', options.action);
  store.commit(PRODUCTION_ID, {
    commandId: 'seed_ip22',
    idempotencyKey: 'seed_ip22',
    baseRevision: 0,
    production,
    events: [{ type: 'action.state_changed', data: action }],
    outbox: options.outbox ?? [],
  });
  return { runtimeDir, store, production, action };
}

function currentAction(store, actionId = ACTION_ID) {
  let found = null;
  for (const event of store.readEvents(PRODUCTION_ID)) {
    if (event.type !== 'action.state_changed' || event.data?.id !== actionId) continue;
    found = { ...(found ?? {}), ...event.data };
  }
  return found;
}

function actionEvents(store, state) {
  return store.readEvents(PRODUCTION_ID).filter(
    (event) => event.type === 'action.state_changed'
      && event.data?.id === ACTION_ID
      && (state === undefined || event.data.state === state),
  );
}

function fakeController() {
  const runs = new Map();
  const starts = [];
  const cancellations = [];
  let counter = 0;
  const controller = {
    runs,
    starts,
    cancellations,
    failAfterStart: false,
    async start(pkg, input, sourceDir, options = {}) {
      counter += 1;
      const runId = `pipe_fake_${counter}`;
      const origin = options.origin
        ? { productionId: options.origin.productionId, actionId: options.origin.actionId }
        : undefined;
      const run = {
        runId,
        status: 'running',
        origin,
        runtimes: {},
        stages: [],
        startedAt: new Date().toISOString(),
      };
      runs.set(runId, run);
      starts.push({ runId, pkg, input, sourceDir, origin });
      if (controller.failAfterStart) {
        controller.failAfterStart = false;
        throw new Error('the process died after submission but before the plan write');
      }
      return { status: 202, run: structuredClone(run) };
    },
    forAction(productionId, actionId) {
      let found = null;
      for (const run of runs.values()) {
        if (run.origin?.productionId === productionId && run.origin?.actionId === actionId) {
          found = run;
        }
      }
      return found ? structuredClone(found) : null;
    },
    get(runId) {
      return runs.has(runId) ? structuredClone(runs.get(runId)) : null;
    },
    list() {
      return [...runs.values()].map((run) => structuredClone(run));
    },
    active() {
      return [...runs.values()].some((run) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status));
    },
    cancel(runId) {
      cancellations.push(runId);
      const run = runs.get(runId);
      if (run && !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
        run.status = 'cancelling';
      }
      return run ? structuredClone(run) : null;
    },
  };
  return controller;
}

function realController(runtimeDir, counter) {
  let send = null;
  const controller = createPipelineController({
    runtimeDir,
    events: { publish() {} },
    stageInputs: async () => {},
    launch: (_spec, receive) => {
      counter.starts += 1;
      send = receive;
      return { cancel() {}, kill() {} };
    },
  });
  return {
    controller,
    send: (message) => send?.(message),
  };
}

test('mapPipelineStatus keeps a closed vocabulary and shutdown uncertainty wins', () => {
  assert.equal(mapPipelineStatus(null), 'unknown');
  assert.equal(mapPipelineStatus({ status: 'running' }), 'running');
  assert.equal(mapPipelineStatus({ status: 'running' }, { intent: 'paused' }), 'paused');
  assert.equal(mapPipelineStatus({ status: 'running' }, { intent: 'cancel_requested' }), 'cancel_requested');
  assert.equal(mapPipelineStatus({ status: 'cancelling' }), 'cancel_requested');
  assert.equal(mapPipelineStatus({ status: 'completed' }), 'completed');
  assert.equal(mapPipelineStatus({ status: 'failed' }), 'failed');
  assert.equal(mapPipelineStatus({ status: 'cancelled' }), 'cancelled');
  assert.equal(mapPipelineStatus({ status: 'interrupted' }), 'interrupted');
  assert.equal(mapPipelineStatus({ status: 'reconciling' }), 'reconciling');
  assert.equal(mapPipelineStatus({ status: 'shutdown_unconfirmed' }), 'shutdown_unconfirmed');

  // A managed runtime that could not confirm shutdown is never reported as a
  // clean finish, even when the worker claimed completion.
  assert.equal(
    mapPipelineStatus({ status: 'completed', runtimes: { media: { state: 'stop_unconfirmed' } } }),
    'shutdown_unconfirmed',
  );
  assert.equal(
    mapPipelineStatus({ status: 'interrupted', runtimes: { media: { ownership: 'managed', state: 'stop_unconfirmed' } } }),
    'shutdown_unconfirmed',
  );
  // An external runtime is not ours to stop.
  assert.equal(
    mapPipelineStatus({ status: 'completed', runtimes: { media: { ownership: 'external', state: 'stop_unconfirmed' } } }),
    'completed',
  );

  assert.equal(actionStateForPipelineStatus('shutdown_unconfirmed'), 'submission_unknown');
  assert.equal(actionStateForPipelineStatus('cancel_requested'), 'cancel_requested');
  assert.equal(actionStateForPipelineStatus('paused'), 'queued');
  assert.equal(actionStateForPipelineStatus('running'), 'running');
  assert.equal(actionStateForPipelineStatus('interrupted'), 'interrupted');
});

test('a dispatch attempt id is deterministic and never clock- or counter-derived', () => {
  const first = attemptIdFor(PRODUCTION_ID, ACTION_ID, PLAN_HASH);
  assert.equal(first, attemptIdFor(PRODUCTION_ID, ACTION_ID, PLAN_HASH));
  assert.match(first, /^att_[a-f0-9]{32}$/);
  assert.notEqual(first, attemptIdFor(PRODUCTION_ID, ACTION_ID, 'c'.repeat(64)));
  assert.notEqual(first, attemptIdFor(PRODUCTION_ID, 'act_other', PLAN_HASH));
});

test('admit journals dispatching before start, and a crash before the run write adopts the run', async (t) => {
  const { store } = seed(t);
  const controller = fakeController();
  const adapter = createPipelineAdapter({ store, controller });

  // Fail exactly the post-start write (runId + running) to reproduce a process
  // death after the paid submission and before the run was journalled.
  const commit = store.commit;
  store.commit = (productionId, input) => {
    if ((input.events ?? []).some((event) => event.data?.runId && event.data?.state === 'running')) {
      store.commit = commit;
      throw new Error('simulated crash before the runId write');
    }
    return commit(productionId, input);
  };

  await assert.rejects(
    adapter.admit({ productionId: PRODUCTION_ID, actionId: ACTION_ID, pkg: PACKAGE, input: INPUT, sourceDir: '.' }),
    /simulated crash/,
  );
  assert.equal(controller.starts.length, 1);
  const submitted = currentAction(store);
  assert.equal(submitted.state, 'dispatching');
  assert.equal(submitted.attemptId, attemptIdFor(PRODUCTION_ID, ACTION_ID, PLAN_HASH));
  assert.equal(submitted.runId, null);

  // A fresh adapter/process: the controller already owns a run for this action,
  // so it is adopted. It must not submit a second paid run.
  const restarted = createPipelineAdapter({ store, controller });
  const result = await restarted.admit({
    productionId: PRODUCTION_ID,
    actionId: ACTION_ID,
    pkg: PACKAGE,
    input: INPUT,
    sourceDir: '.',
  });
  assert.equal(result.started, false);
  assert.equal(result.duplicate, true);
  assert.equal(result.adopted, true);
  assert.equal(controller.starts.length, 1);

  const adopted = currentAction(store);
  assert.equal(adopted.runId, 'pipe_fake_1');
  assert.equal(adopted.state, 'running');
});

test('a real controller restart never starts a second run for the same action', async (t) => {
  const { runtimeDir, store } = seed(t);
  const counter = { starts: 0 };
  const fixture = realController(runtimeDir, counter);
  const firstAdapter = createPipelineAdapter({ store, controller: fixture.controller });

  const first = await firstAdapter.admit({
    productionId: PRODUCTION_ID,
    actionId: ACTION_ID,
    pkg: PACKAGE,
    input: INPUT,
    sourceDir: '.',
  });
  assert.equal(first.started, true);
  assert.equal(counter.starts, 1);
  assert.deepEqual(fixture.controller.get(first.run.runId).origin, {
    productionId: PRODUCTION_ID,
    actionId: ACTION_ID,
  });
  assert.equal(fixture.controller.forAction(undefined, undefined), null);

  // A Google Colab runtime is allocated when the process dies, exactly the
  // crash the review reproduced.
  fixture.send({ kind: 'runtime', runtime: 'media', value: { ownership: 'managed', state: 'allocating' } });

  // A second controller over the same runtime directory is what a server
  // restart looks like: the in-flight run is marked interrupted and its
  // managed runtime can no longer confirm shutdown.
  const restarted = realController(runtimeDir, counter);
  const interrupted = restarted.controller.get(first.run.runId);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.runtimes.media.state, 'stop_unconfirmed');
  assert.equal(restarted.controller.forAction(PRODUCTION_ID, ACTION_ID).runId, first.run.runId);

  const restartedAdapter = createPipelineAdapter({ store, controller: restarted.controller });
  const second = await restartedAdapter.admit({
    productionId: PRODUCTION_ID,
    actionId: ACTION_ID,
    pkg: PACKAGE,
    input: INPUT,
    sourceDir: '.',
  });
  assert.equal(second.started, false);
  assert.equal(counter.starts, 1, 'a restarted adapter must not submit the same approved slot again');
  const action = currentAction(store);
  assert.ok(['interrupted', 'submission_unknown'].includes(action.state), `unexpected action state ${action.state}`);
  assert.equal(action.state, 'submission_unknown');
  assert.equal(second.reconcileRequired, true);
  assert.equal(action.runId, first.run.runId);
});

test('a dispatching or interrupted action with no attributed run becomes submission_unknown and never starts', async (t) => {
  for (const state of ['dispatching', 'running', 'interrupted']) {
    await t.test(state, async (subtest) => {
      const { store } = seed(subtest, { actionState: state });
      const controller = fakeController();
      const adapter = createPipelineAdapter({ store, controller });
      const result = await adapter.admit({
        productionId: PRODUCTION_ID,
        actionId: ACTION_ID,
        pkg: PACKAGE,
        input: INPUT,
        sourceDir: '.',
      });
      assert.equal(result.started, false);
      assert.equal(result.duplicate, false);
      assert.equal(result.reconcileRequired, true);
      assert.equal(controller.starts.length, 0);
      assert.equal(currentAction(store).state, 'submission_unknown');
    });
  }
});

test('only a queued action with no attributed run may start', async (t) => {
  const { store } = seed(t);
  const controller = fakeController();
  const adapter = createPipelineAdapter({ store, controller });
  const result = await adapter.admit({
    productionId: PRODUCTION_ID,
    actionId: ACTION_ID,
    pkg: PACKAGE,
    input: INPUT,
    sourceDir: '.',
  });
  assert.equal(result.started, true);
  assert.equal(controller.starts.length, 1);
  assert.deepEqual(controller.starts[0].origin, { productionId: PRODUCTION_ID, actionId: ACTION_ID });
  assert.ok(!Object.hasOwn(controller.starts[0], 'productionId'));

  // The fake stores origin exactly like pipeline.mjs does, never top-level ids.
  const run = controller.get(result.run.runId);
  assert.deepEqual(run.origin, { productionId: PRODUCTION_ID, actionId: ACTION_ID });
  assert.equal(Object.hasOwn(run, 'productionId'), false);
  assert.equal(Object.hasOwn(run, 'actionId'), false);

  const action = currentAction(store);
  assert.equal(action.state, 'running');
  assert.equal(action.runId, result.run.runId);
  assert.equal(action.attemptId, attemptIdFor(PRODUCTION_ID, ACTION_ID, PLAN_HASH));
});

test('runForAction reads the run origin only, never top-level production/action ids', (t) => {
  const { store } = seed(t);
  const controller = fakeController();
  controller.forAction = () => ({
    runId: 'pipe_legacy',
    status: 'running',
    productionId: PRODUCTION_ID,
    actionId: ACTION_ID,
  });
  const adapter = createPipelineAdapter({ store, controller });
  assert.equal(adapter.runForAction(PRODUCTION_ID, ACTION_ID), null);
});

test('a paused production admits nothing and leaves the dispatch in the outbox', async (t) => {
  const { store } = seed(t, {
    intent: 'paused',
    outbox: [{
      id: 'dsp_ip22',
      type: 'action.dispatch',
      payload: { productionId: PRODUCTION_ID, actionId: ACTION_ID },
    }],
  });
  const controller = fakeController();
  const adapter = createPipelineAdapter({ store, controller });
  const result = await adapter.admit({
    productionId: PRODUCTION_ID,
    actionId: ACTION_ID,
    pkg: PACKAGE,
    input: INPUT,
    sourceDir: '.',
  });
  assert.equal(result.admitted, false);
  assert.equal(result.started, false);
  assert.equal(result.status, 'paused');
  assert.equal(controller.starts.length, 0);
  assert.equal(currentAction(store).state, 'queued');
  assert.deepEqual(store.pending(PRODUCTION_ID).map((entry) => entry.id), ['dsp_ip22']);
});

test('cancel_requested cancels the in-flight run and records cancel_requested', async (t) => {
  const { store } = seed(t, {
    intent: 'cancel_requested',
    actionState: 'running',
    action: { runId: 'pipe_live' },
  });
  const controller = fakeController();
  controller.runs.set('pipe_live', {
    runId: 'pipe_live',
    status: 'running',
    origin: { productionId: PRODUCTION_ID, actionId: ACTION_ID },
    runtimes: {},
    stages: [],
  });
  const adapter = createPipelineAdapter({ store, controller });
  const result = await adapter.admit({
    productionId: PRODUCTION_ID,
    actionId: ACTION_ID,
    pkg: PACKAGE,
    input: INPUT,
    sourceDir: '.',
  });
  assert.equal(result.started, false);
  assert.equal(result.cancelled, true);
  assert.deepEqual(controller.cancellations, ['pipe_live']);
  assert.equal(currentAction(store).state, 'cancel_requested');
});

test('an unconfirmed managed shutdown maps to submission_unknown and asks for reconcile', async (t) => {
  const { store } = seed(t, {
    actionState: 'running',
    action: { runId: 'pipe_unknown' },
  });
  const controller = fakeController();
  controller.runs.set('pipe_unknown', {
    runId: 'pipe_unknown',
    status: 'interrupted',
    origin: { productionId: PRODUCTION_ID, actionId: ACTION_ID },
    runtimes: { media: { ownership: 'managed', state: 'stop_unconfirmed' } },
    stages: [],
  });
  const adapter = createPipelineAdapter({ store, controller });
  const result = await adapter.observe({ productionId: PRODUCTION_ID, actionId: ACTION_ID });
  assert.equal(result.status, 'shutdown_unconfirmed');
  assert.equal(result.reconcileRequired, true);
  assert.equal(result.changed, true);
  assert.equal(currentAction(store).state, 'submission_unknown');

  // Observing the same durable fact again appends nothing.
  const before = actionEvents(store).length;
  const again = await adapter.observe({ productionId: PRODUCTION_ID, actionId: ACTION_ID });
  assert.equal(again.changed, false);
  assert.equal(again.duplicate, true);
  assert.equal(actionEvents(store).length, before);
});

test('observe is idempotent for the same pipeline state', async (t) => {
  const { store } = seed(t, {
    actionState: 'dispatching',
    action: { runId: 'pipe_running' },
  });
  const controller = fakeController();
  controller.runs.set('pipe_running', {
    runId: 'pipe_running',
    status: 'running',
    origin: { productionId: PRODUCTION_ID, actionId: ACTION_ID },
    runtimes: {},
    stages: [],
  });
  const adapter = createPipelineAdapter({ store, controller });
  const first = await adapter.observe({ productionId: PRODUCTION_ID, actionId: ACTION_ID });
  assert.equal(first.changed, true);
  assert.equal(first.status, 'running');
  assert.equal(currentAction(store).state, 'running');
  assert.equal(actionEvents(store, 'running').length, 1);

  const second = await adapter.observe({ productionId: PRODUCTION_ID, actionId: ACTION_ID });
  assert.equal(second.changed, false);
  assert.equal(second.duplicate, true);
  assert.equal(actionEvents(store, 'running').length, 1);
});

test('observing a completed run completes the action once', async (t) => {
  const { store } = seed(t, {
    actionState: 'running',
    action: { runId: 'pipe_done' },
  });
  const controller = fakeController();
  controller.runs.set('pipe_done', {
    runId: 'pipe_done',
    status: 'completed',
    origin: { productionId: PRODUCTION_ID, actionId: ACTION_ID },
    runtimes: { media: { state: 'stopped' } },
    stages: [],
  });
  const adapter = createPipelineAdapter({ store, controller });
  const first = await adapter.observe({ productionId: PRODUCTION_ID, actionId: ACTION_ID });
  assert.equal(first.status, 'completed');
  assert.equal(currentAction(store).state, 'completed');
  const second = await adapter.observe({ productionId: PRODUCTION_ID, actionId: ACTION_ID });
  assert.equal(second.changed, false);
  assert.equal(actionEvents(store, 'completed').length, 1);
});

test('the adapter never touches a budget ledger', async (t) => {
  const { runtimeDir, store } = seed(t);
  const controller = fakeController();
  // A ledger path that would be obvious if the adapter tried to reserve.
  assert.equal(readdirOrEmpty(join(runtimeDir, 'ledgers')).length, 0);
  const adapter = createPipelineAdapter({ store, controller, ledgerFor: undefined });
  await adapter.admit({
    productionId: PRODUCTION_ID,
    actionId: ACTION_ID,
    pkg: PACKAGE,
    input: INPUT,
    sourceDir: '.',
  });
  assert.equal(readdirOrEmpty(join(runtimeDir, 'ledgers')).length, 0);
});

function readdirOrEmpty(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function slowController() {
  const controller = fakeController();
  const start = controller.start;
  let release;
  controller.gate = new Promise((resolve) => { release = resolve; });
  controller.release = () => release();
  controller.start = async (...args) => {
    await controller.gate;
    return start(...args);
  };
  return controller;
}

test('review fix-up: a second admit during an in-flight start waits, adopts and never journals submission_unknown', async (t) => {
  const { store } = seed(t);
  const controller = slowController();
  const adapter = createPipelineAdapter({ store, controller });
  const args = { productionId: PRODUCTION_ID, actionId: ACTION_ID, pkg: PACKAGE, input: INPUT, sourceDir: '.' };
  const first = adapter.admit(args);
  const second = adapter.admit(args);
  await new Promise((resolve) => setImmediate(resolve));
  controller.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(controller.starts.length, 1);
  assert.equal(a.started, true);
  assert.equal(b.started, false);
  assert.equal(b.duplicate, true);
  assert.deepEqual(actionEvents(store, 'submission_unknown'), []);
  assert.equal(currentAction(store).state, 'running');
  assert.equal(currentAction(store).runId, 'pipe_fake_1');
});

test('review fix-up: a cancel during an in-flight start cancels the run it produced', async (t) => {
  const { store } = seed(t);
  const controller = slowController();
  const adapter = createPipelineAdapter({ store, controller });
  const pending = adapter.admit({ productionId: PRODUCTION_ID, actionId: ACTION_ID, pkg: PACKAGE, input: INPUT, sourceDir: '.' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(currentAction(store).state, 'dispatching');
  const cancelled = adapter.cancel({ productionId: PRODUCTION_ID, actionId: ACTION_ID });
  assert.equal(cancelled.status, 'cancel_requested', 'an in-flight dispatch is never claimed cancelled');
  controller.release();
  await pending;
  assert.equal(controller.starts.length, 1);
  assert.deepEqual(controller.cancellations, ['pipe_fake_1']);
  const action = currentAction(store);
  assert.equal(action.state, 'cancel_requested');
  assert.equal(action.runId, 'pipe_fake_1');
  assert.deepEqual(actionEvents(store, 'running'), []);
});
