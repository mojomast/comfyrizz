# UX and video-result remediation — subagent implementation plan

**Status:** planning only; implementation has not started. October 26, 2026.
**Baseline:** audited upstream `f16d188` with deployment fix `2de992d`.
**Inputs:** [current-code audit](../research/UX_RESULTS_AUDIT_20261026.md) and
[outcome evaluation plan](../research/UX_RESULTS_EVALUATION_20261026.md).

## Objective and completion rule

Deliver a usable, recoverable creative loop: accurate brief → reviewed plan →
authorized generation → actual-media review → scoped correction → faithful export.
Keep simple modes simple while preserving the same project, authority, cost,
selection and review semantics in every mode.

Each packet must finish at an observable mounted behavior, not only a new helper.
Work can merge behind an unavailable capability until dependencies are integrated;
that is **component complete**, not **user-journey accepted**. The findings are
static traces: begin each fix by reproducing it with deterministic fixtures or
documenting why the current baseline already resolves it.

## Execution protocol

### Coordinator and working trees

- One coordinator owns the integration branch, dependency graph, shared contracts,
  file leases, conflict resolution and milestone acceptance.
- Use separate worktrees/branches for implementation workers, based on the latest
  accepted integration commit. Do not implement directly in the running release
  worktree. Prefer persistent storage here: `/tmp` was full during deployment.
- Inventory current disk space, Git state and upstream changes first. Preserve
  the existing loader fix and local research documents. If the base changes,
  revalidate cited findings rather than applying this plan blindly.
- Start implementation from a branch containing these two research documents and
  this plan (merge or carry forward the documentation PR first). Do not stage
  `.smoke-runtime/`, `.tmp/`, credentials, runtime copies or unrelated production work.
- Use synthetic runtimes and local fixtures. No test may attach to the live service
  or dispatch paid model/GPU work. Existing approved audio/video may inform expected
  behavior; do not commit private production bytes or substitute new references.
- Keep the previous productions, rejected takes, owner edits and delivered links
  intact. Follow the standing voice policy in the original workspace's
  `docs/VOICE_CASTING_STANDARD.md`; incorporate a portable policy into docs during
  the casting packet without hard-coding machine-local reference paths.

### Parallelism and file leases

Run **up to four implementation workers plus one independent test/review worker**
at a time initially. Reduce concurrency if disk/memory or shared-file ownership
becomes the bottleneck. A packet is a bounded assignment, not a permanent agent;
reuse a lane's worker for dependent packets where that retains useful context.

The coordinator exclusively edits `apps/server/src/app.mjs` and
`apps/web/src/main.ts`, plus root build/lockfile changes. Workers supply exported
adapters, signatures and exact wiring instructions. The coordinator mounts each
completed adapter immediately and reruns its mounted acceptance cases; integration
is ongoing, not deferred until the final wave.

For other shared files, an explicit lease names the active packet and base commit.
Separate worktrees prevent accidental overwrite, but do not remove semantic merge
conflicts. Never grant overlapping leases merely because edits appear to touch
different line ranges. Transfer a lease only after its preceding change is merged.

### Worker return contract

Every worker returns:

1. Packet ID, base and head commits, changed paths and concise behavior summary.
2. Before/after reproducer and test commands/results; distinguish executed from
   proposed checks. Include mounted evidence or identify the exact wiring pending.
3. Contract/schema changes, compatibility behavior and migration/rollback notes.
4. Fake backend dispatch counts, artifact hashes, revision or state evidence where
   relevant; never expose secret-bearing logs.
5. Shared-file wiring handoff, unresolved assumptions and remaining limitations.

The reviewer tries the failure path, not just the happy path. Return any out-of-
scope discovery to the coordinator; do not silently broaden a packet or rewrite
unrelated infrastructure.

### Reusable implementation prompt

> Implement packet UXxx from `docs/tasks/UX_RESULTS_REMEDIATION_20261026.md` on
> the assigned branch at BASE_COMMIT. Read its audit evidence and applicable
> repository instructions. Your leased paths are PATHS; do not edit coordinator-
> owned files or another packet's paths. Reproduce the finding using isolated
> fixtures, implement the smallest coherent fix using the agreed contracts, and
> run the packet's meaningful regressions. No live service, paid calls, secrets or
> existing production mutations. Return the worker contract above. A mocked helper
> pass is not proof of mounted integration or subjective creative approval.

## Shared contracts to freeze in UX00

Extend existing schemas and stores; this is not a new production framework. Freeze
only the interfaces needed by the first slice, then version amendments before
dependent workers begin. Proposed semantic contracts (names are not existing APIs):

