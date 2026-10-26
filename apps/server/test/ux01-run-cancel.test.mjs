// UX01: the run controller keeps its abort handle. A run's AbortController used
// to be created inline and thrown away, so nothing could ever stop a run that
// had reached `runPackage`. `controller.cancel(runId)` is the entry point the
// coordinator mounts for `/api/run` cancellation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRunController } from '../src/run.mjs';
import { boundPackage, fakeBackend, makeBoundProduction, runControllerFor, tempRuntime } from './ux01-fixture.mjs';

test('UX01: cancel aborts the signal handed to the backend and ends the run as cancelled', async t => {
  const runtimeDir = tempRuntime(t);
  const { backend, state } = fakeBackend({ hold: true });
  const controller = createRunController({ runtimeDir, backendFactory: async () => backend });
  const started = await controller.start({ backendId: 'colab', pkg: { id: 'pkg_unbound', assets: {}, scenes: [] }, budgetUnits: 1000, approved: true });
  assert.ok(started.runId);
  await state.entered;
  assert.equal(state.signal.aborted, false);

  const cancelled = controller.cancel(started.runId);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.runId, started.runId);
  assert.equal(state.signal.aborted, true, 'the backend sees the abort');

  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'cancelled');
  assert.equal(state.aborted, true);
  assert.equal(controller.status().activeRunId, null, 'the controller is free for the next run');
  assert.equal(done.abort, undefined, 'the abort handle is not exposed on a public record');
});

test('UX01: cancel is idempotent and ignores finished or unknown runs', async t => {
  const runtimeDir = tempRuntime(t);
  const { backend, state } = fakeBackend({ hold: true });
  const controller = createRunController({ runtimeDir, backendFactory: async () => backend });
  assert.equal(controller.cancel('run_missing'), null);
  const started = await controller.start({ backendId: 'colab', pkg: { id: 'pkg_unbound', assets: {}, scenes: [] }, budgetUnits: 1000, approved: true });
  await state.entered;
  assert.equal(controller.cancel(started.runId).cancelRequested, true);
  assert.equal(controller.cancel(started.runId).cancelRequested, true);
  await controller.wait(started.runId);
  const late = controller.cancel(started.runId);
  assert.equal(late.cancelRequested, false);
  assert.equal(late.status, 'cancelled');
});

test('UX01: a bound run cancelled through the controller settles its slot and closes the action', async t => {
  const ctx = makeBoundProduction(t);
  const { backend, state } = fakeBackend({ hold: true });
  const controller = runControllerFor(ctx, async () => backend);
  const started = await controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, ...ctx.startBody() });
  assert.ok(started.runId, JSON.stringify(started));
  await state.entered;
  controller.cancel(started.runId);
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'cancelled');
  assert.equal(done.errorCode, 'CANCELLED');
  assert.equal(ctx.ledger.status().openReservations.length, 0, 'the slot hold is settled, not left open');
  assert.equal(ctx.action().state, 'failed', 'the action is terminal; UX03 owns the durable cancelled edge');
  assert.equal(ctx.action().lastError.code, 'CANCELLED');
  assert.equal(state.realCalls, 1);
});

test('UX01: a cancel that lands before the backend runs stops the run without calling runPackage', async t => {
  const runtimeDir = tempRuntime(t);
  const { backend, state } = fakeBackend();
  let releaseFactory;
  const gate = new Promise(resolve => { releaseFactory = resolve; });
  let factoryCalls = 0;
  const controller = createRunController({
    runtimeDir,
    backendFactory: async () => {
      factoryCalls += 1;
      if (factoryCalls > 1) await gate;
      return backend;
    },
  });
  const started = await controller.start({ backendId: 'colab', pkg: { id: 'pkg_unbound', assets: {}, scenes: [] }, budgetUnits: 1000, approved: true });
  assert.ok(started.runId);
  controller.cancel(started.runId);
  releaseFactory();
  const done = await controller.wait(started.runId);
  assert.equal(done.status, 'cancelled');
  assert.equal(state.realCalls, 0, 'the real run never started');
});
