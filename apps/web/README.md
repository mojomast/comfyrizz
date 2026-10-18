# `apps/web` — Comfyrizz shell

Vanilla TS + Vite shell styled from Orbit's Grok Bots chat layout, with **one React island** for
the Remotion Player. The vanilla side owns a single state store (`pkg` + compiled `timeline`);
the island only receives the compiled timeline and playhead.

## What is here

- **Chat pane** — local transcript, `esc()`/`md()` subset, composer with a **Plan/Express** toggle. Submitting a brief posts to `POST /api/agent` on the server, which runs the local or live model and returns the compiled package; the browser never holds a provider key. A streaming bubble shows while the request is in flight, and server `agent.*` SSE events are mirrored into Activity.
- **Preview** — `@remotion/player` mounted with the same `TimelinePlayer` composition the MP4
  renderer uses. Edit a headline, a chart value or the palette: the preview updates on the next
  frame; the storyboard marks the timeline as a draft because the browser does not re-hash.
- **Storyboard** — inline headline/sub/body fields for each scene, chart dataset values, and the
  four-swatch theme palette. Edits patch the package and the compiled timeline copy without
  changing timing; the server recompiles and re-hashes on export. Clicking a scene card (outside its
  fields) seeks the Player to that scene and marks it active, and empty Sub/body fields explain
  themselves with placeholders.
- **Activity** — local events plus server events (agent start/step/finish/fail, run lifecycle).
- **Assets** — generated-first assets from the package, with generator + licence chips. Assets whose
  generator is GPU-bound (`flux3-klein`, `ltx25`) stay `pending`, and are carded in the **GPU queue**
  pane with their procedural fallback preview and a `pending spend` chip.

## Run

```bash
cd apps/web
npm install --no-package-lock
npm run dev          # builds packages/planner, serves 127.0.0.1:4174
npm run typecheck
npm run build
```

`npm run dev` exposes a **dev-only** `POST /api/render` route. It validates the edited package,
compiles it with A2, passes `{pkg, timeline}` to Remotion as `--props`, renders on CPU, and streams
the MP4 back. The route is bound to `127.0.0.1` and is deliberately not the C2 server.

For the C2 server (`apps/server`), run `npm start` there after `npm run build`. It serves this
build, reads the token from the URL fragment into `sessionStorage`, strips the fragment, and sends
the token on API calls. Export then PATCHes the package with `baseRevision`, renders the accepted
revision, and listens to `/api/events` for Activity entries. C2 also adds strict Host/Origin checks.

## C5 agent slice (chat brief → package → Player → MP4)

The composer now posts the brief to `POST /api/agent` on the C2 server. The top-bar **LLM**
picker chooses the provider: `local · scripted model` (offline), `opencode-go`, `custom`
(OpenAI-compatible) or `openrouter`. The server runs `packages/agent` (`runCpuSlice`) with a
scripted model when no provider is set, or the selected live model otherwise. `GET /api/providers`
(authenticated, booleans only) labels each option `configured` / `no key` and prints which server
keys are present in the header — the key values never reach the page. The router sends icons,
diagrams,
patterns and vector-anim needs to `assets.generate_svg` (A5 stub offline, the model live) and
leaves FLUX/LTX needs as `status: 'pending'` with a procedural fallback, so nothing GPU-bound is
submitted. The returned package validates against `comfyrizz.package/v1`, the server compiles the
timeline and returns `{ package, timeline, generatedAssets, routes, pendingGpu }`; the shell swaps
it into the Player and the storyboard. **Export MP4** then renders that package on CPU.

The agent runner lives in `apps/server/src/agent-runner.mjs`. It passes `maxSteps: 16` so a live
model cannot stream tool calls indefinitely. If a live model stalls, stops early or invents fields
the v1 schema rejects, the runner falls back to the deterministic plan (still using the live SVG
generator) and validates before returning; the response reports `fallback: true` when that happens.

