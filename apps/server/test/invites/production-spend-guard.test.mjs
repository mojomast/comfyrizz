import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';
import { createInviteProductionSpendGuard } from '../../src/invites/production-spend-guard.mjs';
import { guestPlannerFixture } from './planner-fixture.mjs';

test('exhausted invites admit zero-CU local work but reject remote execution and foreign packages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-cpu-guard-'));
  const ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
  try {
    const invite = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    ledger.debit(invite.id, 1);
    const { package: pkg } = await guestPlannerFixture({ runtimeDir: dir })({ brief: 'A CPU edit with existing media' });
    for (const asset of Object.values(pkg.assets)) if (asset.status === 'pending') {
      asset.status = 'ready'; asset.file = 'assets/ready.png'; asset.bytes = 1; asset.sha256 = 'a'.repeat(64);
    }
    ledger.bindResource(invite.id, 'production', 'prod_cpu');
    ledger.bindResource(invite.id, 'package', pkg.id);
    let calls = 0;
    const guard = createInviteProductionSpendGuard({ ledger, spendEnabled: () => false, adapter: { admit: async () => { calls++; return { started: true }; } } });
    const args = { productionId: 'prod_cpu', actionId: 'act_invite_cpu', pkg, input: { backendId: 'cpu', budgetUnits: 0 } };
    assert.equal((await guard.admit(args)).started, true);
    for (const patch of [{ narrationRuntime: 'colab' }, { renderLocation: 'colab' }, { comfyuiUrl: 'http://127.0.0.1:8188' }, { budgetUnits: 1 }]) {
      await assert.rejects(guard.admit({ ...args, input: { ...args.input, ...patch } }), { code: 'INVITE_CPU_ONLY' });
    }
    await assert.rejects(guard.admit({ ...args, pkg: { ...pkg, id: 'pkg_foreign' } }), { code: 'INVITE_OWNERSHIP_REQUIRED' });
    await assert.rejects(guard.admit({ ...args, input: { backendId: 'colab', budgetUnits: 1 } }), { code: 'INVITE_SPEND_DISABLED' });
    assert.equal(calls, 1);
    assert.equal(ledger.actionReservation('prod_cpu', 'act_invite_cpu'), null);
    ledger.revoke(invite.id);
    await assert.rejects(guard.admit(args), { code: 'INVITE_OWNERSHIP_REQUIRED' });
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('outbox dispatch requires an enabled, owned Google Colab reservation before allocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-dispatch-'));
  const ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
  try {
    const invite = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    let enabled = false;
    let calls = 0;
    const adapter = { async admit(args) { calls++; assert.equal(ledger.actionReservation(args.productionId, args.actionId).units, 0.7); return { started: true }; }, cancel() {}, observe() {} };
    const guard = createInviteProductionSpendGuard({ adapter, ledger, spendEnabled: () => enabled });
    const args = { productionId: 'prod_1', actionId: 'act_1', input: { backendId: 'colab', budgetUnits: 0.7 } };
    await assert.rejects(guard.admit(args), { code: 'INVITE_SPEND_DISABLED' });
    enabled = true;
    await assert.rejects(guard.admit(args), { code: 'INVITE_OWNERSHIP_REQUIRED' });
    ledger.bindResource(invite.id, 'production', 'prod_1');
    await assert.rejects(guard.admit({ ...args, input: { backendId: 'other', budgetUnits: 0.7 } }), { code: 'INVITE_COLAB_ONLY' });
    assert.equal(calls, 0);
    assert.equal((await guard.admit(args)).started, true);
    assert.equal(calls, 1);
    assert.equal(ledger.get(invite.id).committedEstimateCu, 0.7);
    await assert.rejects(guard.admit({ ...args, actionId: 'act_2', input: { backendId: 'colab', budgetUnits: 0.4 } }), { code: 'INVITE_BUDGET_REFUSED' });
    assert.equal(calls, 1);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an uncertain dispatch failure retains its durable reservation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-dispatch-failure-'));
  let ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
  try {
    const invite = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    ledger.bindResource(invite.id, 'production', 'prod_1');
    const guard = createInviteProductionSpendGuard({ ledger, spendEnabled: () => true, adapter: { async admit() { throw new Error('unknown dispatch outcome'); } } });
    await assert.rejects(guard.admit({ productionId: 'prod_1', actionId: 'act_1', input: { backendId: 'colab', budgetUnits: 1 } }), /unknown dispatch outcome/);
    ledger.close();
    ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
    assert.equal(ledger.get(invite.id).committedEstimateCu, 1);
    assert.equal(ledger.actionReservation('prod_1', 'act_1').state, 'reserved');
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
