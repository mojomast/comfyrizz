# Editor fixtures (Phase 0)

Committed, JSON-only packages for the editor contract tests described in
`docs/editor/PHASE0.md`. No binary media is committed: the declared asset files
do not exist in a clone, so the renderer draws its labelled placeholders, and the
schema only validates the declarations (`file`, `sha256`, `bytes`, `media`).

| Fixture | Frames @30 fps | Scenes | Used for |
|---|---|---|---|
| `short/` | 483 (16.1 s) | 3 | trim floors, a 24 fps plate, reorder and delete |
| `hermes-190s/` | 5700 (190.000 s) | 12 | target mode, fade overlaps, presenter, music ducking, chart/stat/code/split/compare |

Each directory holds:

- `package.json` — the canonical package (validated with `validatePackage`).
- `audio/durations.json` — measured narration chunks in the same shape the TTS
  pipeline writes, with `gapSeconds` and `paddingSeconds`. This is what makes the
  timing real rather than estimated.

Both fixtures are deterministic: the narration budget per chunk is derived from
the intended scene length, so the compiled timeline lands on the exact frame
counts above with no warnings and no target deviation. If you change a
`preferredFrames`, a narration text or a transition frame count, re-check the
compiled total — the frame counts in the table are asserted by
`apps/web/test/editor-phase0.test.mjs`.

Consumers must build `packages/planner` first (`pnpm --filter @comfyrizz/web test`
does it for you).
