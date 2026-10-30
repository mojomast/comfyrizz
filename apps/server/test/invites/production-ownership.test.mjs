import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';
import { createInviteProductionOwnership } from '../../src/invites/production-ownership.mjs';
import { deterministicProductionId } from '../../src/productions/commands.mjs';

test('guest production creation and access are scoped to resources owned by that invite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-owner-'));
  const ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
  try {
    const first = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    const second = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    const guest = { inviteId: first.id };
    const owner = createInviteProductionOwnership({ ledger, store: { read: id => id === deterministicProductionId('existing') ? { id } : null } });
    ledger.bindResource(first.id, 'package', 'pkg_a');
    ledger.bindResource(second.id, 'conversation', 'conv_other');
    assert.throws(() => owner.prepareCreate(guest, { commandId: 'nested', payload: { production: { packageId: 'pkg_other' } } }), { code: 'INVITE_RESOURCE_FORBIDDEN' });
    assert.throws(() => owner.prepareCreate(guest, { commandId: 'ledger', payload: { budgetLedgerId: 'ledger_other' } }), { code: 'INVITE_RESOURCE_FORBIDDEN' });
    assert.throws(() => owner.prepareCreate(guest, { commandId: 'c1', payload: { packageId: 'pkg_a', conversationId: 'conv_other' } }), { code: 'INVITE_RESOURCE_FORBIDDEN' });
    assert.throws(() => owner.prepareCreate(guest, { commandId: 'existing', payload: {} }), { code: 'INVITE_RESOURCE_FORBIDDEN' });
    owner.prepareCreate(guest, { commandId: 'c1', payload: { packageId: 'pkg_a' } });
    const productionId = deterministicProductionId('c1');
    owner.assertAccess(guest, productionId);
    assert.throws(() => owner.assertAccess({ inviteId: second.id }, productionId), { code: 'INVITE_RESOURCE_FORBIDDEN' });
    ledger.revoke(first.id);
    assert.throws(() => owner.assertAccess(guest, productionId), { code: 'INVITE_RESOURCE_FORBIDDEN' });
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