| Contract | Required agreement |
| --- | --- |
| Command/admission | Server-resolved binding, stable command ID, expected revisions, immutable approved-plan/action identity, request hash and typed refusal; no caller boolean authority. |
| Execution/reconciliation | Queued/claimed/running/terminal versus unknown execution; durable start/cancel/settle effects; claim fencing; adopt attributable work before any redispatch. |
| Budget | Ceiling, spent, reserved, available and unit/provenance separately; reservation identity, unknown liability, repeatable settlement and cap-effect evidence. |
| Snapshot/replay | Complete current plan/action/decision projections, committed sequence and epoch; expired cursor/reset semantics and authoritative refetch. |
| Project/session | New-project reset, brief versus scene-edit invalidation, preview-ready versus export-ready, actual save state, session generation for rejecting late old-project events. |
| Mutation scope | Canonical project/shot/clip/take/asset/line IDs, source revision, requested change and preserve set; enforced across every mutation tool. |
| Take/selection/review | Artifact hash and source/reference fingerprint; selection command CAS; technical evidence and human verdict independent from automatic selection. |
| Media resolver | Authorized source identity plus expiry, cancellation/deduplication and bounded renewal; no persistent expiring URL as artifact identity. |
| Delivery snapshot | Package+editor revisions, exact selected media/timing/reference inputs, aspect and export intent; immutable fingerprint and versioned output manifest. |
| Voice reference | Approved immutable recording identity/hash, character/language/delivery direction, provenance and rejected status; native validation bound to reference/model/workflow. |
| Content evidence | Explicit/inferred/defaulted/unresolved preferences; claims linked to source excerpts/date/qualification; user approval cannot be model-authored. |

Budget authority, selection and review must not become new repeated approval
dialogs for harmless edits. Preserve draft downloads as drafts; explain missing
final-review evidence rather than silently declaring it approved or blocking all
preview exports.

## Packet status tracking

All packets start **planned**. Track `reproduced → implementing → component
verified → mounted/accepted`, with separate blocked state and named dependency.
An obsolete finding may close as `already resolved` only with current-code evidence
and the relevant regression. Do not treat a docs update as an implementation pass.

## Verification and release policy

The packet catalog and launch schedule follow this policy. Read the packet's hard
dependencies and file lease before starting work; wave grouping is not permission
to edit a still-owned file.

### Test layers

1. **Focused packet regressions:** test the consequential failure, including the
   actual mount/route when the defect is wiring. Scripted models and fake execution
   adapters provide observable dispatch/settlement counts. No source-string-only
   assertion can establish runtime wiring.
2. **Cross-packet integration:** clean runtime with named scene IDs, multiple
   disjoint takes, speech/video fixtures, portrait/square/landscape packages,
   caption overrides, referenced assets and a spent/reserved budget. Inject
   disconnect/crash/storage faults at contractual boundaries.
3. **Rendered artifact checks:** decode short local fixtures, verify frame count,
   aspect, caption parity and source hashes; reopen the actual archive. A valid MP4
   alone does not prove it contains the intended version.
4. **Browser acceptance:** real mounted UI, keyboard and 320/390px reflow; Chromium,
   Firefox and WebKit where installed. Report unavailable browser/AT/device checks
   explicitly. Viewport emulation does not establish real iOS behavior.
5. **Human quality/usability:** task-based comparison against the brief, including
   audible performance review. Separate follow-up from deterministic release
   checks; real generation trials require an explicit scope/budget. Do not use
   ASR, muted playback or hashes as evidence of appealing acting.

Existing commands, to run in isolated worktrees with suitable temporary storage:

```sh
pnpm install --frozen-lockfile
pnpm run build:libs
pnpm -C packages/agent test
pnpm -C apps/server test
pnpm -C apps/web test
pnpm -C apps/web typecheck
pnpm -C apps/web build
pnpm -C apps/web test:e2e -- <focused-spec>
```

Choose the affected tests per packet; do not run every suite for every change.
The integration owner runs `pnpm check`, the production web build and the integrated
offline browser journeys at milestone gates. Run Python/renderer suites when those
paths change. Audit the chosen browser fixture server to ensure it uses isolated
state and cannot call real providers. The new multi-browser project names become
valid only after the QA configuration packet lands.

### Data compatibility and rollback

- Exercise old package/editor/take records, queued actions, terminal actions with
  unsettled holds, existing exports and missing-reference records. Missing review
  or provenance becomes unknown/not reviewed, never invented approval.
- Version new records and maintain old readers where feasible. Any incompatible
  migration is explicit, fixture-tested, resumable and backed up. Do not rewrite
  every saved project just because the server starts.
- When restoring the old server after a failed deployment, first stop the new
  executor and reconcile attributable active work. Do not restore stale financial
  snapshots over real incurred costs or let two executors own the same runtime.
