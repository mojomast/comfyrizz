# `apps/web` — Comfyrizz shell (C1)

Vanilla TS + Vite shell styled from Orbit's Grok Bots chat layout, with **one React island** for
the Remotion Player. The vanilla side owns a single state store (`pkg` + compiled `timeline`);
the island only receives the compiled timeline and playhead.

## What is here

- **Chat pane** — local transcript, `esc()`/`md()` subset, composer. The agent arrives in C3;
  C1 never calls a model and never sends a request to a network.
- **Preview** — `@remotion/player` mounted with the same `TimelinePlayer` composition the MP4
  renderer uses. Edit a headline, a chart value or the palette: the preview updates on the next
  frame; the storyboard marks the timeline as a draft because the browser does not re-hash.
- **Storyboard** — inline headline/sub/body fields for each scene, chart dataset values, and the
  four-swatch theme palette. Edits patch the package and the compiled timeline copy without
  changing timing; the server recompiles and re-hashes on export.
- **Activity** — local events only (load, Player ready, export start/finish/failure).
- **Assets** — generated-first assets from the package, with generator + licence chips.

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

The composer now posts the brief to `POST /api/agent` on the C2 server. The server runs
`packages/agent` (`runCpuSlice`) with a scripted model when no provider is set, or the live
OpenCode Go model when `{ provider: 'opencode-go' }` is passed. The router sends icons, diagrams,
patterns and vector-anim needs to `assets.generate_svg` (A5 stub offline, the model live) and
leaves FLUX/LTX needs as `status: 'pending'` with a procedural fallback, so nothing GPU-bound is
submitted. The returned package validates against `comfyrizz.package/v1`, the server compiles the
timeline and returns `{ package, timeline, generatedAssets, routes, pendingGpu }`; the shell swaps
it into the Player and the storyboard. **Export MP4** then renders that package on CPU.

The agent runner lives in `apps/server/src/agent-runner.mjs`. If a live model stalls, stops early
or invents fields the v1 schema rejects, the runner falls back to the deterministic plan (still
using the live SVG generator) and validates before returning.

### Live OpenCode Go check

`apps/web/scripts/live-agent.mjs` posts one brief with `provider: 'opencode-go'` and prints the
package id, provider/model, SVG asset count and timeline length. It exits `0` with a `skip:` line
when `OPENCODE_GO_API_KEY`/`OPENCODE_API_KEY` is unset, so it never makes a network call without a
key, and it reads the server token from `apps/server/.runtime/server-token` (never printed).

```bash
COMFYRIZZ_PORT=4320 node apps/server/src/index.mjs &   # or npm start in apps/server
node apps/web/scripts/live-agent.mjs
```

**Known limitation (2026-10-17):** the live DeepSeek/OpenCode Go path was not yet green — a run
ended with `agent did not produce a package draft` while the offline scripted run and the stub
e2e (valid package + ffprobe-checked MP4) both pass. The runner keeps the deterministic fallback
so the slice still completes; the live-model tool loop is the open item.

## M2 evidence (2026-10-17)

Real headless Chrome against `http://127.0.0.1:4174/`:

1. Changed `s_title.headline` to `Edited headline C1` → Player text updated.
2. Changed the first chart value to `99` → sought to the chart scene → `99` rendered.
3. Changed palette slot 2 to `#ff0000` → chart bar `fill="#ff0000"`.
4. Clicked **Export MP4** → downloaded `comfyrizz-export.mp4`:
   **1920×1080 H.264, 1095 frames, 36.500 s, 2,796,657 bytes**.

The export path really recompiles from the edited package; it is not a pre-rendered clip.

## Notes

- `public/fonts/Inter-Variable.ttf` is the same OFL-licensed Inter file as the renderer. The comma
  in the upstream filename was dropped because Vite serves `%2C` as a SPA fallback (invalid font).
- Vite dedupes `remotion`/`react` so the renderer source and the Player share one Remotion context.
- `packages/planner` must be built (the `dev`/`build` scripts do it) because the dev export route
  imports its compiled `dist`.
