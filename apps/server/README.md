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

## Fresh clone (clean-clone e2e, C12/M8)

A stranger's path from a fresh `git clone` to a finished video needs the workspace dependencies
first — the package scripts use `npm --prefix` but the workspace is installed with pnpm:

```bash
pnpm install                 # no lockfile is committed yet, so this resolves fresh
pnpm -r --if-present run build   # packages/* dist + apps/web dist
cd apps/server && npm start  # or: node src/index.mjs after the build above
```

`scripts/clean-clone-e2e.sh` runs that whole path non-interactively and is the M8 acceptance: it
clones HEAD into a temp dir, installs, builds, starts this server on a free port with the
**scripted** agent (no API key), sends one brief, renders the MP4, calls `POST /api/export`, checks
the five export files exist and that `ffprobe` frames equal the compiled timeline, then stops the
server and removes the temp dir. It needs no key and never starts a Google Colab runtime.

```bash
bash apps/server/scripts/clean-clone-e2e.sh   # exits 0 in a few minutes; KEEP=1 to inspect
```

The missing step for a true stranger is a committed `pnpm-lock.yaml`, which lives at the repo root
(DOLAN-owned); the script works without it using `--no-frozen-lockfile`.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | Public, host-checked: `{ok:true, service:"comfyrizz-local"}` |
| `GET` | `/api/providers` | Auth: `{providers:{openrouter,opencode-go,custom}}` booleans reporting server-key *presence* only — key values never leave the server (U1) |
| `GET` | `/api/package/:id` | `{package, revision}` |
| `PATCH` | `/api/package/:id` | `{baseRevision, package}`; mismatch → `409 {currentRevision}`; invalid → `422 {details}` |
| `POST` | `/api/agent` | C5 agent slice: `{brief, provider?, model?, sessionId?}`. Runs `runCpuSlice` (scripted offline, the live model when `provider` is set), validates and returns `{package, revision, timeline, generatedAssets, routes, pendingGpu, svgAssets, live, fallback, provider, model}` |
| `POST` | `/api/brief` | R2 plan-mode brief: `{prompt, mode?: "plan"\|"express", decisions?, askMore?, attachments?}` → `{mode, complete, brief, questions, outline?}`. No model/network: the deterministic extractor in `@comfyrizz/agent` fills the §2.3 brief, then the response carries the top ≤3 §2.4 questions (chips + a Decide-for-me default); sending `decisions` applies them and completes, and a completed response also carries the §2.2 script-first `outline` (beats + estimated seconds) |
| `POST` | `/api/brief/outline` | R2 step 4: `{brief}` → `{mode, complete: true, brief, outline}`. Completes an edited Brief card and returns a fresh script-first outline; a cleared field falls back to its preset default |
| `GET` | `/api/brief/presets` | R2 step 5: `{presets}` — the six bundled looks with their palette, font, attributes and an inline 160×90 CPU/SVG `thumbnail`. `/api/brief` and `/api/brief/outline` also carry it so the picker renders without a second round-trip |
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

### R2: plan-mode brief flow

`POST /api/brief` is the cheap first half of the agent: it fills the research §2.3 brief from the
prompt with a deterministic extractor (`packages/agent/src/brief.ts` — goal, key message, audience,
length, aspect, tone, CTA, language, must-include/avoid; it never invents facts), then asks the top
≤3 unanswered §2.4 questions. Each question carries tappable chips and a *Decide for me* default.
`mode:"express"` skips the questions and returns a completed brief. Sending `decisions` (question id
→ chip / typed answer, `undefined` = Decide for me) applies the answers and completes; `askMore:true`
keeps asking instead. The response brief is validated against the zod schema and always has exactly
three tones and a preset palette/font (Inter until the B1 brand kit overrides it).

No model, no network and no GPU: the two agent runs (extraction, narration estimate) are pure text,
so a plan round costs nothing and the flow is fully testable. `estimateNarrationSeconds` (2.5 words/s
English, 2.1 French) is the script-first outline's per-scene time budget.

### C10: export bundle

