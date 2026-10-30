// PO-4: cancellation could not interrupt allocation. `ensureUp` spawned `colab new` with no signal, so a
// cancel during the slowest, most expensive step waited for it to finish - and then billed for a VM nobody
// wanted. The signal now goes through the CLI, which kills the child; the abort reason surfaces as a
// cancellation rather than as "colab new failed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createColabBackend } from '../src/colab-backend.mjs';
import { installFakeColab, makeCli, readLog } from './helpers.mjs';

function backendFor(t, state = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-po4-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = installFakeColab(dir, { state });
  const backend = createColabBackend({
    cli: makeCli(fake),
    packageId: 'pkg_po4cancel01',
    scratchDir: join(dir, 'scratch'),
    logDir: join(dir, 'logs'),
    packageDir: null,
    hfTokenPath: null,
    watchdogMinutes: 0.02,
  });
  return { backend, fake, dir, commands: () => readLog(fake.logPath).map(entry => entry.argv[0]) };
}

test('an aborted ensureUp never allocates a VM and rethrows the abort reason', async t => {
  const { backend, commands } = backendFor(t, { stopped: true });
  const controller = new AbortController();
  controller.abort(new Error('the owner cancelled before allocation'));
  await assert.rejects(() => backend.ensureUp({ approved: true, signal: controller.signal }), /the owner cancelled before allocation/);
  assert.ok(!commands().includes('new'), 'no allocation may be attempted once the run is cancelled');
});

test('the abort reason is not reported as a Colab failure', async t => {
  const { backend } = backendFor(t, { stopped: true });
  const controller = new AbortController();
  controller.abort();
  // AbortController.abort() with no reason is a DOMException named AbortError, not a ColabCliError whose
  // message would blame the CLI for a cancelled run.
  const error = await backend.ensureUp({ approved: true, signal: controller.signal }).then(() => null, e => e);
  assert.equal(error?.name, 'AbortError');
  assert.doesNotMatch(error.message, /colab new failed/);
});

// PO-4 review (BLOCKER 1): a cancel that lands after the assign POST provisioned the VM used to leave the
// session unregistered, so teardown answered not_owned and the run reported "stopped" while it spent.
test('a cancel while `colab new` hangs stops the session it created before reporting clean', async t => {
  const { backend, fake, commands } = backendFor(t, { stopped: true, newHangs: true });
  const controller = new AbortController();
  const pending = backend.ensureUp({ approved: true, signal: controller.signal }).then(() => null, e => e);
  // wait until the fake has provisioned (state lists the session) and is hanging
  const { readState } = await import('./helpers.mjs');
  for (let i = 0; i < 200 && !String(readState(fake.statePath).sessions || '').includes('['); i += 1) await new Promise(r => setTimeout(r, 25));
  controller.abort(new Error('owner cancelled mid-allocation'));
  const error = await pending;
  assert.match(error?.message ?? '', /owner cancelled mid-allocation/);
  assert.equal(error.allocationCleanup?.confirmedGone, true);
  assert.equal(error.allocationCleanup?.listedEver, true);
  const seen = commands();
  assert.ok(seen.includes('new') && seen.includes('sessions') && seen.includes('stop'), `expected new, sessions, stop; got ${seen}`);
  assert.equal(readState(fake.statePath).stopped, true, 'the VM must actually be stopped');
  const teardown = await backend.teardown('after cancel');
  assert.equal(teardown.state, 'not_owned', 'nothing left to own once the stop is confirmed');
  assert.equal(teardown.shutdownVerified, true);
  assert.equal(teardown.allocation, 'attempted', 'verified cleanup cannot prove a transient runtime was free');
});

