// UX03: server-owned execution from the production outbox.
//
// The outbox is the durable record that an approved action was dispatched. This
// suite drains it through the pipeline adapter with a fake controller: one
// action yields at most one attributed execution, a dropped acknowledgement is
// repaired by adopting the already-attributed run, and a paused production
// leaves its entry pending without starting anything. Cancellation is reported
// as requested, stopped or unconfirmed; it is never mistaken for proof that the
// remote compute stopped.
//
// Local only: no network, no Google Colab session and no paid backend.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOutboxExecutor } from '../../src/productions/outbox-execution.mjs';
import {
  attemptIdFor,
  createPipelineAdapter,
} from '../../src/productions/pipeline-adapter.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';

const AT = '2026-10-26T12:00:00.000Z';
const PRODUCTION_ID = 'prod_ux03';
const ACTION_ID = 'act_ux03';
const PLAN_HASH = 'd'.repeat(64);
const PACKAGE = JSON.parse(
  readFileSync(new URL('../../../../examples/launch-demo/package.json', import.meta.url)),
);
const INPUT = Object.freeze({ backendId: 'cpu' });

function tempRuntime(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ux03-outbox-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeProduction(intent = 'active') {
  return {
    schema: 'comfyrizz.production/v1',
    id: PRODUCTION_ID,
    revision: 0,
    conversationId: 'conv_ux03',
    packageId: null,
    intent,
    briefVersionId: null,
    scriptVersionId: null,
    shotIds: [],
    characterBindings: [],
    reviewPolicy: { requireUserVerdict: true },
    budgetLedgerId: 'ledger_ux03',
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
    planId: 'plan_ux03',
    planHash: PLAN_HASH,
    commandId: 'coord_ux03',
    idempotencyKey: 'coord_ux03',
    expected: { productionRevision: 0 },
    state,
    reservationId: 'slot_ux03',
    attemptId: null,
    jobId: null,
    runId: null,
    lastError: null,
    ...extra,
  };
}

function outboxEntry(id = 'dsp_ux03', type = 'action.dispatch') {
  return {
    id,
    type,
    payload: {
      productionId: PRODUCTION_ID,
      actionId: ACTION_ID,
      planId: 'plan_ux03',
      planHash: PLAN_HASH,
      commandId: 'coord_ux03',
      reservationId: 'slot_ux03',
      upperBound: 30,
    },
  };
}

function seed(t, { intent = 'active', actionState = 'queued', action = {}, outbox = [outboxEntry()] } = {}) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const production = makeProduction(intent);
  store.create(production);
  const record = makeAction(actionState, action);
  store.commit(PRODUCTION_ID, {
    commandId: 'seed_ux03',
    idempotencyKey: 'seed_ux03',
    baseRevision: 0,
    production,
    events: [{ type: 'action.state_changed', data: record }],
    outbox,
  });
  return { runtimeDir, store, production, action: record };
}

function currentAction(store) {
  let found = null;
  for (const event of store.readEvents(PRODUCTION_ID)) {
    if (event.type !== 'action.state_changed' || event.data?.id !== ACTION_ID) continue;
    found = { ...(found ?? {}), ...event.data };
  }
  return found;
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
    async start(pkg, input, sourceDir, options = {}) {
      counter += 1;
      const runId = `pipe_ux03_${counter}`;
      const run = {
        runId,
        packageId: pkg.id,
        status: 'running',
        origin: {
          productionId: options.origin?.productionId,
          actionId: options.origin?.actionId,
        },
        runtimes: {},
        stages: [],
        startedAt: new Date().toISOString(),
      };
      runs.set(runId, run);
      starts.push({ runId, pkg, input, sourceDir, origin: run.origin });
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

function executorFor(store, controller, extra = {}) {
  const adapter = createPipelineAdapter({ store, controller });
  return {
    adapter,
    executor: createOutboxExecutor({ store, adapter, ...extra }),
  };
}

async function drain(executor) {
  return executor.drainProduction(PRODUCTION_ID, {
    pkg: PACKAGE,
    input: INPUT,
    sourceDir: '.',
  });
}

test('a pending dispatch starts once, is acknowledged, and a repeated drain starts nothing', async (t) => {
  const { store } = seed(t);
  const controller = fakeController();
  const { executor } = executorFor(store, controller);

  const first = await drain(executor);
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].outcome, 'started');
  assert.equal(first.entries[0].acknowledged, true);
  assert.equal(controller.starts.length, 1);
  assert.deepEqual(store.pending(PRODUCTION_ID), []);

  const again = await drain(executor);
  assert.deepEqual(again.entries, []);
  assert.equal(controller.starts.length, 1);
  assert.equal(currentAction(store).state, 'running');
  assert.equal(currentAction(store).attemptId, attemptIdFor(PRODUCTION_ID, ACTION_ID, PLAN_HASH));
});

