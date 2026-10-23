# Iterative Production Agent

*Specification for iterative, scene-by-scene production. Status: draft for implementation. Audited baseline: `main` at `37f8f73` (2026-10-22). Plan: [PLAN.md](../PLAN.md). Product spec: [SPEC.md](../SPEC.md). Workflow research: [ITERATIVE_PRODUCTION_WORKFLOW_20261022.md](../research/ITERATIVE_PRODUCTION_WORKFLOW_20261022.md). Voice reference: [VOICE_GENERATION.md](../VOICE_GENERATION.md).*

## 1. Goal

Today the product runs one shot: build a package, pay for one Google Colab or
bring-your-own-ComfyUI run, then render. The iterative production agent turns
that into a durable production record that a user and an agent can work on
scene by scene:

1. Start from a brief and keep a stable production identity **before** a
   package exists.
2. Propose a plan, let the user approve scope and budget, then dispatch only
   the approved work.
3. Land every generated file as a take beside the previous takes, so the user
   can compare, approve or correct one clip without rebuilding the production.
4. Continue after a Google Colab job finishes, fails or is interrupted, without
   losing decisions or replaying paid work.
5. Render only when the review gate is satisfied, or when the user records an
   explicit override reason.

Non-goals: a general workflow engine, user-defined DAGs, plugin steps, a
generic queue, distributed workers, an external broker, a second take browser,
and agent autonomy over spend. The vocabulary below is closed and hand-written;
extending it is a specification change, not configuration.

## 2. Invariants

- **I1. Identity before package.** A production exists and can be read before
  any package, run or Google Colab session exists.
- **I2. Durable decisions.** Approvals, verdicts, corrections, overrides and
  budget settlements survive restarts and are reconstructed from the snapshot
  plus the event log.
- **I3. Continuation after GPU jobs.** A completed, failed or orphaned job is
  observed and reconciled from its durable attempt record; the coordinator
  never depends on an in-process callback.
- **I4. Idempotent side effects.** Every mutation carries an idempotency key;
  repeating it returns the first result and does not dispatch twice.
- **I5. One command path.** UI clicks and chat decisions resolve to the same
  `POST /api/productions/:id/commands` path with the same validation.
- **I6. No self-approval.** The agent may propose, never approve its own plan,
  budget, take or render override.
- **I7. Persistent budget.** Reservations are separate from settlements and are
  never reset by a restart or retry. A project ceiling is not blanket approval.
- **I8. Cards are views.** The model never returns card HTML. Cards render from
  durable snapshot data and define empty, loading, error and stale states.
- **I9. Takes stay the system of record.** Production artifacts point at take
  IDs; they do not copy or mutate take files.
- **I10. One paid executor.** `pipeline.mjs` / `pipeline-worker.mjs` remain the
  only executor of paid video work. The coordinator admits and observes.

## 3. Architecture decisions

**D1. A production-domain coordinator, not a workflow engine.** Build one
in-process module under `apps/server/src/productions/` with a fixed vocabulary
of stages, commands and events. It has no user-defined DAGs, plugin steps,
generic queue, distributed workers or external broker. Persistence follows the
pattern `pipeline.mjs` already uses: a JSON snapshot, `events.jsonl` and an
outbox under `runtime/productions/<id>/`, single-writer with compare-and-swap.
`/api/productions/*` is a thin facade over that module. Existing routes become
adapters into the same command path so there is not a second system.

**D2. Reuse before adding.** `pipeline.mjs` / `pipeline-worker.mjs` stay the
only executor of paid video work. `takes/{model,store,ingest,select,correction,gate,clips,routes}.mjs`
stay the take system of record. The density review drawer
(`apps/web/src/takes/review-drawer.ts`, with Redo at :849) and `takes/panel.ts`
become the Review surface; we do not build a second take browser.
`editor/store.ts` commands stay the only way to mutate the timeline.

