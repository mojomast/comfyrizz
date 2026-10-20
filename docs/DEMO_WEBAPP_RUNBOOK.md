# Demo web app runbook

How to run the two-minute interactive demo (`apps/web/demo.html`), what each region shows, and the
seven-beat script from [SPEC.md §11](SPEC.md) mapped one-to-one onto UI actions. Feature spec:
[docs/specs/DEMO_WEBAPP.md](specs/DEMO_WEBAPP.md). Demo code lives in `apps/web/src/demo/` (pure
`.mjs` modules + the `demo.html` shell); see also [apps/web/README.md](../apps/web/README.md).

Prerequisites: Node >= 20 and the workspace dependencies installed (same as the rest of the repo —
see the **Run** block in `apps/web/README.md`).

## TL;DR

```bash
# Fixture mode — no server, no token, no GPU, no network (deterministic)
cd apps/web && npm run dev        # then open http://127.0.0.1:4174/demo.html?fixture=1

# Live mode — real local server + SSE
cd apps/server && npm start       # prints http://127.0.0.1:4319/#token=<token>
# then open http://127.0.0.1:4319/demo.html#token=<same token>
```

## 1. Fixture mode (recommended first run)

Fixture mode (`?fixture=1`) swaps the API client and the SSE stream for a deterministic offline
backend (`src/demo/fixture.mjs`): no server process, no session token, no GPU and no network. It is
the mode to rehearse and present from unless you specifically want live model/server behaviour.

```bash
cd apps/web
npm run dev                      # builds packages/planner, serves 127.0.0.1:4174
```

Open **http://127.0.0.1:4174/demo.html?fixture=1** (the header also has a **Try fixture mode**
link). What you should see:

- header pill `fixture · offline`, events pill `fixture replay`
- chat model badge `fixture-canned - any OpenAI-compatible model works`, with a seeded brief and
  storyboard reply
- storyboard with the 6 launch-demo scene chips, all `ready`
- licence chips seeded from `examples/licensing-demo`: one ok **CC BY 4.0 — Marta Rivera** chip and
  one blocked **CC BY-NC 4.0** chip with its refusal reason
- Spend card (Google Colab G4, 3 jobs, every figure labelled **estimate**) and a completed Activity
  run replayed from the canned event stream: VM up → health → jobs → collected → VM stopped
  (verified)
- the Remotion preview player playing the finished launch timeline from
  `examples/launch-demo/timeline.json`

Fixture mode also works from the built output: `npm run build` then `npm run preview` and open
**http://127.0.0.1:4173/demo.html?fixture=1**, or from the live server at
**http://127.0.0.1:4319/demo.html?fixture=1** (still no token needed).

## 2. Live mode (real server + demo page)

Live mode talks to the local C2 server (`apps/server`): authenticated JSON API with the
`x-comfyrizz-token` header and live progress over SSE `GET /api/events`.

```bash
cd apps/server
npm start                        # builds packages + apps/web, serves 127.0.0.1:4319
```

`npm start` builds every package, builds the web app (which emits `dist/demo.html` alongside
`dist/index.html`), seeds `examples/launch-demo` and prints:

```
Comfyrizz local server
  open   http://127.0.0.1:4319/#token=<token>
  token  apps/server/.runtime/server-token (0600)
```

Open the demo page with the **same token** in the URL fragment (the page stores it in
`sessionStorage` and strips it from the URL, exactly like the main shell):

```
http://127.0.0.1:4319/demo.html#token=<token>
```

The token also lives in `apps/server/.runtime/server-token` (mode 0600). Never put the token in a
query string, a log or a screenshot; never open the page from a non-loopback host (the server
enforces Host/Origin and answers 403 otherwise). Port override: `COMFYRIZZ_PORT` (default `4319`).

In live mode the header shows `live server`, the events pill goes `events connecting` →
`events live` once SSE is up, and the model badge reads `local scripted model - any OpenAI-compatible
model works`.

## 3. Page map

Six regions (`demo.html`), all driven from one store; every rendered string is HTML-escaped:

| Region | id | What it does |
| --- | --- | --- |
| Chat | `#chat` | Composer (Enter sends, Shift+Enter newline) -> `POST /api/agent`; model badge; assistant replies |
| Preview | `#preview` | Remotion player for the current timeline + the instant chart edit form (`#demo-instant-edit`) |
| Storyboard | `#storyboard` | One chip per scene with a status badge (`ready`/`stale`/`rerendering`/`failed`) and a **Re-run** button; Left/Right arrows move the selection |
| Licence chips | `#licences` | Per-asset licence receipts: `ok` (CC0/PDM/approved CC BY), warn, or `blocked` with the reason; hover a chip for the full detail, links go to the source |
| Spend | `#spend` | Estimate vs budget for the chosen backend; every number labelled **estimate** |
| Activity | `#activity` | Phase stepper VM up → health → jobs → collected → VM stopped (verified) plus a **sped up** label slot, fed by SSE (live) or the canned stream (fixture) |

Header: mode pill, events pill, **Try fixture mode** link. Footer (beat 7): repo, workflows,
credits and hook-credits links, MIT notice.

## 4. The 7-beat demo script (SPEC §11) -> UI actions

Timecodes are the SPEC §11 outline (total <= 2:00). Beat 5 is narration only — the spec's demo
table has no page action for it.

