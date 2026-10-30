# Hosted Google Colab invite demo — state, design, next steps

## Main integration: known planning gap

After integration with the Pi production changes, the isolated hosted guest
builder still invokes its offline runner. Generated-film planning now requires
a live model, so hosted guest planning currently fails before dispatch. The
offline guest-builder test and the three hosted Super Easy pipeline/no-spend
tests fail as a result. The earlier no-spend smoke below describes the prior
host deployment, not a successful test of this integrated version. Reconnect
guest planning to a host-configured live model with isolated guest storage and
verify the hosted flow before deploying this integration or enabling spend.

## Host integration update (2026-10-28)

The sections below describe the original branch and should not be treated as
the current deployment status. The owner API is available through a separate
loopback listener behind a tailnet-only HTTPS endpoint. It requires the
host-held owner token in `X-Comfyrizz-Token`; mint, summary, detail, and revoke
are owner-only. The private `/admin/` dashboard requires the same token and
keeps it in page memory only. Invite links are shown once when minted; the
ledger stores only their hashes.

Hosted guests use the production outbox, not the legacy `/api/run` path. Their
productions and result tickets are invite-scoped; a guest can request a fresh
ticket through `GET /api/invites/productions/:id/result`. The SQLite ledger
persists ownership and estimated CU reservations. Terminal pipelines charge
their reserved estimate, including uncertain failures; actual account usage is
not yet independently attributable or proven to obey a hard CU cap.

Spending is disabled. The public no-spend proxy is installed for
`https://comfy.rizz.click/secretfriendsdemo/`, `/hosted-demo/`, and guest APIs.
The private owner listener remains Tailscale-only. A public mint, redeem, plan,
disabled-dispatch, reporting, restart, and revoke smoke passed with zero CU.
Hosted `GET /api/demo/showcase` returns shared items from other invites with an
`openApiPath`. A guest `POST` to that path creates a separate, viewer-owned
package and returns its `openPath` plus a short-lived `videoUrl`. The source
package and production remain inaccessible. The copy is read-only in the hosted
guest profile; copied files are independent, while video tickets stop working
when either invite is revoked or expires. Fake-worker success and failure,
result ownership, revocation, and restart settlement have been tested; paid
execution requires explicit Phase C approval. The guest showcase is currently
an API surface, not a gallery in the Super Easy UI.

The TLS-server nginx routes derive from `deploy/nginx-hosted-invite.conf`.
The original live site configuration is preserved at
`/etc/nginx/sites-available/comfy.rizz.click.pre-hosted-invite-20261028`.
Access logging and token-bearing error logging are disabled on the invite,
app and API routes and on the HTTP-to-HTTPS redirect server. Validate the
complete live nginx configuration before reloading. Build the guest web app with
`COMFYRIZZ_WEB_BASE=/hosted-demo/ npm run build` in `apps/web`;
`COMFYRIZZ_DEMO_APP_PATH` controls server routing and does not set Vite's base.

**Audience:** Kyle Durepos  
**Clarification (t559u / pt559u, 2026-10-28 America/Toronto):** “colab demo” = **hosted mintable invite links** with a **Google Colab budget per link** for recipients — **not** the hackathon film cut.  
**Comfy Cloud / API Phase 1:** deferred. Prefer the **Google Colab** path.  
**Ops note:** COLAB ORCHESTRATOR stopped film GPU (assignments 0) — do not restart film sessions from this track.  
**Date:** 2026-10-28 (America/Toronto)  
**Branch:** `feat/hosted-colab-invite` @ `/home/box/wt/hosted-colab-invite`  
**Scope:** Ledger + mint/redeem HTTP + guest Super Easy session + spend wire + owner observability + showcase. No Google Colab spend, no Orbit/launcher, no main merge/tag, no deploy to public host yet.

**Related:**
- Prior Cloud-oriented research (deferred): `/workspace/hackathon-demo/out/JUDGE_DEMO_INVITE_COMPUTE_RESEARCH.md`
- Super Easy UX: `docs/ui/SUPER_EASY.md`

---

## 1. Kyle digest — what works locally vs public host

