# Reference watch

Reference watch reviews each generated reference still before the LTX video stage. A still is the keyframe a video job starts from, so a bad still becomes a bad clip. The watcher checks the still first, and the video job stays held until the still is either accepted or overridden.

This document describes the code in `apps/server/src/ref-watch/`, the contracts in `packages/schema/src/ref-review.mjs`, the Pi review skill in `packages/agent/src/skills/ref-review/SKILL.md`, and the offline calibration script in `scripts/ref-watch/calibrate.mjs`.

## What reference watch does

The flow is:

1. Stills render first.
2. Each still that a video job consumes as a keyframe is reviewed.
3. The verdict becomes a decision: accept, re-prompt and regenerate, replace the reference, or escalate.
4. Regeneration is capped and estimated before it runs.
5. The LTX video job is released only when every keyframe it uses is in an open gate state.

The gate is fail-closed. `refGateOpen(state)` returns true only for `accepted` and `overridden`. Every other gate state (`pending`, `reviewing`, `regenerating`, `held`) holds the video job. If the review request is invalid, the cheap checks fail, the judge errors, the reply is unusable, the estimate is blocked, the budget ledger refuses the reservation, or the keyframe becomes stale, the still is held and the video is not submitted.

### The review layers

The controller starts with deterministic T0 checks (`runT0Checks`, reviewer `t0`):

- dimensions must match the planned dimensions;
- aspect must be within 1% of the planned aspect;
- pixel standard deviation must be at least 4, which rules out a blank or flat still;
- if an identity scorer is injected, its cosine score must meet its threshold.

A hard T0 failure decides immediately and the Pi judge is not called. Otherwise the still goes to the Pi production agent, which is the judge: `deepseek-v4.1-flash` with vision. There is no separate VLM backend and no Google Colab judge. The agent receives the still as an image, the shot prompt, and every character identity lock with its wardrobe state, and returns one `RefVerdict`.

The verdict dimensions are `technical`, `identity`, `anatomy`, `framing`, `prompt`, and `text_artifact`. Each check has a `pass` boolean, a `severity` of `hard` or `soft`, and evidence of at most 400 characters. `fixHints` are positive end-state phrases such as "five fingers clearly visible".

A malformed or unparseable Pi reply is repaired once. If the second reply is still invalid, the verdict becomes `overall: "error"`, never `pass`. An error never opens the gate.

### The decision

`decide` turns a verdict into a `RefDecision`:

- `overall: "pass"` is accepted, even when soft checks failed.
- `overall: "fail"` with only soft failures is also accepted.
- `overall: "fail"` with hard failures is re-prompted while both the per-still and production caps are open.
- An identity hard failure that has happened twice becomes `replace_ref`.
- Any other hard failure, a judge error, or cap exhaustion becomes `escalate`.
- `override` is also a valid action, described under Overrides.

A re-prompt uses `steerPrompt` to build an end-state caption from the prior prompt, the passing checks, the fix hints, and the identity and wardrobe locks. `chooseReplacementRef` picks the newest accepted still whose identity check passed, then falls back to the primary reference. A decision that cannot be filled with real values is escalated rather than submitted.

## How to turn it on

Reference watch is off by default. The run option is `opts.refWatch`:

- `opts.refWatch` unset or false: no watcher and no gate.
- `opts.refWatch: true`: the gate is enabled, but no reviewer, budget ledger, or other hooks are supplied. Every review therefore fails closed.
- `opts.refWatch: { ... }`: the gate is enabled and the object supplies the injected pieces.

The option is wired through `buildRefWatch` in `apps/server/src/app.mjs` and passed to the Google Colab backend. The backend supplies `jobsDoc`, `onEvent`, `submitJobs`, and `receiptsDir`. The `opts.refWatch` object can supply:

| Option | Purpose |
| --- | --- |
| `reviewer` | Required for a real review. Called as `reviewer({ request, image })` and must return a `RefVerdict`. This is where the Pi agent call goes. |
| `t0` | Replaces `runT0Checks`. |
| `decide` | Replaces `decide`. |
| `steer` | Replaces the steering module (`steerPrompt`, `fillDecision`, `chooseReplacementRef`). |
| `estimate` | Replaces `estimateRegen`. |
| `budgetLedger` | Shared spend ledger with `status()` and `reserve()`. A regeneration cannot proceed without it. |
| `policy` | Overrides `REF_POLICY_DEFAULTS`. |
| `iteration` | Inputs for the iteration estimate. |
| `now` | Clock used on events. |
| `reviewTimeoutMs` | Judge timeout, default 60000 ms. |
| `measure` | Returns measured still dimensions and pixel statistics, and optionally an identity scorer input. |
| `currentKeyframeSha` | Function or map used to detect stale keyframes. |

Tests use a scripted fake reviewer with `reviewer: "fake"`; no network, no paid calls, and no Google Colab are needed.

The controller is also created directly with `createRefWatchController`. It returns `start`, `handle`, `stop`, `filterBatch`, `beforeRender`, and `snapshot`. `snapshot` reports `regenJobsUsed`, `cap`, and the per-still `states`. `beforeRender` refuses the Google Colab video render with `REF_GATE_HELD` while any still is `pending`, `reviewing`, or `regenerating`.

## Caps and the regeneration estimate

The caps come from `REF_POLICY_DEFAULTS`:

- `maxRegensPerStill: 2` — a still can be regenerated at most twice after its first render. The request `attempt` is therefore 0, 1, or 2.
- `maxRegenJobs: 6`.
- `maxRegenFraction: 0.25`.

The production-wide cap is `refRegenJobCap(n)`, where `n` is the number of stills:

```
refRegenJobCap(n) = min(6, max(2, floor(0.25 * n)))   for n > 0
refRegenJobCap(0) = 0
```

So 1 to 11 stills allow 2 regenerations, 12 allow 3, 16 allow 4, and 24 or more allow the maximum of 6. Both the per-still cap and the production cap must be open; if either is exhausted the decision escalates and the gate stays held. The reason says which cap is exhausted.

Every regeneration is preceded by an estimate. `estimateRegen` runs only for `reprompt` and `replace_ref` decisions and returns:

- `label` — the iteration estimate labels joined with `; `;
- `units` — the estimated units;
- `blocked` — true when a cap is exhausted;
- `reason` — for example `within regen caps`, `per-still regen cap exhausted`, `production regen cap exhausted`, or `per-still and production regen caps exhausted`;
- `money` — present only when the iteration estimate returns a money value.

The estimate is shown in the `ref_regen_estimate` event and is never treated as approval. Before submitting a regeneration the controller reserves the estimated upper bound in `budgetLedger`, using the same ledger that self-repair spends from. If the ledger is absent, the reservation is refused, or the upper bound does not fit the remaining cap, the decision escalates with the reason `regen estimate exceeds the budget ledger cap` or `budget ledger refused the regen reservation`.

A regeneration gets a fresh seed, a new cache key, and `refRegen = { attempt, seed }` so the Google Colab runner cannot replay the rejected still from its cache. A `replace_ref` decision also replaces the reference path in `params.reference`, `params.refs`, and the matching file inputs.

## Events emitted

The contract event list is `REF_EVENTS`:

- `ref_review_started`
- `ref_review_verdict`
- `ref_review_error`
- `ref_regen_queued`
- `ref_gate_open`
- `ref_gate_held`

The controller also emits `ref_regen_estimate` for the estimate. It is emitted by the controller and covered by the controller tests, but it is not one of the six names in `REF_EVENTS`.

