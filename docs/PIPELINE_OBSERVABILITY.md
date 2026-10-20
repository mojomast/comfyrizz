# End-to-end pipeline and frontend progress contract

Date: 2026-10-19. Backend integration branch: **`feat/pipeline-observability`**.
Companion to [the editor plan](FRONTEND_EDITOR_PLAN.md).

## Handoff to the frontend agents

The initial change added the backend API and worker. The subsequent
[voice-generation integration](VOICE_GENERATION.md) adds a small storyboard
panel using this API in the current web shell. Integrate the same contract into
the redesigned frontend work in progress; the existing `/api/run` remains the
legacy media-only flow. A frontend still calling `/api/run` does not acquire the
voice/sync/export stages automatically.

The new endpoint accepts a **saved package revision** and processes it through
voice generation, measured timing, generated media, presenter diagnostics and
bounded correction, CPU rendering, verification and an editable export. There
are no manual shell steps between these stages. Server model/runtime configuration
is still required, and reported in preflight or the failing stage.

Generated cuts are isolated snapshots. They never overwrite edits made while the
run was active. Use the result package and its asset URLs to show the generated
cut; label its source revision. The editable ZIP includes the generated assets
and measured narration. Import/adopt behavior in the redesigned project store is
a frontend/backend follow-up decision; do not PATCH returned relative asset paths
blindly into the original project's shared media directory.

## Audit: did we have enough observability?

**Previously, no.** There was useful GPU telemetry but no reliable end-to-end
application-level state model.

| Area | Previous behavior | Added behavior / remaining precision limit |
|---|---|---|
| Orchestration | Media generation followed by rendering; Qwen/sync were production scripts | One isolated worker drives nine ordered application stages |
| History | In-memory run map and 200-event SSE ring | Atomic per-run snapshot and durable sequence-numbered JSONL journal |
| GPU progress | Job/attempt/progress/output events existed | Preserved and mapped to task snapshots; split transport records no longer disappear |
| Voice | Final summary and raw logs | Voice-design/setup phases, per-scene synthesis and alignment start/completion |
| Model downloads | Quiet setup periods or terminal text | Named download/setup phase and diagnostic tail; byte percentage is unavailable |
| Collection | Aggregate tree completion | Successfully collected/reused files versus total listed files |
| Presenter | Manual SyncNet and FFmpeg | Per-presenter measurement, bounded correction, remeasurement and confidence/offset diagnostics |
| Render | Synchronous server call, no frame counts | Worker uses Remotion's actual rendered/encoded frame counters and renderer progress |
| Final audio | Production-only mix comparison | Normalization plus stream, duration and narration-envelope checks |
| Completion | Could report media done despite render failure | Completed only after all required stages, verified artifacts and a clean worker exit |
| Cancellation | Controller discarded its AbortController | Cancel request, visible cleanup state, local process termination and managed runtime teardown |
| Restart | Run state disappeared | Interrupted state, outputs retained, shutdown marked unconfirmed, explicit reconciliation |
| Cost | GPU estimate around one media run | Separate voice/media allocations, measured account balance deltas, unknown cost remains null |
| Concurrency | An edit could conflict with generated result application | Immutable input hash/revision; result cut retained separately |

The legacy controller also now reports a render failure as a failed request,
instead of publishing a successful finish after rendering failed.

## Stage IDs and semantics

| ID | Display label | Progress the frontend can use |
|---|---|---|
| `preflight` | Check project and inputs | Indeterminate checks; never imply GPU allocation |
| `narration` | Generate voice and align captions | Setup/design phases, synthesized scenes, separately aligned scenes |
| `timing` | Assemble narration and measure timing | Indeterminate assembly, then measured scene count |
| `presenter_inputs` | Prepare presenter audio | Scene ID; exact source window and native frame lattice |
| `media` | Generate and collect visual media | Dependency/job list, active attempts, reported ComfyUI progress, collected files, teardown |
| `presenter_sync` | Check and correct presenter timing | Scene ID, correction frames, verified presenters, offset/confidence |
| `render` | Render video | Bundling, rendered/encoded frames, encoding/muxing, audio normalization |
| `verify` | Verify video and audio | Indeterminate technical inspection, then pass/fail |
| `export` | Package editable project | Packaging milestones, then ZIP integrity and asset-hash validation |

