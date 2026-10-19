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
- Preferred pacing is clamped to `LAYOUT_LIMITS` (a readable floor and a visual
  ceiling). Measured narration plus padding raises that ceiling when necessary:
  a long take in a stat or title scene is never truncated to the layout default.
- Transitions **overlap**: `total = sum(scenes) − sum(overlaps)`. Six 150-frame scenes
  with five 15-frame fades compile to **825** frames. A transition that does not fit
  both neighbours throws `TimelineError` with code `transition-out-of-range`.
- `target` mode grows scenes toward `targetFrames` and reports
  `target.deviationFrames` + `target.requiresAcceptance`; it never cuts speech.
- `flexible` mode grows to fit speech. `MAX_FLEXIBLE_FRAMES` (2700 = 90 s at
  30 fps) is an advisory threshold, not an export limit. Past it, the compiler
  warns and adds a "shorten copy" proposal; longer explainers still compile with
  all measured speech intact.
- Narration is **provisional** until measured chunks exist; provisional timelines are
  flagged and must not be exported as final.
- Source plates at another fps (for example LTX at 24 fps) get an explicit
  `plates[]` entry with `speed`, `retimedFrames` and strategy (`retime`, `trim`, `loop`).
- Captions are sentence-level, from measured chunks when present, otherwise marked
  `estimated: true`.
- K1: when a measured chunk carries `words[]`, each caption cue also carries
  `words: [{text, from, to}]` in absolute frames, clamped inside the cue so
  karaoke stays monotonic. A chunk with no words produces no `cue.words`, so the
  default sentence output is unchanged.
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