| Event | When it is emitted | Extra payload |
| --- | --- | --- |
| `ref_review_started` | The watcher sees a new still preview whose image is consumed by a video job. Duplicates for the same job and keyframe sha are ignored. | `state: "reviewing"` |
| `ref_review_verdict` | A verdict and decision are recorded, whether the still is held, regenerating, accepted, or overridden. | `verdict`, `decision`, `state` |
| `ref_review_error` | The request is invalid, T0 throws or returns an invalid verdict, the reviewer times out or fails, or the judge returns an unusable verdict. | `decision` with action `escalate`, `state: "held"` |
| `ref_regen_estimate` | A reprompt or replace decision has an estimate, before the regeneration is submitted or the estimate blocks it. | `estimate: { label, units, blocked, reason }`, `state: "regenerating"` |
| `ref_regen_queued` | The regeneration job has been submitted. | `state: "regenerating"` |
| `ref_gate_open` | A still becomes `accepted` or `overridden`. | `state` |
| `ref_gate_held` | A still is held, or a video is refused because its keyframe is stale. The stale case also carries `refusal`. | `state: "held"` |

Every event also carries `type`, `productionId`, `jobId`, `keyframeSha256`, and `at`.

## Receipts

Each decision writes one receipt when `receiptsDir` is available. The file is `ref-review/<keyframeSha256>.json` under the receipts directory the backend supplies. It is written with mode `0600` inside a `0700` directory, using a temporary file and a rename so a reader never sees a partial receipt.

The receipt body has schema `comfyrizz.ref-review.evidence/v1` and contains:

- `keyframeSha256`;
- `imageSha256`, which equals the keyframe sha;
- `verdicts`, the T0 and Pi verdicts collected for the attempt;
- `decision`, the final `RefDecision`.

The sha is the link between the image, the verdicts, the decision, and the video job. If a later edit changes the keyframe, the accepted sha no longer matches the current sha and the video is refused with `ref_gate_held` and a `refusal` payload rather than being rendered from the old still.

## Overrides

An override is not a judge pass. It is a `RefDecision` with action `override`, and `validateRefDecision` requires it to carry a `receiptId`. The controller treats an override like an acceptance for the gate: the still state becomes `overridden`, the gate opens, the still is remembered as accepted for replacement selection, and the receipt is written with the override decision.

Because `refGateOpen` accepts only `accepted` or `overridden`, an override is the deliberate human escape hatch from a held still. It does not change the verdict that was recorded; it records who authorised the gate to open. An override without a `receiptId` is invalid and is replaced by an escalation, so the gate cannot open on an anonymous override.

## Opt-in last-frame chaining

Last-frame chaining is off by default. `planChainedShot` returns `null` without touching either injected dependency unless `chainFromPrevious` is true.

When it is on:

- `previousClip.status` must be `accepted`, otherwise the plan throws;
- `extractLastFrame(previousClip)` produces the image;
- `reviewKeyframe({ kind: "keyframe", image })` must return `overall: "pass"`, otherwise the plan throws.

The result contains `loadImage`, `imgToVideoInplace` with `CHAIN_STRENGTHS` (`strength: 0.7`, `strength2: 0.7`), and a note to run a ref-watch identity judge check on the chained clip frames before release. The strength is never 1.0 because identity drift is reviewed rather than amplified.

The module is pure. Frame extraction and keyframe review are injected, so there is no ffmpeg, network, clock, or disk access in the plan itself.

## Judge calibration

`scripts/ref-watch/calibrate.mjs` is an offline tool. It compares past stills that a human has labelled with the verdicts the judge produced, and reports accuracy for each review dimension. Each dimension is one calibration question: `technical`, `identity`, `anatomy`, `framing`, `prompt`, and `text_artifact`.

It does not call a model, a GPU, or Google Colab. It reads two JSON files and writes a reliability matrix.

### 1. Build the labels

Create a labels array. Each entry needs the same `jobId` and `keyframeSha256` as the verdict, plus an `expected` object with `pass` or `fail` for the dimensions you want to calibrate:

```json
[
  {
    "jobId": "still_001",
    "keyframeSha256": "0000000000000000000000000000000000000000000000000000000000000001",
    "expected": {
      "identity": "pass",
      "anatomy": "pass",
      "framing": "pass"
    }
  },
  {
    "jobId": "still_002",
    "keyframeSha256": "0000000000000000000000000000000000000000000000000000000000000002",
    "expected": {
      "identity": "fail",
      "anatomy": "fail",
      "framing": "pass"
    }
  }
]
```

Use known-good stills and known-bad stills. A set that contains only passes cannot measure false passes, which is the failure that matters most: a judge that says `pass` on a bad still opens the gate on a bad clip. Include at least `MIN_TRUSTED_N` (5) labelled stills per dimension before treating a result as evidence; more is better.

### 2. Collect the verdicts

Create a verdicts array of valid `RefVerdict` objects. Each verdict needs the matching `jobId` and `keyframeSha256`, and `validateRefVerdict` must accept it. Verdicts with `overall: "error"` are reported as judge errors and are not counted as correct. Invalid verdicts and verdicts or labels with no match are reported by index.

If you are comparing judge models, run the same labels against a separate verdict file per model. Compare the matrices side by side, because the tool matches on `jobId` and `keyframeSha256`, not on the model name.

### 3. Run the calibration

```bash
node scripts/ref-watch/calibrate.mjs \
  --labels labels.json \
  --verdicts verdicts.json \
  --out matrix.json \
  --min-accuracy 0.8
```

`--labels` and `--verdicts` are required. `--out` writes the reliability matrix to a file instead of standard output. `--min-accuracy` accepts a number from 0 to 1 and defaults to `DEFAULT_MIN_ACCURACY` (0.8). Unknown arguments are rejected.

The matrix uses schema `comfyrizz.ref-review.reliability/v1`. Standard error also prints one line per dimension:

```
identity: n=12 accuracy=0.9167 falsePassRate=0.0833 falseFailRate=0.0000 trusted=true
```

For each dimension the report contains `n`, `accuracy`, `falsePassRate`, `falseFailRate`, `correct`, `falsePass`, and `falseFail`. The matrix contains `trusted`, `accuracy`, `falsePassRate`, and `n`.

### 4. Read the result

A dimension is `trusted: true` only when all three hold:

- `n >= MIN_TRUSTED_N` (5);
- `accuracy >= minAccuracy` (default `DEFAULT_MIN_ACCURACY`, 0.8);
- `falsePassRate <= MAX_FALSE_PASS_RATE` (0.1).

Anything else is untrusted. Pay particular attention to `falsePassRate`: a high false-pass rate means the judge is opening the gate on stills a human called bad, which is the expensive error. A high `falseFailRate` mostly costs regenerations, but a high false-pass rate costs a bad video.

### 5. Blacklist biased question and model pairs

Calibration does not write a blacklist file. Its output is the evidence you use to make one.

Treat a `trusted: false` dimension for a given judge model as a biased question/model pair and blacklist it for that model: do not use that dimension's answer from that model, and do not treat a `pass` on it as a gate-opener until a later calibration with more labelled stills clears it. Common reasons are too few labelled stills, accuracy below the threshold, and a false-pass rate above 10%.

Blacklist at the level of the pair, not the whole model. One model can be reliable on `identity` and unreliable on `anatomy`; the calibration matrix exists to show exactly that split. Re-run calibration after a prompt, skill, or model change, because a previously trusted pair is only trusted for the version that was measured.

### Current blacklist

The W4 calibration (2026-10-30) ran deepseek-v4.1-flash through the shipped `reviewStill` path on 28 labelled FLUX 3 Klein stills (11 known-good, 17 known-bad). `prompt` came out `trusted: false`: it holds too many good stills, flagging small wording differences such as "medium shot" vs a chest-up crop. It is blacklisted for that model in `REF_UNTRUSTED_DIMENSIONS` (`apps/server/src/ref-watch/decide.mjs`). A failed `prompt` check is still reported in the verdict and in the why drawer, but it never holds or regenerates a still. Every other hard failure still holds the still. Clear the entry only after a re-calibration with more labelled stills shows `prompt` as trusted.
