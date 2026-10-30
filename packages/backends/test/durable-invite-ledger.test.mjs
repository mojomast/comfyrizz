import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createDurableInviteLedger } from '../src/durable-invite-ledger.mjs';

test('invites, reservations, revocation and generations survive restart without storing bearer tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-ledger-'));
  const path = join(dir, 'ledger.sqlite');
  try {
    let ledger = createDurableInviteLedger({ path });
    const minted = ledger.mint({ cu: 2, ttlDays: 1 });
    ledger.recordVisit(minted.invite.id);
    ledger.bindResource(minted.invite.id, 'package', 'pkg_prompt');
    ledger.setResourceDetails('package', 'pkg_prompt', { prompt: 'Saved prompt', planner: { name: 'test-model' } });
    assert.equal(ledger.commit(minted.invite.id, 1.5).ok, true);
    ledger.close();
    assert.equal(readFileSync(path).includes(Buffer.from(minted.token)), false);
    ledger = createDurableInviteLedger({ path });
    assert.equal(ledger.ownerSummary().totals.visits, 1);
    assert.deepEqual(ledger.resourceDetails('package', 'pkg_prompt'), { prompt: 'Saved prompt', planner: { name: 'test-model' } });
    assert.equal(ledger.redeem(minted.token).invite.remainingCu, 0.5);
    assert.equal(ledger.commit(minted.invite.id, 1).ok, false);
    ledger.settle(minted.invite.id, { spent: 1.5, filmCompleted: true });
    ledger.recordGeneration(minted.invite.id, { runId: 'run_provenance', packageId: 'pkg1', prompt: 'test' });
    ledger.recordGenerationModels('run_provenance', [{ name: 'Verified model', role: 'image', evidence: 'verified_workflow' }]);
    ledger.revoke(minted.invite.id);
    ledger.close();
    ledger = createDurableInviteLedger({ path });
    assert.equal(ledger.redeem(minted.token).reason, 'revoked');
    assert.equal(ledger.ownerSummary().totals.spentEstimateCu, 1.5);
    assert.equal(ledger.ownerSummary().generations[0].packageId, 'pkg1');
    assert.equal(ledger.ownerSummary().generations[0].status, 'ready');
    assert.equal(ledger.ownerSummary().generations[0].details.models[0].name, 'Verified model');
    ledger.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('independent ledger instances see reservations before accepting more spend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-ledger-'));
  try {
    const path = join(dir, 'ledger.sqlite');
    const first = createDurableInviteLedger({ path });
    const second = createDurableInviteLedger({ path });
    const { invite } = first.mint({ cu: 1, ttlDays: 1 });
    assert.equal(first.commit(invite.id, 0.8).ok, true);
    assert.equal(second.commit(invite.id, 0.3).ok, false);
    assert.equal(second.get(invite.id).remainingCu, 0.2);
    first.close();
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const limit of ['budget', 'film']) test(`concurrent independent workers cannot exceed the shared invite ${limit} limit`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-ledger-concurrent-'));
  const path = join(dir, 'ledger.sqlite');
  const ledger = createDurableInviteLedger({ path });
  const workers = [];
  try {
    const invite = ledger.mint({ cu: limit === 'budget' ? 1 : 10, maxFilms: limit === 'film' ? 1 : 0, ttlDays: 1 }).invite;
    ledger.bindResource(invite.id, 'production', 'prod_shared');
    const barrier = new SharedArrayBuffer(4);
    const flag = new Int32Array(barrier);
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { createDurableInviteLedger } = await import(workerData.module);
        const ledger = createDurableInviteLedger({ path: workerData.path });
        parentPort.postMessage({ ready: true });
        Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
        const result = ledger.reserveAction({ inviteId: workerData.inviteId, productionId: 'prod_shared', actionId: workerData.actionId, backendId: 'colab', units: 0.6 });
        ledger.close();
        parentPort.postMessage({ ok: result.ok, reason: result.reason });
      })().catch(error => { throw error; });`;
    const ready = [], results = [];
    for (let i = 0; i < 4; i++) {
      const worker = new Worker(source, { eval: true, workerData: { module: new URL('../src/durable-invite-ledger.mjs', import.meta.url).href, path, barrier, inviteId: invite.id, actionId: `act_${i}` } });
      workers.push(worker);
      ready.push(new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
      results.push(new Promise((resolve, reject) => {
        worker.on('message', message => { if (!message.ready) resolve(message); });
        worker.once('error', reject);
      }));
    }
    await Promise.all(ready);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    const outcomes = await Promise.all(results);
    assert.equal(outcomes.filter(result => result.ok).length, 1);
    assert.equal(outcomes.filter(result => !result.ok && result.reason === (limit === 'budget' ? 'insufficient' : 'film_limit')).length, 3);
    assert.equal(ledger.get(invite.id).committedEstimateCu, 0.6);
    assert.equal(ledger.get(invite.id).remainingCu, limit === 'budget' ? 0.4 : 9.4);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('production ownership survives restart and cannot be claimed by another invite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-ownership-'));
  try {
    const path = join(dir, 'ledger.sqlite');
    let ledger = createDurableInviteLedger({ path });
    const first = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    const second = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    assert.equal(ledger.bindResource(first.id, 'production', 'prod_123').created, true);
    assert.equal(ledger.bindResource(first.id, 'production', 'prod_123').created, false);
    assert.throws(() => ledger.bindResource(second.id, 'production', 'prod_123'), /another invite/);
    ledger.close();
    ledger = createDurableInviteLedger({ path });
    assert.equal(ledger.resourceOwner('production', 'prod_123'), first.id);
    assert.deepEqual(ledger.resourcesForInvite(first.id).map(row => ({ ...row })), [{ kind: 'production', resourceId: 'prod_123' }]);
    ledger.revoke(first.id);
    assert.throws(() => ledger.bindResource(first.id, 'package', 'pkg_1'), /not active/);
    assert.throws(() => ledger.bindResource(second.id, 'production', '../escape'), /invalid/);
    ledger.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('showcase copies bind both ownership records for exhausted viewers but not revoked viewers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-showcase-owner-'));
  const ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
  try {
    const first = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    const other = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    ledger.commit(first.id, 1);
    ledger.bindShowcaseCopy(first.id, 'pkg_copy');
    assert.equal(ledger.resourceOwner('package', 'pkg_copy'), first.id);
    assert.equal(ledger.resourceOwner('showcase_copy', 'pkg_copy'), first.id);
    assert.throws(() => ledger.bindShowcaseCopy(other.id, 'pkg_copy'), /another invite/);
    ledger.revoke(first.id);
    assert.throws(() => ledger.bindShowcaseCopy(first.id, 'pkg_other'), /unavailable/);
    assert.equal(ledger.resourceOwner('package', 'pkg_other'), null);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('production actions atomically reserve CU, enforce ownership and settle only once across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-actions-'));
  try {
    const path = join(dir, 'ledger.sqlite');
    let a = createDurableInviteLedger({ path });
    const b = createDurableInviteLedger({ path });
    const invite = a.mint({ cu: 1, ttlDays: 1 }).invite;
    const other = a.mint({ cu: 1, ttlDays: 1 }).invite;
    a.bindResource(invite.id, 'production', 'prod_a');
    const action = { inviteId: invite.id, productionId: 'prod_a', actionId: 'act_1', backendId: 'colab', units: 0.7 };
    assert.equal(a.reserveAction(action).ok, true);
    assert.equal(b.reserveAction(action).duplicate, true);
    assert.equal(b.reserveAction({ ...action, actionId: 'act_2', units: 0.4 }).ok, false);
    assert.throws(() => b.reserveAction({ ...action, inviteId: other.id }), /not owned/);
    assert.throws(() => b.reserveAction({ ...action, backendId: 'other' }), /Google Colab/);
    assert.throws(() => b.reserveAction({ ...action, units: 0.6 }), /conflict/);
    a.close();
    a = createDurableInviteLedger({ path });
    assert.equal(a.get(invite.id).committedEstimateCu, 0.7);
    assert.throws(() => a.settleAction({ productionId: 'prod_a', actionId: 'act_1', spent: 0.8 }), /reconciliation/);
    assert.equal(a.get(invite.id).committedEstimateCu, 0.7);
    assert.equal(a.settleAction({ productionId: 'prod_a', actionId: 'act_1', spent: 0.5, filmCompleted: true }).ok, true);
    assert.equal(b.settleAction({ productionId: 'prod_a', actionId: 'act_1', spent: 0.5 }).duplicate, true);
    assert.equal(b.get(invite.id).spentEstimateCu, 0.5);
    assert.equal(b.get(invite.id).remainingCu, 0.5);
    assert.throws(() => b.reserveAction(action), /already settled/);
    a.close(); b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an expired or revoked invite cannot replay an already reserved action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-expiry-'));
  try {
    let time = 1_700_000_000_000;
    const ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite'), now: () => time });
    const invite = ledger.mint({ cu: 1, ttlMs: 1000 }).invite;
    ledger.bindResource(invite.id, 'production', 'prod_1');
    const action = { inviteId: invite.id, productionId: 'prod_1', actionId: 'act_1', backendId: 'colab', units: 1 };
    assert.equal(ledger.reserveAction(action).ok, true);
    assert.equal(ledger.reserveAction(action).duplicate, true);
    time += 1000;
    assert.equal(ledger.reserveAction(action).reason, 'expired');
    assert.equal(ledger.get(invite.id).committedEstimateCu, 1);
    ledger.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sub-millicredit action estimates are reserved upward, never rounded down', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-precision-'));
  const ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
  try {
    const invite = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    ledger.bindResource(invite.id, 'production', 'prod_1');
    const reservation = ledger.reserveAction({ inviteId: invite.id, productionId: 'prod_1', actionId: 'act_1', backendId: 'colab', units: 0.10001 });
    assert.equal(reservation.units, 0.101);
    assert.equal(ledger.get(invite.id).committedEstimateCu, 0.101);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('invalid mint precision cannot increase the budget or corrupt the durable ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-mint-precision-'));
  let ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
  try {
    for (const cu of [0.0001, 0.0009, 0.1004, 1e30]) {
      assert.throws(() => ledger.mint({ cu, ttlDays: 1 }), /at least 0.001/);
    }
    const invite = ledger.mint({ cu: 0.001, ttlDays: 1 }).invite;
    ledger.close();
    ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
    assert.equal(ledger.get(invite.id).spendCeilingCu, 0.001);
    assert.equal(ledger.list().length, 1);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
