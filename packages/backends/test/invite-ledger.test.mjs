import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SPEND_CEILING_CU,
  DEFAULT_PUBLIC_BASE_URL,
  INVITE_PATH_PREFIX,
  INVITE_POOL_GOOGLE_COLAB,
  budgetUnitsFromInvite,
  createInviteLedger,
  hashInviteToken,
  invitePathForToken,
  invitePublicUrl,
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

test("public URL uses /secretfriendsdemo/<token>", () => {
  const token = mintInviteToken();
  assert.equal(invitePathForToken(token), `${INVITE_PATH_PREFIX}/${token}`);
  assert.equal(
    invitePublicUrl(token),
    `${DEFAULT_PUBLIC_BASE_URL}${INVITE_PATH_PREFIX}/${token}`,
  );
  assert.match(invitePublicUrl(token), /^https:\/\/comfy\.rizz\.click\/secretfriendsdemo\//);
});

test("mint accepts cu + ttlSeconds + label and returns full public URL", () => {
  const ledger = createInviteLedger({ now: () => 1_700_000_000_000 });
  const minted = ledger.mint({
    cu: 3.5,
    ttlSeconds: 3600,
    label: "judge-a",
    maxFilms: 2,
    requireCu: true,
    requireTtl: true,
  });
  assert.equal(minted.invite.pool, INVITE_POOL_GOOGLE_COLAB);
  assert.equal(minted.invite.spendCeilingCu, 3.5);
  assert.equal(minted.invite.remainingCu, 3.5);
  assert.equal(minted.invite.label, "judge-a");
  assert.equal(minted.invite.expiresAt, 1_700_000_000_000 + 3600_000);
  assert.equal(minted.path, `${INVITE_PATH_PREFIX}/${minted.token}`);
  assert.equal(minted.url, `${DEFAULT_PUBLIC_BASE_URL}${minted.path}`);
  assert.ok(!JSON.stringify(ledger.list()).includes(minted.token), "raw token must not appear in list()");
});

test("mint accepts ttlDays and refuses requireCu without cu", () => {
  const ledger = createInviteLedger({ now: () => 1_700_000_000_000 });
  const minted = ledger.mint({ cu: 1, ttlDays: 2, requireCu: true, requireTtl: true });
  assert.equal(minted.invite.expiresAt, 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000);
  assert.throws(() => ledger.mint({ ttlSeconds: 60, requireCu: true }), /cu/);
  assert.throws(() => ledger.mint({ cu: 1, requireTtl: true }), /ttl/);
});

test("redeem accepts active tokens and rejects unknown / revoked / expired", () => {
  let t = 1_700_000_000_000;
  const ledger = createInviteLedger({ now: () => t });
  const { token, invite } = ledger.mint({ cu: 2, ttlMs: 60_000 });
  assert.equal(ledger.redeem(token).ok, true);
  assert.equal(ledger.redeem("not-a-real-token-value!!").ok, false);

  ledger.revoke(invite.id);
  assert.equal(ledger.redeem(token).reason, "revoked");

  const again = ledger.mint({ cu: 1, ttlMs: 1_000 });
  t += 5_000;
  assert.equal(ledger.redeem(again.token).reason, "expired");
});

test("debit refuses when the invite ceiling would be exceeded (overspend)", () => {
  const ledger = createInviteLedger();
  const { invite } = ledger.mint({ cu: 1, ttlDays: 1 });
  const ok = ledger.debit(invite.id, 0.6);
  assert.equal(ok.ok, true);
  assert.equal(ok.invite.spentEstimateCu, 0.6);
  const refused = ledger.debit(invite.id, 0.5);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "insufficient");
});

test("commit + settle releases unused reserve and can mark a film", () => {
  const ledger = createInviteLedger();
  const { invite } = ledger.mint({ spendCeilingCu: 3, maxFilms: 1, ttlDays: 1 });
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

test("ownerSummary and showcase track generations per invite", () => {
  const ledger = createInviteLedger({ now: () => 1_700_000_000_000 });
  const a = ledger.mint({ cu: 2, ttlDays: 1, label: "a" });
  const b = ledger.mint({ cu: 4, ttlDays: 1, label: "b" });
  ledger.debit(a.invite.id, 0.5, { filmCompleted: true });
  ledger.recordGeneration(a.invite.id, {
    packageId: "pkg_a",
    prompt: "a teal robot waves",
    title: "Robot wave",
    spentEstimateCu: 0.5,
  });
  ledger.recordGeneration(b.invite.id, {
    packageId: "pkg_b",
    prompt: "rain on neon streets",
    title: "Neon rain",
  });
  const summary = ledger.ownerSummary();
  assert.equal(summary.totals.inviteCount, 2);
  assert.equal(summary.totals.generationCount, 2);
  assert.equal(summary.totals.spentEstimateCu, 0.5);
  assert.equal(summary.totals.ceilingCu, 6);
  const gallery = ledger.showcase({ excludeInviteId: a.invite.id });
  assert.equal(gallery.length, 1);
  assert.equal(gallery[0].packageId, "pkg_b");
  assert.equal(gallery[0].prompt, "rain on neon streets");
  assert.equal(gallery[0].openPath, "/#package=pkg_b");
});

test("budgetUnitsFromInvite maps remaining CU for /api/run", () => {
  assert.equal(budgetUnitsFromInvite(null), 0);
  assert.equal(budgetUnitsFromInvite({ status: "active", remainingCu: 2 }), 2);
  assert.equal(budgetUnitsFromInvite({ status: "revoked", remainingCu: 2 }), 0);
  assert.equal(DEFAULT_SPEND_CEILING_CU, 2);
  assert.equal(INVITE_PATH_PREFIX, "/secretfriendsdemo");
});