- Deploy only after the relevant milestone is accepted and deployment is requested.
  Back up runtime and service configuration; retain the previous release and video
  delivery links. Check project/source hashes, service health, a returning project,
  captions/downloads and rollback compatibility.

### Completion evidence

The release report lists accepted packet IDs, tested commit, commands and results,
artifact examples, known limitations and manual checks still pending. Record time
to first useful preview, correction success, preservation of unrelated content,
recovery success and cost per accepted result when data exists. Establish baselines
before numerical performance claims; do not invent deadlines or improvement rates.

## Implementation packets

Effort labels describe scope, not promised elapsed time: **S** is a narrow seam,
**M** spans a component and its consumer, **L** involves durable cross-layer state.
Split L packets at the stated checkpoints; never return an unreviewable broad diff.
Paths below are existing entry points, not permission to edit every file in a
directory. The coordinator records exact write sets before launch. Tests belonging
to a component follow its owner; UX20 owns new cross-system acceptance fixtures.

### UX00 — Baseline, contracts and compatibility [M]

**Owner:** coordinator/contracts agent. **Depends:** none.
Inventory current route/mount coverage and schema exports; establish the contracts
above using existing schema conventions. Freeze the first admission/session/media
fixtures now, then export/voice/evidence amendments before their consumers start.
Own shared schema/type changes and document the canonical field/validator location.
Record an entry-point matrix for all start, cancel, select, revert and export paths,
including legacy/internal queues. Define unbound-project compatibility explicitly.
**Accept:** fixtures validate; packet write sets and old-record behavior are agreed;
no duplicate private DTOs. No broad schema rewrite is a prerequisite for the P0 fixes.
**Status:** component verified — see `docs/tasks/UX00_CONTRACTS_20261026.md` for the
frozen contracts, entry-point matrix and Wave 1 leases.

### UX01 — Universal generation admission [M, P0]

**Owner:** execution lane. **Depends:** UX00 first authority contract.
**Own:** `apps/server/src/pipeline.mjs`, initial admission portions of `run.mjs`,
production authority adapter and route-level tests; coordinator wires `app.mjs`.
Resolve production binding on the server; require current authorized action and
active intent before any allocation for bound packages. Close direct pipeline and
legacy bypasses. Preserve explicitly unbound behavior. Use precise refusal codes;
unsupported bound entry points refuse rather than fall back to unguarded execution.
**Accept:** actual mounted routes with fake launchers produce zero launches for
exhausted/paused/cancelled/stale/rejected/missing authority; valid admitted request
works, and a repeated command cannot allocate twice. Hand the `run.mjs` lease onward.

### UX02 — Budget effects and recoverable accounting [L, P1]

**Owner:** budget lane. **Depends:** UX00; coordinate authority contract with UX01.
**Own:** ledger/reconciliation modules, cap command effect and
`apps/server/src/routes/productions.mjs`, `productions/iteration-routes.mjs`;
lease `productions/actions.mjs` and `commands.mjs` before UX03.
**A:** make cap commands durably apply or explicitly reject unsupported entry;
preserve structured available/requested/spent/reserved details; derive estimates
from actual package duration and remaining allowance.
**B:** durable reservation/effect identity, orphan-hold reconciliation and independent
settlement/release retries. A terminal action must not hide unfinished accounting.
Provide executor-facing APIs; `run.mjs` adoption/recovery wiring lands with UX03.
**Accept:** fault after reserve-before-action, cap journal-before-ledger and failed
settlement remains recoverable after repeated restart; no duplicate settlement or
unexplained permanent hold. Unknown provider liability stays conservative. Both
cap endpoints agree; recommendations vary correctly with reserved/spent allowance.

### UX03 — Server-owned execution, cancellation and restart [L, P1]

**Owner:** execution lane. **Depends:** UX01 and UX02 execution/accounting contract.
**Own:** `run.mjs`, production actions/commands/outbox execution/pipeline adapter;
coordinator mounts startup/event drain and updates the browser handoff with UX07.
**A:** claim/fence outbox effects, bind one action→execution identity, adopt existing
attributed work and recover dropped acknowledgments. Do not resubmit uncertain work.
**B:** durable cancel fan-out, retained abort handles, pre-start intent recheck and
settlement retry independent of terminal action state. Pause stops future admissions;
make active-work semantics explicit. Cancel is not proof of compute shutdown.
**Accept:** mounted HTTP dispatch/start/cancel with crashes and competing drains
gives one attributable execution or explicit unresolved reconciliation. Browser
dispatch→reload no longer strands work; a legacy duplicate start cannot race the
server dispatcher. Cancellation surfaces requested/stopped/unconfirmed accurately.
Do not activate server dispatch before the browser double-start compatibility gate.