test('a dropped acknowledgement adopts the attributed run instead of starting again', async (t) => {
  const { store } = seed(t);
  const controller = fakeController();
  const { executor } = executorFor(store, controller);

  const acknowledge = store.acknowledgeOutboxEntry;
  let dropped = false;
  store.acknowledgeOutboxEntry = (input) => {
    if (!dropped) {
      dropped = true;
      return { id: input.outboxId, acknowledged: false, reason: 'SIMULATED_ACK_DROP' };
    }
    return acknowledge(input);
  };

  const first = await drain(executor);
  assert.equal(first.entries[0].outcome, 'started');
  assert.equal(first.entries[0].acknowledged, false);
  assert.equal(controller.starts.length, 1);
  assert.equal(store.pending(PRODUCTION_ID).length, 1, 'the dropped ack leaves the effect pending');

  const restarted = executorFor(store, controller);
  const second = await drain(restarted.executor);
  assert.equal(second.entries[0].outcome, 'adopted');
  assert.equal(second.entries[0].acknowledged, true);
  assert.equal(controller.starts.length, 1, 'the attributed run is adopted, never started twice');
  assert.deepEqual(store.pending(PRODUCTION_ID), []);
  assert.equal(currentAction(store).state, 'running');
});

test('a paused production leaves the dispatch pending and starts it once after resume', async (t) => {
  const { store } = seed(t, { intent: 'paused' });
  const controller = fakeController();
  const { executor } = executorFor(store, controller);

  const paused = await drain(executor);
  assert.equal(paused.entries[0].outcome, 'paused');
  assert.equal(paused.entries[0].acknowledged, false);
  assert.equal(controller.starts.length, 0);
  assert.equal(store.pending(PRODUCTION_ID).length, 1);
  assert.equal(currentAction(store).state, 'queued');

  const current = store.read(PRODUCTION_ID);
  store.commit(PRODUCTION_ID, {
    commandId: 'resume_ux03',
    idempotencyKey: 'resume_ux03',
    baseRevision: current.revision,
    production: { ...current, intent: 'active' },
    events: [{ type: 'production.intent_changed', data: { intent: 'active' } }],
  });

  const resumed = await drain(executor);
  assert.equal(resumed.entries[0].outcome, 'started');
  assert.equal(resumed.entries[0].acknowledged, true);
  assert.equal(controller.starts.length, 1);
  assert.deepEqual(store.pending(PRODUCTION_ID), []);
});

test('an uncertain dispatch becomes submission_unknown once and is never resubmitted', async (t) => {
  const { store } = seed(t, { actionState: 'dispatching' });
  const controller = fakeController();
  const { executor } = executorFor(store, controller);

  const first = await drain(executor);
  assert.equal(first.entries[0].outcome, 'uncertain');
  assert.equal(first.entries[0].acknowledged, true);
  assert.equal(controller.starts.length, 0);
  assert.equal(currentAction(store).state, 'submission_unknown');

  const second = await drain(executor);
  assert.deepEqual(second.entries, []);
  assert.equal(controller.starts.length, 0, 'uncertain work is reconciled, never resubmitted');
});