**D3. Google Colab is a first-class, primary inference adapter.** Its execution
policy covers session start, a per-production `scratchDir` in place of the
`/tmp` default in `colab-backend.mjs:211`, collect, verify and apply as
separate retryable steps, teardown confirmation (with `stop_unconfirmed`
surfaced), and budget settlement on success and failure. A CPU/fake backend
implements the same contract and is what tests use.

**D4. Fix money and integrity hazards before paid autonomy.** First fix the
TR07 blocker, CPU regenerate, the double-counting budget at `run.mjs:238`,
mutable take completion at `app.mjs:231-282`, and export fingerprinting. Until
then the agent may only propose plans.

**D5. One command path for UI and chat.** Every mutation goes through
`POST /api/productions/:id/commands` with an idempotency key, the base revision
and an originating user-event ID. Explicit clicks need no LLM call. Chat
decisions resolve to the same command and must cite the user message. The agent
cannot approve its own proposal.

**D6. Cards are views of durable records.** Card payloads come from snapshot
data. The model returns a card reference and data, never HTML.

**D7. Budget is a persistent per-production ledger.** Reservations stay
separate from settlements. Restarts and retries never reset the allowance. A
project ceiling is not blanket approval: each paid plan needs its own scoped
approval.

**D8. Canonical voice documentation.** The voice standard is
[VOICE_GENERATION.md](../VOICE_GENERATION.md). A broken link to
the earlier voice-standard filename appeared in drafts; that file never
existed on `main`. All voice-standard links now point at the canonical guide,
and [the link test](../../scripts/check-doc-links.test.mjs) enforces it.

## 4. Closed vocabulary

### 4.1 Stages

| Stage | Entry condition | Exit artifact |
|---|---|---|
| `brief` | production created | brief revision |
| `plan` | brief accepted | approved plan + scoped budget |
| `casting` | plan includes narration | cast decision |
| `storyboard` | plan approved | storyboard revision |
| `references` | storyboard needs references | reference set |
| `media` | spend approval present | run request / attempt record |
| `review` | takes landed | per-clip verdicts |
| `render` | review gate satisfied | render job |
| `export` | render exists | export + fingerprint |
| `done` | export accepted | terminal state |

A stage may loop back (`review` -> `media` for one clip) without recreating the
production. Stage transitions are events, not mutable status flags.

### 4.2 Commands

`production.create`, `plan.propose`, `plan.approve`, `stage.advance`,
`artifact.attach`, `cast.decide`, `take.request`, `take.select`,
`clip.approve`, `clip.reject`, `render.request`, `gate.override`,
`budget.reserve`, `budget.settle`, `production.cancel`.

Every command carries `{idempotencyKey, baseRevision, userEventId}`. Approval
commands additionally name the exact proposal revision and the approver.

### 4.3 Events

`production.created`, `plan.proposed`, `plan.approved`, `stage.entered`,
`stage.completed`, `artifact.attached`, `cast.decided`, `take.requested`,
`take.landed`, `take.selected`, `clip.reviewed`, `budget.reserved`,
`budget.settled`, `render.gate.blocked`, `production.failed`,
`production.cancelled`.

Events are append-only. Consumers may rebuild every derived card and gate from
the snapshot plus events.

## 5. Persistence and concurrency

```
runtime/productions/<productionId>/
  snapshot.json      # canonical state, atomic temp+rename, mode 0600
  events.jsonl       # append-only command/event journal
  outbox/            # pending side effects, drained idempotently
```

- One writer per production. Every command compares `baseRevision`; a mismatch
  is `409 revision_conflict` with the current revision.
- The writer appends the event before draining the outbox. A crash between the
  two is repaired by replaying the outbox with the idempotency key.
- Snapshot writes use a temporary file in the same directory and `rename`.
- Reads never block writes and never mutate state.
- Budget reservations and settlements are ledger entries, not counters that
  can be recomputed from a mutable total.

## 6. API facade

