# Quality integration (PR #50 helpers)

PR #50 adds caption presentation, caption diagnostics and fingerprint-bound review
records (see [`docs/END_PRODUCT_QUALITY.md`](../../docs/END_PRODUCT_QUALITY.md)).
Those helpers existing does **not** mean this production uses them. The film is
rendered by a bespoke path (generated clips, Remotion/FFmpeg, separate audio stems),
so each check below is invoked by name and its JSON output is saved to
`evidence/` (create it locally; media and generated evidence are not committed
unless a human chooses to).

All commands are CPU-only and never start generation or touch Google Colab.
Run from the repository root; `<dir>` is `productions/action-film-20261026`.

## Thin helper

[`tools/quality-gate.mjs`](tools/quality-gate.mjs) wraps the existing helpers without
changing them:

```sh
G=productions/action-film-20261026/tools/quality-gate.mjs

node $G plan  > evidence/quality-plan.json     # beats + continuity, before generation
node $G hash take.mp4 > evidence/hashes.json   # sha256 + bytes of each take and source
node $G captions --timeline timeline.json --package package.json > evidence/captions.json
node $G final > evidence/quality-final.json    # all seven review areas, connected cut
node $G bind --quality quality.json --review quality-review.json > evidence/binding.json
```

The same plan and final checks are available as
`pnpm quality:production plan <dir>` and `pnpm quality:production final <dir>`.

Every command exits nonzero for findings or missing evidence. A missing evidence
file is reported as missing, not as a pass: with no `beats.json` yet, `plan` fails
on purpose.

## When each step is required

| Stage | Required invocation | Evidence it needs |
|---|---|---|
| Before spending setup/pilot credits | `plan` | `beats.json`, `shots.json`, `script.json`, `library.json`, `ledger.json` authored from this package (observable setup, action and result per essential beat; versioned prop ids; declared speaker) |
| After each batch is collected | `hash` | The collected media. Keep hashes and the exact selected frame ranges in the take records |
| Editing | existing take, voice, caption, cue-sheet and listening contracts | `takes.json`, `captions.json`, `cue-sheet.json`, `listening.json`, `voice-manifest.json` |
| Caption pass | `captions` | The compiled timeline and package (342px inline player defaults). Advisory; check the intended viewport |
| Before delivery | `final` | All seven areas. Run on the connected cut |
| After export | `bind` | `quality.json` from the export (carries `renderFingerprint`) and `quality-review.json` |

## Fingerprint-bound review

The export fingerprint binds the package, timeline (including selected trims),
actual asset bytes, caption inputs and composition sources. Save a completed review
as `quality-review.json` with `schema: comfyrizz.export-review/v1` and
`renderFingerprint` copied from the exported `quality.json`. `bind` reports `current`
only when they match; any change to the cut makes the review `stale_or_invalid` and
the connected cut must be reviewed again. A bound review is a local evidence record,
not authenticated approval; an empty review establishes nothing.

If the film is delivered through a path other than the normal exporter, produce
the same evidence manually: source hashes, selected ranges, the caption diagnostics
and a `final` run on the connected cut. Record which checks were skipped and why.

## What the helpers do not do

They do not direct performances, model a mechanism, verify that a wheel visibly
turns, or establish that anyone listened. Review before/action/after frames of each
contact shot, keep audible review separate, and cite the actual results.