test('concurrent drains of one entry produce one attributed execution', async (t) => {
  const { store } = seed(t);
  const controller = slowController();
  const { executor } = executorFor(store, controller);

  const first = drain(executor);
  const second = drain(executor);
  await new Promise((resolve) => setImmediate(resolve));
  controller.release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(controller.starts.length, 1);
  assert.equal(a.entries.length, 1);
  assert.equal(b.entries.length, 1);
  assert.ok(
    ['started', 'adopted'].includes(a.entries[0].outcome),
    `unexpected first outcome ${a.entries[0].outcome}`,
  );
  assert.ok(
    ['started', 'adopted'].includes(b.entries[0].outcome),
    `unexpected second outcome ${b.entries[0].outcome}`,
  );
  assert.deepEqual(store.pending(PRODUCTION_ID), []);
  assert.equal(currentAction(store).runId, 'pipe_ux03_1');
});

test('cancel fan-out journals the request, aborts the run and distinguishes unconfirmed from stopped', async (t) => {
  const { store } = seed(t, {
    actionState: 'running',
    action: { runId: 'pipe_live' },
    outbox: [],
  });
  const controller = fakeController();
  controller.runs.set('pipe_live', {
    runId: 'pipe_live',
    status: 'running',
    origin: { productionId: PRODUCTION_ID, actionId: ACTION_ID },
    runtimes: { media: { ownership: 'managed', state: 'allocating' } },
    stages: [],
  });
  const { executor } = executorFor(store, controller);

  const requested = executor.cancelProduction({ productionId: PRODUCTION_ID });
  assert.deepEqual(requested.requested.map((entry) => entry.actionId), [ACTION_ID]);
  assert.deepEqual(requested.stopped, []);
  assert.deepEqual(requested.unconfirmed, []);
  assert.deepEqual(controller.cancellations, ['pipe_live']);
  assert.equal(currentAction(store).state, 'cancel_requested');

  // The process reports a cancelled run, but its managed runtime could not
  // confirm shutdown. That is unconfirmed exposure, never "stopped".
  controller.runs.set('pipe_live', {
    runId: 'pipe_live',
    status: 'cancelled',
    origin: { productionId: PRODUCTION_ID, actionId: ACTION_ID },
    runtimes: { media: { ownership: 'managed', state: 'stop_unconfirmed' } },
    stages: [],
    teardown: { state: 'stop_unconfirmed' },
  });
  const unconfirmed = executor.cancelProduction({ productionId: PRODUCTION_ID });
  assert.deepEqual(unconfirmed.requested, []);
  assert.deepEqual(unconfirmed.unconfirmed.map((entry) => entry.actionId), [ACTION_ID]);

  // Once teardown is confirmed, the same request reports the action stopped.
  controller.runs.set('pipe_live', {
    runId: 'pipe_live',
    status: 'cancelled',
    origin: { productionId: PRODUCTION_ID, actionId: ACTION_ID },
    runtimes: { media: { ownership: 'managed', state: 'stopped' } },
    stages: [],
    teardown: { state: 'stopped' },
  });
  const stopped = executor.cancelProduction({ productionId: PRODUCTION_ID });
  assert.deepEqual(stopped.unconfirmed, []);
  assert.deepEqual(stopped.stopped.map((entry) => entry.actionId), [ACTION_ID]);
  assert.equal(currentAction(store).state, 'cancelled');
});

test('an outbox cancel releases a queued action hold without touching compute', async (t) => {
  const { runtimeDir, store } = seed(t, {
    outbox: [outboxEntry('cancel_ux03', 'action.cancel')],
  });
  const ledger = createBudgetLedger({ runtimeDir, ledgerId: 'ledger_ux03' });
  ledger.reserve({
    reservationId: 'slot_ux03',
    upperBound: 30,
    collectAndStopReserve: 0,
    idempotencyKey: 'hold_ux03',
  });
  const controller = fakeController();
  const { executor } = executorFor(store, controller, { ledgerFor: () => ledger });

  const result = await drain(executor);
  assert.equal(result.entries[0].outcome, 'cancelled');
  assert.equal(result.entries[0].acknowledged, true);
  assert.equal(controller.starts.length, 0);
  assert.deepEqual(controller.cancellations, []);
  assert.equal(currentAction(store).state, 'cancelled');
  assert.equal(ledger.status().openReservations.length, 0, 'a never-started hold is released');
});