Optional stages emit `skipped`. Stage states are `pending`, `running`, `completed`,
`skipped`, `failed`, `cancelled`, `interrupted`, or `blocked` by an earlier failure.
Do not animate a spinner on `pending`/`blocked` stages after a terminal failure.

Run states: `running`, `cancelling`, `completed`, `failed`, `cancelled`,
`interrupted`, `reconciling`. A cancellation request is **not** shutdown proof.
Runtime records independently report `allocating`, `stopped`, or
`stop_unconfirmed` (and backend-specific non-success states). External ComfyUI
ownership is explicit; stopping its local proxy does not shut down the user's GPU.

## HTTP API

All routes use the existing local-server authentication and origin rules.
Use the frontend's authenticated API client. Native media/SSE can use the existing
token-query mechanism where required; keep those credentials out of exported
documents, telemetry and copied links.

### 1. Plan and start

`POST /api/pipeline/plan`:

```json
{
  "packageId": "pkg_example0001",
  "baseRevision": 4,
  "backendId": "colab",
  "budgetUnits": 6,
  "narrationRuntime": "colab",
  "narrationUnits": 2
}
```

- `backendId`: `cpu`, `colab`, `byo-comfyui`.
- `narrationRuntime`: `local` or `colab`; remote voice currently supports Qwen.
- `comfyuiUrl`: optional HTTP(S) URL for the external backend; no embedded credentials.
- `budgetUnits`: whole-run allocation ceiling. `narrationUnits`: Qwen's portion,
  at most 4 units. The remaining allocation belongs to Colab visual media.
- An unchanged ready visual asset is reused. Enabled voice is synthesized for
  the run; regenerated voice invalidates its conditioned presenter clips.

Response includes `version`, `planHash`, `inputHash`, `baseRevision`, `stages`,
`jobs`, `reusableAssets`, `budget`, `requiresApproval`, `ready` and `issues[]` with
`code/message/action`. Allocation ceilings are **not predicted charges**.
The detailed media estimate is recalculated after real narration fixes the clip
lengths; if it exceeds the allocation, the pipeline stops before media allocation.

`POST /api/pipeline` uses the same body, adding `approvedPlanHash` when metered
compute is required. Approval binds the entire input package and options, including
voice and budget. Changed text/revisions/options require a fresh plan. Returns
HTTP **202** with `{status:202, run}` after staging; **409** for revision/busy/
approval conflicts; **422** for reported readiness issues. Invalid inputs return
400. Staging copies ready file-backed assets and validates declared hashes.

The implementation admits one pipeline at a time. Legacy run/render/export
requests are refused while it is active so they cannot block progress delivery.
Ordinary project edits and chat remain available.

### 2. Status and events

- `GET /api/pipeline`: `{runs:[...]}` retained run snapshots.
- `GET /api/pipeline/:runId`: `{run}` full snapshot.
- `GET /api/pipeline/:runId/events?after=123`: up to 500 durable events with
  `nextSequence` and `hasMore`. Fetch further pages until `hasMore` is false.
- Existing `GET /api/events`: live SSE event type **`pipeline.event`**.

Example event:

```json
{
  "version": 1,
  "type": "pipeline.event",
  "kind": "progress",
  "runId": "pipe_0123456789abcdef0123456789abcdef",
  "packageId": "pkg_example0001",
  "baseRevision": 4,
  "sequence": 38,
  "at": "2026-10-19T20:00:00.000Z",
  "stageId": "render",
  "message": "encoding",
  "progress": {
    "mode": "measured",
    "completed": 820,
    "total": 5700,
    "unit": "frames",
    "encodedFrames": 790,
    "fraction": 0.14,
    "source": "remotion"
  }
}
```

