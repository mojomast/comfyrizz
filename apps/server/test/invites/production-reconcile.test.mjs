import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';
import { reconcileInvitePipeline } from '../../src/invites/production-reconcile.mjs';

function fixture(t, { cu = 2, units = 0.7, maxFilms = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'invite-reconcile-'));
  const path = join(dir, 'ledger.sqlite');
  let ledger = createDurableInviteLedger({ path });
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const invite = ledger.mint({ cu, ttlDays: 1, maxFilms }).invite;
  ledger.bindResource(invite.id, 'production', 'prod_1');
  ledger.reserveAction({ inviteId: invite.id, productionId: 'prod_1', actionId: 'act_1', backendId: 'colab', units });
  const run = { runId: 'pipe_1', origin: { productionId: 'prod_1', actionId: 'act_1' }, status: 'completed', packageId: 'pkg_1',
    budget: { ceilingUnits: units, mediaCeilingUnits: units, narrationCeilingUnits: 0 },
    runtimes: { media: { runId: 'pipe_1', session: 'session_1', ownership: 'managed', state: 'stopped',
      shutdownVerified: true, spentUnits: 0.2, costSource: 'account_balance_delta' } } };
  return { run, invite, get ledger() { return ledger; },
    reconcile: () => reconcileInvitePipeline({ ledger, run }),
    restart() { ledger.close(); ledger = createDurableInviteLedger({ path }); } };
}

function receipt(run, units = 0.2) {
  return { source: 'provider_session', receiptId: `receipt_${run.runId}`, unit: 'CU', final: true,
    runId: run.runId, session: run.runtimes.media.session, units };
}

test('completed account-estimate run retains its hold and counts one film across restart', t => {
  const f = fixture(t);
  assert.equal(f.reconcile(), true);
  f.restart();
  f.reconcile(); f.reconcile();
  const invite = f.ledger.get(f.invite.id);
  assert.equal(invite.spentEstimateCu, 0);
  assert.equal(invite.committedEstimateCu, 0.7);
  assert.equal(invite.filmsCompleted, 1);
  const reservation = f.ledger.actionReservation('prod_1', 'act_1');
  assert.equal(reservation.state, 'reserved');
  assert.equal(reservation.spent, null);
  assert.equal(reservation.accounting.reason, 'session_usage_unavailable');
  assert.equal(reservation.accounting.shutdownVerified, true);
  const generations = f.ledger.listGenerations(f.invite.id);
  assert.equal(generations.length, 1);
  assert.equal(generations[0].status, 'ready');
  assert.equal(generations[0].details.actualSpendCu, null);
  assert.equal(generations[0].details.accounting.status, 'unresolved');
});

test('final session receipt releases only the unused reservation after verified shutdown', t => {
  const f = fixture(t);
  f.reconcile(); // Completion precedes billing evidence.
  f.run.runtimes.media.usageReceipt = receipt(f.run);
  f.reconcile();
  f.restart(); f.reconcile();
  const invite = f.ledger.get(f.invite.id);
  assert.equal(invite.spentEstimateCu, 0.2);
  assert.equal(invite.committedEstimateCu, 0);
  assert.equal(invite.remainingCu, 1.8);
  assert.equal(invite.filmsCompleted, 1);
  const generation = f.ledger.listGenerations()[0];
  assert.equal(generation.details.costSource, 'verified_session_usage');
  assert.equal(generation.details.actualSpendCu, 0.2);
  assert.equal(generation.details.accounting.status, 'settled');
});

test('proven non-allocation releases a failed run at zero, idempotently', t => {
  const f = fixture(t);
  f.run.status = 'failed';
  Object.assign(f.run.runtimes.media, { allocation: 'not_attempted', spentUnits: 0, costSource: 'verified_no_allocation' });
  f.reconcile(); f.restart(); f.reconcile();
  assert.equal(f.ledger.get(f.invite.id).spentEstimateCu, 0);
  assert.equal(f.ledger.get(f.invite.id).committedEstimateCu, 0);
  assert.equal(f.ledger.get(f.invite.id).filmsCompleted, 0);
  assert.equal(f.ledger.actionReservation('prod_1', 'act_1').accounting.costSource, 'verified_no_allocation');
});

test('all allocated sessions need final receipts before their total can settle', t => {
  const f = fixture(t);
  f.run.budget.narrationCeilingUnits = 0.2;
  f.run.runtimes.media.usageReceipt = receipt(f.run);
  f.run.runtimes.narration = { ...f.run.runtimes.media, session: 'narration_1', usageReceipt: undefined };
  f.reconcile();
  assert.equal(f.ledger.get(f.invite.id).committedEstimateCu, 0.7);
  f.run.runtimes.narration.usageReceipt = { ...receipt(f.run, 0.1), receiptId: 'receipt_voice', session: 'narration_1' };
  f.reconcile(); f.restart(); f.reconcile();
  assert.equal(f.ledger.get(f.invite.id).spentEstimateCu, 0.3);
  assert.equal(f.ledger.get(f.invite.id).committedEstimateCu, 0);
  assert.equal(f.ledger.get(f.invite.id).filmsCompleted, 1);
});