| Route | Purpose |
|---|---|
| `POST /api/productions` | create from a brief |
| `GET /api/productions/:id` | snapshot + derived cards |
| `GET /api/productions/:id/events` | replay, SSE with `Last-Event-ID` |
| `POST /api/productions/:id/commands` | the only mutation path |

Existing take, render and pipeline routes become adapters that construct the
same command and pass through the same checks. They must not mutate production
state directly.

## 7. Budget and approvals

- `budget.reserve` records `{planHash, upperBound, reason, approvalId}` before
  dispatch. `budget.settle` records actual usage or a failure settlement.
- The reserve check is `spent + committed + nextUpper + collectAndStopReserve
  <= allowance`. Failure paths settle too, so a failed Google Colab start does
  not leave an open reservation.
- Each paid plan has its own scoped approval. A larger project ceiling does not
  authorize a new Google Colab session.
- A genuinely missing backend still returns `BACKEND_UNAVAILABLE` (HTTP 422).
  The CPU/fake backend exists so a CPU regenerate is not a 422 by accident.

## 8. Review and rendering

- A landed take is `unreviewed`. It never auto-selects over an approved take.
- `clip.approve` and `clip.reject` are user commands; the agent can only
  propose them. A correction regenerates one asset through
  `planJobs({assets:[assetId]})`.
- The preview shows the selected take. Selecting a take writes its file,
  checksum and generation metadata into the package asset, so the final render
  consumes what was previewed.
- `render.request` is refused while the gate is blocked. `gate.override`
  requires a written reason and is recorded in the event log.

## 9. Google Colab execution policy

1. Preflight: budget reservation, backend health, model and token availability.
2. Start: create the session with a per-production `scratchDir`, never a shared
   temporary directory.
3. Execute: dispatch the existing pipeline job; record the attempt before
   submit.
4. Collect: download outputs, then verify the manifest and checksums.
5. Apply: ingest each output as a take before any package file is replaced.
6. Stop: confirm teardown; surface `stop_unconfirmed` rather than claiming
   success.
7. Settle: settle the budget on success, failure and interruption.

All normalization, checksum comparison and take ingestion are retryable and
idempotent. Tests use the fake backend and a fake `colab` executable; they never
start a real Google Colab session and never make network calls.

## 10. Re-verified audit at baseline `37f8f73`

Status: confirmed, drifted, partial, or not on `main`.

