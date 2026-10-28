# Hybrid planning-thinking experiment

Status: harness implemented; **no main live run**. One preliminary paired
sample exists only as calibration context and is **not evidence**.

Google Colab is not used. This experiment is planning-only.

## Hypothesis

A thinking-disabled first draft plus one thinking-enabled targeted correction
(when deterministic oracles fail) can approach thinking-on quality at a lower
median token and latency cost than sending the whole plan with thinking on.

The preliminary A/B sample (thinking off ~23.3s / 68,608 tokens / 1 repair /
schema-valid but missed Remotion opener + end card; thinking on ~157.4s /
308,012 tokens / 0 repairs / quality checks passed) is calibration only. It
does not establish hybrid feasibility.

## Verified product facts (this branch, commit `25f5f64`)

- `POST /api/agent` accepts optional `thinking: "disabled" | "enabled"`.
  Omit keeps the existing default (max reasoning on the DeepSeek paths).
- Focused repair in `apps/server/src/agent-runner.mjs` reuses the same model
  object, so it **inherits** the request thinking setting. Arms A and B
  therefore keep repair thinking aligned with the initial plan without extra
  product defaults.
- `takes/correction.mjs` and `agent-chat` are take/prompt correction for
  generation. They do **not** expose `thinking` and are not used here.
- Planning-stress fixtures currently select `opencode-go` /
  `deepseek-v4.1-flash`. Direct DeepSeek is `custom` +
  `https://api.deepseek.com/v1` + `deepseek-flash`. This experiment keeps
  provider/model **identical across arms** and changes only thinking /
  correction strategy. Default live target is direct DeepSeek /
  `deepseek-flash` when a matching env credential is present; otherwise the
  OpenCode Go DeepSeek path already used by planning-stress.

## Arms (logically distinct)

| Arm | Initial plan | Normal validation/repair | Targeted correction |
| --- | --- | --- | --- |
| **A Off baseline** | `thinking: "disabled"` | same setting | none |
| **B On baseline** | `thinking: "enabled"` | same setting | none |
| **C Hybrid** | **reuse A's exact draft + metrics** (no resample) | none extra | at most one thinking-enabled correction, only if the trigger oracle reports bounded failures |

C rules:

- Same fixture, repetition, brief, provider, model, route, timeout, and retry policy as A/B.
- If every trigger oracle passes on A's result: C final = A, zero extra tokens/time.
- If failures are bounded: exactly one thinking-enabled correction using the
  fixed machine-generated template in
  `apps/server/src/hybrid-planning-correction.mjs` (`buildCorrectionPrompt`).
  Template contents are only: original brief, objective failure codes/details,
  relevant package/scene/asset context, immutable IDs, allowed-edit scope.
- Preserve package ID, unrelated scene/asset IDs, previously passing
  requirements, and out-of-scope creative choices.
- Re-run full package validation and every quality oracle after the correction.
- Do not silently full-replan or run extra correction rounds. A
  `storyboard.propose` during C is recorded as `needs_global_replan`; the
  replan package is discarded and C final stays A's draft (correction tokens
  still count).
- Refusal / unsatisfiable fixtures never trigger correction or generation.
- Infrastructure failures stay infrastructure. They are never converted into
  model-quality failures.
- Any production / run / generated-media invocation is a hard harness failure.
- C total usage = A's complete off-draft usage + correction usage. Correction-only
  usage is also reported.

## Predeclared engineering targets

Written **before** any main results. These are decision targets, not claims of
statistical significance.

1. Hybrid final pass rate ≤ 5 percentage points below thinking-on (arm B).
2. No increase in critical failures or correction collateral damage versus A/B.
3. ≥ 25% median total-token savings versus thinking-on.
4. ≥ 20% median end-to-end latency savings versus thinking-on.
5. Report (do not hide) every trial where hybrid costs more than direct thinking-on.

Critical failures: infrastructure converted to quality, generation/production
invocation, schema-invalid accepted as pass, refusal fixture that triggers
correction, or package-id collision across concurrent runtimes.

## Fixtures

Smoke (2, 1 rep): `S02` simple plan; `C01` calibration skater / Remotion plan.

Main (12, 3 reps if budget permits — predeclared, **not started**):

| ID | Class |
| --- | --- |
| S02 | simple / low-constraint |
| A05 | simple / ambiguous defaults |
| H21 | multi-scene narration + exact cue phrases (Klein) |
| H24 | multi-scene narration + exact cue phrases (Auto) |
| W20 | wordless native-sound |
| C01 | live-action human consistency + Remotion opener/outro (calibration) |
| D13 | purpose-matched structured visuals / shared dataset |
| T25 | duration splitting / clip bounds |
| T30 | exact shot counts / media coverage |
| M10 | corrections must preserve unrelated work (shared mascot) |
| T29 | preserve unrelated list/numbers |
| X33 | refusal / unsatisfiable — must not trigger correction or generation |

Existing planning-stress oracles are reused and are **not** weakened. `C01` is
experiment-only. Remotion bookend checks apply to `C01` and, as hybrid-only
extras, to narrated generated-film fixtures that already expect on-screen text.
They are not added to planning-stress.

## Measurements (sanitized aggregates only)

Wall time to first valid draft; normal repair time; targeted correction time;
E2E time; provider input/output/total tokens for initial / normal repairs /
targeted correction / overall; model calls, repairs, corrections, retries,
provider errors, 429s, timeouts, concurrency; correction trigger rate;
correction success rate; needs-global-replan count; schema validity + every
deterministic oracle; collateral damage (passed before, failed after);
out-of-scope ID/asset/scene changes; generation/production/run invocations.

No LLM judge is used. If one is added later, its tokens must be reported
separately and never mixed into planning-arm usage. Persist only scores and
failure categories, never raw model outputs.

## Isolation and credentials

- Isolated runtimes and ports `4531–4536` under
  `/tmp/opencode/comfyrizz-hybrid-thinking`.
- Same brief → same package ID; concurrent A and B never share a runtime.
- C always uses the same worker/runtime as that trial's A.
- Credentials only from the operator environment. Never read
  provider-settings files, server tokens, or HF tokens from another process.
- Reports omit credentials, raw reasoning, raw model text, tool arguments,
  provider responses, and full packages.

## Main-run budget (predeclared; operator approval required)

See `qa/hybrid-thinking/budget.mjs`. Worst-case live requests: **108**
(12 fixtures × 3 reps × arms A+B + optional C). Hard token ceiling: **20,000,000**
provider tokens. The main run is gated on `HYBRID_THINKING_MAIN=1` and has
**not** been started.

## Recommendation slots (fill after an approved main run)

- Viable overall:
- Viable only for named classes:
- Not worthwhile:
