// IP06: the run controller's spend ledger must settle each run once, with its own
// incremental cost (never the cumulative `budget.required`), and it must settle
// honestly when a paid backend may have allocated compute but failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunController } from '../src/run.mjs';

const PKG = { id: 'pkg_ip06', schema: 'comfyrizz.package/1', assets: {}, scenes: [] };

function runtimeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-run-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A metered (Google Colab-priced) fake backend. `runReal` decides what the real
 * (non-dry) runPackage does; the dry run always succeeds so the controller can
 * plan and admit the run.
 */
function fakeBackend({ gpuMinutes = 60, runReal = null } = {}) {
  const backend = {
    id: 'colab',
    async describe() {
      return { label: 'Google Colab G4', costVisibility: 'account-estimate' };
    },
    async runPackage(pkg, opts = {}) {
      const jobsDoc = { jobs: [{ id: 'j1' }] };
      const estimate = { gpuMinutes, overheadMinutes: 5, ratePerHour: 8.9 };
      if (opts.dryRun) return { jobsDoc, estimate, teardown: null };
      if (runReal) return runReal({ pkg, opts, jobsDoc, estimate });
      opts.onEvent?.({ v: 1, event: 'run_phase', phase: 'up', state: 'started' });
      opts.onEvent?.({ v: 1, event: 'run_phase', phase: 'ran', counts: { succeeded: 1 } });
      opts.onEvent?.({ v: 1, event: 'run_phase', phase: 'teardown', state: 'stopped' });
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

function controllerFor(t, backend, extra = {}) {
  return createRunController({
    runtimeDir: runtimeDir(t),
    events: null,
    backendFactory: async () => backend,
    ...extra,
  });
}

const startColab = (controller) => controller.start({ backendId: 'colab', pkg: PKG, budgetUnits: 1000, approved: true });

test('two runs settle the sum of their incremental costs, not cumulative required', async t => {
  const controller = controllerFor(t, fakeBackend());
  const first = await startColab(controller);
  assert.ok(first.budget.required > 0);
  const firstDone = await controller.wait(first.runId);

  const second = await startColab(controller);
  const secondDone = await controller.wait(second.runId);

  assert.equal(firstDone.settled.kind, 'completed');
  assert.equal(secondDone.settled.kind, 'completed');
  const inc1 = firstDone.settled.units;
  const inc2 = secondDone.settled.units;
  assert.ok(inc1 > 0 && inc2 > 0);
  assert.ok(inc2 < second.budget.required, 'the second run does not re-add the first run spend');
  assert.equal(controller.status().spentEstimate, inc1 + inc2);
});

test('a failed run settles the backend actual usage when it reports one', async t => {
  const backend = fakeBackend({
    runReal: async ({ opts, jobsDoc, estimate }) => {
      opts.onEvent?.({ v: 1, event: 'run_phase', phase: 'allocating' });
      const error = new Error('job blew up');
      error.spend = { units: 4.5, label: 'estimate' };
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
  });
  const controller = controllerFor(t, backend);
  const started = await startColab(controller);
  const done = await controller.wait(started.runId);

  assert.equal(done.status, 'failed');
  assert.equal(done.settled.kind, 'actual');
  assert.equal(done.settled.units, 4.5);
  assert.equal(controller.status().spentEstimate, 4.5);
});

test('(a) a failure that may have allocated with no reading settles the reservation increment', async t => {
  const backend = fakeBackend({
    runReal: async ({ opts, jobsDoc, estimate }) => {
      opts.onEvent?.({ v: 1, event: 'run_phase', phase: 'allocating' });
      const error = new Error('ensureUp was cut off');
      error.runPackage = { jobsDoc, estimate, up: null, teardown: { state: 'unknown' }, manifest: null, counts: null };
      throw error;
    },
  });
  const controller = controllerFor(t, backend);
  const started = await startColab(controller);
  const done = await controller.wait(started.runId);
  const increment = started.budget.required - started.budget.spent;

  assert.equal(done.settled.kind, 'reservation_unverified');
  assert.ok(done.settled.units > 0);
  assert.equal(done.settled.units, increment);
  assert.equal(controller.status().spentEstimate, increment);
});

test('(b) a backend that was never constructed settles zero', async t => {
  let constructed = 0;
  const controller = createRunController({
    runtimeDir: runtimeDir(t),
    events: null,
    backendFactory: async () => {
      constructed += 1;
      if (constructed > 1) throw new Error('cannot construct backend');
      return fakeBackend();
    },
  });
  const started = await startColab(controller);
  const done = await controller.wait(started.runId);

  assert.equal(done.status, 'failed');
  assert.equal(done.settled.kind, 'not_allocated');
  assert.equal(done.settled.units, 0);
  assert.equal(controller.status().spentEstimate, 0);
});

test('(c) a render failure after the media completed settles the media cost, not zero', async t => {
  const controller = controllerFor(t, fakeBackend(), {
    onComplete: async () => { throw new Error('encoder failed'); },
  });
  const started = await startColab(controller);
  const done = await controller.wait(started.runId);
  const increment = started.budget.required - started.budget.spent;

  assert.equal(done.status, 'failed');
  assert.equal(done.settled.kind, 'media_completed');
  assert.ok(done.settled.units > 0);
  assert.equal(done.settled.units, increment);
});

test('(d) an incomplete manifest settles the actual result spend when present', async t => {
  const backend = fakeBackend({
    runReal: async ({ opts, jobsDoc, estimate }) => {
      opts.onEvent?.({ v: 1, event: 'run_phase', phase: 'ran', counts: { failed: 1 } });
      return {
        ok: false,
        jobsDoc,
        estimate,
        manifest: { complete: false, counts: { failed: 1 } },
        counts: { failed: 1 },
        applied: [],
        teardown: { state: 'stopped' },
        spend: { units: 3.25, label: 'estimate' },
      };
    },
  });
  const controller = controllerFor(t, backend);
  const started = await startColab(controller);
  const done = await controller.wait(started.runId);

  assert.equal(done.status, 'failed');
  assert.equal(done.settled.kind, 'actual');
  assert.equal(done.settled.units, 3.25);
  assert.equal(controller.status().spentEstimate, 3.25);
});

test('(e) settlement is idempotent: one settlement per run', async t => {
  const controller = controllerFor(t, fakeBackend());
  const started = await startColab(controller);
  const done = await controller.wait(started.runId);
  const settledAt = done.settled.at;
  const spent = controller.status().spentEstimate;

  await controller.wait(started.runId);
  await controller.wait(started.runId);
  const again = controller.get(started.runId);

  assert.equal(controller.status().spentEstimate, spent);
  assert.equal(again.settledUnits, done.settledUnits);
  assert.equal(again.settled.at, settledAt);
});

test('(f) an interrupted allocation with a possibly created session settles the increment', async t => {
  const backend = fakeBackend({
    runReal: async ({ opts, jobsDoc, estimate }) => {
      opts.onEvent?.({ v: 1, event: 'run_phase', phase: 'allocating' });
      const error = new Error('allocation was interrupted and the session it may have created is not confirmed stopped');
      error.allocationCleanup = { confirmedGone: false, listedEver: true };
      error.runPackage = {
        jobsDoc,
        estimate,
        up: null,
        session: null,
        teardown: { state: 'unknown' },
        manifest: null,
        counts: null,
      };
      throw error;
    },
  });
  const controller = controllerFor(t, backend);
  const started = await startColab(controller);
  const done = await controller.wait(started.runId);
  const increment = started.budget.required - started.budget.spent;

  assert.equal(done.settled.kind, 'reservation_unverified');
  assert.ok(done.settled.units > 0);
  assert.equal(done.settled.units, increment);
});

test('(g) allocation cleanup proving nothing was ever listed settles zero', async t => {
  const backend = fakeBackend({
    runReal: async ({ opts, jobsDoc, estimate }) => {
      opts.onEvent?.({ v: 1, event: 'run_phase', phase: 'allocating' });
      const error = new Error('Google Colab answered 503 while assigning');
      error.allocationCleanup = { confirmedGone: true, listedEver: false };
      error.runPackage = { jobsDoc, estimate, up: null, teardown: { state: 'none' }, manifest: null, counts: null };
      throw error;
    },
  });
  const controller = controllerFor(t, backend);
  const started = await startColab(controller);
  const done = await controller.wait(started.runId);

  assert.equal(done.settled.kind, 'not_allocated');
  assert.equal(done.settled.units, 0);
  assert.equal(controller.status().spentEstimate, 0);
});

test('(h) a failure before any allocating event with no up settles zero', async t => {
  const backend = fakeBackend({
    runReal: async ({ jobsDoc, estimate }) => {
      const error = new Error('package staging failed');
      error.runPackage = { jobsDoc, estimate, up: null, teardown: null, manifest: null, counts: null };
      throw error;
    },
  });
  const controller = controllerFor(t, backend);
  const started = await startColab(controller);
  const done = await controller.wait(started.runId);

  assert.equal(done.settled.kind, 'not_allocated');
  assert.equal(done.settled.units, 0);
  assert.equal(controller.status().spentEstimate, 0);
});
