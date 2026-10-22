// IP08: route run admission through the persistent production ledger.
//
// The controller must claim a durable hold before it estimates or constructs a
// backend, then replace that hold with the run's own reservation before any
// paid work is dispatched. The ledger is the source of truth for the cap, so a
// restart never replays an old idempotency key or loses a settlement.
//
// Google Colab is the paid adapter here; the fake backend implements the same
// package contract and never touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunController } from '../src/run.mjs';
import { ProductionLedgerError, createBudgetLedger } from '../src/productions/ledger.mjs';

const UNIT = 'colab_compute_units';
const PKG = { id: 'pkg_ip08', schema: 'comfyrizz.package/1', assets: {}, scenes: [] };

function runtimeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-run-admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tidy(value) {
  return Number(Number(value).toPrecision(12));
}

function makeLedger(runtimeDir, overrides = {}) {
  return createBudgetLedger({
    runtimeDir,
    ledgerId: 'ledger_prod_ip08',
    unit: UNIT,
    ...overrides,
  });
}

/**
 * A metered fake Google Colab backend. `dryRun` can replace the planning
 * response (and throw); `runReal` can replace the paid path.
 */
function makeBackend({ gpuMinutes = 60, dryRun = null, runReal = null } = {}) {
  const backend = {
    id: 'colab',
    dryRuns: 0,
    realRuns: 0,
    async describe() {
      return { label: 'Google Colab G4', costVisibility: 'account-estimate' };
    },
    async runPackage(pkg, opts = {}) {
      const jobsDoc = { jobs: [{ id: 'j1' }] };
      const estimate = { gpuMinutes, overheadMinutes: 5, ratePerHour: 8.9 };
      if (opts.dryRun) {
        backend.dryRuns += 1;
        if (dryRun) return dryRun({ pkg, opts, jobsDoc, estimate });
        return { jobsDoc, estimate, teardown: null };
      }
      backend.realRuns += 1;
      const emit = event => opts.onEvent?.(event);
      if (runReal) return runReal({ pkg, opts, jobsDoc, estimate, emit });
      emit({ v: 1, event: 'run_phase', phase: 'up', state: 'started' });
      emit({ v: 1, event: 'run_phase', phase: 'ran', counts: { succeeded: 1 } });
      emit({ v: 1, event: 'run_phase', phase: 'teardown', state: 'stopped' });
      return {
        ok: true,
        jobsDoc,
        estimate,
        manifest: { complete: true, counts: { succeeded: 1 } },
        counts: { succeeded: 1 },
        applied: [],
        teardown: { state: 'stopped' },
      };
    },
    async teardown() {
      return { state: 'stopped', evidence: 'fake teardown' };
    },
  };
  return backend;
}

function controllerFor(runtimeDir, backend, extra = {}) {
  return createRunController({
    runtimeDir,
    events: null,
    backendFactory: async () => backend,
    ...extra,
  });
}

function startColab(controller, extra = {}) {
  return controller.start({
    backendId: 'colab',
    pkg: PKG,
    budgetUnits: 1000,
    approved: true,
    productionId: 'prod_ip08',
    userEventId: 'evt_user_ip08',
    actor: 'user',
    ...extra,
  });
}

test('two concurrent starts admit exactly one run', async (t) => {
  const runtime = runtimeDir(t);
  const ledger = makeLedger(runtime);
  const controller = controllerFor(runtime, makeBackend(), { ledgerFor: () => ledger });

  const [first, second] = await Promise.all([startColab(controller), startColab(controller)]);
  const admitted = [first, second].filter(result => result?.runId);
  const busy = [first, second].filter(result => result?.status === 409);

  assert.equal(admitted.length, 1);
  assert.equal(busy.length, 1);
  assert.equal(busy[0].error, 'run busy');

  const done = await controller.wait(admitted[0].runId);
  assert.equal(done.status, 'done');
  assert.ok(ledger.status().spent > 0);
  assert.equal(ledger.status().committed, 0);
  assert.equal(ledger.status().openReservations.length, 0);
});