test('unconfirmed shutdown retains even attributable usage until shutdown reconciliation', t => {
  const f = fixture(t);
  f.run.status = 'failed';
  f.run.runtimes.media.usageReceipt = receipt(f.run);
  Object.assign(f.run.runtimes.media, { state: 'stop_unconfirmed', shutdownVerified: false });
  f.reconcile(); f.restart(); f.reconcile();
  assert.equal(f.ledger.actionReservation('prod_1', 'act_1').accounting.reason, 'shutdown_unconfirmed');
  assert.equal(f.ledger.get(f.invite.id).committedEstimateCu, 0.7);
  Object.assign(f.run.runtimes.media, { state: 'stopped', shutdownVerified: true });
  f.reconcile();
  assert.equal(f.ledger.get(f.invite.id).spentEstimateCu, 0.2);
  assert.equal(f.ledger.get(f.invite.id).committedEstimateCu, 0);
  assert.equal(f.ledger.get(f.invite.id).filmsCompleted, 0);
});

test('restart without runtime evidence does not imply no allocation', t => {
  const f = fixture(t);
  f.run.status = 'interrupted'; delete f.run.runtimes;
  f.reconcile(); f.restart(); f.reconcile();
  assert.equal(f.ledger.get(f.invite.id).committedEstimateCu, 0.7);
  assert.equal(f.ledger.get(f.invite.id).spentEstimateCu, 0);
  assert.equal(f.ledger.listGenerations()[0].showcase, false);
  assert.equal(f.ledger.actionReservation('prod_1', 'act_1').accounting.reason, 'runtime_evidence_missing');
});

test('overlapping account deltas are not apportioned or charged to either run', t => {
  const f = fixture(t, { cu: 10, units: 2 });
  f.run.runtimes.media.spentUnits = 3; // Includes a sibling's spending; exceeds this run's cap.
  const second = structuredClone(f.run);
  second.runId = 'pipe_2'; second.origin.productionId = 'prod_2';
  Object.assign(second.runtimes.media, { runId: 'pipe_2', session: 'session_2' });
  f.ledger.bindResource(f.invite.id, 'production', 'prod_2');
  f.ledger.reserveAction({ inviteId: f.invite.id, productionId: 'prod_2', actionId: 'act_1', backendId: 'colab', units: 2 });
  f.reconcile(); reconcileInvitePipeline({ ledger: f.ledger, run: second });
  f.restart(); f.reconcile(); reconcileInvitePipeline({ ledger: f.ledger, run: second });
  assert.equal(f.ledger.get(f.invite.id).spentEstimateCu, 0);
  assert.equal(f.ledger.get(f.invite.id).committedEstimateCu, 4);
  assert.equal(f.ledger.get(f.invite.id).filmsCompleted, 2);
});

test('completed unresolved holds count once toward film quota, not twice', t => {
  const f = fixture(t, { cu: 10, maxFilms: 2 });
  f.reconcile();
  for (const id of ['prod_2', 'prod_3']) f.ledger.bindResource(f.invite.id, 'production', id);
  assert.equal(f.ledger.reserveAction({ inviteId: f.invite.id, productionId: 'prod_2', actionId: 'act_2', backendId: 'colab', units: 1 }).ok, true);
  assert.equal(f.ledger.reserveAction({ inviteId: f.invite.id, productionId: 'prod_3', actionId: 'act_3', backendId: 'colab', units: 1 }).reason, 'film_limit');
});

test('invalid, partial, foreign or over-cap receipts never release the hold', t => {
  const f = fixture(t);
  for (const patch of [{ source: 'account_balance_delta' }, { runId: 'pipe_foreign' }, { session: 'other' },
    { final: false }, { units: -1 }, { units: 0.8 }, { units: NaN }, { receiptId: '' }]) {
    f.run.runtimes.media.usageReceipt = { ...receipt(f.run), ...patch };
    f.reconcile();
    assert.equal(f.ledger.actionReservation('prod_1', 'act_1').state, 'reserved', JSON.stringify(patch));
  }
  f.run.runtimes.media.usageReceipt = receipt(f.run);
  f.run.budget.narrationCeilingUnits = 0.1;
  f.reconcile();
  assert.equal(f.ledger.actionReservation('prod_1', 'act_1').accounting.reason, 'runtime_evidence_missing');
});

test('CPU completion neither reserves CU nor consumes another paid film slot', t => {
  const f = fixture(t);
  f.run.origin.actionId = 'act_invite_cpu';
  f.run.budget = { ceilingUnits: 0 }; f.run.runtimes = {};
  const before = f.ledger.get(f.invite.id);
  f.reconcile(); f.restart(); f.reconcile();
  assert.deepEqual(f.ledger.get(f.invite.id), { ...before, generations: before.generations + 1 });
  assert.equal(f.ledger.actionReservation('prod_1', 'act_invite_cpu'), null);
  assert.equal(f.ledger.listGenerations()[0].details.accounting.actualSpendCu, 0);
});

test('historically settled reservations remain explicitly estimated after restart', t => {
  const f = fixture(t);
  f.ledger.settleAction({ productionId: 'prod_1', actionId: 'act_1', spent: 0.7, filmCompleted: true });
  f.restart(); f.reconcile();
  assert.equal(f.ledger.get(f.invite.id).spentEstimateCu, 0.7);
  assert.equal(f.ledger.get(f.invite.id).filmsCompleted, 1);
  assert.equal(f.ledger.listGenerations()[0].details.accounting.status, 'legacy_estimate');
  assert.equal(f.ledger.listGenerations()[0].details.actualSpendCu, null);
});
