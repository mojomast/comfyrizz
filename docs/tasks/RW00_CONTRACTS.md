# RW00: Reference Watch contracts and file leases

Feature REF-WATCH, integration branch `feat/ref-watch` (off main `ba16d378`, PR #64). Never main, never tag.
Every RW task reads this file and imports the contracts from `@comfyrizz/schema/ref-review` (`packages/schema/src/ref-review.mjs`). It never redefines them.

## Judge
The judge is the **Pi production agent** (deepseek-v4.1-flash over OpenCode Go, with vision). Pi receives each still as an image input plus the shot prompt and the story-bible lock, and returns one `RefVerdict` JSON. There is no separate VLM backend and no Google Colab judge. Tests use a scripted fake (`reviewer: "fake"`). The cheap deterministic checks report as `reviewer: "t0"`.

## Contracts (v1)
- **RefReviewRequest** `comfyrizz.ref-review.request/v1` has these fields:
  - `productionId, runId, jobId, shotId, prompt`: non-empty strings
  - `keyframeSha256`: 64 hex characters
  - `imagePath`: a relative path, no `..`
  - `width, height, plannedWidth, plannedHeight`: positive integers
  - `attempt`: 0..2
  - `characters[]`: each has `{characterId, identityLock, wardrobeState?}`
- **RefVerdict** `comfyrizz.ref-review.verdict/v1` has `jobId, keyframeSha256, reviewer (t0|pi|fake), model?, overall (pass|fail|error), checks[], fixHints[]`.
  - Each check is `{dimension, pass, severity (hard|soft), evidence (<=400 chars), category?}`.
  - Dimensions: `technical | identity | anatomy | framing | prompt | text_artifact`. `category` may carry a WeGen-style deduction (entity, appearance, activity, counting, composition).
  - `overall: pass` with a failed hard check is invalid. `overall: fail` needs at least one failed check.
  - A malformed or unparseable judge reply becomes `overall: error`, never `pass`.
  - `fixHints` are positive end-state phrases ("five fingers clearly visible"), never negatives.
- **RefDecision** `comfyrizz.ref-review.decision/v1` has `jobId, keyframeSha256, action, reason, attempt`, plus action-specific fields: `reprompt` needs `nextPrompt` (optional `nextSeed`), `replace_ref` needs `replaceRef`, and `override` needs `receiptId`.
  - Actions: `accept | reprompt | replace_ref | escalate | override`.
- **Policy** (`REF_POLICY_DEFAULTS`, approved by Kyle 2026-10-30): `maxRegensPerStill 2`, `maxRegenJobs 6`, `maxRegenFraction 0.25`. The production regen cap is `refRegenJobCap(n) = min(6, max(2, floor(n*0.25)))` for `n > 0`, or 0 when `n <= 0`.
- **Gate states**: `pending | reviewing | accepted | regenerating | held | overridden`. `refGateOpen` returns true only for `accepted` and `overridden`, so the gate is fail-closed.
- **Events**: `ref_review_started, ref_review_verdict, ref_review_error, ref_regen_queued, ref_gate_open, ref_gate_held`. Each payload is `{type, productionId, jobId, keyframeSha256, state?, verdict?, decision?, at}`.

## File leases (one owner per file; read anything)
| Task | Owns (new unless marked) |
|---|---|
| RW00 | `packages/schema/src/ref-review.mjs`, `packages/schema/test/ref-review.test.mjs`, `packages/schema/test/fixtures/ref-review/*`, `packages/schema/package.json` (export line), this file |
| RW01 watcher | `apps/server/src/ref-watch/watcher.mjs`, `apps/server/test/ref-watch/watcher.test.mjs` |
| RW02 T0 checks | `apps/server/src/ref-watch/t0-checks.mjs`, `apps/server/test/ref-watch/t0-checks.test.mjs` |
| RW03 Pi review | `packages/agent/src/ref-review.ts`, `packages/agent/src/skills/ref-review/SKILL.md`, `packages/agent/test/ref-review.test.ts`. Registering the skill in `skills/index.ts` is a coordinator one-liner after landing. |
| RW05 decide | `apps/server/src/ref-watch/decide.mjs`, `apps/server/test/ref-watch/decide.test.mjs` |
| RW06 steer | `apps/server/src/ref-watch/steer.mjs`, `apps/server/test/ref-watch/steer.test.mjs` |
| RW07 bible lock | `apps/server/src/ref-watch/bible-lock.mjs`, `apps/server/test/ref-watch/bible-lock.test.mjs` |
| RW08 controller | `apps/server/src/ref-watch/controller.mjs` + test. Wiring in `packages/backends/src/colab-backend.mjs`, `apps/server/src/pipeline-colab-render.mjs`, `apps/server/src/app.mjs` is held for Kyle's decision. |
| RW09 events/routes | `apps/server/src/ref-watch/events.mjs`, `apps/server/src/routes/ref-review.mjs` + tests |
| RW10 UI strip | `apps/web/src/productions/ref-strip.ts`, `apps/web/src/productions/ref-strip.css`, `apps/web/test/ref-strip.test.ts` (no `main.ts`) |
| RW11 staleness | `apps/server/src/productions/keyframe-staleness.mjs`, `apps/server/test/productions/keyframe-staleness.test.mjs` |
| RW12 estimate | `apps/server/src/ref-watch/estimate.mjs` + test |
| RW13 docs | `docs/ref-watch.md` |
| RW14 calibrate | `scripts/ref-watch/calibrate.mjs`, `scripts/ref-watch/calibrate.test.mjs` |
| RW-W1 | `packages/jobs/test/ltx-lattice.test.mjs` |
| RW-W2 | `workflows/ltx25_{i2v,t2v,a2v}_2stage.api.params.json`, `packages/jobs/src/defaults.mjs`, `packages/jobs/test/ltx-stage2-sigmas.test.mjs` |
| RW-W3 | `workflows/flux3_klein_*.api.params.json`, `packages/jobs/test/klein-draft-steps.test.mjs` (RW-W3 owns `defaults.mjs` after RW-W2) |
| RW-W5 | `workflows/flux3_klein_{t2i,img2img,ref_edit,ref2_edit}.api.json`, `packages/jobs/test/klein-no-negative.test.mjs`. Workflow sha256 entries in `packages/jobs/src/model-contribution.mjs` are refreshed by the box reviewer. |
| RW-W6/W7 | `packages/agent/src/prompts/model-quality.ts`, `packages/agent/test/klein-prompt-lint.test.ts` |

## Rules for every RW task
Write tests first and show them red on the base. Use fakes only: no Google Colab, no Comfy Cloud, no paid calls in tests. Never print or store keys. Write "Google Colab", never bare. Change only your leased files, and run only your own tests plus the listed checks.
