# Hosted Google Colab invite demo — state, design, next steps

## Accounting reconciliation integration (2026-10-30)

Hosted pipelines now keep invite CU **reserved and unresolved** after a
completed/failed run when its usage is only an account-wide balance delta.
Concurrent account deltas overlap; they are neither apportioned nor charged
as actual per-film usage. Verified shutdown is necessary but does not itself
prove the cost. The current CLI usage/status parser supplies no final,
session-attributable CU receipt, so real allocated hosted runs retain their
holds pending explicit reconciliation. No actual-usage measurement is invented.

The durable action reservation and generation `details.accounting` expose
`status`, `actualSpendCu` (null when unknown), `shutdownVerified`, `costSource`,
and the unresolved reason. The hosted gallery (own-invite films only) and admin
dashboard show **Usage indeterminate; CU reserved** with the held amount, not
interpret the legacy numeric `spentEstimateCu: 0` as free work. Verified
settlements show actual usage, zero held CU and the unused amount released;
CPU renders and historical estimates have distinct labels. The shared gallery
does not disclose other invites' billing or private runtime/receipt identities.
A finished film counts once toward its film quota even while its CU hold is
unresolved. Restart and repeated observations do not charge or count it again.

An operation proven never to have attempted allocation releases its reservation
at zero. An attempted allocation followed by a clean session listing is not
proof that no transient usage occurred. An unconfirmed stop retains the hold.
CPU edits have zero CU and do not consume another paid-film slot. Existing
historical full-reservation charges (including the 15.442-CU test estimate
reported below) remain explicitly **legacy estimates**, not retroactive actual
usage measurements.

The worker accepts server-owned `spec.accountingMode: 'invite-reserved'`; the
hosted environment also selects it. Per-run admission, estimated budgets and
watchdog/wall-clock limits remain enforced. An overlapping account delta no
longer trips the media worker's or Qwen narration runner's per-run actual-spend
comparison in this mode. Qwen receives the mode and run identity from the worker;
its standalone CLI defaults to owner accounting. Qwen still refuses insufficient
or unreadable pre-allocation credit, requires execution/shutdown budget headroom,
and refuses success when teardown is unconfirmed.
Owner sequential pipelines retain their existing account-balance comparison.
The optional internal final-session receipt contract is documented in
`packages/backends/src/session-accounting.mjs`; the current Colab backend does
not produce those receipts. No guest-supplied receipt or new settlement HTTP
endpoint is accepted.

## Shared-link gallery update (2026-10-30)

Deployed from `feat/shared-invite-gallery`. The hosted systemd service is active
and enabled, with guest generation enabled following Kyle's explicit live-test
approval. The current host concurrency setting is **2** simultaneous films.
The marketing homepage remains available and the owner dashboard remains
tailnet-only at `https://<PRIVATE_ADMIN_HOST>:8456/admin/` (host shared separately).

* An invite is reusable by multiple people. Each redemption issues a separate
  guest login and records a durable visit. Everyone using that invite shares
  its CU ceiling and film limit. Exhausted links still open the gallery;
  expired or revoked links do not.
* Redeeming opens `/hosted-demo/gallery/`, with all shared completed guest
  films, including films made through the viewer's own invite. Cards show
  the generation prompt, planning model, generation models and verified
  workflow checkpoint names when available. Older records explicitly show
  missing attribution instead of inventing it. A prominent link opens Super
  Easy; Easy has a return link to the gallery. The gallery discloses that
  finished films and prompts are shared with other invite holders.
* `GET /api/demo/generations?offset=0&limit=24` lists paginated public metadata;
  `GET /api/demo/generations/:id/video` issues an expiring video ticket. Source
  packages and productions are not exposed. Source/viewer revocation or expiry
  invalidates guest playback, including subsequent range requests.
* The private dashboard shows per-link visits, last visit, CU usage, film
  counts, generation states, prompts, planning/generation model information,
  and a video player. Owner playback also works for revoked invites and uses
  separate tickets accepted only by the private listener. Signing out removes
  players and the in-memory owner credential.