test('an unconfirmed stop after a cancelled allocation keeps ownership and is not reported clean', async t => {
  const { backend, fake } = backendFor(t, { stopped: true, newHangs: true, keepAfterStop: true });
  const controller = new AbortController();
  const pending = backend.ensureUp({ approved: true, signal: controller.signal }).then(() => null, e => e);
  const { readState } = await import('./helpers.mjs');
  for (let i = 0; i < 200 && !String(readState(fake.statePath).sessions || '').includes('['); i += 1) await new Promise(r => setTimeout(r, 25));
  controller.abort(new Error('owner cancelled'));
  const error = await pending;
  assert.match(error?.message ?? '', /not confirmed stopped/);
  assert.equal(error.detail?.allocationCleanup?.confirmedGone, false);
  const teardown = await backend.teardown('after cancel');
  assert.equal(teardown.state, 'stop_unconfirmed', 'a still-listed session must never map to stopped');
  await backend.disarmWatchdog?.('test');
});

test('the 503 retry wait is abort-aware', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-po4-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = installFakeColab(dir, { state: { stopped: true, allowNew: false, newOutput: 'Failed to issue request POST https://colab.research.google.com/tun/m/assign?accelerator=G4: Service Unavailable' } });
  const backend = createColabBackend({ cli: makeCli(fake), packageId: 'pkg_po4cancel02', scratchDir: join(dir, 'scratch'), logDir: join(dir, 'logs'), packageDir: null, hfTokenPath: null, watchdogMinutes: 0.02, newRetryMs: 60000 });
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(new Error('cancel during backoff')), 300);
  const error = await backend.ensureUp({ approved: true, signal: controller.signal }).then(() => null, e => e);
  assert.ok(error);
  assert.ok(Date.now() - started < 20000, 'ensureUp must not sit out a 60 s backoff after cancel');
});

// PO-4 re-review (1): an interrupted `new` can leave an unnamed ('?') row. That is not "gone".
test('an orphan row after a cancelled hanging allocation is surfaced, not counted as gone', async t => {
  const { backend, fake } = backendFor(t, { stopped: true, newHangs: true, newListsOrphan: true, keepAfterStop: true });
  const { readState } = await import('./helpers.mjs');
  const controller = new AbortController();
  const pending = backend.ensureUp({ approved: true, signal: controller.signal }).then(() => null, e => e);
  for (let i = 0; i < 200 && !String(readState(fake.statePath).sessions || '').includes('[?]'); i += 1) await new Promise(r => setTimeout(r, 25));
  controller.abort(new Error('owner cancelled'));
  const error = await pending;
  assert.match(error?.message ?? '', /not confirmed stopped/);
  const cleanup = error.detail?.allocationCleanup;
  assert.equal(cleanup?.confirmedGone, false);
  assert.equal(cleanup.orphans.length, 1, 'the orphan must be surfaced');
  assert.match(cleanup.note, /unnamed \(orphan\)/);
  assert.ok(backend.state.watchdog?.pid, 'an unconfirmed cleanup arms the watchdog');
  const teardown = await backend.teardown('after cancel');
  assert.equal(teardown.state, 'stop_unconfirmed');
  assert.equal(teardown.orphans?.length, 1);
});

// PO-4 re-review (2): when every `colab sessions` call fails, nothing is confirmed, so the watchdog is armed.
test('a cleanup whose sessions calls all fail still arms the watchdog', async t => {
  const { backend, fake } = backendFor(t, { stopped: true, newHangs: true });
  const { readState, writeState } = await import('./helpers.mjs');
  const controller = new AbortController();
  const pending = backend.ensureUp({ approved: true, signal: controller.signal }).then(() => null, e => e);
  for (let i = 0; i < 200 && !String(readState(fake.statePath).sessions || '').includes('['); i += 1) await new Promise(r => setTimeout(r, 25));
  writeState(fake.statePath, { ...readState(fake.statePath), failSessions: true });
  controller.abort(new Error('owner cancelled'));
  const error = await pending;
  assert.equal(error?.detail?.allocationCleanup?.confirmedGone, false);
  assert.equal(error.detail.allocationCleanup.listedEver, false, 'no listing ever succeeded');
  assert.match(error.detail.allocationCleanup.note, /colab sessions failed/);
  assert.ok(backend.state.watchdog?.pid, 'watchdog armed although no listing succeeded');
});