`storyboard.propose`/`storyboard.edit` normalize each model-authored scene into the published
package shape: `role`/`title` scenes get a real `layout`, a string `copy` becomes `{ headline }`,
copy is clamped to the layout limits, `stat`/`chart` scenes without a known dataset are downgraded,
variant/background values are checked, unknown keys are dropped, and a missing `preferredFrames`
falls back to a readable per-layout length. The live model sends this shape, which is why the loop
now lands a valid package instead of tripping the schema.

### Live OpenCode Go check

`apps/web/scripts/live-agent.mjs` posts one brief with `provider: 'opencode-go'` and prints the
package id, provider/model, `live`/`fallback`, SVG asset count and timeline length. It exits `0`
with a `skip:` line when `OPENCODE_GO_API_KEY`/`OPENCODE_API_KEY` is unset, so it never makes a
network call without a key, and it reads the server token from `apps/server/.runtime/server-token`
(never printed).

```bash
COMFYRIZZ_PORT=4320 node apps/server/src/index.mjs &   # or npm start in apps/server
node apps/web/scripts/live-agent.mjs
```

### Live brief → edit → MP4 check (C8)

`apps/web/scripts/live-brief-to-mp4.mjs` runs the full C8 loop against a running server: a live
brief builds the package, the M2 edit loop changes a headline and the first chart value with a
base revision, and `/api/render` exports the edited revision to an MP4 on disk, which `ffprobe`
reports. Pick the provider with `COMFYRIZZ_PROVIDER` (`opencode-go`, `openrouter` or `custom`); it
skips cleanly when the chosen provider has no key. For a local OpenAI-compatible endpoint, also
set `COMFYRIZZ_CUSTOM_BASE_URL` on the server process.

```bash
COMFYRIZZ_PROVIDER=opencode-go node apps/web/scripts/live-brief-to-mp4.mjs
```

**Verified (2026-10-17):** one live DeepSeek v4.1 run through `/api/agent` returned a model-built
package with `live=true fallback=false`, 7 SVG assets, 1 pending-GPU still and a 900-frame timeline
in ~37 s. A reproducible offline transcript (`apps/server/test/live-loop.test.mjs`) replays
DeepSeek's stream shape (reasoning deltas, fragmented tool-call names/arguments, a malformed call,
a text-only turn) and asserts the loop yields a valid `comfyrizz.package/v1`.

Live SVG *markup* is opt-in via `COMFYRIZZ_LIVE_SVG=1`. By default the SVG assets come from the
deterministic A5 stub even on a live run: each live SVG is a full reasoning stream (~60 s each),
which pushed one live run past the client's 300 s headers timeout. The live model still builds the
package draft (the C5-live goal); `COMFYRIZZ_LIVE_SVG=1` restores model-written markup.

## R2 plan mode (brief before building)

The composer has a **Plan / Express** toggle. **Plan** sends the prompt to `POST /api/brief` first:
the server runs the deterministic extractor in `packages/agent` (no model, no spend) and returns a
draft brief plus the top **≤3** research-§2.4 questions, each with tappable chips and a **Decide for
me** default. The `#brief-panel` renders those chips above the textarea; nothing is built until
**Looks right**, which posts the chosen answers back. **Express** skips the questions and builds the
raw prompt immediately. Plan mode falls back to a direct build if `/api/brief` is unavailable.

Evidence (headless Chrome 1440×900, `docs/ui/r2-plan-mode.png`): one brief produced two questions
(`look` + `data`) with their chips; clicking a chip per question and **Looks right** then showed the
Brief card. Express built directly with no panel. No model, network or GPU is used to plan.

### Step 4: the editable Brief card + script-first outline