| You can do **locally now** | Still needed for **public** `comfy.rizz.click` |
|----------------------------|--------------------------------------------------|
| Mint invite with **cu + ttl** (+ optional label) via `POST /api/invites/mint` or `scripts/invites/mint.mjs` | Bind server beyond `127.0.0.1` (today `hostAllowed` + `listen` are loopback-only) |
| Full public URL returned: `https://comfy.rizz.click/secretfriendsdemo/<token>` | TLS / reverse proxy in front of demo process |
| Redeem at `/secretfriendsdemo/<token>` → guest Super Easy session (`#token=` guest) | Allow `comfy.rizz.click` (and/or demo host) in `hostAllowed` / same-origin |
| Guest `/api/run` forced to **Google Colab**, budget capped to invite remaining; refuse when exhausted/expired | Host process signed into **your** Colab CLI + HF (vault/runtime — not chat) |
| Owner: `GET /api/invites` — CU used per invite + overall; generations listed | Durable ledger (in-memory dies on restart) |
| Guest/owner: `GET /api/demo/showcase` + `POST /api/demo/showcase/:packageId/open` | Optional: SPA polish for showcase gallery UI (API ready) |
| Unit tests: mint / redeem / expire / overspend / showcase | Explicit Kyle OK before Phase C spend + deploy |

**Do not deploy to comfy.rizz.click yet** — host bind is not trivial (loopback + token model). See §8.

---

## 2. URL shape (frozen)

```text
https://comfy.rizz.click/secretfriendsdemo/<token>
```

- Path segment is exactly **`secretfriendsdemo`** (not `/i/`).
- `<token>` = CSPRNG base64url (≥128 bits); server stores **sha256(token)** only.
- Local redeem while developing: `http://127.0.0.1:<port>/secretfriendsdemo/<token>`
- Mint always returns `{ token, path, url, invite, urlShape }`.

---

## 3. Kyle defaults (accepted)

| Decision | Value |
|----------|--------|
| CU + TTL | **Chosen at mint time** (API requires `cu` + `ttlSeconds` or `ttlDays` / `ttlMs` / `expiresAt`). No fixed 2 CU product requirement. |
| Public URL | `https://comfy.rizz.click/secretfriendsdemo/<token>` |
| Pool | Google Colab only (Comfy Cloud deferred) |
| Merge/tag | **No** main merge/tag from this track without OK |

Optional mint fields: `label`, `maxFilms` (default 3).

---

## 4. Surfaces & APIs

### Owner (requires `COMFYRIZZ_TOKEN`)

| Method | Path | Body / notes |
|--------|------|----------------|
| `POST` | `/api/invites/mint` | `{ cu, ttlSeconds\|ttlDays\|ttlMs\|expiresAt, label?, maxFilms? }` → `{ token, path, url, invite }` |
| `GET` | `/api/invites` | Owner summary: totals + per-invite CU + generations |
| `GET` | `/api/invites/:id` | One invite + its generations |
| `POST` | `/api/invites/:id/revoke` | Revoke + drop guest sessions |
| `GET` | `/api/demo/showcase` | Gallery items |
| `POST` | `/api/demo/showcase/:packageId/open` | `{ openPath, packageId, prompt, title }` for Comfyrizz |

CLI:

```bash
COMFYRIZZ_TOKEN=… node scripts/invites/mint.mjs --cu 2 --ttlDays 7 --label friend
# or --ttlSeconds 3600
```

### Guest (invite redeem)

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/secretfriendsdemo/:token` | Validates invite → issues guest session → JSON or 302 to `/?demo=1&mode=super-easy#token=<guest>` |
| `POST` | `/api/invites/redeem` | `{ token }` → `{ guestToken, budgetUnits, openPath, mode: "super-easy", backendId: "colab" }` |
| `GET` | `/api/invites/session` | Guest self-status + remaining CU |
| `POST` | `/api/run` | Forced `backendId=colab`; `budgetUnits` capped to remaining; commit/settle against invite ledger |

### Showcase / observability add-ons

1. **Owner observability:** CU used per invite + overall; list of what each guest generated (`ownerSummary` / `GET /api/invites`).
2. **Demo showcase:** gallery of other demo-user creations with prompt + details (`GET /api/demo/showcase`).
3. **Open in Comfyrizz:** `POST /api/demo/showcase/:packageId/open` → `#package=<id>` deep-link (package must already exist in host runtime store).

