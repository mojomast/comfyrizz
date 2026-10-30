// Guest sessions bound to a Google Colab invite after redeem.
// In-memory only (Phase B). Opaque guest tokens are accepted by the API in
// place of the owner COMFYRIZZ_TOKEN, with invite-scoped spend caps.

import { randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_GUEST_TTL_MS = 12 * 60 * 60 * 1000; // 12h session after redeem

export function createGuestSessionStore({ now = () => Date.now(), ttlMs = DEFAULT_GUEST_TTL_MS } = {}) {
  /** @type {Map<string, { token: string, inviteId: string, createdAt: number, expiresAt: number, label: string }>} */
  const byToken = new Map();

  function issue({ inviteId, label = "" }) {
    if (typeof inviteId !== "string" || !inviteId) {
      throw new TypeError("inviteId is required");
    }
    const token = randomBytes(32).toString("hex");
    const createdAt = now();
    const expiresAt = createdAt + ttlMs;
    const row = { token, inviteId, createdAt, expiresAt, label: typeof label === "string" ? label : "" };
    byToken.set(token, row);
    return { guestToken: token, inviteId, expiresAt, createdAt };
  }

  function resolve(token) {
    if (typeof token !== "string" || token.length < 16) return null;
    const row = byToken.get(token);
    if (!row) return null;
    if (now() >= row.expiresAt) {
      byToken.delete(token);
      return null;
    }
    return { inviteId: row.inviteId, expiresAt: row.expiresAt, createdAt: row.createdAt, label: row.label };
  }

  function revoke(token) {
    return byToken.delete(token);
  }

  function revokeInvite(inviteId) {
    let n = 0;
    for (const [token, row] of byToken) {
      if (row.inviteId === inviteId) {
        byToken.delete(token);
        n += 1;
      }
    }
    return n;
  }

  /** Constant-time compare against stored guest tokens (small map). */
  function match(supplied) {
    if (typeof supplied !== "string" || supplied.length < 16) return null;
    for (const [token, row] of byToken) {
      const a = Buffer.from(supplied);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        if (now() >= row.expiresAt) {
          byToken.delete(token);
          return null;
        }
        return { inviteId: row.inviteId, expiresAt: row.expiresAt, createdAt: row.createdAt, label: row.label, guestToken: token };
      }
    }
    return null;
  }

  return { issue, resolve, revoke, revokeInvite, match };
}
