// Hosted Google Colab invite demo: mint / redeem / owner summary / showcase
// + guest-scoped /api/run spend hooks. Comfy Cloud deferred.

import {
  INVITE_PATH_PREFIX,
  DEFAULT_PUBLIC_BASE_URL,
  budgetUnitsFromInvite,
  createInviteLedger,
} from "../../../../packages/backends/src/invite-ledger.mjs";
import { createGuestSessionStore } from "./guest-sessions.mjs";

/**
 * @param {object} opts
 * @param {ReturnType<typeof createInviteLedger>} [opts.ledger]
 * @param {ReturnType<typeof createGuestSessionStore>} [opts.guests]
 * @param {string} [opts.publicBaseUrl]
 * @param {() => number} [opts.now]
 * @param {(status: number, body: object) => void} opts.sendJson
 * @param {(request: import('node:http').IncomingMessage) => Promise<object>} opts.readJson
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, url: URL) => void} [opts.serveStatic]
 */
export function createDemoInvites({
  ledger = null,
  guests = null,
  publicBaseUrl = process.env.COMFYRIZZ_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL,
  now = () => Date.now(),
  sendJson,
  readJson,
  serveStatic = null,
} = {}) {
  if (typeof sendJson !== "function" || typeof readJson !== "function") {
    throw new TypeError("createDemoInvites requires sendJson and readJson");
  }

  const inviteLedger = ledger ?? createInviteLedger({ now, publicBaseUrl });
  const guestSessions = guests ?? createGuestSessionStore({ now });
  /** @type {Map<string, { inviteId: string, committed: number, packageId: string, prompt: string, title: string }>} */
  const pendingRuns = new Map();

  function parseRedeemToken(pathname) {
    if (typeof pathname !== "string") return null;
    const prefix = `${INVITE_PATH_PREFIX}/`;
    if (!pathname.startsWith(prefix)) return null;
    const token = pathname.slice(prefix.length);
    if (!token || token.includes("/") || token.includes("..")) return null;
    return token;
  }

  /**
   * Resolve auth role from supplied API token.
   * @returns {{ role: "owner"|"guest"|"none", inviteId?: string, guest?: object }}
   */
  function resolveAuth(supplied, ownerToken) {
    if (typeof supplied === "string" && typeof ownerToken === "string"
      && supplied.length === ownerToken.length) {
      // Owner compare is done by the caller with timingSafeEqual; here we only
      // distinguish guest after owner miss. Callers pass ownerOk boolean.
    }
    return { role: "none" };
  }

  function resolveGuest(supplied) {
    return guestSessions.match(supplied);
  }

  /**
   * Apply guest Colab spend rules before runs.start.
   * Returns { ok, error?, status?, budgetUnits, inviteId, committed } or refusal.
   */
  function admitGuestRun(guest, body = {}) {
    const invite = inviteLedger.get(guest.inviteId);
    if (!invite || invite.status !== "active") {
      return { ok: false, status: 403, error: "invite not active", code: "INVITE_INACTIVE", reason: invite?.status ?? "unknown" };
    }
    const remaining = budgetUnitsFromInvite(invite);
    if (remaining <= 0) {
      return { ok: false, status: 403, error: "invite budget exhausted", code: "INVITE_EXHAUSTED", invite };
    }
    const requested = Number(body.budgetUnits);
    const budgetUnits = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, remaining)
      : remaining;
    if (body.backendId && body.backendId !== "colab") {
      return { ok: false, status: 400, error: "demo guests may only use Google Colab", code: "INVITE_COLAB_ONLY" };
    }
    let committed = 0;
    if (body.approved === true) {
      const c = inviteLedger.commit(guest.inviteId, budgetUnits);
      if (!c.ok) {
        return {
          ok: false,
          status: 403,
          error: c.reason === "insufficient" ? "invite budget insufficient" : `invite ${c.reason}`,
          code: "INVITE_COMMIT_REFUSED",
          reason: c.reason,
          invite: c.invite,
        };
      }
      committed = budgetUnits;
    }
    return {
      ok: true,
      budgetUnits,
      inviteId: guest.inviteId,
      committed,
      invite: inviteLedger.get(guest.inviteId),
      backendId: "colab",
    };
  }

  function bindGuestRun(runId, meta) {
    if (!runId || !meta?.inviteId) return;
    pendingRuns.set(runId, {
      inviteId: meta.inviteId,
      committed: Number(meta.committed) || 0,
      packageId: typeof meta.packageId === "string" ? meta.packageId : "",
      prompt: typeof meta.prompt === "string" ? meta.prompt : "",
      title: typeof meta.title === "string" ? meta.title : "",
    });
  }

  function releaseGuestCommit(inviteId, committed) {
    if (!inviteId || !(committed > 0)) return;
    inviteLedger.settle(inviteId, { spent: 0, release: committed });
  }

  /** Hook for EventLog publish wrapper — settle invite on run.settled / terminal. */
  function onRunEvent(event) {
    if (!event || typeof event !== "object") return;
    const runId = event.runId;
    if (!runId || !pendingRuns.has(runId)) return;
    const pending = pendingRuns.get(runId);

    if (event.type === "run.settled") {
      const spent = Math.max(0, Number(event.units) || 0);
      const release = Math.max(0, roundCu(pending.committed - spent));
      inviteLedger.settle(pending.inviteId, {
        spent: Math.min(spent, pending.committed),
        release,
        filmCompleted: spent > 0,
      });
      pending.committed = 0;
      pendingRuns.set(runId, pending);
      return;
    }

    if (event.type === "run.finished") {
      inviteLedger.recordGeneration(pending.inviteId, {
        packageId: pending.packageId,
        prompt: pending.prompt,
        title: pending.title,
        spentEstimateCu: 0,
        status: "ready",
        showcase: true,
        runId,
        details: { status: event.status ?? "finished" },
      });
      if (pending.committed > 0) {
        inviteLedger.settle(pending.inviteId, { spent: pending.committed, release: 0, filmCompleted: true });
        pending.committed = 0;
      }
      pendingRuns.delete(runId);
      return;
    }

    if (event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.refused") {
      if (pending.committed > 0) {
        inviteLedger.settle(pending.inviteId, { spent: 0, release: pending.committed });
      }
      if (event.type === "run.failed") {
        inviteLedger.recordGeneration(pending.inviteId, {
          packageId: pending.packageId,
          prompt: pending.prompt,
          title: pending.title,
          status: "failed",
          showcase: false,
          runId,
          details: { message: event.message ?? "failed" },
        });
      }
      pendingRuns.delete(runId);
    }
  }

  function roundCu(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 1000) / 1000;
  }

  /**
   * Handle invite-related HTTP before/inside the main handler.
   * @returns {Promise<boolean>} true if handled
   */
  async function handle(request, response, url, { ownerOk = false, guest = null } = {}) {
    const pathname = url.pathname;
    const reply = (status, body) => {
      sendJson(response, status, body);
      return true;
    };

    // Public redeem page: bind guest session and bounce into Super Easy with #token=
    const redeemToken = parseRedeemToken(pathname);
    if (redeemToken && (request.method === "GET" || request.method === "HEAD")) {
      const redeemed = inviteLedger.redeem(redeemToken);
      if (!redeemed.ok) {
        return reply(403, {
          error: `invite ${redeemed.reason}`,
          code: "INVITE_REDEEM_REFUSED",
          reason: redeemed.reason,
          invite: redeemed.invite,
        });
      }
      const session = guestSessions.issue({
        inviteId: redeemed.invite.id,
        label: redeemed.invite.label,
      });
      const budgetUnits = budgetUnitsFromInvite(redeemed.invite);
      // Prefer SPA shell with fragment token (same contract as owner URL).
      const loc = `/?demo=1&mode=super-easy#token=${encodeURIComponent(session.guestToken)}`;
      if (serveStatic && request.headers.accept && String(request.headers.accept).includes("text/html")) {
        response.writeHead(302, {
          location: loc,
          "cache-control": "no-store",
          "x-comfyrizz-invite-id": redeemed.invite.id,
          "x-comfyrizz-invite-remaining-cu": String(budgetUnits),
        });
        response.end();
        return true;
      }
      return reply(200, {
        ok: true,
        guestToken: session.guestToken,
        expiresAt: session.expiresAt,
        invite: redeemed.invite,
        budgetUnits,
        openPath: loc,
        mode: "super-easy",
        backendId: "colab",
        urlShape: `${publicBaseUrl}${INVITE_PATH_PREFIX}/<token>`,
      });
    }

    // POST /api/invites/redeem — JSON redeem (tests / non-browser)
    if (pathname === "/api/invites/redeem" && request.method === "POST") {
      const body = await readJson(request);
      const token = typeof body?.token === "string" ? body.token : "";
      const redeemed = inviteLedger.redeem(token);
      if (!redeemed.ok) {
        return reply(403, {
          error: `invite ${redeemed.reason}`,
          code: "INVITE_REDEEM_REFUSED",
          reason: redeemed.reason,
          invite: redeemed.invite,
        });
      }
      const session = guestSessions.issue({ inviteId: redeemed.invite.id, label: redeemed.invite.label });
      return reply(200, {
        ok: true,
        guestToken: session.guestToken,
        expiresAt: session.expiresAt,
        invite: redeemed.invite,
        budgetUnits: budgetUnitsFromInvite(redeemed.invite),
        openPath: `/?demo=1&mode=super-easy#token=${encodeURIComponent(session.guestToken)}`,
        mode: "super-easy",
        backendId: "colab",
      });
    }

    // Public showcase gallery (read-only). Guests and owners may read.
    if (pathname === "/api/demo/showcase" && request.method === "GET") {
      if (!ownerOk && !guest) {
        return reply(401, { error: "unauthorized" });
      }
      const exclude = guest?.inviteId ?? null;
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return reply(200, {
        items: inviteLedger.showcase({ excludeInviteId: exclude, limit }),
        urlShape: `${publicBaseUrl}${INVITE_PATH_PREFIX}/<token>`,
      });
    }

    // Open a showcase / guest package in Comfyrizz (returns deep-link + package id).
    const openMatch = /^\/api\/demo\/showcase\/([^/]+)\/open$/.exec(pathname);
    if (openMatch && request.method === "POST") {
      if (!ownerOk && !guest) {
        return reply(401, { error: "unauthorized" });
      }
      let packageId;
      try {
        packageId = decodeURIComponent(openMatch[1]);
      } catch {
        return reply(400, { error: "bad package id" });
      }
      const hit = inviteLedger.listGenerations().find((g) => g.packageId === packageId && g.showcase && g.status === "ready");
      if (!hit) {
        return reply(404, { error: "showcase item not found", code: "SHOWCASE_NOT_FOUND" });
      }
      return reply(200, {
        ok: true,
        packageId: hit.packageId,
        prompt: hit.prompt,
        title: hit.title,
        details: hit.details,
        openPath: `/#package=${encodeURIComponent(hit.packageId)}`,
        mode: "super-easy",
      });
    }

    // Owner-only mint
    if (pathname === "/api/invites/mint" && request.method === "POST") {
      if (!ownerOk) return reply(401, { error: "unauthorized", code: "OWNER_REQUIRED" });
      const body = await readJson(request);
      try {
        const minted = inviteLedger.mint({
          cu: body.cu ?? body.spendCeilingCu,
          spendCeilingCu: body.spendCeilingCu,
          ttlSeconds: body.ttlSeconds,
          ttlDays: body.ttlDays,
          ttlMs: body.ttlMs,
          expiresAt: body.expiresAt,
          label: body.label,
          maxFilms: body.maxFilms,
          publicBaseUrl: body.publicBaseUrl ?? publicBaseUrl,
          requireCu: true,
          requireTtl: true,
        });
        return reply(200, {
          token: minted.token,
          path: minted.path,
          url: minted.url,
          invite: minted.invite,
          urlShape: `${publicBaseUrl}${INVITE_PATH_PREFIX}/<token>`,
        });
      } catch (error) {
        return reply(400, { error: error.message, code: "INVITE_MINT_INVALID" });
      }
    }

    // Owner observability
    if (pathname === "/api/invites" && request.method === "GET") {
      if (!ownerOk) return reply(401, { error: "unauthorized", code: "OWNER_REQUIRED" });
      return reply(200, inviteLedger.ownerSummary());
    }

    if (pathname === "/api/invites/summary" && request.method === "GET") {
      if (!ownerOk) return reply(401, { error: "unauthorized", code: "OWNER_REQUIRED" });
      return reply(200, inviteLedger.ownerSummary());
    }

    // Guest session self-status
    if (pathname === "/api/invites/session" && request.method === "GET") {
      if (!guest) return reply(401, { error: "unauthorized" });
      const invite = inviteLedger.get(guest.inviteId);
      return reply(200, {
        role: "guest",
        invite,
        budgetUnits: budgetUnitsFromInvite(invite),
        backendId: "colab",
        mode: "super-easy",
      });
    }

    const inviteGet = /^\/api\/invites\/([^/]+)$/.exec(pathname);
    if (inviteGet && request.method === "GET") {
      if (!ownerOk) return reply(401, { error: "unauthorized", code: "OWNER_REQUIRED" });
      const invite = inviteLedger.get(inviteGet[1]);
      if (!invite) return reply(404, { error: "invite not found" });
      return reply(200, {
        invite,
        generations: inviteLedger.listGenerations(invite.id),
      });
    }

    const inviteRevoke = /^\/api\/invites\/([^/]+)\/revoke$/.exec(pathname);
    if (inviteRevoke && request.method === "POST") {
      if (!ownerOk) return reply(401, { error: "unauthorized", code: "OWNER_REQUIRED" });
      const result = inviteLedger.revoke(inviteRevoke[1]);
      if (!result.ok) return reply(404, { error: "invite not found" });
      guestSessions.revokeInvite(inviteRevoke[1]);
      return reply(200, result);
    }

    return false;
  }

  return {
    ledger: inviteLedger,
    guests: guestSessions,
    handle,
    parseRedeemToken,
    resolveGuest,
    resolveAuth,
    admitGuestRun,
    bindGuestRun,
    releaseGuestCommit,
    onRunEvent,
    pathPrefix: INVITE_PATH_PREFIX,
    publicBaseUrl,
  };
}