Kinds include `started`, `stage`, `progress`, `task`, `runtime`, `artifacts`,
`warning`, `diagnostic`, `heartbeat`, `result`, terminal states and reconciliation
events. Source job/attempt details are under `task.detail`; snapshots keep the
latest tasks keyed by `stageId:id`. `media_plan` supplies asset IDs, affected scene
IDs (including dependent jobs), batch and dependencies. `artifacts` adds available
local asset URLs after collection.

**Reconnect recipe:** subscribe to SSE and buffer events; fetch the run snapshot;
apply buffered events whose per-run `sequence` exceeds the snapshot's sequence.
On any sequence gap/reconnect, use the durable endpoint or fetch a fresh snapshot.
Deduplicate by `(runId, sequence)`. SSE's outer `id` belongs to the global
in-memory stream and is not the per-run sequence. A server restart resets the
global ring; it does not erase durable pipeline history.

Heartbeats are emitted every 10 seconds while the worker event loop is responsive.
They are liveness evidence, not progress. Frame/job progress is throttled to
approximately two updates per second; diagnostic previews to one per second.
Significant stage and scene boundaries are not throttled. The underlying backend
retains its redacted step logs locally.

### 3. Cancel, recover and download

- `POST /api/pipeline/:runId/cancel` with `{}`: requests cancellation; poll or
  subscribe through cleanup. Local subprocess groups receive termination;
  active Colab exec is stopped and the owned VM is torn down. Cancelling during
  allocation interrupts the allocation itself, so a run that is stopped before
  it starts is not billed. Cancelling a reconcile stops the reconcile, not the
  run. Allocation/control requests already in flight may finish before
  cancellation reaches cleanup.
- `POST /api/pipeline/:runId/reconcile` with `{}`: for a terminal/interrupted run,
  checks the persisted owned runtime identities and verifies/stops them. Does
  not regenerate assets or start a new allocation. Unconfirmed managed runtimes
  block new pipeline starts until resolved. A reconcile has a deadline
  (`COMFYRIZZ_RECONCILE_TIMEOUT_MS`, default 6 minutes, then a 10 s grace before
  the worker is killed) and records its own outcome on the run
  (`reconcile.confirmed`, `reconcile.timedOut`, `reconcile.cancelled`), so an
  unanswered CLI cannot leave the pipeline busy forever.
- One runtime directory serves one server process. `pipelines/owner.json` names
  the owning pid; a second server on the same directory is refused with an
  explanation instead of silently sharing runs and journals, and a lock left by
  a process that no longer exists is taken over. Event replay reads only the
  lines appended since the previous poll, and heartbeats update the run in
  memory rather than growing the journal every ten seconds.
- `GET /api/pipeline/:runId/assets/:assetId`: authenticated, byte-range-capable
  collected assets, when listed in the snapshot's `artifacts`.
- Completed `result.files[]` supplies download URLs and sizes for the MP4,
  captions, credits and editable ZIP.
- `result.packageUrl` returns the generated cut's package; `verificationUrl`
  returns its technical verification. Final artifacts are served only after
  the run reaches `completed`.

Retry is an explicit fresh plan/start, with a new run ID and approval where
needed. There is no automatic paid retry or automatic restart replay. Previous
outputs and diagnostics are retained for recovery; partial-result resume is not
implemented in this version.

## Recommended visual treatment

1. Persistent run card: project/revision, current stage, elapsed time, cancel.
2. Expandable nine-stage stepper, with clear skipped/blocked/failed states.
3. Narration rows keyed by scene: synthesizing, aligning, ready, review flagged.
4. Media rows keyed by job: dependency waiting, running attempt, progress if
   reported, reused, collected. Show an asset preview only after its URL exists.
5. Separate “Stopping GPU” state. Do not show the whole job as done while video
   rendering or export continues after the GPU has stopped.
6. Render counter plus encoding/muxing substate. Completed picture frames can
   reach the total before encoding and audio normalization finish.
7. Cost card: allocation ceilings, estimated media requirements, measured account
   deltas, unknown/external cost. Account-wide deltas are not per-session billing.
