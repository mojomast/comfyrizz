// Hosted Google Colab invite ledger.
// Pure in-memory store: mint / redeem / commit / settle / debit / revoke / expire
// + generation catalog for owner observability and guest showcase.
// No network, no Google Colab CLI, no secrets. Per-link ceilings are product
// estimates (SPEC.md 6.6): Google Colab usage is account-wide, so Comfyrizz
// enforces invite caps on its own spent_estimate ledger.
//
// Pool is fixed to google-colab on this track (Comfy Cloud invite pool deferred).
// Public URL shape: https://comfy.rizz.click/secretfriendsdemo/<token>

import { createHash, randomBytes } from "node:crypto";

export const INVITE_POOL_GOOGLE_COLAB = "google-colab";

/** Path segment for public redeem URLs (exact). */
export const INVITE_PATH_PREFIX = "/secretfriendsdemo";

/** Default public origin when mint does not pass publicBaseUrl. */
export const DEFAULT_PUBLIC_BASE_URL = "https://comfy.rizz.click";

/**
 * Suggested fallback CU when mint omits cu (HTTP mint API should require cu).
 * Prefer passing cu + ttl at mint time.
 */
export const DEFAULT_SPEND_CEILING_CU = 2;

/** Default TTL when mint omits ttl (7 days). Prefer passing ttlSeconds/ttlDays. */
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

export function invitePathForToken(token) {
  if (typeof token !== "string" || token.length < 16) {
    throw new TypeError("invite token must be a string of at least 16 characters");
  }
  return `${INVITE_PATH_PREFIX}/${token}`;
}

export function invitePublicUrl(token, publicBaseUrl = DEFAULT_PUBLIC_BASE_URL) {
  const base = typeof publicBaseUrl === "string" && publicBaseUrl.trim()
    ? publicBaseUrl.trim().replace(/\/$/, "")
    : DEFAULT_PUBLIC_BASE_URL;
  return `${base}${invitePathForToken(token)}`;
}

function roundCu(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1000) / 1000;
}

function resolveSpendCeilingCu(opts) {
  const raw = opts.cu ?? opts.spendCeilingCu;
  if (raw === undefined || raw === null) return DEFAULT_SPEND_CEILING_CU;
  return Number(raw);
}

