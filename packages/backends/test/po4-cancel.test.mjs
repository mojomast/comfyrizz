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
