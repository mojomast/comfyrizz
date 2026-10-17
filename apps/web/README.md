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
the MP4 back. The route is bound to `127.0.0.1` and is deliberately not the C2 server: C2 adds the
token-in-fragment, strict Host/Origin checks, revision conflicts, SSE progress and cancellation.

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