| Beat | §11 time | UI action on the demo page | Expected result |
| --- | --- | --- | --- |
| 1 Hook | 0:00-0:10 | Press play on the **Preview** player (`#demo-preview-player`) | The finished launch video plays from 0:00 — this is the rendered result, not a work-in-progress |
| 2 Brief | 0:10-0:30 | Type the brief in **Chat** (`#chat`) and press Enter. Then in **Preview** set Scene = `s_chart`, Chart point = `0`, pick a new **Value**, click **Update chart** | The model badge says "any OpenAI-compatible model works"; a 6-chip storyboard appears; the status line reads `Updated s_chart in memory — preview patched, no render queued.`, the `s_chart` chip goes `stale`, and the preview seeks and updates on the next frame — no GPU, no server render |
| 3 Assets with receipts | 0:30-0:50 | Point at the **Licence chips** region (`#licences`); hover a chip to show its full receipt | One `ok` chip: approved **CC BY 4.0 — Marta Rivera** with attribution and source link; one `blocked` chip: **CC BY-NC 4.0** with "non-commercial licence is outside the v0.1 policy"; generated assets show as generated (CC0) |
| 4 Compute | 0:50-1:10 | Point at the **Spend** card, then walk the **Activity** phase stepper. Mention "or point it at your own ComfyUI" | Spend card shows Google Colab G4, job count, estimated units/time, budget ceiling and remaining — every figure labelled **estimate**. Activity reaches `VM stopped (verified)` through VM up → health → jobs (with the **sped up** label) → collected; BYO ComfyUI renders as "no spend" |
| 5 How it's built | 1:10-1:30 | None — narration only. Hold on the storyboard/preview | Every GPU job is a ComfyUI workflow run with the Comfy SDK; LTX-2.5 makes the moving plates, FLUX 3 Klein the stills; text and charts are exact through Remotion; open weights; no tunnel on Google Colab |
| 6 Iterate | 1:30-1:45 | Say "make scene 3 warmer", then click **Re-run** on the third scene chip (`s_stat`) | Only the `s_stat` chip flips `ready` → `rerendering` → `ready`; every other chip is untouched. A second re-run of the same scene while one is in flight is refused. (In fixture mode the badge is held visible for ~0.6 s on purpose.) |
| 7 Open source | 1:45-2:00 | Point at the footer links: **repo**, **workflows**, **credits**, **hook credits** | MIT repo, workflows folder and CREDITS on screen. The portable `package.zip` comes from the live server's existing `POST /api/export` (the **Export bundle** flow in the main shell — see "C10 export bundle" in `apps/web/README.md`). Close on "open the example with zero setup": that is exactly the `?fixture=1` URL from section 1 |

Rehearsal tip: run the whole script twice against `?fixture=1` (deterministic, zero setup), then
once live from section 2 if you want the real agent and SSE stream on stage.

## 5. Tests and checks

```bash
cd apps/web
npm test                          # node:test over test/*.test.mjs (includes all demo-*.test.mjs)
npm run typecheck                 # tsc --noEmit, covers preview-mount.tsx
npm run build                     # vite build must emit dist/demo.html
npm run test:e2e                  # Playwright suite (own harness, CPU only); the demo spec lands with T14
```

Demo modules are import-safe in node: pure `.mjs` with no DOM globals at import time (mount
functions take a root element), and every demo test injects fakes for `fetch`/`EventSource` so the
suite needs no network or server.

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Live demo page shows `demo failed: ...` or API calls 401 | The page has no valid token. Open the exact `http://127.0.0.1:4319/demo.html#token=<token>` URL printed by `npm start` (or copy it from `apps/server/.runtime/server-token`). The page stores it in sessionStorage and strips the fragment, so a plain reload keeps working |
| Server answers 403 `host not allowed` / `origin not allowed` | Open the page from `127.0.0.1` only. The C2 server enforces Host/Origin; remote hosts and mismatched origins are rejected by design |
| Server answers 503 `web build missing` (or `/demo.html` 404s) | The web build is missing or stale. Run `cd apps/web && npm run build` (or restart `apps/server` `npm start`, which builds it for you). `dist/demo.html` must exist |
| Events pill stuck on `events retrying` / `events offline` (live) | The SSE stream cannot reach `/api/events` — check the server is still running and reload. Fixture mode intentionally shows `events fixture replay` instead and needs no server |
| **Update chart** shows an error under the form | Value must be numeric and the scene must exist; unknown scenes and bad input are rejected with a message and nothing is mutated |
| Preview shows `Preview unavailable: ...` | The Remotion island failed to load — run `npm run dev` or `npm run build` from `apps/web` (both build `packages/planner` first) and reload |
| **Re-run** seems dead | A second re-run of a scene that is already `rerendering` is refused until the first finishes; wait for the badge to leave `rerendering` |
| Licence chips look empty in live mode | The licence region mirrors the current package. Fixture mode always seeds `examples/licensing-demo`; live mode fills it from the package the agent built |
| Playwright e2e fails to start its browser/server | `npm run test:e2e` boots its own loopback harness (`e2e/serve.mjs`) on ports 4175/4391; nothing else may be bound there, and the repo's Playwright browsers must be installed |

## 7. Boundaries

- The demo page is additive: it uses the existing APIs only. Do not edit `apps/server/**`,
  `apps/web/src/main.ts`, `packages/backends/**`, `colab/**`, HyperFrames compositions, or any
  renderer/GPU code to make the demo work — record a missing API as an issue instead.
- No new dependencies; keep rendered strings escaped and pure modules free of DOM globals at import
  time.
- No network in tests: inject `fetch`/`EventSource` fakes.