### UX04 — Hydrated recovery and event reset [M, P1/P2]

**Owner:** recovery lane. **Depends:** UX02 and UX03 merged (route leases released).
**Own:** server production snapshot routes, `events.mjs`, web
`productions/client.ts` and `easy/events.ts` with their tests.
Return complete current plan/action/decision/error projections with committed cursor;
handle epoch changes and expired replay explicitly. Reconcile server-owned execution
instead of reconstructing it from a spinner. Expose recovery actions that distinguish
reconnect, local download retry, shutdown reconciliation and a new generation.
**Accept:** recreate client/server mid-run or pending decision and recover equivalent
actionable state; truncated history/restart triggers snapshot refresh. Late events
from project A cannot update project B. Scope inference, new paid work and "done"
status must never follow merely from an empty replay.

### UX05 — Undo, revision and save-state truth [M, P1]

**Owner:** editor-state lane. **Depends:** UX00 revision/session contract.
**Own:** web `editor/store.ts`, `editor/autosave.ts`, related commands/serialization
and tests. Remain the contact for export-sidecar serialization; do not grant UX15
a competing store writer.
Keep acknowledged server revision outside undoable content; preserve real conflicts,
offline recovery and manual baselines. Export an actual save-status subscription
distinguishing local draft, saving, server-saved, conflict and error.
**Accept:** edit→save→undo→save→redo→save advances revision correctly; a second-tab
edit still conflicts. Held/rejected save never reports Saved through the shared
subscription. UX08 mounts the Studio consumer.

### UX06 — First useful result and stable progress [M, P0/P1]

**Owner:** journey lane. **Depends:** UX00 session contract.
**Own:** `easy/mount.ts`, `cpu-path.ts`, Super Easy session/mount/progress view.
Represent preview-ready separately from finished MP4; provide Review/Export handoff
and explicit error/retry/escape controls. Keep progress DOM/media/focus stable;
update a persistent live region on meaningful stage changes, not every fraction.
Progress means measured stage work, not invented time remaining.
**Accept:** real `mountEasyStudio` with fixture CPU build reaches playable review;
planning failure is visible and actionable. Frequent progress events preserve a
playing sample and focused escape. No final-ready claim without an actual artifact.
Transfer the journey files to UX07 after this independently acceptable fix.

### UX07 — Project identity, replanning and approval handoff [M, P1/P2]

**Owner:** same journey lane. **Depends:** UX06; UX03 for execution handoff activation.
**Own:** `easy/mount.ts`, store/home, Idea/Plan steps, `plan-writer.ts`,
`approve-generate.ts`, Super Easy start-new/mode handlers.
Use one clean-start operation preserving project A while creating B; invalidate old
async sessions. Preserve unsent prompt on mode switch. Differentiate brief changes
from scene-text edits. Bind required decision answers to proposal identity and pass
them to approval; drop stale answers on plan change. Stop the browser from owning
dispatch→start once UX03 is integrated, using its idempotent compatibility contract.
**Accept:** New video and Make another reset IDs/cast/export/decisions; idea B
actually rebuilds B, while headline edits do not rebuild the whole brief. Nondefault
decision is submitted correctly. Reload or duplicate approval starts no second run.
UX07-A (project/brief/decisions) can land before UX03; UX07-B is the atomic handoff.

### UX08 — Ask, visible settings and truthful Studio header [M, P1/P2]

**Owner:** shell-guidance lane. **Depends:** UX05 and UX07-A; UX09 for scoped Ask gate.
**Own:** `easy/ask-drawer.ts`, `agent-settings.ts`, project-name/shell APIs;
take the `easy/mount.ts` lease after UX07, coordinator wires `main.ts`.
Mount real provider-aware Ask against the current conversation/project; preserve
prefill and canonical scope. Expose visible mode-independent AI settings instead
of clicking hidden inspector elements. Subscribe header to actual save state;
show Untitled/New video before binding and wire persistent rename.
**Accept:** connected Ask opens conversation, disconnected Ask opens visible setup;
closing restores focus/context. Switching project cannot send prior context.
Pending/failed save updates Studio correctly; rename agrees on reload/recent/export.

### UX09 — Authoritative scope across agent tools [M, P1]

**Owner:** agent-policy lane. **Depends:** UX00 target/authority contract.
**Own:** server `agent-chat.mjs`; agent `conversation.ts`, `production-tools.ts`,
`production-planner.ts` and related tool tests.
Propagate canonical scope into production tool context; resolve structured IDs
against real state, including named scenes. Define absent versus empty target set.
Enforce one mutation policy across ordinary and production tools, including build,
locks, intent and preserve constraints. Share remaining-capacity logic with planner.
**Accept:** mounted scripted-model turns accept legal `s_intro`/line scope, reject
build-before-read, paused mutation, unrelated patch and scope expansion without
changing state. Exhausted/locked takes yield a valid refusal or bounded proposal.
Hand shared agent files to UX17, then UX18; they must preserve this policy.

### UX10 — Take selection transactions and reference freshness [L, P1]

**Owner:** take-state lane. **Depends:** UX00; UX01 for authority refusals;
UX03 for end-to-end regenerate activation.
**Own:** server `takes/model.mjs`, `gate.mjs`, `select.mjs`, `routes.mjs`, ingestion
and tests; UX11 owns the web take API and consumes this contract.
**A:** reference-aware source fingerprints at ingest/read/gate; preserve unknown
legacy evidence rather than invent approval. Distinguish actual error codes and
require run identity before returning started.
**B:** caller revision/expected selection plus stable command ID; recoverable
package/sidecar selection and compensating revert. Wire production binding via
coordinator; do not introduce a second writer outside shared transaction semantics.
**Accept:** two-tab conflict, identical Revert twice and crash between projections
are safe; direct/transitive reference changes become stale. Scope and authority
refusals cannot appear as queued/started. Auto-selection never becomes human review.

### UX11 — Media access, real narration and timeline hydration [M, P1/P2]

**Owner:** media-infrastructure lane. **Depends:** UX00 media contract;
UX10 API contract for selection consumers (can build against frozen fixtures).
**Own:** web take/media API adapters, shared ticket resolver, thumbnail client,
inspector/audio preview modules, timeline mount adapter; coordinator handles main.
Preserve expiry metadata; deduplicate and bound requests/renewal; decode actual
selected audio and remove demo-tone fallbacks from production mounts. Forward
timeline thumbnail/open hooks. Prioritize current/next shot instead of waiting for
serial hydration of the entire project; cancel stale requests.
**Accept:** distinct WAV fixtures produce matching samples/peaks; missing bytes show
unavailable. Idle→seek refreshes expired tickets without losing position; old response
cannot overwrite new selection. Mounted timeline renders thumbnails and opens once;
100-shot delayed fixture becomes usable before all tickets load.

### UX12 — Exact-target, audible and accessible review [L, P1/P2]

**Owner:** media-review lane. **Depends:** UX11 and UX10 selection contract;
UX09 for correction end-to-end acceptance.
**Own:** `viewer/asset-viewer.ts`, viewer model, `takes/compare.ts`, viewer styles;
coordinator wires explicit targets and asset-list sources in main.
**A:** immutable shot/clip/take/asset target metadata, clear/reload on compare
navigation, stale-fetch rejection and disabled Keep until valid. Resolve Files
audio/video on demand with visible loading/errors.
**B:** stable players, shared seconds/frame comparison with explicit end behavior,
one audible monitored take, honest/persistent favorite semantics, media-relative
annotations under zoom/letterbox. Preserve button Space/Enter and modifier keys;
sync audio/video playing/pause/end/error state and destroy media on close.
**Accept:** older historical take correction uses exact IDs; rapid cross-shot
navigation never submits another shot's take. 3s/5s clips at 1s both show 1s;
focus does not reset playback. Keyboard actions work, same image feature maps to
same source region, 50 open-close cycles leave bounded nodes and no residual audio.

### UX13 — Honest auditions and accessible character editor [M, P1/P2]

**Owner:** casting lane. **Depends:** UX00, UX11 media resolver;
UX03 before paid prompt/native audition dispatch can be enabled.
**Own:** web `characters/*`, server character audition/routes, capability adapter;
coordinator mounts actual production/model context.
**A:** connect ordinary audition to `requestAudition`; Describe returns a real
prompt-plan status or an accurate unsupported explanation, never a Kokoro substitute.
Use real modal containment/restoration for Characters.
**B:** immutable candidate config/audio identity for play and select; repair standalone
comparison before mounting. Rejected candidates remain rejected after reload.
**Accept:** mounted preset audition calls correct route; Describe calls no stock
synthesis path. Prompt work uses production authority. Played/selected hash matches;
Tab stays in the modal and Escape closes only the topmost surface.

### UX14 — Approved recording and native-transfer continuity [L, P1]

