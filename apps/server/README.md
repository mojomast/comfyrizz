# `apps/server` — Comfyrizz local server (C2)

Loopback-only HTTP server that serves the built `apps/web` shell and owns the package revisions,
CPU render and SSE events. It is deliberately not a public service: bind is `127.0.0.1`, the token
travels only in the URL fragment, and state-changing requests must be same-origin.

## Start

```bash
cd apps/server
npm start          # builds planner + web, then listens on 127.0.0.1:4319
```

It prints a URL like `http://127.0.0.1:4319/#token=…`. The browser strips the fragment from the
address bar and keeps the token in `sessionStorage`; it is sent as `x-comfyrizz-token` on API
requests and as `?token=` only for the SSE `EventSource` (which cannot set headers).

`COMFYRIZZ_PORT` overrides the port, `COMFYRIZZ_RUNTIME` overrides the state directory, and
`COMFYRIZZ_TOKEN` fixes the token (tests use this). The generated token is written to
`.runtime/server-token` with mode `0600`.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | Public, host-checked: `{ok:true, service:"comfyrizz-local"}` |
| `GET` | `/api/providers` | Auth: `{providers:{openrouter,opencode-go,custom}}` booleans reporting server-key *presence* only — key values never leave the server (U1) |
| `GET` | `/api/package/:id` | `{package, revision}` |
| `PATCH` | `/api/package/:id` | `{baseRevision, package}`; mismatch → `409 {currentRevision}`; invalid → `422 {details}` |
| `POST` | `/api/agent` | C5 agent slice: `{brief, provider?, model?, sessionId?}`. Runs `runCpuSlice` (scripted offline, the live model when `provider` is set), validates and returns `{package, revision, timeline, generatedAssets, routes, pendingGpu, svgAssets, live, fallback, provider, model}` |
| `POST` | `/api/render` | `{packageId, baseRevision}`, or a C1-style `{package}` draft; returns `video/mp4` |
| `POST` | `/api/export` | C10 bundle: `{packageId, baseRevision, force?}` or `{package}` draft. Renders (or reuses) the MP4 and writes `out/export/<package-id>/{video.mp4,captions.srt,captions.vtt,CREDITS.md,package.zip}`; `package.zip` ships only assets the v0.1 rights policy allows and lists every refusal with its licence reason |
| `POST` | `/api/run` | C6 backend run: `{backendId, jobs, budgetUnits, approved?, comfyuiUrl?}`. Returns the estimate + `planHash`; a Colab run without approval returns `approvalRequired:true` and starts nothing |
| `GET` | `/api/run` | C6 run status: active run, `spentEstimate`, approvals and run list |
| `POST` | `/api/run/approve` | `{planHash}`; approves exactly that plan (hardware + budget), so a changed plan needs a new card |
| `GET` | `/api/run/:id` | One run record: status, budget, estimate, lifecycle events, teardown |
| `GET` | `/api/events` | `text/event-stream`, replay from `Last-Event-ID`/`lastEventId` |

Render events: `render.started`, `render.log`, `render.finished`, `render.failed`,
`package.updated`. The route is synchronous (the HTTP response is the MP4); SSE carries the same
lifecycle for the Activity panel and for future async progress. Only one CPU render runs at a
time; a second request gets `409 render busy`.

Export events (C10): `export.started`, `export.log` (one line per render/log step), `export.finished`
(`dir`, `files`, `frames`, `captions`, `complete`, `excluded`) and `export.failed`. `POST /api/export`
is synchronous like `/api/render`; the SSE events drive the run panel's progress. Only one export
runs at a time. An export is *reused* (no re-render) when `out/export/<id>/video.mp4` already exists
and `force` is not set, so a second click is instant.

Run events (C6): `run.approval_required`, `run.approved`, `run.refused`, `run.started`,
`run.event` (one `ensure_up` / `health` / `collected` / `teardown` / `error` payload each),
`run.finished`, `run.failed`. A run is admitted only if the reserve formula allows it
(`spent + committed + next_job_upper + collect_and_stop_reserve <= budget`); BYO ComfyUI is not
metered and never asks for approval. Only one backend run runs at a time. The teardown result is
reported as `stopped` or `stop_unconfirmed`; the spend figure is always labelled an estimate.

The server takes a `backendFactory(backendId, opts)` so tests run the full lifecycle against a
fake (see `test/run.test.mjs`); the default factory lazily loads `packages/backends`.