test('a zero spend cap refuses before any backend is constructed', async (t) => {
  const runtime = runtimeDir(t);
  const ledger = makeLedger(runtime, { ceiling: 0, userEventId: 'evt_user_cap' });
  let constructed = 0;
  const controller = createRunController({
    runtimeDir: runtime,
    events: null,
    ledgerFor: () => ledger,
    backendFactory: async () => {
      constructed += 1;
      return makeBackend();
    },
  });

  const result = await startColab(controller);

  assert.equal(result.refused, true);
  assert.equal(result.code, 'BUDGET_EXCEEDED');
  assert.equal(result.budget.allowed, false);
  assert.equal(constructed, 0, 'the estimate backend is never constructed');
  const status = ledger.status();
  assert.equal(status.spent, 0);
  assert.equal(status.committed, 0);
  assert.equal(status.openReservations.length, 0);
});

test('a disabled cap still records the reservation and settlement', async (t) => {
  const runtime = runtimeDir(t);
  const ledger = makeLedger(runtime);
  const controller = controllerFor(runtime, makeBackend(), { ledgerFor: () => ledger });

  const started = await startColab(controller);
  const done = await controller.wait(started.runId);
  const increment = tidy(started.budget.required - started.budget.spent);

  assert.equal(done.status, 'done');
  assert.equal(ledger.status().ceiling, null);
  assert.equal(ledger.status().spent, increment);
  assert.equal(ledger.status().committed, 0);

  const kinds = ledger.entries().map(entry => entry.kind);
  assert.ok(kinds.includes('reserve'));
  assert.ok(kinds.includes('settle'));
});