function resolveTtlMs(opts) {
  if (opts.ttlMs != null) return Number(opts.ttlMs);
  if (opts.ttlSeconds != null) return Number(opts.ttlSeconds) * 1000;
  if (opts.ttlDays != null) return Number(opts.ttlDays) * 24 * 60 * 60 * 1000;
  return DEFAULT_TTL_MS;
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
 * @typedef {object} GenerationRecord
 * @property {string} id
 * @property {string} inviteId
 * @property {string} packageId
 * @property {string} prompt
 * @property {string} title
 * @property {object} details
 * @property {number} createdAt
 * @property {number} spentEstimateCu
 * @property {"ready"|"failed"} status
 * @property {boolean} showcase
 * @property {string|null} runId
 */

/**
 * In-memory invite ledger. Swap for a durable store before multi-process host.
 */
export function createInviteLedger({ now = () => Date.now(), publicBaseUrl = DEFAULT_PUBLIC_BASE_URL, initialState = null } = {}) {
  /** @type {Map<string, InviteRecord>} */
  const byHash = new Map();
  /** @type {Map<string, InviteRecord>} */
  const byId = new Map();
  /** @type {GenerationRecord[]} */
  const generations = [];
  let seq = 0;
  let genSeq = 0;

  if (initialState !== null) {
    if (initialState.version !== 1 || !Array.isArray(initialState.invites)
        || !Array.isArray(initialState.generations) || !Number.isSafeInteger(initialState.seq)
        || initialState.seq < 0 || !Number.isSafeInteger(initialState.genSeq) || initialState.genSeq < 0) {
      throw new Error('invalid persisted invite ledger');
    }
    for (const row of initialState.invites) {
      if (!row || typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.tokenHash)
          || byId.has(row.id) || byHash.has(row.tokenHash)
          || !['active', 'revoked', 'expired', 'exhausted'].includes(row.status)
          || !Number.isFinite(row.spendCeilingCu) || row.spendCeilingCu <= 0
          || !Number.isFinite(row.spentEstimateCu) || row.spentEstimateCu < 0
          || !Number.isFinite(row.committedEstimateCu) || row.committedEstimateCu < 0
          || !Number.isFinite(row.expiresAt) || !Number.isFinite(row.createdAt)
          || !Number.isFinite(row.maxFilms) || row.maxFilms < 0
          || !Number.isFinite(row.filmsCompleted) || row.filmsCompleted < 0) throw new Error('invalid persisted invite record');
      byId.set(row.id, row);
      byHash.set(row.tokenHash, row);
    }
    generations.push(...initialState.generations);
    seq = initialState.seq;
    genSeq = initialState.genSeq;
  }

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
      generations: generations.filter((g) => g.inviteId === live.id).length,
    };
  }

  /**
   * Mint a new invite. Returns the raw token once; only the hash is stored.
   * Prefer passing cu + ttlSeconds (or ttlDays / ttlMs) + optional label.
   * @param {object} [opts]
   * @param {number} [opts.cu] alias for spendCeilingCu
   * @param {number} [opts.spendCeilingCu]
   * @param {number} [opts.maxFilms]
   * @param {number} [opts.expiresAt] unix ms
   * @param {number} [opts.ttlMs]
   * @param {number} [opts.ttlSeconds]
   * @param {number} [opts.ttlDays]
   * @param {string} [opts.label]
   * @param {string} [opts.publicBaseUrl]
   * @param {boolean} [opts.requireCu] when true, cu/spendCeilingCu is mandatory
   * @param {boolean} [opts.requireTtl] when true, one of ttlSeconds/ttlDays/ttlMs/expiresAt is mandatory
   */
  function mint(opts = {}) {
    if (opts.requireCu && opts.cu == null && opts.spendCeilingCu == null) {
      throw new TypeError("cu (or spendCeilingCu) is required");
    }
    if (
      opts.requireTtl
      && opts.ttlMs == null
      && opts.ttlSeconds == null
      && opts.ttlDays == null
      && opts.expiresAt == null
    ) {
      throw new TypeError("ttlSeconds, ttlDays, ttlMs, or expiresAt is required");
    }
    const spendCeilingCu = resolveSpendCeilingCu(opts);
    if (!Number.isFinite(spendCeilingCu) || spendCeilingCu < 0.001
        || !Number.isSafeInteger(Math.round(spendCeilingCu * 1000))
        || Math.abs(Math.round(spendCeilingCu * 1000) - spendCeilingCu * 1000) > 1e-7) {
      throw new TypeError("cu / spendCeilingCu must be at least 0.001 and use at most three decimal places");
    }
    const maxFilms = opts.maxFilms == null ? 3 : Number(opts.maxFilms);
    if (!Number.isFinite(maxFilms) || maxFilms < 0) {
      throw new TypeError("maxFilms must be a non-negative number");
    }
    const createdAt = now();
    const expiresAt =
      opts.expiresAt != null
        ? Number(opts.expiresAt)
        : createdAt + resolveTtlMs(opts);
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
    const base = opts.publicBaseUrl ?? publicBaseUrl;
    const path = invitePathForToken(token);
    return {
      token,
      path,
      url: invitePublicUrl(token, base),
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
    // Exhausted links remain useful for viewing the gallery. Admission still
    // refuses new spend through commit/reserveAction.
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

  /**
   * Record what a guest generated (owner observability + showcase).
   * @param {string} inviteId
   * @param {{ packageId?: string, prompt?: string, title?: string, details?: object, spentEstimateCu?: number, status?: "ready"|"failed", showcase?: boolean, runId?: string|null }} entry
   */
  function recordGeneration(inviteId, entry = {}) {
    const row = byId.get(inviteId);
    if (!row) return { ok: false, reason: "unknown", generation: null };
    if (typeof entry.runId === 'string' && entry.runId) {
      const previous = generations.find(generation => generation.runId === entry.runId);
      if (previous) {
        if (previous.inviteId !== inviteId) throw new Error('generation run belongs to another invite');
        if (['queued', 'running'].includes(previous.status) && entry.status && !['queued', 'running'].includes(entry.status)) {
          Object.assign(previous, {
            status: entry.status, showcase: entry.showcase === true,
            spentEstimateCu: roundCu(Number(entry.spentEstimateCu ?? 0)) || 0,
            details: { ...previous.details, ...entry.details }, finishedAt: now(),
          });
        }
        return { ok: true, reason: 'already_recorded', generation: { ...previous } };
      }
    }
    genSeq += 1;
    const createdAt = now();
    /** @type {GenerationRecord} */
    const generation = {
      id: `gen_${createdAt.toString(36)}_${genSeq}`,
      inviteId,
      packageId: typeof entry.packageId === "string" ? entry.packageId : "",
      prompt: typeof entry.prompt === "string" ? entry.prompt : "",
      title: typeof entry.title === "string" ? entry.title : "",
      details: entry.details && typeof entry.details === "object" ? entry.details : {},
      createdAt,
      spentEstimateCu: roundCu(Number(entry.spentEstimateCu ?? 0)) || 0,
      status: ['queued', 'running', 'failed', 'cancelled', 'interrupted'].includes(entry.status) ? entry.status : 'ready',
      showcase: entry.showcase !== false,
      runId: typeof entry.runId === "string" ? entry.runId : null,
    };
    generations.push(generation);
    return { ok: true, reason: "recorded", generation: { ...generation } };
  }

  function listGenerations(inviteId = null) {
    const rows = inviteId == null ? generations : generations.filter((g) => g.inviteId === inviteId);
    return rows.map((g) => ({ ...g }));
  }

  /** Guest-facing gallery of other demo creations (prompt + details). */
  function showcase({ excludeInviteId = null, limit = 50 } = {}) {
    const lim = Number.isFinite(Number(limit)) ? Math.max(0, Math.min(200, Number(limit))) : 50;
    return generations
      .filter((g) => g.showcase && g.status === "ready" && g.inviteId !== excludeInviteId)
      .slice(-lim)
      .reverse()
      .map((g) => ({
        id: g.id,
        packageId: g.packageId,
        prompt: g.prompt,
        title: g.title || g.prompt.slice(0, 80) || "Untitled demo",
        details: g.details,
        createdAt: g.createdAt,
        spentEstimateCu: g.spentEstimateCu,
        openPath: g.packageId ? `/#package=${encodeURIComponent(g.packageId)}` : null,
      }));
  }

  /** Owner observability: per-invite + overall CU and generations. */
  function ownerSummary() {
    const invites = list();
    const gens = listGenerations();
    const totals = invites.reduce(
      (acc, inv) => {
        acc.ceilingCu = roundCu(acc.ceilingCu + inv.spendCeilingCu);
        acc.spentEstimateCu = roundCu(acc.spentEstimateCu + inv.spentEstimateCu);
        acc.committedEstimateCu = roundCu(acc.committedEstimateCu + inv.committedEstimateCu);
        acc.remainingCu = roundCu(acc.remainingCu + Math.max(0, inv.remainingCu));
        return acc;
      },
      { ceilingCu: 0, spentEstimateCu: 0, committedEstimateCu: 0, remainingCu: 0, inviteCount: invites.length, generationCount: gens.length,
        runningCount: gens.filter(g => ['queued', 'running'].includes(g.status)).length,
        readyCount: gens.filter(g => g.status === 'ready').length,
        failedCount: gens.filter(g => ['failed', 'cancelled', 'interrupted'].includes(g.status)).length,
        visits: [...byId.values()].reduce((sum, row) => sum + (row.visits ?? 0), 0) },
    );
    return {
      totals,
      invites: invites.map((inv) => ({
        ...inv,
        visits: byId.get(inv.id)?.visits ?? 0,
        lastVisitAt: byId.get(inv.id)?.lastVisitAt ?? null,
        generations: gens.filter((g) => g.inviteId === inv.id),
      })),
      generations: gens,
    };
  }

  return {
    exportState: () => ({ version: 1, invites: [...byId.values()], generations, seq, genSeq }),
    mint,
    recordVisit(inviteId) {
      const row = byId.get(inviteId);
      if (!row) return;
      row.visits = (row.visits ?? 0) + 1;
      row.lastVisitAt = now();
    },
    recordGenerationModels(runId, models) {
      const generation = generations.find(row => row.runId === runId);
      if (!generation || !Array.isArray(models)) return false;
      // Host-only provenance enrichment never alters ownership, status or CU.
      generation.details = { ...generation.details, models: structuredClone(models), modelEvidence: 'verified_pipeline' };
      return true;
    },
    redeem,
    commit,
    settle,
    debit,
    revoke,
    get,
    list,
    recordGeneration,
    listGenerations,
    showcase,
    ownerSummary,
  };
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