**Owner:** same casting lane. **Depends:** UX13, UX10 and UX03.
**Own:** character voice schema/projection consumers, native-test/conditioning adapter,
voice-mode/reference UI and casting docs; shared schema amendments through UX00.
**A:** portable approved reference asset with checksum/provenance, language, delivery
direction, explicit selection/rejection and missing-byte states. Inspect actual
backend capability; do not promise a modality because a label exists.
**B:** one native transfer test tied to exact recording/model/workflow/conditioning
inputs and a separate human verdict. Changed dependencies invalidate acceptance.
Returning characters reuse their own references; appearance-only edits preserve
voice. Show each visual/motion reference's actual conditioning/prompt-only use.
**Accept:** fixture reference bytes unchanged across projects; unavailable reference
does not recast. Changed reference invalidates transfer; technical success cannot
approve acting. Basil, Molty and Don Piedro remain separate; QC1/QC2 stay rejected.
Real dry audition/native-speaking validation is a separately authorized human
acceptance step; fixture success alone does not establish voice quality.

### UX15 — Canonical immutable export and publication [L, P1/P2]

**Owner:** delivery lane. **Depends:** UX00, UX05 serialization and UX10 freshness.
**Own:** server `export.mjs`, `routes/render.mjs`, delivery snapshot/artifact modules,
renderer `scripts/render-package-lib.mjs`; coordinator wires every export entry.
**A:** one package/editor/selection/timing snapshot and fingerprint, shared preflight,
caption override parity, aspect-preserving defaults and explicit draft/final intent.
Gates apply even with no take sidecar. Keep source completeness and rights exclusions
visible; distinguish private editable and redistributable archives.
**B:** freeze actual input bytes, render and ZIP from the same staging set; publish
versioned bundle/manifest atomically. Stable artifact lookup supports existing
downloads and prior versions. Retention policy must not delete delivered assets.
**Accept:** caption-only edit agrees across preview/burn/SRT/VTT/archive and retains
speech hash; portrait remains portrait on both paths. Mid-render source mutation
uses staged bytes or explicitly fails. Failed publication leaves prior bundle valid.
Unknown creative review stays visible and does not become a final approval.

### UX16 — Reopenable export and honest delivery UI [M, P1]

**Owner:** export-UI lane. **Depends:** UX15; UX08 for established shell wiring.
**Own:** `easy/steps/export.ts`, artifact client/presentation and export-state types
through UX00; coordinator connects ordinary editor MP4 action to the same contract.
Persist artifact ID/manifest, not Blob or expiring URL. Retrieve prior output after
reload with renewed access. Present draft/final status, dimensions, review gaps,
caption/source contents and missing archive inputs before final export.
**Accept:** export→fresh module/page→Download calls no render endpoint; missing or
expired artifact has truthful recovery. Ordinary MP4 and Studio bundle show the
same snapshot/preflight facts and preserve the intended aspect and caption revision.

### UX17 — Compiled visual fidelity, timing and duration [L, P1/P2]

**Owner:** agent-quality lane. **Depends:** UX09; coordinate snapshot inputs with UX15.
**Own:** `chat-project.mjs`, agent scene schema/build loop, `agent-chat.mjs` context,
`productions/plan-from-package.mjs`, relevant compiler helpers/tests by explicit lease.
**A:** bounded visual role/placement and canonical asset traversal including
`scene.media`; compiled diagrams/jokes must not shrink to decorative thumbnails.
**B:** typed requested duration, overlap-aware compiled runtime and structured
estimated/measured/stale timing/coverage. Evaluate post-update revision before build,
including batched tool calls; preserve intentional holds and point-edit boundaries.
**Accept:** worked-example/comedy fixtures remain legible in rendered frames;
split/compare includes both assets. Cut/fade duration meets declared tolerance or
reports mismatch; overfull narration cannot bypass checks by batching update+build.
A 4s clip at 0.4× reports 10s coverage, not 14s. Manual timing is not silently stretched.

### UX18 — Evidence-backed briefs and useful scaffolds [M, P2]

**Owner:** same agent-quality lane. **Depends:** UX17 shared-file lease; UX00 evidence
contract. Independent brief fixtures may be prepared after UX09.
**Own:** agent/server brief modules, claim/source adapters, conversation evidence
tools/prompts and associated evals. Coordinator approves shared schema amendments.
Preserve explicit style/voice/language; distinguish user choice from inference and
default. Track factual claims to supplied/retrieved excerpts, dates and qualifications;
research content is data, not instructions. Reuse existing retrieval where available;
otherwise offer source/omit/hypothetical, not a fabricated sourced claim. User consent
is server-owned. Make scaffold topic/language/silent-mode appropriate.
**Accept:** unsupported current statistic is not validated by a provenance enum;
qualified excerpt stays qualified; malicious source does not gain tool authority.
Paper-cut/French/authoritative preferences survive; silent/non-numeric/fiction briefs
avoid phantom speech and irrelevant numbers. Inspect reachability of legacy showcase
fallback; if user-reachable, preserve the user's topic or label demo explicitly.

### UX19 — Non-obstructing shell and interaction efficiency [M, P2]