| ID | Finding | Verified location | Status |
|---|---|---|---|
| A01 | Project chat built without runs/events/measuredFor | `apps/server/src/app.mjs:172`; chat correction at `agent-chat.mjs:12,94-139` | drifted |
| A02 | No audition route or UI | `characters/audition.mjs` exists; dispatch at `characters/routes.mjs:1093-1096` | confirmed |
| A03 | Upload-only, no-clone instruction | `packages/agent/src/character-tools.ts:463` | drifted |
| A05/A06 | Chat CAS and journal gaps | `apps/server/src/agent-chat.mjs` | confirmed in principle |
| A08 | Timeline mount does not forward review callbacks | `apps/web/src/editor/timeline/mount.tsx:23` | confirmed |
| A09 | `replaceDocument` clears undo | `apps/web/src/editor/store.ts:118,483`; undo stack `:253` | drifted |
| A11 | Activity pane hidden below 1100px | not as originally described; only 1100px rule is `apps/web/src/style.css:226` | re-scoped |
| A12 | In-memory runs, approvals, spend | `apps/server/src/run.mjs:97,372` | confirmed |
| A13 | Budget adds `required` already including prior spend | `apps/server/src/run.mjs:238` | drifted; still double-counts |
| A14 | Take completion copies into mutable package assets | `app.mjs:231,251,282` | drifted |
| A15 | Google Colab collect/apply contract | `packages/backends/src/colab-backend.mjs:211`; `run-package.mjs:133` | drifted |
| A16 | Take fingerprint omits model revision and transitive bytes | `apps/server/src/takes/model.mjs:384-394` | confirmed |
| A17 | Ten-minute, process-local media tickets | `apps/server/src/media-range.mjs:13` | confirmed |
| A18 | `renderGate` not used uniformly | `app.mjs:371,804`; `routes/render.mjs:197`; `takes/render-bar.ts:93` | partial |
| A19 | Export reuses `video.mp4` without a full fingerprint | `apps/server/src/export.mjs:160-164` | confirmed |
| A20 | Native audio treated as ambience | `apps/renderer/src/audio-mix-model.js:180-187` | drifted |
| A23 | Global `references.json` sidecar | `apps/server/src/chat-project.mjs:406` | drifted |
| A24 | `has()` calls `ensure()`; non-empty WAV trusted | `characters/audition.mjs:550-551,606-607` | confirmed |
| NEW-1 | Density review work is missing from the audit | `apps/web/src/takes/review-drawer.ts` (Redo `:849-867`), `preview-takes.ts`, `render-bar.ts`, `apps/server/src/takes/clips.mjs` | reuse as Review |
| NEW-2 | TR07 failing | `apps/server/test/takes/run-mode.test.mjs:216` | **blocker** |
| NEW-3 | CPU regenerate returns 422 | `takes/routes.mjs:43-58`; `run.mjs:45`; `test/takes/cpu-regenerate.test.mjs:115` | **blocker** |
| NEW-4 | Broken voice-standard doc link | `docs/VOICE_GENERATION.md` is canonical; the earlier filename did not exist | fixed here |

A04, A07, A10, A21, A22 and A25 were not re-verified line by line at this
baseline. The owning task's first step is to relocate them before changing
code.

## 11. Delivery order

Phase P0 removes hazards before any paid autonomy:

1. TR07 green.
2. A working CPU/fake regenerate backend.
3. Budget double-count and failure settlement fixed.
4. Take completion no longer mutates package assets.
5. Export fingerprinting covers reused renders.
6. Voice-standard links fixed and the documentation link test green.

Only after P0 may the coordinator dispatch paid work. Before P0 the agent may
propose plans and nothing else.

## 12. Iteration levels

A production stores one iteration policy (`comfyrizz.iteration-policy/v1`) as an
`iteration.set` event. The level is `draft`, `balanced`, `director`, or
`custom`. Presets are frozen. Any edit, including a per-shot override, derives
`custom`. The user guide is [ITERATION_LEVELS.md](../ITERATION_LEVELS.md).

- **Choice before spend.** `plan.approve` for a plan with a paid slot returns
  `409 ITERATION_LEVEL_REQUIRED` until `iteration.set` exists. A paid slot has
  `upperBound > 0`, except `kind: audition` with `engine: kokoro`. Choosing a
  level writes only `iteration.set`. It never sends `plan.approve` and never
  carries an actor from the client.
- **Estimates stay advisory.** `estimateIteration` returns low, expected, and
  high ranges. Copy says "estimate; other sessions may be running", and an
  unmeasured rate says "unmeasured estimate". The plan's `reservationCeiling`
  remains the binding number. No cap does not block. The UI names the service
  Google Colab in full.
- **The agent obeys the level.** `production_read` exposes the effective policy
  per shot. A proposal past the policy's takes, rounds, or auditions is
  `ITERATION_EXCEEDED`. `iteration.set` is in `FORBIDDEN_AGENT_COMMANDS`.
- **Auto-pick is not spend.** When the user set a stage to `auto`, a landed
  take may be selected with actor `system` and reason `iteration:auto-pick`.
  That path never resolves `final_delivery` or `action_spend`.
- **Mid-production change.** A later `iteration.set` applies only to shots that
  are not rendered and not in flight. A locked shot returns
  `ITERATION_SHOT_LOCKED` and keeps its current stages. An already proposed
  plan is not mutated; the plan card shows "level changed — re-propose".