The C5 agent runner (`src/agent-runner.mjs`) caps the live tool loop at 16 steps, normalizes the
model's scenes into the package shape, and reports `fallback: true` when a live package was not
acceptable and the deterministic plan was used instead. Live SVG markup is opt-in via
`COMFYRIZZ_LIVE_SVG=1`; by default SVG assets come from the deterministic A5 stub so a live run
stays within the client timeout.

### C8: a second provider and the edit loop

`/api/agent` accepts any of the three presets (`opencode-go`, `openrouter`, `custom`). The
`custom` preset can be pointed at a local OpenAI-compatible server without editing code:
`COMFYRIZZ_CUSTOM_BASE_URL=http://127.0.0.1:8000/v1` (the optional key stays in
`COMFYRIZZ_CUSTOM_API_KEY`). The web shell's **LLM** picker selects the provider for a brief.

`apps/server/test/c8-live-mp4.test.mjs` is the end-to-end acceptance: a brief through a second
OpenAI-compatible provider (`custom`, a loopback fake replaying the agent's calls over the real
SSE transport) builds a valid `comfyrizz.package/v1`, the M2 edit loop changes a headline and a
chart value (a stale `PATCH` gets `409`), and `/api/render` renders the edited revision to a real
H.264 1920×1080 MP4 whose `nb_frames` matches the compiled timeline. No network and no key.

`apps/web/scripts/live-brief-to-mp4.mjs` runs the same flow against a live provider and writes the
MP4 to a temp dir before ffprobe; it skips cleanly when the chosen provider has no key.

The web shell persists an edit with a base revision before rendering, so a stale `PATCH` gets a
conflict instead of silently overwriting an accepted edit. A render records the revision it used
in the response headers (`x-comfyrizz-revision`) together with the timeline hash and frame count.

### C10: export bundle

`POST /api/export` compiles the same timeline the Player shows, renders (or reuses) the final MP4,
and writes a redistribution-ready directory under `out/export/<package-id>/`:

| File | Source |
| --- | --- |
| `video.mp4` | the CPU render, or an existing file when `force` is not set |
| `captions.srt` / `captions.vtt` | `packages/tts` `captionsToSrt`/`captionsToVtt` over the player's own cues (measured narration when `audio/durations.json` is present) |
| `CREDITS.md` | `packages/sources` `buildCredits`, including a "Not redistributable" section with each refusal's licence and source URL |
| `package.zip` | `packages/sources` `buildPackageZip`: package + timeline + workflows + credits + only assets the v0.1 rights policy allows; NC/ND/SA/unknown and byte-less assets are listed in `manifest.json` with a reason |

The example seed copies `examples/launch-demo/assets` into `<runtime>/packages/assets` so the
seeded demo can render and export its SVG vectors. `apps/server/test/export.test.mjs` is the e2e
acceptance: it renders `examples/launch-demo` on the real CPU path and asserts ffprobe frames ==
compiled timeline and SRT/VTT cue counts == timeline captions, a second call reuses the MP4, and a
package with a `CC-BY-NC-4.0` asset has it refused from `package.zip` with its licence reason in
`CREDITS.md`.

## Security checks

- Host must be `127.0.0.1`, `localhost` or `[::1]` (any port) — DNS-rebinding hosts get `403`.
- API requests need the token (header, bearer or query for SSE); missing/wrong → `401`.
- `POST`/`PATCH` must carry `Origin` whose host exactly equals `Host`; otherwise `403`.
- Package ids are restricted to `[A-Za-z0-9_.-]`; static paths are resolved under `apps/web/dist`
  and traversal is rejected.
- Package writes are validated with B1's `validatePackage` and atomic-renamed.
- Package and render state live under `apps/server/.runtime/` (gitignored); no secrets in packages.

## Verify

```bash
npm test          # host/token/origin, revisions/conflict, invalid package, render + SSE, replay,
                  # traversal, the C5/C8 agent end-to-end renders and the C10 export-bundle e2e
                  # (29 tests; real CPU render, ~2 min)
```

Real end-to-end check (2026-10-17): built web served by this server, opened with the fragment
token, edited a headline, clicked **Export MP4**. The server saved revision 2, rendered it, and
the browser downloaded a **1920×1080 H.264, 1095-frame, 36.500 s** MP4. `evil.example` Host and a
missing `Origin` were both rejected with `403`.

The shared render path is `apps/renderer/scripts/render-package-lib.mjs` (validate → A2 compile →
Remotion CPU render); C1's Vite dev route uses the same library.
