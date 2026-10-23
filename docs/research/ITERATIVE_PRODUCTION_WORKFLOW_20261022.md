# Iterative Production Workflow Research

*Research note, 2026-10-22. Baseline: `main` at `37f8f73`. Companion
specification: [ITERATIVE_PRODUCTION_AGENT.md](../specs/ITERATIVE_PRODUCTION_AGENT.md).
Delivery plan: [PLAN.md](../PLAN.md). Product context: [SPEC.md](../SPEC.md).
Canonical voice reference: [VOICE_GENERATION.md](../VOICE_GENERATION.md).*

## 1. Question

How should Comfyrizz move from a single build/run/render pass to an iterative
production agent that can propose, dispatch, observe, review and continue
across paid Google Colab jobs without becoming a general workflow platform?

## 2. Method

- Read the server, take, render and Google Colab adapter code at `37f8f73`.
- Re-ran the focused take tests named in the audit and recorded their current
  state. No real Google Colab session, paid API or network call was used.
- Compared the existing `pipeline.mjs` persistence and lease patterns with the
  state the iterative feature needs.
- Checked documentation links across the specification set with a local link
  test. The test is [scripts/check-doc-links.test.mjs](../../scripts/check-doc-links.test.mjs).

## 3. What the code already provides

| Area | Existing mechanism | Reuse decision |
|---|---|---|
| Pipeline execution | `pipeline.mjs`, `pipeline-worker.mjs` snapshot, leases, reconciliation | Keep as the only paid executor; the coordinator admits and observes |
| Takes | `apps/server/src/takes/{model,store,ingest,select,correction,gate,clips,routes}.mjs` | Keep as the take system of record; point artifacts at take IDs |
| Review UI | `apps/web/src/takes/review-drawer.ts`, `panel.ts`, `preview-takes.ts`, `render-bar.ts` | Use as the Review surface; add no second browser |
| Timeline edits | `apps/web/src/editor/store.ts` command union | Keep as the only timeline mutation path |
| Media serving | short-lived tickets in `media-range.mjs` | Keep the contract; note the process-local ten-minute limit |
| Google Colab | `packages/backends/src/colab-backend.mjs`, `run-package.mjs` | Add per-production scratch, verify and stop confirmation; keep argv-array and no-secret rules |
| Render gate | `renderGate` and take render bar | Enumerate all callers and make the gate uniform |

This is enough machinery for a closed production vocabulary. A generic DAG
engine would duplicate leases, reconciliation and persistence, and would make
the paid path harder to audit.

## 4. Findings that constrain sequencing

### 4.1 Money paths are not safe for autonomy yet

`run.mjs:238` adds a `required` estimate that already includes prior spend, so
the reservation double-counts. Failure paths do not always settle. Spend and
approvals are process-local (`run.mjs:97,372`), so a restart loses the
allowance. The conclusion is that an iterative agent must not dispatch paid
work until the ledger is durable and separate from settlements.

### 4.2 Completion still mutates package assets

`app.mjs:231-282` copies collected output into the package and then merges
media. A second output for the same asset can overwrite the first file. The
take ingestion path already knows how to keep files apart. Completion must
ingest a take before any package file is touched, and a take-mode run must skip
the automatic full render.

### 4.3 A CPU regenerate currently fails as if the backend were missing

`takes/routes.mjs:43-58` maps `BACKEND_UNAVAILABLE` to HTTP 422, and the code
raises it when no paid backend is configured. That is correct for a genuinely
missing backend, but it makes CPU regenerate untestable. A fake/CPU backend
that implements the same contract fixes the test path without weakening the
error for real missing backends.

### 4.4 Google Colab needs a per-production scratch directory

`colab-backend.mjs:211` defaults scratch space to a shared temporary path.
Iterative productions can overlap in review while an older run is still being
collected. Each production needs its own `scratchDir`, plus separate collect,
verify and apply steps so a retry cannot reapply a half-downloaded set.
Teardown must confirm `stopped` or surface `stop_unconfirmed`; the budget must
settle on both success and failure.