8. Error card: affected stage/scene/job, reason, retained outputs, shutdown state,
   appropriate re-plan/reconcile action, expandable diagnostics.
9. Completed card: playable video, captions, editable project and technical report.

**Avoid a synthetic whole-run percentage or guessed ETA.** Stage duration varies
with model downloads, voice length, batch size and hardware. Use a stage stepper
and real stage-local counters. Null progress means indeterminate, not zero.
Humanize phase identifiers; keep raw diagnostics collapsed by default. Do not
announce every frame to screen readers; announce stage changes and milestones.

## Runtime configuration

Server environment:

- `COMFYRIZZ_PYTHON`: host Python with local TTS/NumPy and pipeline dependencies.
- `COMFYRIZZ_HF_TOKEN_FILE`: protected model-access token file for Colab graphics.
- `COMFYRIZZ_COLAB_BIN`: optional Qwen CLI executable override.
- `COMFYRIZZ_QWEN_TTS_PYTHON` / `COMFYRIZZ_QWEN_ASR_PYTHON`: isolated local Qwen
  environments when `narrationRuntime: local`; Colab creates its pinned environments.
- `COMFYRIZZ_SYNCNET_PYTHON` / `COMFYRIZZ_SYNCNET_DIR`: installed SyncNet environment
  and checkout containing `syncnet_v2.model` for presenter generation.
- `REMOTION_BROWSER`: installed headless browser executable.

Presenter correction uses the measured source frame rate. It requires confidence
at least 3 and absolute offset at most 400 ms, shifts the picture at native speed,
preserves frame count, then remeasures against the exact narration. The final
diagnostic must meet the existing 80-ms/3-confidence gate. Low confidence or a
failed correction stops the stage with a regeneration/review message. No extra
GPU retry occurs. This is a timing diagnostic, not a guarantee of naturalness.

## Verification and remaining limits

Automated coverage includes revision/approval binding, start races, durable
replay, restart interruption, cancellation cleanup state, secret redaction,
authenticated range downloads, stage ordering, failed generation and failed sync.
An actual CPU narration → timing → Remotion → audio verification → editable ZIP
smoke run exercises the production worker. Existing backend tests use fake Colab
and ComfyUI; no new paid allocation is needed for these tests.

Evidence on this host: a real **151-frame** Kokoro-narrated CPU run completed all
applicable stages and produced 12 measured render-progress updates. Automatic
SyncNet correction was also run against both original Hermes presenter clips:
the pipeline independently applied **3/4 native frames**, then measured **0 ms**
for both, with confidence **9.292/9.818**. Exact presenter-input preparation
produced **305/369 frames at 24 fps** and two valid, workflow-hashed jobs.
No new Colab allocation was used; balance remained **365.95**, usage **0.00/hr**,
active assignments **0**. A live paid run of the newly combined API remains
unverified; its provider components were previously exercised during production.

A full-HD version of the short CPU smoke test is published at
[CPU pipeline example](https://mail.tailec998.ts.net:8451/cpu-pipeline/index.html),
with MP4, captions and editable ZIP links. It is 151 frames at 30 fps, with local
Kokoro narration. The original 360p test exposed fixed-pixel caption sizing in
`apps/renderer/src/captions.tsx`; technical checks passed but captions were too
large at that resolution. This is a remaining low-resolution layout issue for
the preview/editor integration. The published example uses the normal 1080p
composition size and has been checked with a sampled frame.

Remaining instrumentation limits are explicit: no truthful byte-level model
download percentage, no reliable overall ETA, and no automatic perception score
for generated imagery or natural speech. Local model loading and ZIP creation
remain indeterminate substages. The app exposes technical outcomes and ASR review
flags; continuous audiovisual review still matters.

Durable files are under `<runtime>/pipelines/<runId>/`: `state.json`,
`events.jsonl`, immutable input specification, staged/generated package, audio,
runtime logs, sync reports, render props, verification and exports. These files
are runtime data, not repository fixtures. The branch does not include model
weights, credentials, production media or the local package-manager lockfile.
