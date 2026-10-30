import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInviteLedger } from '../../../../packages/backends/src/invite-ledger.mjs';
import { createDemoInvites } from '../../src/invites/demo-invites.mjs';
import { createGuestSessionStore } from '../../src/invites/guest-sessions.mjs';

function mockResponse() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    ended: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(buf) {
      this.ended = true;
      this.body = buf == null ? null : Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    },
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function makeInvites({ now, ledger } = {}) {
  const clock = now ?? (() => Date.now());
  const inviteLedger = ledger ?? createInviteLedger({ now: clock, publicBaseUrl: 'https://comfy.rizz.click' });
  const guests = createGuestSessionStore({ now: clock });
  const demo = createDemoInvites({
    ledger: inviteLedger,
    guests,
    publicBaseUrl: 'https://comfy.rizz.click',
    now: clock,
    sendJson,
    readJson: async (request) => request._body ?? {},
  });
  return { demo, ledger: inviteLedger, guests, clock };
}

test('mint requires cu + ttl and returns secretfriendsdemo public URL', async () => {
  const { demo } = makeInvites();
  const resBad = mockResponse();
  await demo.handle(
    { method: 'POST', headers: {}, _body: { label: 'x' } },
    resBad,
    new URL('http://127.0.0.1/api/invites/mint'),
    { ownerOk: true },
  );
  assert.equal(resBad.statusCode, 400);

  const res = mockResponse();
  await demo.handle(
    { method: 'POST', headers: {}, _body: { cu: 2.5, ttlSeconds: 86400, label: 'friend-demo' } },
    res,
    new URL('http://127.0.0.1/api/invites/mint'),
    { ownerOk: true },
  );
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.match(data.url, /^https:\/\/comfy\.rizz\.click\/secretfriendsdemo\//);
  assert.equal(data.path, `/secretfriendsdemo/${data.token}`);
  assert.equal(data.invite.spendCeilingCu, 2.5);
  assert.equal(data.urlShape, 'https://comfy.rizz.click/secretfriendsdemo/<token>');
});

test('guest sessions stop authenticating when the invite expires or is revoked', () => {
  let time = 1_700_000_000_000;
  const { demo, ledger, guests } = makeInvites({ now: () => time });
  const first = ledger.mint({ cu: 1, ttlMs: 1000 }).invite;
  const session = guests.issue({ inviteId: first.id });
  assert.ok(demo.resolveGuest(session.guestToken));
  time += 1000;
  assert.equal(demo.resolveGuest(session.guestToken), null);
  const second = ledger.mint({ cu: 1, ttlMs: 1000 }).invite;
  const revokedSession = guests.issue({ inviteId: second.id });
  ledger.revoke(second.id);
  assert.equal(demo.resolveGuest(revokedSession.guestToken), null);
});

test('failed runs keep the reservation until settlement and charge paid usage', () => {
  const { demo, ledger } = makeInvites();
  const { invite } = ledger.mint({ cu: 2, ttlDays: 1 });
  const admitted = demo.admitGuestRun({ inviteId: invite.id }, { budgetUnits: 1, approved: false });
  assert.equal(admitted.committed, 1);
  demo.bindGuestRun('run_failure', { inviteId: invite.id, committed: 1 });
  demo.onRunEvent({ type: 'run.failed', runId: 'run_failure', message: 'failed after allocation' });
  assert.equal(ledger.get(invite.id).committedEstimateCu, 1);
  demo.onRunEvent({ type: 'run.settled', runId: 'run_failure', units: 0.6 });
  assert.equal(ledger.get(invite.id).spentEstimateCu, 0.6);
  assert.equal(ledger.get(invite.id).committedEstimateCu, 0);
  assert.equal(ledger.listGenerations(invite.id)[0].status, 'failed');
});

test('successful terminal event waits for settlement before recording generation', () => {
  const { demo, ledger } = makeInvites();
  const { invite } = ledger.mint({ cu: 2, ttlDays: 1 });
  const admitted = demo.admitGuestRun({ inviteId: invite.id }, { budgetUnits: 1, approved: true });
  demo.bindGuestRun('run_success', { inviteId: invite.id, committed: admitted.committed, packageId: 'pkg' });
  demo.onRunEvent({ type: 'run.finished', runId: 'run_success', status: 'completed' });
  assert.equal(ledger.get(invite.id).committedEstimateCu, 1);
  demo.onRunEvent({ type: 'run.settled', runId: 'run_success', units: 0.6 });
  assert.equal(ledger.get(invite.id).spentEstimateCu, 0.6);
  assert.equal(ledger.get(invite.id).filmsCompleted, 1);
  assert.equal(ledger.listGenerations(invite.id)[0].spentEstimateCu, 0.6);
});

test('redeem / expire / overspend + owner summary + showcase open', async () => {
  let t = 1_700_000_000_000;
  const { demo, ledger } = makeInvites({ now: () => t });
  const minted = ledger.mint({ cu: 1, ttlMs: 10_000, label: 'guest', requireCu: true, requireTtl: true });

  const redeemRes = mockResponse();
  await demo.handle(
    { method: 'GET', headers: { accept: 'application/json' } },
    redeemRes,
    new URL(`http://127.0.0.1/secretfriendsdemo/${minted.token}`),
    {},
  );
  assert.equal(redeemRes.statusCode, 200);
  const guestBody = JSON.parse(redeemRes.body);
  assert.equal(guestBody.ok, true);
  assert.ok(guestBody.guestToken.length >= 32);
  assert.equal(guestBody.budgetUnits, 1);
  assert.equal(guestBody.mode, 'gallery');
  assert.match(guestBody.openPath, /\/gallery\/#token=/);
  assert.equal(guestBody.backendId, 'colab');

  const guest = demo.resolveGuest(guestBody.guestToken);
  assert.equal(guest.inviteId, minted.invite.id);

  const sessionRes = mockResponse();
  await demo.handle(
    { method: 'GET', headers: {} },
    sessionRes,
    new URL('http://127.0.0.1/api/invites/session'),
    { guest },
  );
  assert.equal(sessionRes.statusCode, 200);
  assert.equal(JSON.parse(sessionRes.body).role, 'guest');

  // Guest cannot mint
  const guestMint = mockResponse();
  await demo.handle(
    { method: 'POST', headers: {}, _body: { cu: 1, ttlSeconds: 60 } },
    guestMint,
    new URL('http://127.0.0.1/api/invites/mint'),
    { ownerOk: false, guest },
  );
  assert.equal(guestMint.statusCode, 401);

  // Spend most of the ceiling; further admit is capped to remaining (no overspend).
  const admit1 = demo.admitGuestRun({ inviteId: minted.invite.id }, { approved: true, budgetUnits: 0.7 });
  assert.equal(admit1.ok, true);
  demo.bindGuestRun('run_test_1', {
    inviteId: minted.invite.id,
    committed: 0.7,
    packageId: 'pkg_demo',
    prompt: 'a friendly fox',
    title: 'Fox',
  });
  demo.onRunEvent({ type: 'run.settled', runId: 'run_test_1', units: 0.7 });
  demo.onRunEvent({ type: 'run.finished', runId: 'run_test_1', status: 'completed' });

  const capped = demo.admitGuestRun({ inviteId: minted.invite.id }, { approved: true, budgetUnits: 5 });
  assert.equal(capped.ok, true);
  assert.equal(capped.budgetUnits, 0.3);
  // Settle the capped reserve as spent to exhaust the invite.
  demo.releaseGuestCommit(capped.inviteId, 0); // no-op sanity
  ledger.settle(capped.inviteId, { spent: 0.3, release: 0, filmCompleted: true });

  const admit2 = demo.admitGuestRun({ inviteId: minted.invite.id }, { approved: true, budgetUnits: 0.1 });
  assert.equal(admit2.ok, false);
  assert.ok(['INVITE_EXHAUSTED', 'INVITE_COMMIT_REFUSED', 'INVITE_INACTIVE'].includes(admit2.code));

  // Expire
  t += 60_000;
  const expired = mockResponse();
  await demo.handle(
    { method: 'GET', headers: { accept: 'application/json' } },
    expired,
    new URL(`http://127.0.0.1/secretfriendsdemo/${minted.token}`),
    {},
  );
  assert.equal(expired.statusCode, 403);
  assert.equal(JSON.parse(expired.body).reason, 'expired');

  const summaryRes = mockResponse();
  await demo.handle(
    { method: 'GET', headers: {} },
    summaryRes,
    new URL('http://127.0.0.1/api/invites'),
    { ownerOk: true },
  );
  const summary = JSON.parse(summaryRes.body);
  assert.equal(summary.totals.inviteCount, 1);
  assert.ok(summary.totals.spentEstimateCu >= 0.7);
  assert.equal(summary.generations.length, 1);
  assert.equal(summary.generations[0].prompt, 'a friendly fox');

  const openRes = mockResponse();
  await demo.handle(
    { method: 'POST', headers: {} },
    openRes,
    new URL('http://127.0.0.1/api/demo/showcase/pkg_demo/open'),
    { ownerOk: true },
  );
  assert.equal(openRes.statusCode, 200);
  const opened = JSON.parse(openRes.body);
  assert.equal(opened.packageId, 'pkg_demo');
  assert.equal(opened.openPath, '/#package=pkg_demo');

  const showcaseRes = mockResponse();
  await demo.handle(
    { method: 'GET', headers: {} },
    showcaseRes,
    new URL('http://127.0.0.1/api/demo/showcase'),
    { ownerOk: true },
  );
  assert.equal(showcaseRes.statusCode, 200);
  assert.equal(JSON.parse(showcaseRes.body).items[0].packageId, 'pkg_demo');
});

test('POST /api/invites/redeem returns guest token without owner auth', async () => {
  const { demo, ledger } = makeInvites();
  const minted = ledger.mint({ cu: 1.25, ttlDays: 1, label: 'json', requireCu: true, requireTtl: true });
  const res = mockResponse();
  await demo.handle(
    { method: 'POST', headers: {}, _body: { token: minted.token } },
    res,
    new URL('http://127.0.0.1/api/invites/redeem'),
    {},
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.budgetUnits, 1.25);
  assert.match(body.openPath, /#token=/);
});
