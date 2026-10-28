import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SPEND_CEILING_CU,
  INVITE_POOL_GOOGLE_COLAB,
  budgetUnitsFromInvite,
  createInviteLedger,
  hashInviteToken,
  mintInviteToken,
} from "../src/invite-ledger.mjs";

test("mintInviteToken is high-entropy base64url", () => {
  const a = mintInviteToken();
  const b = mintInviteToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 22);
});

test("hashInviteToken is stable sha256 hex", () => {
  const token = "a".repeat(24);
  assert.equal(hashInviteToken(token), hashInviteToken(token));
  assert.match(hashInviteToken(token), /^[a-f0-9]{64}$/);
});

test("mint returns raw token once and stores only the hash path shape", () => {
  const ledger = createInviteLedger({ now: () => 1_700_000_000_000 });
  const minted = ledger.mint({ label: "judge-a", spendCeilingCu: 2.5, maxFilms: 2 });
  assert.equal(minted.invite.pool, INVITE_POOL_GOOGLE_COLAB);
  assert.equal(minted.invite.spendCeilingCu, 2.5);
  assert.equal(minted.invite.remainingCu, 2.5);
  assert.equal(minted.invite.label, "judge-a");
  assert.equal(minted.invite.status, "active");
  assert.equal(minted.path, `/i/${minted.token}`);
  assert.equal(ledger.list().length, 1);
  assert.ok(!JSON.stringify(ledger.list()).includes(minted.token), "raw token must not appear in list()");
});

test("redeem accepts active tokens and rejects unknown / revoked / expired", () => {
  let t = 1_700_000_000_000;
  const ledger = createInviteLedger({ now: () => t });
  const { token, invite } = ledger.mint({ ttlMs: 60_000 });
  assert.equal(ledger.redeem(token).ok, true);
  assert.equal(ledger.redeem("not-a-real-token-value!!").ok, false);

  ledger.revoke(invite.id);
  assert.equal(ledger.redeem(token).reason, "revoked");

  const again = ledger.mint({ ttlMs: 1_000 });
  t += 5_000;
  assert.equal(ledger.redeem(again.token).reason, "expired");
});

test("debit refuses when the invite ceiling would be exceeded", () => {
  const ledger = createInviteLedger();
  const { invite } = ledger.mint({ spendCeilingCu: 1 });
  const ok = ledger.debit(invite.id, 0.6);
  assert.equal(ok.ok, true);
  assert.equal(ok.invite.spentEstimateCu, 0.6);
  const refused = ledger.debit(invite.id, 0.5);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "insufficient");
});

test("commit + settle releases unused reserve and can mark a film", () => {
  const ledger = createInviteLedger();
  const { invite } = ledger.mint({ spendCeilingCu: 3, maxFilms: 1 });
  assert.equal(ledger.commit(invite.id, 1.2).ok, true);
  const settled = ledger.settle(invite.id, { spent: 0.8, release: 0.4, filmCompleted: true });
  assert.equal(settled.ok, true);
  assert.equal(settled.invite.spentEstimateCu, 0.8);
  assert.equal(settled.invite.committedEstimateCu, 0);
  assert.equal(settled.invite.filmsCompleted, 1);
  assert.equal(settled.invite.status, "exhausted");
  const dead = ledger.get(invite.id);
  assert.equal(dead.status, "exhausted");
  assert.equal(ledger.debit(invite.id, 0.1).reason, "exhausted");
});

test("budgetUnitsFromInvite maps remaining CU for /api/run", () => {
  assert.equal(budgetUnitsFromInvite(null), 0);
  assert.equal(budgetUnitsFromInvite({ status: "active", remainingCu: 2 }), 2);
  assert.equal(budgetUnitsFromInvite({ status: "revoked", remainingCu: 2 }), 0);
  assert.equal(DEFAULT_SPEND_CEILING_CU, 2);
});
