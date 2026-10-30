import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuestSessionStore } from '../../src/invites/guest-sessions.mjs';

test('guest session issue / match / expire / revokeInvite', () => {
  let now = 1000;
  const store = createGuestSessionStore({ now: () => now, ttlMs: 5000 });
  const issued = store.issue({ inviteId: 'inv_1', label: 'x' });
  assert.equal(store.match(issued.guestToken).inviteId, 'inv_1');
  now = 7000;
  assert.equal(store.match(issued.guestToken), null);
  const again = store.issue({ inviteId: 'inv_2' });
  assert.equal(store.revokeInvite('inv_2'), 1);
  assert.equal(store.match(again.guestToken), null);
});
