// Hosted Google Colab invite ledger (Phase A scaffold).
// Pure in-memory store: mint / redeem / debit / revoke / expire.
// No network, no Google Colab CLI, no secrets. Per-link ceilings are product
// estimates (SPEC.md 6.6): Google Colab usage is account-wide, so Comfyrizz
// enforces invite caps on its own spent_estimate ledger.
//
// Pool is fixed to google-colab on this track (Comfy Cloud invite pool deferred).

import { createHash, randomBytes } from "node:crypto";

export const INVITE_POOL_GOOGLE_COLAB = "google-colab";

/** Suggested default CU ceiling until Kyle sets a measured default (see HOSTED_COLAB_INVITE_DEMO.md). */
export const DEFAULT_SPEND_CEILING_CU = 2;

/** Default TTL when mint omits expiresAt (7 days). */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashInviteToken(token) {
  if (typeof token !== "string" || token.length < 16) {
    throw new TypeError("invite token must be a string of at least 16 characters");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function mintInviteToken(bytes = 24) {
  const n = Number(bytes);
  if (!Number.isInteger(n) || n < 16) throw new TypeError("mintInviteToken bytes must be an integer >= 16");
  return randomBytes(n).toString("base64url");
}

function roundCu(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1000) / 1000;
}

/**
 * @typedef {object} InviteRecord
 * @property {string} id
 * @property {string} tokenHash
 * @property {"google-colab"} pool
 * @property {number} spendCeilingCu
 * @property {number} spentEstimateCu
 * @property {number} committedEstimateCu
 * @property {number} maxFilms
 * @property {number} filmsCompleted
 * @property {number} expiresAt
 * @property {string} label
 * @property {"active"|"revoked"|"exhausted"|"expired"} status
 * @property {number} createdAt
 * @property {number|null} revokedAt
 */

/**
 * In-memory invite ledger. Swap for a durable store in Phase B.
 */
export function createInviteLedger({ now = () => Date.now() } = {}) {
  /** @type {Map<string, InviteRecord>} */
  const byHash = new Map();
  /** @type {Map<string, InviteRecord>} */
  const byId = new Map();
  let seq = 0;

  function refreshStatus(row, at = now()) {
    if (row.status === "revoked") return row;
    if (at >= row.expiresAt) {
      row.status = "expired";
      return row;
    }
    const remaining = remainingCu(row);
    if (remaining <= 0 || (row.maxFilms > 0 && row.filmsCompleted >= row.maxFilms)) {
      row.status = "exhausted";
      return row;
    }
    row.status = "active";
    return row;
  }

  function remainingCu(row) {
    return roundCu(row.spendCeilingCu - row.spentEstimateCu - row.committedEstimateCu);
  }

  function publicView(row) {
    const live = refreshStatus({ ...row });
    return {
      id: live.id,
      pool: live.pool,
      spendCeilingCu: live.spendCeilingCu,
      spentEstimateCu: live.spentEstimateCu,
      committedEstimateCu: live.committedEstimateCu,
      remainingCu: remainingCu(live),
      maxFilms: live.maxFilms,
      filmsCompleted: live.filmsCompleted,
      expiresAt: live.expiresAt,
      label: live.label,
      status: live.status,
      createdAt: live.createdAt,
      revokedAt: live.revokedAt,
    };
  }

  /**
   * Mint a new invite. Returns the raw token once; only the hash is stored.
   * @param {object} [opts]
   * @param {number} [opts.spendCeilingCu]
   * @param {number} [opts.maxFilms]
   * @param {number} [opts.expiresAt] unix ms
   * @param {number} [opts.ttlMs]
   * @param {string} [opts.label]
   */
  function mint(opts = {}) {
    const spendCeilingCu = Number(opts.spendCeilingCu ?? DEFAULT_SPEND_CEILING_CU);
    if (!Number.isFinite(spendCeilingCu) || spendCeilingCu <= 0) {
      throw new TypeError("spendCeilingCu must be a positive number");
    }
    const maxFilms = opts.maxFilms == null ? 3 : Number(opts.maxFilms);
    if (!Number.isFinite(maxFilms) || maxFilms < 0) {
      throw new TypeError("maxFilms must be a non-negative number");
    }
    const createdAt = now();
    const expiresAt =
      opts.expiresAt != null
        ? Number(opts.expiresAt)
        : createdAt + (Number.isFinite(Number(opts.ttlMs)) ? Number(opts.ttlMs) : DEFAULT_TTL_MS);
    if (!Number.isFinite(expiresAt) || expiresAt <= createdAt) {
      throw new TypeError("expiresAt must be after createdAt");
    }
    const token = mintInviteToken();
    const tokenHash = hashInviteToken(token);
    seq += 1;
    /** @type {InviteRecord} */
    const row = {
      id: `inv_${createdAt.toString(36)}_${seq}`,
      tokenHash,
      pool: INVITE_POOL_GOOGLE_COLAB,
      spendCeilingCu: roundCu(spendCeilingCu),
      spentEstimateCu: 0,
      committedEstimateCu: 0,
      maxFilms,
      filmsCompleted: 0,
      expiresAt,
      label: typeof opts.label === "string" ? opts.label : "",
      status: "active",
      createdAt,
      revokedAt: null,
    };
    byHash.set(tokenHash, row);
    byId.set(row.id, row);
    return {
      token,
      path: `/i/${token}`,
      invite: publicView(row),
    };
  }

  /**
   * Redeem a raw token. Does not consume budget; only validates and returns the invite view.
   * @param {string} token
   */
  function redeem(token) {
    let tokenHash;
    try {
      tokenHash = hashInviteToken(token);
    } catch {
      return { ok: false, reason: "malformed", invite: null };
    }
    const row = byHash.get(tokenHash);
    if (!row) return { ok: false, reason: "unknown", invite: null };
    refreshStatus(row);
    if (row.status === "revoked") return { ok: false, reason: "revoked", invite: publicView(row) };
    if (row.status === "expired") return { ok: false, reason: "expired", invite: publicView(row) };
    if (row.status === "exhausted") return { ok: false, reason: "exhausted", invite: publicView(row) };
    return { ok: true, reason: "active", invite: publicView(row) };
  }

  /**
   * Reserve estimated CU before starting Google Colab work (commit).
   * Pair with settle() after the run finishes or fails.
   */
  function commit(inviteId, units) {
    const row = byId.get(inviteId);
    if (!row) return { ok: false, reason: "unknown", invite: null };
    refreshStatus(row);
    if (row.status !== "active") return { ok: false, reason: row.status, invite: publicView(row) };
    const amount = roundCu(Number(units));
    if (!Number.isFinite(amount) || amount < 0) {
      throw new TypeError("commit units must be a non-negative number");
    }
    if (remainingCu(row) < amount) {
      refreshStatus(row);
      return { ok: false, reason: "insufficient", invite: publicView(row) };
    }
    row.committedEstimateCu = roundCu(row.committedEstimateCu + amount);
    refreshStatus(row);
    return { ok: true, reason: "committed", invite: publicView(row) };
  }

  /**
   * Move committed units into spent (or release on failure).
   * @param {string} inviteId
   * @param {{ spent?: number, release?: number, filmCompleted?: boolean }} settlement
   */
  function settle(inviteId, settlement = {}) {
    const row = byId.get(inviteId);
    if (!row) return { ok: false, reason: "unknown", invite: null };
    const spent = roundCu(Number(settlement.spent ?? 0));
    const release = roundCu(Number(settlement.release ?? 0));
    if (!Number.isFinite(spent) || spent < 0 || !Number.isFinite(release) || release < 0) {
      throw new TypeError("settle spent/release must be non-negative numbers");
    }
    const total = roundCu(spent + release);
    if (total > row.committedEstimateCu + 1e-9) {
      return { ok: false, reason: "over_settle", invite: publicView(row) };
    }
    row.committedEstimateCu = roundCu(row.committedEstimateCu - total);
    row.spentEstimateCu = roundCu(row.spentEstimateCu + spent);
    if (settlement.filmCompleted === true) {
      row.filmsCompleted += 1;
    }
    refreshStatus(row);
    return { ok: true, reason: "settled", invite: publicView(row) };
  }

  /** One-shot debit for simple callers (commit + settle spent). */
  function debit(inviteId, units, { filmCompleted = false } = {}) {
    const committed = commit(inviteId, units);
    if (!committed.ok) return committed;
    return settle(inviteId, { spent: units, release: 0, filmCompleted });
  }

  function revoke(inviteId) {
    const row = byId.get(inviteId);
    if (!row) return { ok: false, reason: "unknown", invite: null };
    row.status = "revoked";
    row.revokedAt = now();
    return { ok: true, reason: "revoked", invite: publicView(row) };
  }

  function get(inviteId) {
    const row = byId.get(inviteId);
    if (!row) return null;
    return publicView(row);
  }

  function list() {
    return [...byId.values()].map((row) => publicView(row));
  }

  return { mint, redeem, commit, settle, debit, revoke, get, list };
}

/**
 * Map invite remaining CU into a run budgetUnits ceiling for existing assessBudget / /api/run.
 */
export function budgetUnitsFromInvite(inviteView) {
  if (!inviteView || inviteView.status !== "active") return 0;
  const remaining = Number(inviteView.remainingCu);
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return remaining;
}