### 4.5 Integrity is weaker than it looks

The take fingerprint omits the model revision and transitive bytes
(`takes/model.mjs:384-394`). Export reuses `video.mp4` without a full
fingerprint when there are no composition extras (`export.mjs:160-164`). Media
tickets are process-local and expire after ten minutes (`media-range.mjs:13`).
These are acceptable for the current single-process demo only because each has
a narrow failure mode; they are not acceptable as the basis for autonomous
retries.

### 4.6 Reviews must keep the take vocabulary

The density work already models filters, sorts, previews and Redo. A production
card should link to that surface rather than render its own clips. The
derived states used there (`planned`, `queued`, `generating`, `review`,
`approved`, `rejected`, `failed`, `stale`) are the vocabulary the coordinator
should emit.

## 5. Proposed workflow

1. **Create.** The user states a brief. A production record exists immediately;
   no package is required.
2. **Propose.** The agent proposes a plan with scenes, assets, a budget upper
   bound and a plan hash. It cannot approve it.
3. **Approve.** The user approves the exact revision. Approval is recorded as a
   command with the originating user-event ID.
4. **Dispatch.** The coordinator reserves budget, then asks the existing
   pipeline to run only the approved assets.
5. **Observe.** A worker records attempt state and reconciles after a lost
   callback. Google Colab teardown is confirmed before success is claimed.
6. **Ingest.** Each output becomes a take. The production points at the take;
   nothing silently replaces an earlier file.
7. **Review.** The user approves, rejects or corrects one clip at a time. The
   agent may propose the same commands but cannot execute the verdict.
8. **Render.** The render gate blocks until every reviewable clip is approved.
   An override needs a written reason.
9. **Settle.** Actual usage and failure both settle the ledger. The next paid
   plan needs a new scoped approval.

## 6. Risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Double dispatch on retry | Pays twice and creates two takes | Idempotency key on every command; attempt record before submit |
| Lost Google Colab callback | Production stalls | Durable attempt record + reconcile; never auto-resubmit `submission_unknown` |
| Unconfirmed teardown | Runtime keeps billing | Surface `stop_unconfirmed`; reconcile sessions before success |
| Budget reset on restart | Overspend | Per-production ledger with reservations and settlements |
| Take file overwritten | Review compares the wrong media | Ingest to a take path before package mutation |
| Stale card data | User approves the wrong revision | Cards carry snapshot revision; stale state is explicit |
| Second take UI | Divergence from the density review work | Reuse the review drawer and panel; cards link to it |
| Agent self-approval | Unauthorized spend or bypassed gate | Approval commands require a user event and cannot cite the agent |

## 7. Open questions

- Should a production allow more than one active media run, or serialize all
  paid dispatch per production? The take system already serializes one active
  run; the coordinator should keep that and queue the rest.
- Should the review gate live entirely in the take system or be projected into
  the production snapshot? The proposal is to project it, so the production
  card can show readiness without rewriting take state.
- How much of the legacy `run.mjs` approval state can be migrated, versus
  recreated from the production ledger? Migration is out of scope until the P0
  blockers are fixed.
- Which existing route adapters need a compatibility shim so old callers do not
  create a second command path? This is enumerated task by task, not globally.

## 8. Documentation links

The voice standard was previously cited under a filename that does not exist
on `main`. The canonical reference is
[docs/VOICE_GENERATION.md](../VOICE_GENERATION.md), which covers voice presets,
saved package fields and full-generation behavior. Both this note and the
specification point there, and the documentation link test rejects the removed
name and any missing relative target.

## 9. Evidence

At baseline `37f8f73` the relevant test command is the focused take suite named
by the audit. It is intentionally not run as part of this documentation task
because the task command is the link check:

```
node --test scripts/check-doc-links.test.mjs
```

The link check reads the specification set, verifies that every relative link
target exists, and asserts the canonical voice reference.