After the chips, `#brief-panel` shows the **Brief card** (`docs/ui/r2-brief-card.png`): editable
`key_message`, `audience.who`, `length_s`, `cta`, `aspect`, `style.preset` and `voice.persona`, above
the script-first outline from `buildOutline` (hook/point/proof/CTA beats with a headline, narration
line and estimated spoken seconds) and a summary line (`≈ s on screen · target s · fit`). **Update
outline** posts the edited brief to `POST /api/brief/outline` and re-renders; **Build video**
serialises the card through `briefToPrompt` into the normal `/api/agent` build and hides the panel.

Evidence: the step-4 probe drove one brief through Plan → chips → card (7 fields, 4 beats, target
45 s / `short`), edited the key message and length (target 12 s / `long`, new headline + narration),
refreshed the outline, then built (`timeline 00:36`) and the panel hid. No model, network or GPU.

## C6 backend run (spend card + run panel)

The top bar's **Backend** picker now offers `BYO ComfyUI` and `Google Colab G4` alongside `CPU`.
**Run on backend** posts the current package's scenes as jobs to `POST /api/run`. A Google Colab
run returns `approvalRequired` with the estimate (GPU minutes, setup, `required` vs `budget`
units) and starts nothing; the shell renders that as a **spend card** in the Preview pane with
**Start** / **Cancel**. Start re-posts the same plan with `approved: true`. BYO ComfyUI is not
metered and runs straight away.

The Activity pane gained a **Run** panel driven entirely by `/api/events`: `ensure_up`, `health`,
per-job, `collected` and `teardown` rows, with the terminal status (`done` / `stop_unconfirmed` /
`failed`) in the chip. The top-bar spend meter shows the server's `spentEstimate` after each run.
The teardown line is the honest stop result, and every spend figure is labelled an estimate.

C6 ships against fakes only: `apps/server/test/run.test.mjs` drives the full lifecycle through a
fake backend, and a real headless-Chrome check (fake backend injected into `createApp`) confirmed
the card → Start → `done` flow with the lifecycle rows and the spend meter at `4.29 GPU units
(est.)`. No Google Colab runtime and no ComfyUI URL are contacted.

## C10 export bundle

The Run panel gained an **Export bundle** button next to the backend run. It persists the draft
with a base revision, then posts `POST /api/export`; progress is read from the existing
`/api/events` SSE stream (`export.started` / `export.log` / `export.finished` / `export.failed`).
When the bundle is done the panel lists the five files (`video.mp4`, `captions.srt`,
`captions.vtt`, `CREDITS.md`, `package.zip`) with sizes, and any asset the v0.1 rights policy
refused is shown with its licence id and reason. The bundle lands in
`apps/server/.runtime/out/export/<package-id>/`. **Export MP4** stays as the single-file download.

## M2 evidence (2026-10-17)

Real headless Chrome against `http://127.0.0.1:4174/`:

1. Changed `s_title.headline` to `Edited headline C1` → Player text updated.
2. Changed the first chart value to `99` → sought to the chart scene → `99` rendered.
3. Changed palette slot 2 to `#ff0000` → chart bar `fill="#ff0000"`.
4. Clicked **Export MP4** → downloaded `comfyrizz-export.mp4`:
   **1920×1080 H.264, 1095 frames, 36.500 s, 2,796,657 bytes**.

The export path really recompiles from the edited package; it is not a pre-rendered clip.

## Notes

- **U1 UI polish** — before/after screenshots live in `docs/ui/`. The pass wired the composer to the
  live agent, replaced the stale C1/C3 copy, raised layout text above foreground media panels and
  switched scene transitions from a cross-fade to a push (renderer), added streaming/empty states
  and click-to-seek scene selection, and carded GPU-pending assets with fallback previews.
- `public/fonts/Inter-Variable.ttf` is the same OFL-licensed Inter file as the renderer. The comma
  in the upstream filename was dropped because Vite serves `%2C` as a SPA fallback (invalid font).
- Vite dedupes `remotion`/`react` so the renderer source and the Player share one Remotion context.
- `packages/planner` must be built (the `dev`/`build` scripts do it) because the dev export route
  imports its compiled `dist`.
