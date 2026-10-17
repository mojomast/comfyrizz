# `@comfyrizz/planner` — timeline compiler

Pure TypeScript implementation of spec §6.8: one Comfyrizz package (plus measured
narration chunks, when available) compiles to one `timeline.json` that both the
Remotion Player preview and the final export consume.

```bash
npm install      # local dev deps (typescript, @types/node)
npm test         # tsc + node:test
```

## Contract

`compileTimeline(pkg, options?) -> Timeline`

- Integer frames at the package fps (30 in our examples; `fps` is respected if different).
- Scene length = `max(preferredFrames, narration frames + padding)`, clamped to the
  layout limits in `LAYOUT_LIMITS` (a readable floor and a sanity ceiling).
- Transitions **overlap**: `total = sum(scenes) − sum(overlaps)`. Six 150-frame scenes
  with five 15-frame fades compile to **825** frames. A transition that does not fit
  both neighbours throws `TimelineError` with code `transition-out-of-range`.
- `target` mode grows scenes toward `targetFrames` and reports
  `target.deviationFrames` + `target.requiresAcceptance`; it never cuts speech.
- `flexible` mode grows to fit speech, up to `MAX_FLEXIBLE_FRAMES` (2700 = 90 s).
  Past the cap it warns and adds a "shorten copy" proposal; speech is never sped up,
  clipped or silently cut.
- Narration is **provisional** until measured chunks exist; provisional timelines are
  flagged and must not be exported as final.
- Source plates at another fps (for example LTX at 24 fps) get an explicit
  `plates[]` entry with `speed`, `retimedFrames` and strategy (`retime`, `trim`, `loop`).
- Captions are sentence-level, from measured chunks when present, otherwise marked
  `estimated: true`.
- A scene's `media_only` and `lower_third` schema fields survive compilation as
  `TimelineScene.mediaOnly` / `.lowerThird`, so the renderer can draw a full-frame
  media plate with a lower third and skip the layout without a sidecar (P-fix3 N8).
  Non-media scenes carry `mediaOnly: false` and `lowerThird: null`.
- `hash` is a SHA-256 over the canonical JSON of everything except the hash itself.
  Identical input → identical hash; any package edit changes it.

## Types

`src/package-types.ts` is a provisional subset of `comfyrizz.package/v1` (task B1,
Hermes). Swap those imports for `packages/schema/types.ts` once it lands; the
compiler only needs `format`, `duration`, `scenes`, `assets`, `voice` and `narration`.

## Not in scope here

Package → `jobs.json` (FLUX/LTX job planning) lives in `packages/jobs/` (Hermes),
so the two workstreams never edit the same package.