**Owner:** shell-accessibility lane. **Depends:** UX07-A/UX08 for journey/layout leases;
UX11 for preview performance wiring.
**Own:** Easy responsive CSS, shared shell CSS, toast component; coordinator modifies
main's scene-card update and narrow-editor advisory handler.
Use in-flow or measured/safe-area-aware action footer, non-obstructing narrow-editor
advisory and persistent/paused actionable toasts. Cache scene-card references and
change active classes only when the active scene changes; measure before/after.
**Accept:** last focused control remains visible at 320px/200% text/400% zoom with
long errors; software-keyboard checks documented separately. Focused toast action
survives its former timeout. Delayed large-project fixture records latency/dropped
frames; reduced UI motion does not change the user's authored video.

### UX20 — Independent mounted acceptance and fault fixtures [M, ongoing]

**Owner:** QA/reviewer lane. **Depends:** none to start; UX00 contracts for integration.
**Own:** new isolated cross-system fixtures, browser config and acceptance specs;
coordinate edits to existing component tests with their packet owners.
Start during Wave 0. Create scripted model/fake runtime and labelled media fixtures;
make outbound paid/external requests fail. Assert actual decoded target identity and
state changes, never insert missing UI to satisfy a test. Add Firefox/WebKit projects
and coverage for keyboard/focus, ticket expiry, late events, mobile reflow and reload.
**Accept:** demonstrate relevant pre-fix failures, then verify the mounted fix per
packet. Include fault injection before/after dispatch, selection and export commits.
Report which browsers/devices/AT were actually exercised; no blanket conformance
claim from Axe or static harness markup. Coordinate task-based usability follow-up.

### UX21 — Incremental integration, release and documentation [M, ongoing]

**Owner:** coordinator/integration agent. **Depends:** starts with UX00;
each milestone depends on its accepted packets below.
**Own:** `app.mjs`, `main.ts`, root build changes, integration log and final docs.
Mount adapters as they arrive; lease contributors' files only after handoff.
Reconcile real capability claims in README/default mode/iteration/voice/quality
docs. Keep generated, auto-selected, technically checked and human-reviewed separate
across all visible states and delivery receipts. Avoid synthetic API click bridges.
**Accept:** no orphan feature component counted as fixed; merged checks pass,
milestone evidence is recorded, compatibility/rollback is exercised on fixtures,
and the final report separates code, browser and human review. Stage a candidate
release only after the applicable gate; live deployment is a separate operation.

## Ownership lanes and serialization

| Shared surface | Lease order / standing owner |
| --- | --- |
| `app.mjs`, `main.ts`, root tooling/lockfile | UX21 only, incremental wiring for all packets |
| Shared record validators/types | UX00; amendment request from each producer/consumer |
| `run.mjs` | UX01 → UX03; UX02 supplies accounting APIs instead of concurrent edits |
| `productions/actions.mjs`, `commands.mjs` | UX02 → UX03 |
| Production routes/snapshot | UX02 → UX04 |
| `easy/mount.ts`, store/session/plan handlers | UX06 → UX07 → UX08; later wiring by explicit handoff |
| `editor/store.ts`, autosave/commands | UX05; later export requests go through this owner |
| Server take model/routes/selection/gate | UX10 only |
| Web take API/ticket/thumbnail/inspector/timeline adapter | UX11 only; consumers UX12/UX13 use its API |
| Viewer model/component/Compare | UX12 only, including its keyboard/accessibility fixes |
| Characters web/server audition/voice/native test | UX13 → UX14 |
| Export backend/renderer versus export UI | UX15 and UX16 respectively; editor serialization remains UX05 |
| Agent chat/conversation/planner | UX09 → UX17 → UX18 |
| `chat-project.mjs`, composition/coverage helpers | UX17; coordinate compiler edits with UX15 before lease |
| Easy/shell responsive CSS and toast | UX19; component-specific accessibility remains each component's owner |
| New cross-system/browser acceptance and config | UX20; component regressions remain packet-owned |

## Launch schedule and milestone gates

"Parallel" means eligible independent work, subject to the four-worker limit and
file leases. Consumers can build against frozen fixtures early; that does not
remove hard dependencies for mounted acceptance. Do not launch all 22 at once.

