// UX03: the run controller's executor-facing cancel, pre-start intent recheck
// and restart settlement. The backend is a local fake; nothing reaches Google
// Google Colab, a provider or the network.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createRunController } from '../src/run.mjs';
import {
  ACTION_ID,
  boundPackage,
  fakeBackend,
  makeBoundProduction,
  runControllerFor,
} from './ux01-fixture.mjs';

function settleEntries(ledger, reservationId) {
  return ledger.entries().filter(
    (entry) => entry.kind === 'settle' && (reservationId === undefined || entry.reservationId === reservationId),
  );
}

function writeRunRecord(runtimeDir, record) {
  const dir = join(runtimeDir, 'runs', record.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

test('cancel reports requested, aborts once, and a finished run reports stopped', async (t) => {
  const ctx = makeBoundProduction(t);
  const { backend, state } = fakeBackend({ hold: true });
  const controller = runControllerFor(ctx, async () => backend);
  const started = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(),
    budgetUnits: 1000,
    ...ctx.startBody(),
  });
  assert.ok(started.runId, JSON.stringify(started));
  await state.entered;

  const requested = controller.cancel(started.runId);
  assert.equal(requested.cancelRequested, true);
  assert.equal(requested.phase, 'requested');
  assert.equal(state.signal.aborted, true, 'the retained abort handle reaches the backend');
  assert.equal(controller.cancel(started.runId).phase, 'requested', 'a repeated request is idempotent');

  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'cancelled');
  assert.equal(state.realCalls, 1);
  const stopped = controller.cancel(started.runId);
  assert.equal(stopped.cancelRequested, false);
  assert.equal(stopped.phase, 'stopped');
  const settles = settleEntries(ctx.ledger, ctx.action().reservationId);
  assert.equal(settles.length, 1, 'the consumed slot settles exactly once');
  assert.equal(ctx.ledger.status().openReservations.length, 0);
});

test('a pause between estimate and action consumption is refused before any backend allocation', async (t) => {
  const ctx = makeBoundProduction(t);
  const { backend, state } = fakeBackend();
  let factoryCalls = 0;
  let paused = false;
  const controller = runControllerFor(ctx, async () => {
    factoryCalls += 1;
    return backend;
  }, {
    prepareWorkDir: async (_pkg, _dir, context = {}) => {
      if (context.dryRun === true && !paused) {
        paused = true;
        ctx.command('production.pause');
      }
    },
  });

  const refused = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(),
    budgetUnits: 1000,
    ...ctx.startBody(),
  });
  assert.equal(refused.code, 'PRODUCTION_NOT_ACTIVE', JSON.stringify(refused));
  assert.equal(refused.status, 409);
  assert.equal(factoryCalls, 1, 'only the dry-run estimate may construct a backend');
  assert.equal(state.dryRuns, 1);
  assert.equal(state.realCalls, 0, 'the paused production never launches media work');
  assert.equal(ctx.action().state, 'queued', 'the action authority is not consumed');
  assert.equal(ctx.action().runId, null);
});

test('a restart retries settlement for a terminal action with an unfinished hold', async (t) => {
  const ctx = makeBoundProduction(t);
  const action = ctx.action();
  assert.equal(ctx.ledger.status().openReservations.length, 1, 'the dispatched slot is held');

  writeRunRecord(ctx.runtimeDir, {
    schema: 'comfyrizz.run-record/v1',
    runId: 'run_ux03_terminal',
    backendId: 'colab',
    productionId: ctx.productionId,
    actionId: ACTION_ID,
    planHash: ctx.planHash,
    actionPlanHash: ctx.planHash,
    reservationId: action.reservationId,
    status: 'failed',
    startedAt: '2026-10-26T12:00:00.000Z',
    finishedAt: '2026-10-26T12:01:00.000Z',
    finished: true,
    error: 'the job failed after allocation',
    errorCode: 'JOB_FAILED',
    settlement: { kind: 'actual', units: 12, at: '2026-10-26T12:01:00.000Z' },
    revision: null,
    render: null,
    teardown: { state: 'stopped' },
    counts: { succeeded: 0, failed: 1 },
    manifest: { complete: false },
  });

  // The action is already terminal, so a recovery that only looks at active
  // states leaves the hold open forever.
  const current = ctx.store.read(ctx.productionId);
  ctx.store.commit(ctx.productionId, {
    commandId: 'terminal_ux03',
    idempotencyKey: 'terminal_ux03',
    baseRevision: current.revision,
    events: [{
      type: 'action.state_changed',
      data: {
        ...action,
        state: 'failed',
        runId: 'run_ux03_terminal',
        lastError: { code: 'JOB_FAILED', message: 'the job failed after allocation' },
      },
    }],
  });

  const recovered = createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory: async () => {
      throw new Error('a restart must not construct a backend while recovering');
    },
    productionStore: ctx.store,
    ledgerFor: ctx.ledgerFor,
    isBusy: () => false,
  });
  assert.ok(recovered);
  assert.equal(ctx.ledger.status().openReservations.length, 0, 'the unfinished hold is retried at startup');
  const settles = settleEntries(ctx.ledger, action.reservationId);
  assert.equal(settles.length, 1);
  assert.equal(settles[0].charged, 12);
});