`POST /api/export` compiles the same timeline the Player shows, renders (or reuses) the final MP4,
and writes a redistribution-ready directory under `out/export/<package-id>/`. The export render is
the **final** one (A9): 1920×1080, preferring each image/video asset's `assets[<id>].variants.upscaled`
x2 file when the package declares it and falling back to the base media scaled by A8's real size.
`POST /api/render` and the Player preview keep the package's working resolution.

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

## Per-scene re-run (C11)

Each storyboard card has two actions that work on the draft the Player shows:

- **Re-render scene** (`POST /api/scene/render`) persists the draft with a base revision, then
  runs `apps/renderer/scripts/render-incremental.mjs` (A6) with a per-package segment cache under
  `<runtime>/scene-cache/<package-id>`. Only the segments whose content key changed are rendered
  again; every other scene's cached segment is reused untouched and the re-stitched MP4 still has
  the full compiled frame count. Progress is published as `scene.render.started`/`log`/`finished`
  over `/api/events`, and the response is the MP4 (`x-comfyrizz-rendered`/`-reused` say how many
  segments were rebuilt vs. reused).
- **Regenerate media** (`POST /api/scene/plan`) returns a **dry run**: a jobs plan (`planJobs`,
  B2) narrowed to that scene's own assets. It reports `dryRun: true` and `metered: false` and the
  storyboard shows it on the spend card; nothing is sent to Google Colab and no VM is started.

`apps/server/test/scene.test.mjs` is the acceptance: a one-scene re-render of the tiny renderer
fixture proves the untouched segments' cache files are not rewritten (mtime) and ffprobe frames ==
compiled timeline, and a `showcase-gpu3` plan for one scene contains only that scene's jobs.

## Agent edit → changed scenes only (C13)

`POST /api/render/edited` is the demo-beat-6 path: after an agent tool edit (or a storyboard
edit) the server diffs the new package against the **last timeline it rendered** for that
package (`apps/server/src/edit.mjs`). A scene-local change (copy, dataset, background,
foreground, referenced media, palette override) goes through the A6 incremental renderer with
the per-package cache, so only the segments whose content key changed are rendered again and
every other scene's cached segment is reused untouched. A change that moves the frame grid
(scene durations, scene order, fps, narration, caption cues) invalidates every segment's frame
range, so the endpoint falls back to a full render and reports why.

The response headers say what happened:

- `x-comfyrizz-rendered` — comma-separated ids of the scenes that re-rendered (all of them on a
  full fallback); `x-comfyrizz-rendered-count` is the count.
- `x-comfyrizz-reused` / `x-comfyrizz-reused-count` — the scenes taken from cache.
- `x-comfyrizz-full-render` (`1`/`0`) and `x-comfyrizz-full-reason` (e.g. `scene durations changed`).

The storyboard has a **Render changes** button and marks each card `re-rendered` or `reused`;
progress is published as `edit.render.started`/`log`/`finished`/`failed` over `/api/events`.
`apps/server/test/edit.test.mjs` is the acceptance: a loopback stub LLM provider builds the
package, a first render fills the cache, a second stub run applies one `storyboard.edit`
("scene 1 warmer") and only `s_title`'s segment is rewritten (other cache mtimes unchanged,
ffprobe frames == compiled timeline), while a `preferredFrames` edit forces the full-render
fallback (`x-comfyrizz-full-render: 1`, reason `scene durations changed`).

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
                  # traversal, the C5/C8 agent end-to-end renders, the C10 export-bundle e2e,
                  # C11 per-scene re-run, C13 changed-scenes-only and the R2 plan-mode brief
                  # (41 tests; real CPU render, ~2 min)
```

Real end-to-end check (2026-10-17): built web served by this server, opened with the fragment
token, edited a headline, clicked **Export MP4**. The server saved revision 2, rendered it, and
the browser downloaded a **1920×1080 H.264, 1095-frame, 36.500 s** MP4. `evil.example` Host and a
missing `Origin` were both rejected with `403`.

The shared render path is `apps/renderer/scripts/render-package-lib.mjs` (validate → A2 compile →
Remotion CPU render); C1's Vite dev route uses the same library.
