import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';
import { reconcileInvitePipeline } from '../../src/invites/production-reconcile.mjs';

test('completed pipeline charges its reservation and records one generation across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-reconcile-'));
  let ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
  try {
    const invite = ledger.mint({ cu: 2, ttlDays: 1 }).invite;
    ledger.bindResource(invite.id, 'production', 'prod_1');
    ledger.reserveAction({ inviteId: invite.id, productionId: 'prod_1', actionId: 'act_1', backendId: 'colab', units: 0.7 });
    const run = { runId: 'pipe_1', origin: { productionId: 'prod_1', actionId: 'act_1' }, status: 'completed', packageId: 'pkg_1' };
    assert.equal(reconcileInvitePipeline({ ledger, run, readPackage: () => ({ title: 'Example' }) }), true);
    ledger.close();
    ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
    assert.equal(reconcileInvitePipeline({ ledger, run }), true);
    assert.equal(ledger.get(invite.id).spentEstimateCu, 0.7);
    assert.equal(ledger.get(invite.id).committedEstimateCu, 0);
    assert.equal(ledger.get(invite.id).filmsCompleted, 1);
    assert.equal(ledger.listGenerations(invite.id).length, 1);
    assert.equal(ledger.listGenerations(invite.id)[0].details.costSource, 'reserved_upper_estimate');
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an interrupted pipeline charges its full reservation without claiming a successful generation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-reconcile-crash-'));
  const ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
  try {
    const invite = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    ledger.bindResource(invite.id, 'production', 'prod_1');
    ledger.reserveAction({ inviteId: invite.id, productionId: 'prod_1', actionId: 'act_1', backendId: 'colab', units: 1 });
    const run = { runId: 'pipe_1', origin: { productionId: 'prod_1', actionId: 'act_1' }, status: 'interrupted' };
    assert.equal(reconcileInvitePipeline({ ledger, run }), true);
    assert.equal(ledger.get(invite.id).remainingCu, 0);
    assert.equal(ledger.get(invite.id).filmsCompleted, 0);
    assert.equal(ledger.listGenerations(invite.id)[0].status, 'interrupted');
    assert.equal(ledger.listGenerations(invite.id)[0].showcase, false);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
