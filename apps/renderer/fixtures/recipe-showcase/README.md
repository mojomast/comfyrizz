# Recipe showcase fixture (AI2)

Two CPU-only packages that exercise the six storytelling recipes and reveal
transitions with native landscape (`package.json`, 1920x1080) and portrait
(`package-portrait.json`, 1080x1920) layouts.

Coverage:

- `sketch`: title annotation plus list cards revealed on planner cue frames.
- `paper-cut`: layered sheets/cards on title, hero and split.
- `morph`: circle-to-blob with two speech cues.
- `technical-flow`: editable `copy.items` as Dagre nodes with packets and
  `motionCues` (explicit seconds in the fixture).
- `focus`: spotlight/frame over a local first-party SVG "screenshot"; the image
  stays visible.
- `kinetic`: phrase/headline reveals from `cue_phrases` + `cue_seconds`.
- `paper-reveal`, `draw-reveal` and `shape-reveal` at scene seams.

The only asset is `assets/evidence.svg`, authored for this fixture (CC0 in the
package manifest). No narration, GPU, network or external media is used.

Run from `apps/renderer`:

```bash
# Landscape MP4 (default)
node scripts/render-recipes.mjs

# Both aspects, half scale
node scripts/render-recipes.mjs --all --scale=0.5

# Portrait only / a still at a frame
node scripts/render-recipes.mjs --portrait
node scripts/render-recipes.mjs --still --frame=75
```

Outputs land in `out/` (gitignored). The fixture validates through the normal
`schema -> planner -> renderPackage` path, so a failure here is a real
integration failure, not a separate demo composition.

The packages deliberately include `motionCues` after compilation for the flow
and sketch list scenes. With `cue_seconds` present the planner records
`source: "explicit-seconds"`; with only `cue_phrases` it resolves measured
captions/word cues and reports unresolved phrases as diagnostics. The renderer
consumes those frames for node/card reveals, with deterministic fallback.