test('the preflight hold is replaced by the exact run reservation before dispatch', async (t) => {
  const runtime = runtimeDir(t);
  const ledger = makeLedger(runtime, { ceiling: 10000, userEventId: 'evt_user_cap' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const backend = makeBackend({
    runReal: async ({ jobsDoc, estimate }) => {
      await gate;
      return {
        ok: true,
        jobsDoc,
        estimate,
        manifest: { complete: true, counts: { succeeded: 1 } },
        counts: { succeeded: 1 },
        applied: [],
        teardown: { state: 'stopped' },
      };
    },
  });
  const controller = controllerFor(runtime, backend, { ledgerFor: () => ledger });

  const started = await startColab(controller);
  const increment = tidy(started.budget.required - started.budget.spent);
  const running = ledger.status();

  assert.equal(running.committed, increment, 'only the run reservation is committed');
  assert.deepEqual(running.openReservations.map(reservation => reservation.reservationId), [`run:${started.runId}`]);

  const closedPreflight = ledger.entries().find(entry => entry.kind === 'reserve'
    && entry.reservationId.startsWith('admission:'));
  assert.ok(closedPreflight, 'a preflight hold was recorded');
  assert.equal(ledger.entries().some(entry => entry.kind === 'settle'
    && entry.reservationId === closedPreflight.reservationId
    && entry.evidence?.reason === 'replaced_by_run_reservation'), true);

  release();
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'done');
  assert.equal(ledger.status().spent, increment);
  assert.equal(ledger.status().committed, 0);
  assert.equal(ledger.status().openReservations.length, 0);
});

test('an unknown-usage failure charges the full run reservation', async (t) => {
  const runtime = runtimeDir(t);
  const ledger = makeLedger(runtime);
  const backend = makeBackend({
    runReal: async ({ jobsDoc, estimate, emit }) => {
      emit({ v: 1, event: 'run_phase', phase: 'allocating' });
      const error = new Error('the Google Colab session was cut off');
      error.runPackage = {
        jobsDoc,
        estimate,
        up: null,
        teardown: { state: 'unknown' },
        manifest: null,
        counts: null,
      };
      throw error;
    },
  });
  const controller = controllerFor(runtime, backend, { ledgerFor: () => ledger });

  const started = await startColab(controller);
  const increment = tidy(started.budget.required - started.budget.spent);
  const done = await controller.wait(started.runId);
  const status = ledger.status();

  assert.equal(done.status, 'failed');
  assert.equal(done.settled.kind, 'reservation_unverified');
  assert.equal(status.spent, increment, 'the hold (the exact run reservation) is charged');
  assert.equal(status.committed, 0);
  assert.equal(status.openReservations.length, 0);
});

test('a failure before allocation settles the run reservation at zero', async (t) => {
  const runtime = runtimeDir(t);
  const ledger = makeLedger(runtime);
  let constructed = 0;
  const controller = createRunController({
    runtimeDir: runtime,
    events: null,
    ledgerFor: () => ledger,
    backendFactory: async () => {
      constructed += 1;
      if (constructed > 1) throw new Error('cannot construct backend');
      return makeBackend();
    },
  });

  const started = await startColab(controller);
  const done = await controller.wait(started.runId);
  const status = ledger.status();

  assert.equal(done.status, 'failed');
  assert.equal(done.settled.kind, 'not_allocated');
  assert.equal(status.spent, 0);
  assert.equal(status.committed, 0);
  assert.equal(status.openReservations.length, 0);
});

test('a failed estimate closes the preflight hold with no allocation', async (t) => {
  const runtime = runtimeDir(t);
  const ledger = makeLedger(runtime);
  const backend = makeBackend({
    dryRun: async () => {
      throw new Error('dry run exploded');
    },
  });
  const controller = controllerFor(runtime, backend, { ledgerFor: () => ledger });

  await assert.rejects(startColab(controller), /dry run exploded/);

  const status = ledger.status();
  assert.equal(status.spent, 0);
  assert.equal(status.committed, 0);
  assert.equal(status.openReservations.length, 0);
  assert.equal(backend.realRuns, 0);
  assert.equal(ledger.entries().some(entry => entry.kind === 'settle'
    && entry.evidence?.reason === 'estimate_failed'), true);
});

test('a prepareWorkDir failure releases the run reservation', async (t) => {
  const runtime = runtimeDir(t);
  const ledger = makeLedger(runtime);
  const controller = controllerFor(runtime, makeBackend(), {
    ledgerFor: () => ledger,
    prepareWorkDir: async (pkg, dir, context) => {
      if (context?.dryRun === true) return;
      throw new Error('staging failed');
    },
  });

  await assert.rejects(startColab(controller), /staging failed/);

  const status = ledger.status();
  assert.equal(status.spent, 0);
  assert.equal(status.committed, 0);
  assert.equal(status.openReservations.length, 0);
  assert.equal(ledger.entries().some(entry => entry.kind === 'settle'
    && entry.evidence?.reason === 'prepare_failed'), true);
});

test('an approval requirement closes the preflight hold with no allocation', async (t) => {
  const runtime = runtimeDir(t);
  const ledger = makeLedger(runtime);
  const controller = controllerFor(runtime, makeBackend(), { ledgerFor: () => ledger });

  const result = await startColab(controller, { approved: false });

  assert.equal(result.approvalRequired, true);
  const status = ledger.status();
  assert.equal(status.spent, 0);
  assert.equal(status.committed, 0);
  assert.equal(status.openReservations.length, 0);
});

test('ledger.settle still charges reserved.hold, with no caller override', (t) => {
  const runtime = runtimeDir(t);
  const ledger = makeLedger(runtime, { ceiling: 100, userEventId: 'evt_user_cap' });

  ledger.reserve({
    reservationId: 'run:unknown',
    upperBound: 4,
    collectAndStopReserve: 3,
    idempotencyKey: 'run-hold:unknown',
  });
  ledger.settle({
    reservationId: 'run:unknown',
    kind: 'reservation_unverified',
    chargedUnits: 0,
  });

  assert.equal(ledger.status().spent, 7);
  assert.equal(ledger.status().committed, 0);
});

test('a fresh controller over the same capped ledger admits a second run without throwing', async (t) => {
  const runtime = runtimeDir(t);
  const ledgerA = makeLedger(runtime, { ceiling: 10000, userEventId: 'evt_user_cap' });
  const first = controllerFor(runtime, makeBackend(), { ledgerFor: () => ledgerA });
  const firstStart = await startColab(first);
  const firstDone = await first.wait(firstStart.runId);
  assert.equal(firstDone.status, 'done');
  const firstSpent = ledgerA.status().spent;
  assert.ok(firstSpent > 0);

  const ledgerB = makeLedger(runtime);
  const second = controllerFor(runtime, makeBackend(), { ledgerFor: () => ledgerB });
  const secondStart = await startColab(second, { userEventId: 'evt_user_ip08_b' });
  assert.ok(secondStart.runId, 'the second run is admitted after a restart');
  const secondDone = await second.wait(secondStart.runId);
  assert.equal(secondDone.status, 'done');

  const secondIncrement = tidy(secondStart.budget.required - secondStart.budget.spent);
  assert.equal(ledgerB.status().spent, tidy(firstSpent + secondIncrement));
  assert.equal(ledgerB.status().committed, 0);
});

test('a fresh controller over the same uncapped ledger takes one preflight hold per start', async (t) => {
  const runtime = runtimeDir(t);
  const ledgerA = makeLedger(runtime);
  const first = controllerFor(runtime, makeBackend(), { ledgerFor: () => ledgerA });
  const firstStart = await startColab(first);
  await first.wait(firstStart.runId);

  const ledgerB = makeLedger(runtime);
  const second = controllerFor(runtime, makeBackend(), { ledgerFor: () => ledgerB });
  const secondStart = await startColab(second, { userEventId: 'evt_user_ip08_b' });
  await second.wait(secondStart.runId);

  const preflights = ledgerB.entries()
    .filter(entry => entry.kind === 'reserve' && entry.reservationId.startsWith('admission:'));
  assert.equal(preflights.length, 2, 'no preflight id is replayed after a restart');
  assert.equal(new Set(preflights.map(entry => entry.reservationId)).size, 2);
  assert.equal(ledgerB.status().openReservations.length, 0);
});

test('a reused idempotency key never admits a second run after a restart', async (t) => {
  const runtime = runtimeDir(t);
  const ledgerA = makeLedger(runtime);
  const first = controllerFor(runtime, makeBackend(), { ledgerFor: () => ledgerA });
  const firstStart = await startColab(first, { idempotencyKey: 'start-key-ip08' });
  const firstDone = await first.wait(firstStart.runId);
  assert.equal(firstDone.status, 'done');
  const entriesBefore = ledgerA.entries().length;

  const ledgerB = makeLedger(runtime);
  let constructed = 0;
  const second = createRunController({
    runtimeDir: runtime,
    events: null,
    ledgerFor: () => ledgerB,
    backendFactory: async () => {
      constructed += 1;
      return makeBackend();
    },
  });
  const replay = await startColab(second, {
    idempotencyKey: 'start-key-ip08',
    userEventId: 'evt_user_ip08_b',
  });

  assert.equal(replay.status, 409);
  assert.equal(replay.code, 'DUPLICATE_START');
  assert.equal(replay.error, 'duplicate start');
  assert.equal(constructed, 0, 'the backend is never constructed for a duplicate start');
  assert.equal(ledgerB.entries().length, entriesBefore, 'no new hold is taken');
});

test('a controller without ledgerFor keeps the existing in-memory behaviour', async (t) => {
  const runtime = runtimeDir(t);
  const controller = controllerFor(runtime, makeBackend());

  const first = await startColab(controller);
  const firstDone = await controller.wait(first.runId);
  const second = await startColab(controller, { userEventId: 'evt_user_ip08_b' });
  const secondDone = await controller.wait(second.runId);

  assert.equal(firstDone.status, 'done');
  assert.equal(secondDone.status, 'done');
  assert.equal(
    controller.status().spentEstimate,
    firstDone.settled.units + secondDone.settled.units,
  );
});

test('the ledger keeps its own settlement rule: reservation_unverified rejects actualUnits', (t) => {
  const runtime = runtimeDir(t);
  const ledger = makeLedger(runtime);
  ledger.reserve({ reservationId: 'run:strict', upperBound: 2 });

  assert.throws(
    () => ledger.settle({ reservationId: 'run:strict', kind: 'reservation_unverified', actualUnits: 0 }),
    (error) => error instanceof ProductionLedgerError && error.code === 'INVALID_SETTLEMENT',
  );
  assert.equal(ledger.status().spent, 0);
  assert.equal(ledger.status().committed, 2);
});
