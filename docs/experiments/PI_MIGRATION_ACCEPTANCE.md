# Production Pi migration: acceptance boundary

Status: implementation in progress. Requested 2026-10-29. The remaining Title rule/reveal capabilities are explicitly deferred.

**Updated user requirement:** every production video must use ComfyUI with at least one official hackathon model. This supersedes the earlier CPU-only final-delivery acceptance criterion. Native-only fixtures and historical experiments remain diagnostic evidence, not compliant final videos.

## Intended scope

Move the production model/tool orchestration onto a shared Pi runtime, preserving existing ComfyRizz public contracts. This includes initial planning, bounded repair, proposal/narration revision and conversational editing. Inventory auxiliary provider calls such as SVG generation and document how they use the shared runtime or why they remain single-purpose provider operations.

Rendering, narration synthesis, source processing, production reservations and ComfyUI execution remain deterministic services. Pi integration must preserve their state transitions rather than replace them with model-written behavior. A Title-only runner or a Pi wrapper around an otherwise active legacy agent loop is not completion of this migration.

## Required compatibility evidence

| Boundary | Required evidence |
|---|---|
| Runtime/provider adapter | Actual installed Pi API; nonempty effective tools; tool-name aliases and results round-trip; multi-turn context; provider/thinking options and usage preserved. |
| Initial planning | Existing modes and tools remain available; dynamic tool exposure, step budgets, malformed-call handling and cancellation remain effective. |
| Revisions/chat | Current package ID/revision and pinned sources survive; stale edits and replacement-package substitutions remain rejected; errors are actionable. |
| Production | Existing approvals, budget/reservation checks and dispatch idempotency remain authoritative; a conversational continuation cannot duplicate a paid job. |
| ComfyUI contribution | Every final video includes a real, relevant contribution from a completed ComfyUI execution with an officially verified supported model. Trusted job/workflow/model/output-hash evidence must bind to the final rendered media or its consumed derivation. Planned jobs, unused assets and model-authored provenance do not qualify. |
| Export enforcement | Shared production export paths, including local/full/incremental/remote and resumed exports, reject missing qualifying evidence before expensive finishing. Surface actionable errors and identify the qualifying model/asset in delivery evidence. Explicit no-generation briefs produce a clear conflict rather than silently overriding the brief. |
| Recovery | Resuming deterministic processing or export does not implicitly regenerate the plan; persisted failure and approval state remain honest. |
| UI/progress | Normal Super Easy and chat entry points reach the migrated runtime; progress and error events remain consumable by existing UI. |
| Scope coverage | Every discovered model-loop entry point is listed as migrated, delegated to a shared implementation, or explicitly excluded with rationale. No unresolved exclusion is hidden behind a whole-pipeline claim. |

## Verification sequence

1. Focused adapter and orchestration tests, including tool-result-driven continuation, provider errors, cancellation and usage aggregation.
2. Existing agent suite and relevant server/web planning, revision, chat, approval and recovery checks; builds/typechecks after source changes settle.
3. Model-disabled browser/renderer preflight in a short-path, isolated runtime.
4. A real-provider Super Easy flow must plan and use a qualifying ComfyUI asset before a compliant final Export/Download can pass. Live GPU execution remains subject to existing approval and campaign authorization; mocked receipts establish enforcement behavior, not actual generated media. A planning-only run may stop before GPU approval and must be reported as incomplete.
5. Report visual acceptance independently of migration success. A valid export or successful runtime migration does not fulfill the deferred Title capabilities.

No GPU dispatch is required for deterministic orchestration/enforcement tests, but real compliant end-to-end delivery requires genuine generation evidence. Preserve existing campaign evidence/accounting; this requirement does not expand the credit authorization.

## Official-source distinction

The [official event page](https://comfy.org/open-source-higgsfield/), checked 2026-10-29, names LTX, FLUX 3 and MiniMax H3 for ecosystem bonuses and requires the relevant model to be core to the workflow for those bonuses. The user's every-video requirement is a product requirement, not a claim that the event publishes that universal rule. Verify exact supported model-family/variant mappings against official sources; do not infer a bonus entitlement from a single qualifying asset. Record exact workflow/model versions rather than a generic ComfyUI label.

## Completion report

Record active production paths, changes to retry/step/event semantics, any excluded paths, exact checks and failures, live evidence/artifact location and cleanup. Distinguish newly introduced regressions from reproduced baseline failures. State whether Pi is the active production default or still opt-in; do not call the migration complete while the normal UI remains on the old runtime.