* Hosted execution permits `COMFYRIZZ_INVITE_MAX_CONCURRENT` simultaneous
  pipelines (default **4**, accepted range **1–16**). Staging consumes capacity,
  duplicate active packages are refused, and every package/run has an isolated
  workspace and run-derived Colab media session name. Local production retains
  its single-run operation coordinator. Colab account/provider allocation
  limits still apply; the setting limits films, not the number of runtimes
  inside a film. Capacity-full requests are refused rather than queued.
* Whole-film guest plans are server-authored final actions covering every
  scene's media estimate (with a 3-CU minimum for cold runtime startup) and,
  when needed, the default remote Qwen narration
  allowance. This prevents one whole-film worker per scene and preserves the
  prohibition on client-authored guest action plans. Concurrent reserved films
  count toward the invite's film limit transactionally in SQLite.

### Host-configured planning

Guest builds now use the host's active provider/model profile, optionally
overridden with `COMFYRIZZ_INVITE_PLANNER_PROVIDER` and
`COMFYRIZZ_INVITE_PLANNER_MODEL`. Without a configured provider the API returns
`INVITE_PLANNER_UNAVAILABLE`. Provider credentials stay on the host; browser
provider/model choices cannot override this configuration. Every build gets a
fresh isolated staging directory and newly owned package/assets. Prompt and
planning-model attribution are stored durably outside the package schema.

The four integration-era invite failures have been resolved. No-spend HTTP
tests use an injected model-result fixture, and concurrency tests hold two
simulated workers open simultaneously. Tests cover distinct session names,
multi-scene plans, reservation/film limits, gallery metadata, private owner
playback, revocation and range requests. A local browser smoke with synthetic
MP4s checks playback, mobile layout, Easy navigation, and dashboard sign-out.

### Live validation — approved and completed October 30

The host uses OpenCode Go `deepseek-v4.1-flash`. Its key is stored only in the
host runtime's mode-0600 provider settings; it is absent from repository files
and guest requests. The provider's tool-use probe passed.

Invite Super Easy pages automatically use the host planner and Colab. They
omit API/provider and Colab setup controls and owner Studio navigation. The
guest's saved local compute choice, setup confirmation, and per-video cap do
not override the invite: planning reads the current server-reported available
credits and uses that allowance as its cap. The home shows available shared
credits, refreshes them every 15 seconds without replacing the prompt draft,
and keeps CPU work and agent edits available when the shared credits or paid
film quota are exhausted, or when the host pauses Google Colab spending.
Guests still approve the creative proposal with “Make this film”; there is no
separate connection or spending-setup step. Durable server admission checks
remain authoritative when simultaneous guests consume the shared allowance.

The automatic-setup UI was verified on the deployed desktop/mobile pages with
a temporary 7.5-CU invite (revoked afterward) and an exhausted invite. No GPU
generation was started by those checks. Typecheck, hosted build, and 91 focused
Super Easy tests passed, including overriding stale local setup and blocking
unavailable invites before planning (subsequently expanded for exhausted-invite
CPU work below).

### CPU work and agent edits after exhaustion

Exhaustion blocks new paid allocations, not planning or editing. Expired and
revoked invites remain inaccessible. Guests can keep planning and revising
proposals with the host's DeepSeek model. In the gallery, **Edit with agent**
opens an independent, viewer-owned copy of a completed film, including ready
media and verified generation receipts. The focused agent revision supports
existing scene text, proposal loglines and scene ordering; the existing
revision validator remains authoritative. Originals and other guests' projects
cannot be mutated. The finished-film **Ask the agent** action uses the same
private-copy flow and carries the guest's requested edit into it.

**Render on CPU** uses a server-authored zero-CU action through the production
outbox, forces local rendering/narration, and requires ready media. It neither
reserves invite CU nor consumes another paid-film slot. Pending generated
media and remote compute options are refused; guests may continue editing
such drafts or reuse a finished gallery film's media. Final delivery still
verifies model contribution and media provenance. CPU results appear in the
gallery and admin reporting, with their agent-edit prompt and zero-CU cost
source. Model API usage remains on the host's OpenCode Go account.

Live validation on October 30 used the already-exhausted two-film test invite:
DeepSeek edited a private copy and pipeline
`pipe_8bee6d8f207f478ca6dfafbe270f9167` completed an eight-second local CPU
render. Its runtime-allocation map was empty and its CU ceiling was zero;
the resulting MP4 served HTTP 206. The invite stayed exhausted with two paid
films, 15.442 estimated CU spent, and zero outstanding reservations. No
additional Colab allocation was made by this test. Integration coverage also
checks cross-invite edit denial, local-only admission, unchanged CU/film quota,
and access revocation.

### Hosted narration runtime prerequisite (2026-10-30)

Guest plans that use local Kokoro narration require a host Python with
`numpy` and `kokoro_onnx`, plus the Kokoro model files at
`~/.cache/comfyrizz/kokoro/kokoro-v1.0.onnx` and `voices-v1.0.bin`
(`packages/tts/scripts/fetch-models.sh` fetches them). Set
`COMFYRIZZ_PYTHON` in the service environment; otherwise preflight falls back
to system `python3` and fails before any Colab allocation. The deployed
drop-in uses:

```ini
Environment=COMFYRIZZ_PYTHON=/home/mojo/projects/comfyrizz/.venv/bin/python
```

Validate with `python -c 'import kokoro_onnx, numpy'` and by running
`packages/tts/py/synth.py` against a planned package. A preflight failure is
settled at zero CU and does not consume a film slot; retained media and the
project remain available for a retry. On October 30, run
`pipe_7b19512ff31943a196046517d96b5940` failed this preflight before allocation,
was recorded as `verified_no_allocation` at 0 CU, and left the invite active
with its full budget and film quota. The same package then passed preflight,
Kokoro synthesis, and measured timing with the pinned environment.

Two isolated browser contexts redeemed the same invite, entered the public
gallery, opened Super Easy, selected Klein-only generation, submitted distinct
eight-second silent-film prompts, and approved both proposals through the UI.
The successful runs were:

* `pipe_b258b55219974a50928e2100c91da16d`
* `pipe_567f8897beb2437fa8cf79ae48822770`

Two distinct G4 assignments were observed together from **04:04:01 through
04:08:11 UTC**, and both films were ready by **04:09:55 UTC**. Both runtimes
stopped. Public gallery playback passed. Private admin playback decoded both
eight-second MP4s and both returned HTTP 206 range responses. Prompts,
DeepSeek planning attribution, and the verified FLUX 3 Image Klein checkpoint
are shown in the dashboard. Playback and attribution persisted after restart;
admin sign-out removed the players without persisting the owner credential.

Live testing uncovered and fixed guest UI access to owner settings, duplicated
gallery links during progress updates, insufficient cold-start allowance,
pre-submission CLI kernel disconnects, unused pending draft assets blocking
export, and nested render-receipt model attribution. The CLI retry is bounded
and applies only to its explicit initial-chdir failure before script submission;
uncertain submitted work is never automatically replayed.

There were two earlier pairs of test attempts: the first hit kernel/startup
failures; the second rendered verified MP4s but failed archive completeness.
Those outcomes remain recorded. Their artifacts were preserved. Across all
test attempts, the observed account balance changed from **203.12 to 200.28 CU**
(**2.84 CU**, an account-level reading). The invite ledger charged **15.442 CU**
in conservative reservations, including failed/uncertain attempts, and had no
outstanding reservations. These values are intentionally not presented as
equivalent or as proof of a hard account-wide actual-usage cap.

Final validation: 652 server/production/backend tests and 1,659 web tests passed
(one web test skipped), plus typecheck, hosted build, and live browser checks.
The deployed nginx guest API location uses a 600-second read timeout and
unbuffered responses for long planning requests. Owner credentials and the
public token-safe logging policy remain in place.

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
**Branch:** `feat/hosted-colab-invite` in the operator's `hosted-colab-invite` worktree.
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