test('restart reconciliation leaves an attributable running action alone and never starts a second run', async (t) => {
  const ctx = makeBoundProduction(t);
  const { backend, state } = fakeBackend({ hold: true });
  const controller = runControllerFor(ctx, async () => backend);
  const started = await controller.start({
    backendId: 'colab',
    pkg: boundPackage(),
    budgetUnits: 1000,
    ...ctx.startBody(),
  });
  await state.entered;
  const before = ctx.action();
  assert.equal(before.state, 'running');
  assert.equal(before.runId, started.runId);

  // A second controller sees a live in-process record only in this process, so
  // its recovery cannot claim the run finished. It must not create a new one.
  const restarted = runControllerFor(ctx, async () => {
    throw new Error('recovery must not start a backend');
  });
  assert.equal(restarted.get(started.runId), null);
  assert.equal(restarted.cancel('run_missing'), null);
  assert.equal(ctx.action().runId, started.runId, 'attribution survives the restart');

  state.release();
  await controller.wait(started.runId);
});

test('action cancel and restart are durable commands with their own outbox effects', async (t) => {
  const ctx = makeBoundProduction(t);
  const cancelled = ctx.actions.cancel({
    productionId: ctx.productionId,
    context: { actor: 'user', userEventId: 'ue_ux03_cancel' },
    body: {
      commandId: 'cmd_ux03_cancel',
      idempotencyKey: 'key_ux03_cancel',
      expected: { productionRevision: ctx.revision() },
      payload: { actionId: ACTION_ID },
    },
  });
  assert.equal(cancelled.action.state, 'cancel_requested');
  assert.equal(cancelled.outboxIds.length, 1);
  assert.deepEqual(
    ctx.store.pending(ctx.productionId).map((entry) => entry.type),
    ['action.dispatch', 'action.cancel'],
  );

  // Move the action to blocked (as a refused dispatch would), then restart it.
  const current = ctx.store.read(ctx.productionId);
  ctx.store.commit(ctx.productionId, {
    commandId: 'blocked_ux03',
    idempotencyKey: 'blocked_ux03',
    baseRevision: current.revision,
    events: [{
      type: 'action.state_changed',
      data: { ...ctx.action(), state: 'blocked', lastError: { code: 'DISPATCH_REFUSED', message: 'refused' } },
    }],
  });
  const restarted = ctx.actions.restart({
    productionId: ctx.productionId,
    context: { actor: 'user', userEventId: 'ue_ux03_restart' },
    body: {
      commandId: 'cmd_ux03_restart',
      idempotencyKey: 'key_ux03_restart',
      expected: { productionRevision: ctx.revision() },
      payload: { actionId: ACTION_ID },
    },
  });
  assert.equal(restarted.action.state, 'queued');
  assert.equal(restarted.action.runId, null);
  assert.equal(restarted.action.attemptId, null);
  assert.deepEqual(
    ctx.store.pending(ctx.productionId).map((entry) => entry.type),
    ['action.dispatch', 'action.cancel', 'action.dispatch'],
  );
});