| Wave | Eligible assignments | Coordinator/reviewer gate |
| --- | --- | --- |
| 0 | UX00 + UX20 fixture baseline; UX21 active | Pin base, map entry points, first contracts, exact write sets and isolated execution |
| 1 | UX01, UX05, UX06, UX09 in parallel | **M1 first-result/trust:** rejection starts zero work; CPU success/error usable; undo/save sound; scoped tools cannot expand edits |
| 2 | UX02, UX07-A, UX10-A, UX11 initial resolver/decoding; rotate slots as dependencies permit | Preserve clean project identity, reference freshness and actual-media identity; contract-level consumers ready |
| 3 | UX03 after UX02; UX10-B; UX08 after UX07-A/UX05; UX12 after UX11; UX13-A can take a free slot | **M2 durable execution:** UX03 + UX07-B + UX04 accepted together; browser/server cannot double-start; cancel/restart/settlement and snapshot recovery pass |
| 4 | UX15 after UX05/UX10; UX13-B → UX14; UX17 → UX18; UX19 in free slots | **M3 faithful correction/delivery:** UX10/11/12/15/16 plus UX08/09; exact scope, unchanged unrelated work, caption/aspect/archive parity and reload download |
| 5 | Finish UX16, UX14, UX17/18/19; UX20 cross-browser/full journey and UX21 docs | **M4 quality/continuity:** preserved voice references, explicit native approval, evidence/timing/rendered fixtures, accessibility and reviewed capability docs |

UX04 starts as soon as UX03 is merged, even if other Wave 3 tasks remain. UX16
starts as soon as UX15 is merged. Wave labels are a suggested dispatch order, not
an artificial barrier or license to ignore prerequisites. M1 can ship independently
with accurate capability limits; do not describe the complete remediation as done
until M4 is accepted. No paid prompt/casting path is enabled before M2 admission,
execution and cancellation/accounting integration passes.

### Essential dependency chains

```text
UX00 → UX01 → UX03 ← UX02
UX06 → UX07-A → UX07-B ← UX03 → UX04
UX05 + UX07-A + UX09 → UX08
UX00 → UX10-A/B → UX15 → UX16
UX00 → UX11 → UX12 ← UX10 + UX09
UX11 → UX13-A/B → UX14 ← UX03 + UX10
UX09 → UX17 → UX18
UX07-A + UX08 + UX11 → UX19
UX20 verifies each mounted slice; UX21 integrates throughout.
```

## Audit coverage checklist

Use the audit's exact source references as the repro starting points. These compact
groups account for every reported issue; update packet status with evidence rather
than deleting findings during implementation.

| Audit issue(s) | Packet(s) |
| --- | --- |
| CPU result/error handoff; stable progress/focus/media | UX06 |
| Brief changes reuse old scenes; new-project state; unsent prompt; unanswered/ignored plan choices | UX07 |
| Ask disconnected; invisible Connect; constant Saved; misleading title/rename | UX05, UX08 |
| Export download lost on reload | UX15, UX16 |
| Ordinary/Describe audition mismatch; candidate identity; Characters modality | UX13 |
| Fake narration/waveform; timeline hooks dropped; serial preview hydration | UX11 |
| Wrong correction IDs; wrong-shot compare; muted/unstable comparison; annotation coordinates | UX09, UX12 |
| Approved recording/native transfer gap; reference actual-use disclosure | UX14 |
| Caption sidecar/export mismatch; inconsistent readiness/aspect/archive; live-byte export race | UX05, UX10, UX15, UX16 |
| Scope not wired; ordinary-tool bypass; named IDs; exhausted/locked planner takes | UX09 |
| Tiny SVG compositions; missing measured coverage; batch warning bypass; requested duration; split assets omitted | UX17 |
| Unsupported sourced/approved claims; lost explicit preferences; generic/localization/silent scaffolds; conditional demo fallback | UX18 |
| Eval structural-only and stale skill documentation | UX17, UX18, UX20, UX21 |
| Pipeline authority bypass | UX01 |
| Stranded dispatch; ineffective cancellation; legacy intent omission | UX01, UX03, UX07-B |
| Undo after successful save conflict | UX05 |
| Stale reference approval; selection/revert CAS, double revert and split writes | UX10 |
| Orphan holds; settlement retry lost; cap commands without effects; inaccurate estimates; opaque budget errors | UX02, UX03 |
| Incomplete reload projection; event epoch/truncation | UX04 |
| Misclassified take route errors | UX01, UX10 |
| Viewer Space interception; missing Files source; media state/leak | UX11, UX12 |
| Expiring cached tickets/thumbnails | UX11 |
| Obscuring mobile footer/advisory; per-frame DOM work; disappearing actionable toast | UX19 |
| Chromium-only/static/axe-only coverage; real-device and AT limitations | UX20 |
| Contradictory default mode/iteration/voice/quality docs | UX14, UX21 |

## First implementation dispatch

When implementation is requested: UX00 establishes minimum contracts and leases;
UX20 starts isolated reproductions. Then launch **UX01 admission, UX05 save/undo,
UX06 Super Easy completion, and UX09 scoped agent tools** concurrently. Their
primary write sets are independent, and all four lead to high-value mounted fixes.
The coordinator integrates each as it arrives instead of waiting for a big merge.
