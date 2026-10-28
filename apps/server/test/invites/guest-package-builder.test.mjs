import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';
import { PackageStore } from '../../src/store.mjs';
import { createGuestPackageBuilder } from '../../src/invites/guest-package-builder.mjs';

test('offline guest builds of the same prompt get separately owned packages and files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guest-package-'));
  const ledger = createDurableInviteLedger({ path: join(dir, 'invites.sqlite') });
  try {
    const store = new PackageStore(join(dir, 'packages'));
    const build = createGuestPackageBuilder({ runtimeDir: dir, ledger, store });
    const a = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    const b = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
    const brief = 'A brief story about a cheerful planet';
    const first = await build({ inviteId: a.id, brief });
    const second = await build({ inviteId: b.id, brief });
    assert.notEqual(first.package.id, second.package.id);
    assert.equal(ledger.resourceOwner('package', first.package.id), a.id);
    assert.equal(ledger.resourceOwner('package', second.package.id), b.id);
    const firstFiles = Object.values(first.package.assets).map(asset => asset.file).filter(Boolean);
    const secondFiles = Object.values(second.package.assets).map(asset => asset.file).filter(Boolean);
    assert.ok(firstFiles.length > 0);
    assert.equal(firstFiles.some(file => secondFiles.includes(file)), false);
    for (const file of [...firstFiles, ...secondFiles]) assert.ok(existsSync(join(store.dir, file)));
    ledger.revoke(a.id);
    await assert.rejects(build({ inviteId: a.id, brief }), /not active/);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