---

## 5. Implementation status

### Phase A+B (this branch — no Colab spend)

- [x] Invite ledger (`packages/backends/src/invite-ledger.mjs`) — mint/redeem/commit/settle/debit/revoke/expire + generations/showcase/ownerSummary
- [x] Path `/secretfriendsdemo/<token>` + full public URL on mint
- [x] Mint API accepts **cu + ttl** (required) + optional label
- [x] Redeem → guest session bound to invite remaining CU
- [x] Wire ledger into `/api/run` for guests (cap + commit/settle on run events)
- [x] Tests: ledger (10) + guest sessions + demo-invites mint/redeem/expire/overspend/showcase
- [x] Mint CLI `scripts/invites/mint.mjs`
- [x] Document URL shape (this doc)
- [ ] SPA showcase gallery UI (API only for now)
- [ ] Durable persistence for ledger
- [ ] Public host bind (see §8)

### Phase C — spend (explicit Kyle OK)

- Deploy demo host with Colab auth in vault/runtime
- Smoke film under a test invite; measure CU; mint real links
- Revoke after event

**Hard rules:** no Google Colab from this track without named OK; no Comfy Cloud Phase 1; no Orbit/launcher; no main merge/tag without OK; **no deploy to comfy.rizz.click until host bind is deliberate**.

---

## 6. Code pointers

| Area | Path |
|------|------|
| Invite ledger | `packages/backends/src/invite-ledger.mjs` |
| Guest sessions | `apps/server/src/invites/guest-sessions.mjs` |
| HTTP + spend hooks | `apps/server/src/invites/demo-invites.mjs` (wired in `apps/server/src/app.mjs`) |
| Mint CLI | `scripts/invites/mint.mjs` |
| Tests | `packages/backends/test/invite-ledger.test.mjs`, `apps/server/test/invites/*` |
| Budget admission | `packages/backends/src/budget.mjs` |
| Run / approval | `apps/server/src/run.mjs` |

---

## 7. Risks (unchanged honesty)

| Risk | Mitigation |
|------|------------|
| Viral / leaked invite drains CU | Low ceilings at mint; revoke; max films; guest session TTL |
| Account-wide Colab metering | Caps are **estimate** product ceilings (SPEC §6.6) |
| Loopback mistaken for hosted | Separate public bind step; marketing Generate still off until OK |
| Guest sees secrets | Guest blocked from `/api/colab/auth`; server holds Colab |
| In-memory ledger | Lost on restart — durable store before multi-process host |

---

## 8. What’s left for host bind (not done)

1. **`server.listen` host** — today hardcoded `127.0.0.1` in `apps/server/src/index.mjs`.
2. **`hostAllowed()`** — only loopback; must allow `comfy.rizz.click` (or demo subdomain) when you choose to bind.
3. **Same-origin** — HTTPS origin must match Host for POSTs.
4. **Process env** — `COMFYRIZZ_PUBLIC_BASE_URL=https://comfy.rizz.click`, token + Colab CLI + HF on the host box.
5. **Durable invite ledger** — replace in-memory `Map` before relying on restart-safe invites.
6. **robots / noindex** for `/secretfriendsdemo/`.
7. **Optional UI** — owner mint page + guest showcase strip in Super Easy.

Until those land, use local mint + local redeem; public URL string is correct for sharing **after** bind.

---

## 9. Quick local smoke (no Colab)

```bash
# terminal A — after web/agent build as usual
cd apps/server && COMFYRIZZ_TOKEN=dev-hosted-invite-token-01 npm start

# terminal B
node scripts/invites/mint.mjs --token dev-hosted-invite-token-01 --cu 2 --ttlDays 3 --label smoke
# open Local redeem URL, or:
curl -s -H 'accept: application/json' "http://127.0.0.1:4319/secretfriendsdemo/<token>"
curl -s -H "x-comfyrizz-token: $OWNER" -H "origin: http://127.0.0.1:4319" \
  http://127.0.0.1:4319/api/invites | jq .totals
```

---

*End. No CU spent; not deployed; film Colab left stopped.*
