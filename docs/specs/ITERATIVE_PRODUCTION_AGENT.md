# Iterative production agent integration

**Status:** proposed integration specification, October 22, 2026.
**Request:** integrate the collaborative creation process into the app's agent so
users can research, create, review and iteratively revise projects in the product.
**Delivery of this task:** architecture/UX specification and scoped implementation
tasks; this document does not claim the functionality has been implemented.

## 1. Product outcome

A user can say “Make a commercial about this website,” choose a creative direction
and voice, watch production progress, correct a shot or soundtrack, and receive an
editable film without leaving the project workspace. Chat, media review and the
timeline operate on the same production state. Reloading or switching devices does
not erase choices or repeat paid work. A completed export remains a versioned
artifact when the user continues editing.

The agent owns coordination and useful creative defaults. The user retains
consequential creative choices and spending authority. Routine preparation and
checks run without repeated approval dialogs. Explicit UI actions and unambiguous
chat decisions use the same application command path.

Evidence from the real production workflow is recorded in
[observations and requirements](../research/ITERATIVE_PRODUCTION_WORKFLOW_20261022.md).
Existing [voice-casting requirements](../VOICE_CASTING_STANDARD.md) apply.

## 2. Required end-to-end experience

### 2.1 A workspace, not a mandatory wizard

Use the existing project workspace with three coordinated areas:

- **Conversation:** brief, discoveries, decisions, concise progress and feedback.
- **Work surface:** script/storyboard, casting, references, takes, review and final
  delivery, selected by the task the user is doing.
- **Timeline/player:** persistent preview and direct editing, with selections
  supplied as explicit context to chat.

On narrow screens these become tabs/sheets, not three squeezed columns. A compact
project status shows current work, next consequential decision, selected revision
and budget. It must not imply every project follows a fixed linear checklist.
Research and references may progress while a voice decision waits; final speaking
production cannot consume an unselected or rejected voice.

### 2.2 Journey and artifact cards

| Step | Agent work | User-visible artifact and action |
| --- | --- | --- |
| Intent | Inspect supplied material, infer reversible defaults, clarify material unknowns | Brief summary, sources, language/duration/audience; edit in chat or form |
| Research | Fetch actual subject, identify supported claims and uncertainty | Source card with URL, captured date, excerpt/capture and supported claim; inspect/correct |
| Direction | Propose a specific premise, script and shot coverage | Editable treatment/script/shot list; choose or redirect; preserve approved material |
| Casting | Reuse approved character reference or design short dry candidates | Audio comparison, delivery direction, transcript, select/reject and feedback |
| Native test | Prepare exact-line conditioning and one native speaking shot | Audition beside actual speaking performance, technical findings and review status |
| References | Prepare identity, composition, product and motion references | Role-labelled boards; inspect/replace/attach to particular shots |
| Production | Plan affected work, reuse existing assets, execute bounded jobs | Cost/impact card; progress by shot; playable collected outputs; pause/cancel |
| Review | Inspect actual media, compare script/timing, propose scoped fixes | Timecoded findings, A/B takes, select/reject, “change only this” |
| Edit | Trim/reorder/reframe, compose graphics, mix stems and captions | Timeline changes and scoped before/after preview; undo/revert |
| Delivery | Export selected revision and verify output | Watch/download/captions/source archive; continue editing or make a new version |

Cards are views of durable artifacts/decisions, not executable HTML returned by the
model. They retain their identity when the chat scrolls out of history. A chat
summary links to the same card in the work surface. Loading/error/empty/stale states
must be defined for each card type.

### 2.3 Selection and feedback

Every turn can carry explicit context: selected scene/clip, selected candidate,
player time or interval, focused artifact, current work-surface tab, and the
revisions seen by the client. The UI displays compact removable context chips.
Never infer a mutation target from an old global “last selected” value.

- “B1” resolves only against the pending audition set visible to that conversation.
- “Keep this performance, make the music more upbeat” leaves its reference and
  selected native take unchanged.
- “Fix his hand at 00:12” creates a scoped finding and correction proposal for the
  selected shot/time; clarification is needed if the actor is ambiguous.
- “Those sound Acadian” rejects the relevant accent candidates with that reason;
  it does not overwrite the character's approved English voice.
- “Go for it” resolves the current, unchanged displayed proposal, not every future
  paid operation or a hidden plan the agent has just rewritten.

Explicit selection/confirmation actions need no additional model call. Ambiguous
references produce one targeted question with candidate previews. A natural-
language decision must retain its originating user message ID and resolved target;
the agent cannot manufacture an approval by calling a tool on its own suggestion.

### 2.4 Honest progress and autonomous continuation

The browser renders durable operation state. An LLM turn is not kept alive for a
multi-minute GPU job. Completion or failure creates a project event and an agent
continuation request; the coordinator advances eligible work or exposes a pending
decision. It does not require a user to type “resume” after every batch.

Distinguish `running`, `waiting_for_user`, `paused`, `recovering`, `failed`,
`cancel_requested`, `shutdown_unconfirmed` and `completed` in status copy.
“Completed” applies to the named operation; “film delivered” requires the final
deliverable. Transport reconnecting is not a production failure or cancellation.

Closing a tab does not cancel paid work. Pausing stops new scheduling and lets
already submitted work reach its defined checkpoint; cancellation requests backend
termination and preserves collected artifacts. Both show remaining active work and
whether compute teardown has been confirmed. A changed user objective suppresses
automatic continuation into new stages until the project intent is resumed.

### 2.5 Accessible review

Playback is user-initiated and never simultaneous across audition comparisons.
Provide keyboard-operable play/select/reject controls, visible focus, descriptive
labels, transcripts/captions, current selection text and reduced-motion support.
Progress announcements are throttled to meaningful transitions. Review controls
remain usable on mobile and after reload. A media `ended` event is not a listening
approval. Colour alone never communicates accepted/rejected/stale status.

## 3. Invariants

1. A production has stable identity before a renderable package exists; later
   binding to a package/conversation does not duplicate the production.
2. Artifacts and takes are immutable versions. Selection and review are separate
   records referring to their exact identities/hashes.
3. The desired brief/script, currently selected media and exported revision may
   differ. The UI shows the difference instead of silently replacing one with another.
4. New voice selection is a human preference decision. Approved returning voices
   can be reused; rejected takes remain excluded from default conditioning.
5. Technical observations never promote subjective review dimensions to approved.
6. Source text, captured webpages and transcripts are evidence, not instructions
   allowed to authorize tools, spending or workspace mutations.
7. Paid work requires current scoped authorization, an admitted plan and reserved
   capacity. Failure/retry/restart never resets the project allowance.
8. Every external side effect has a durable intent/idempotency key; uncertain
   submission is reconciled, not blindly repeated.
9. User edits and locked selections survive asynchronous results. Conflicting
   outputs become candidates, with an explicit rebase/choose action.
10. A collected, verified local output can be recovered without rerunning inference.
11. Changed requirements invalidate only their dependent outputs and decisions;
    unaffected approved work stays usable.
12. The ordinary app export remains available. Native-speaking productions preserve
    native audio; conditioning audio is never silently substituted as final speech.

## 4. Review and autonomy policy

This integration retains explicit user authority over take selection and creative
verdicts from the timeline-review design. It reduces duplicate dialogs by making a
user's direct click or unambiguous chat instruction the confirmation, rather than
adding an “are you sure?” to the same action.

The agent may research, draft, inspect, prepare alternatives, calculate impact,
generate within an already approved exact plan, and propose revisions. Technical
failures may trigger retries only when the approved plan includes the affected
targets, bounded retry policy and budget. A correction batch is one proposal, not
one interruption per attempt. Out-of-plan work requires a revised proposal.

Native speaking validation is mandatory before a new voice's full batch. Record
technical, visual and listening evidence separately. Whether a separate user
native-test decision is required is explicit in the project's review policy; it
must not be inferred from ASR success. New casting always needs user selection.
The first integration release must not silently relax existing take-selection or
paid-regeneration confirmation behavior.

Review evidence has independent dimensions: transcript, decode/timing, image
identity/anatomy, temporal action, lip sync, audible delivery/accent, composition,
mix and user preference. Each observation identifies artifact hash, interval,
method/reviewer, result and evidence. Results include `pass`, `fail`, `uncertain`
and `not_reviewed`. User decisions have their own selected/rejected record.

Raw and normalized transcripts are both retained. Brand spelling corrections and
accepted pronunciation variants are explicit records, not hidden normalization
that makes every spoken mistake appear correct. Contact sheets establish sampled
visual observations; muted browser playback establishes playback behavior.

## 5. Current application and integration approach

The [code audit](../research/ITERATIVE_PRODUCTION_CODE_AUDIT_20261022.md) records
exact modules, findings A01–A25, evidence limits and primary design sources.

**Reuse:** `PackageStore`, `buildChatProject`/`rebaseChatPlans`, the character and
reference libraries, take store/correction/selection, the editor command store,
deterministic job planner, backend attempts/reconciliation, durable pipeline,
audio mix and export services. The strongest background substrate is
`apps/server/src/pipeline.mjs`, not the older memory-only `run.mjs` controller.

**Add:** a small production-domain coordinator, durable command/decision journal,
artifact dependency index, project budget ledger, casting/review adapters, and
shared client projections. Do not add a general distributed workflow platform,
arbitrary agent shell execution or a second editor. The initial deployment keeps
the existing single-server runtime and managed-compute lease.

### 5.1 Current capability versus integration work

| Area | Present today | Integration needed |
| --- | --- | --- |
| Chat | Draft/patch/build, metadata tools, bounded history, some proposal confirmations | Research, production actions, durable decisions/continuations, scoped editor context |
| Character/voice | Library and pinned cast; voice settings; audition cache/controller | Mounted auditions, approved audio identity, clone/native-transfer chain, language-scoped decisions |
| Generation | Scoped jobs, takes, corrections, backend execution and durable linear pipeline | Action-level orchestration across casting/test/batch/review, persistent cumulative budget |
| Review | Take panels/verdicts/gates; technical QA | Working chat/timeline connections, actual evidence attachments and multidimensional review |
| Editing | Command store, timeline, autosave, sidecars | All manual/chat paths share commands; offline restore; independent native dialogue and graphics |
| Delivery | MP4/captions/archive exporters | Universal input fingerprints/gates, immutable delivery versions, real download cards |

### 5.2 Preconditions before exposing paid agent execution

Resolve A01/A02/A05/A06/A09/A12–A19/A24: missing dependency wiring, late chat/run
locks, shared conversation CAS, cross-document partial commits, inconsistent
editor mutations, in-memory/cumulative accounting, take-copy-before-conflict,
collection destination, transitive stale hashes, ticket expiry, gate parity and
ordinary-package stale export reuse. Add reproducers, then fix; source inspection
alone is not a passing test. Do not ship a new agent tool that bypasses those paths.

The approved timeline-review policy remains authoritative: per-regeneration
`planHash` authorization; user confirmation of creative selections/verdicts;
approved selected takes before final render, or a reasoned user override. A batch
lists all targeted regenerations in its approved plan. Technical reconciliation of
the same backend job is not a new creative regeneration. A new seed/input variation
outside that plan needs a new decision even if the project still has funds.

## 6. Canonical records and ownership

All names below are **proposed contracts**, to be implemented and frozen with
fixtures in IP00. Existing package/take/character contracts remain the authority
for their existing fields. Reference IDs instead of creating competing full copies.

### 6.1 Production state

```ts
type Production = {
  schema: 'comfyrizz.production/v1'; id: string; revision: number;
  conversationId: string; packageId: string | null;
  intent: 'active' | 'paused' | 'cancel_requested' | 'archived';
  briefVersionId: string | null; scriptVersionId: string | null;
  shotIds: string[]; characterBindings: CharacterBinding[];
  reviewPolicy: ReviewPolicy; budgetLedgerId: string;
  pendingDecisionIds: string[]; actionIds: string[];
  latestDeliveryId: string | null; lastSequence: number;
};
```

`phase` is a derived summary of active actions and unmet prerequisites, not the
single source of workflow truth. Each action has dependencies; research and visual
development can proceed independently. Productions may be created before package
build, and one production can have several immutable delivery versions.

`Shot` has stable `id`, scene binding(s), purpose, subject/speaker character ID,
onscreen/offscreen/silent intent, dialogue text, reference-role bindings, selected
voice reference, target timing, natural-speed constraint and continuity notes.
A storyboard scene and a generated shot are not assumed to be the same object.
Multiple edits can use one source shot; an asset shared by scenes is explicit.
Initial native scope is one identified speaker per generated shot; dialogue
coverage can combine several shots rather than promise unsupported multi-speaker
lip sync. Plan schema limits must support real examples above twelve scenes,
with bounded/paged context instead of silently truncating longer productions.

### 6.2 Artifact lineage

```ts
type ArtifactVersion = {
  id: string; logicalId: string; version: number; productionId: string;
  kind: 'source' | 'brief' | 'script' | 'identity' | 'composition' |
    'motion_reference' | 'audition' | 'voice_reference' | 'conditioning' |
    'native_take' | 'transcript' | 'review' | 'edit' | 'mix' | 'delivery';
  contentHash: string; mediaId?: string; metadata: Record<string, unknown>;
  derivedFrom: { artifactId: string; hash: string; role: string }[];
  createdBy: { actionId?: string; commandId?: string; actor: string };
  provenance: { modelRevision?: string; workflowHash?: string;
    seed?: number; sourceUrl?: string; retrievedAt?: string;
    transform?: Record<string, unknown> };
  access: { private: boolean; conditionAllowed: boolean;
    redistributeAllowed: boolean; licenseId?: string };
};
```

Metadata is discriminated/validated per kind, not arbitrary trusted model JSON.
Paths stay server-owned and contained. Media identities are durable IDs/hashes;
short-lived playback URLs are resolved at read time. Preserve originals and
derivatives (crop, motion excerpt, resample, loudness-matched audition preview).
Selection refers to raw approved audio; normalization does not redefine identity.

`Claim` links a source version/excerpt to exact brief/script claim IDs and records
supported/uncertain/contradicted status, scope and reviewer. Sources and fictional
staging are explicitly different. Research fetch failures leave uncertainty,
not fabricated facts. Source updates make dependent claims reviewable; they do not
silently rewrite an approved script.

### 6.3 Decisions and scoped preferences

```ts
type Decision = {
  id: string; productionId: string;
  kind: 'direction' | 'voice_selection' | 'native_transfer' | 'reference' |
    'take_selection' | 'creative_verdict' | 'action_spend' | 'final_delivery';
  status: 'pending' | 'resolved' | 'rejected' | 'superseded' | 'revoked';
  targetIds: string[]; inputFingerprint: string; proposalVersion: number;
  options: { id: string; label: string; artifactIds: string[] }[];
  resolution?: { optionId?: string; artifactIds: string[]; reason?: string;
    userEventId: string; at: string; actor: 'user' };
};
```

A rejected candidate is retained and excluded from default reuse; it may be
reconsidered only through an explicit new decision. An edited proposal supersedes
the old one rather than reusing its approval. Selecting a take and approving its
quality remain separate operations; “Use and approve” is an explicit compound
command. An agent recommendation never carries `actor: user`.

**Decision effects are explicit and independent:**

| User action | Editorial selection | Quality / transfer effect | Spend authority |
| --- | --- | --- | --- |
| Preview / A–B | None | None | None |
| Use this take | Select exact take in scope | No new verdict; existing verdict retained | None |
| Approve quality | No selection change | Approve named take/hash and stated review scope, even if not selected | None |
| Use and approve | Select named take | Approve that exact take in stated scope | None |
| Reject | No implicit replacement or regeneration | Reject named candidate; selected rejected take remains visibly blocked until changed | None |
| Accept native transfer | No automatic timeline selection | Accept voice-reference/profile/test binding and explicit review dimensions; does not approve the test as a final timeline take | None |
| Approve generation | None | No creative verdict | Consume only enumerated execution slots below |
| Final review override | None | Permit named delivery/revision despite listed creative review blockers, with reason | None |

A combined control must name all effects. Every compound command is atomic and
expands into the same recorded effects as the separate commands. Final delivery
remains blocked when a selected replacement is unreviewed, even if the source
voice transfer was accepted.

Preference records have scope (`user`, `project`, `character`, `language/accent`),
source user event, value and explicit overrides. Preserve “avoid generic announcer”
and character delivery without applying Basil's voice to every character. Saving
an accepted voice for future use is visible; approval of one shot does not imply
all languages, roles or future spending.

### 6.4 Actions, evidence and deliverables

`ActionPlan` is immutable: kind, targets, input versions, exact dependency hashes,
backend/capability profile, expected changes, reusable artifacts, job graph,
bounded attempt policy, estimates, reservation ceiling, stop/collect reserve,
required decisions and `planHash`.

`Action` links that plan to a durable command/idempotency key, expected revisions,
reservations, submitted attempt/job/run IDs, artifacts and error/reconciliation
state. States: `planned → awaiting_decision → queued → dispatching → running →
collecting → verifying → completed`; branches include `blocked`, `failed`,
`submission_unknown`, `cancel_requested`, `cancelled`, `interrupted` and
`reconciling`. Runtime teardown status is orthogonal to output success.

`ReviewObservation` stores dimension, result, interval, artifact hash, evidence
artifact IDs, method/version and reviewer. `CreativeVerdict` stores the user's
choice. Technical jobs can append observations but cannot resolve user verdicts.

`Delivery` pins package/editor/production revisions; selected source/take hashes;
composition, native-audio, caption and mix hashes; model/workflow provenance;
review/override records; rights mode; actual output hashes, bytes, frames and
durations. It is immutable. Subsequent edits mark the current workspace newer,
not the historical delivery corrupt or silently updated.

### 6.5 Persistence and crash consistency

Proposed layout under the configured runtime (no machine-specific paths):

```text
productions/<id>/state.json
productions/<id>/events.jsonl
productions/<id>/commands/<commandId>.json
productions/<id>/plans/<planHash>.json
productions/<id>/artifacts/<artifactId>.json
productions/<id>/decisions/<decisionId>.json
productions/<id>/actions/<actionId>.json
productions/<id>/deliveries/<deliveryId>.json
budgets/<ledgerId>.json
media/<content-addressed bytes>                 # existing media service boundary
```

Extend the existing atomic-write/journal/ownership patterns. One shared mutation
service serializes all writers for a production and bound package. Legacy chat,
cast, reference, take and editor routes must participate; a lock used only by the
new route does not solve cross-route races. Persist command intent and expected
before/after fingerprints before side effects; record receipts and publish events
only after durable updates. Recover incomplete multi-file commits before admitting
another mutation. Atomic rename alone is not a transaction across conversation,
package, take and budget files. Use a write-ahead operation journal with idempotent
steps; retain enough expected content/revision data to distinguish already-applied
from unapplied steps. If that cannot be proven, surface conflict/recovery rather
than writing over a newer package. Do not hold a file lock for an entire GPU run.

### 6.6 Commit, read visibility and publication protocol

IP00/IP03 must implement one protocol, not independently atomic writes to each
sidecar. Initial single-server protocol:

1. A short **runtime mutation gate** serializes metadata transactions, including
   legacy participants. It is fenced by runtime ownership; recovery runs before
   new mutations. Use this single gate initially rather than acquiring production,
   package, conversation and account locks in inconsistent orders. Never await a
   provider/network operation while holding it. Managed-compute operation ownership
   is recorded within admission, not acquired in reverse lock order elsewhere.
2. Prepare a transaction with participant keys, expected revisions/hashes, complete
   after-images, decision-slot consumption, ledger transitions and outbox entries.
   Participants may include production, package, conversation, takes, editor
   selection and budget. Validate all expected versions before any visible change.
3. Durably write immutable participant versions and a prepared manifest. Then
   atomically replace a runtime **commit index** pointing to the new participant
   versions and transaction sequence. This durable index update is the sole
   authoritative commit point. Fsync/atomic-write behavior is defined and tested
   for the supported filesystem; an interrupted write must leave the old index.
4. Production-aware readers pin one committed index generation and resolve all
   constituent versions from it. They never combine independently read mutable
   sidecars. Existing filenames are compatibility projections, materialized after
   commit under the same gate. All legacy read/mutation routes for a bound package
   use the adapter; workers receive immutable staged snapshots, not those mutable
   projections. Do not release the gate/admit legacy writes while projection repair
   is incomplete. Unbound packages retain their existing storage behavior.
5. The committed transaction contains a durable **outbox** for events,
   continuations and dispatch intents. Publish after commit; acknowledge each item
   durably. Consumers deduplicate by stable event/continuation/action ID. A crash
   after publication but before acknowledgement can replay; a crash after commit
   but before publication cannot lose notification or next-step scheduling.
6. Recovery resolves the last valid committed index, repairs projections, replays
   its unacknowledged outbox, and removes/ignores uncommitted staging. It never
   treats prepared but uncommitted decision/budget data as authority. If committed
   bytes or versions cannot be verified, fence the affected mutations and surface
   recovery failure. Retain old versions long enough for recovery/history.

Reservation creation, execution-slot consumption and dispatch-intent creation are
one committed admission transaction. Reservation → dispatch liability → settlement
are ledger-participant transitions, never additional independent debits. External
generation is not part of the filesystem transaction: the durable dispatch intent
and backend attempt receipt reconcile its uncertain outcome (§8).

IP00 freezes the protocol/fixtures; IP03 owns the index/gate/outbox and shared
transaction API. IP04 supplies ledger transitions; IP13 routes every legacy
participant through it before the first paid-capable slice. Tests crash after each
participant write, index replacement, projection write, event publish and
continuation enqueue, then attempt both a snapshot read and a legacy mutation.
This design is a proposed metadata-store evolution, not a claim the current JSON
stores already provide multi-document transactions.

## 7. Service, API and agent contracts

### 7.1 Shared command boundary

UI and agent adapters call the same service functions. The model proposes typed
changes and can start only a stored action with already valid authority. It does
not pass `approved: true`, shell commands, arbitrary workflow graphs or local paths.

```json
{
  "commandId": "cmd_...",
  "productionId": "prod_...",
  "expected": {"productionRevision": 12, "packageRevision": 7},
  "kind": "decision.resolve",
  "payload": {"decisionId": "dec_voice_...", "proposalVersion": 2, "optionId": "B1"}
}
```

Authenticated actor/user-event attribution is added server-side, not trusted from
the request/model. Same command ID + same canonical payload returns its recorded
result; same ID + different payload returns conflict. Keep deduplication for the
production lifetime, not just the last chat turn. Responses identify committed
revisions, resulting artifact/action/decision IDs and event sequence.

### 7.2 Proposed HTTP surface

| Route | Responsibility |
| --- | --- |
| `POST /api/productions` | Create draft production/conversation binding; idempotent client request key |
| `GET /api/productions/:id` | Consistent snapshot, current sequence and pending decisions/actions |
| `GET /api/productions/:id/events?after=:sequence` | Durable ordered production events or explicit snapshot-reset requirement |
| `POST /api/productions/:id/commands` | Resolve decisions, apply approved edits, pause/resume/cancel; CAS and idempotency |
| `POST /api/productions/:id/action-plans` | Build exact proposal and reuse/cost impact; no allocation |
| `POST /api/productions/:id/actions` | Dispatch stored plan after fresh decision/budget/dependency validation; return 202 |
| `GET /api/productions/:id/actions/:actionId` | Durable operation, attempts, receipts and runtime status |
| `GET /api/productions/:id/artifacts/:artifactId` | Metadata, provenance, review and stable media ID |
| `POST /api/productions/:id/artifacts/:artifactId/ticket` | Authenticated expiring media access with explicit expiry metadata |
| `GET /api/productions/:id/deliveries/:deliveryId` | Manifest and authorized download links |

Use existing auth and error conventions. Distinguish conflict (`409`, current
revision plus conflict paths), invalid request (`422` or existing validation code),
missing dependency/decision, unavailable capability, exhausted budget and queued
work. An estimate is a value, not a thrown “generation failed” error. All responses
are project-scoped. Existing APIs become adapters to shared services or retain
legacy mode explicitly; they must not bypass new policy on a production-bound
package. Integration includes direct export and old regenerate routes.

### 7.2.1 Legacy entry-point closure — required before the first slice

IP13 owns an exhaustive route/internal-dispatch inventory test. The initial matrix
below names the audited entry points; implementation must compare it with all
registered handlers and fail coverage when another bound-project mutation or paid/
final-output entry point is added without a policy adapter. Resolve production
binding server-side from package/conversation/run IDs. Client `productionId`, a
feature flag, legacy `approved:true`, or an approved-hash set cannot opt out.

| Entry point | Required production-bound behavior | Implementation owner |
| --- | --- | --- |
| `/api/agent/chat`, legacy `/api/agent`, build/brief adoption | Shared commands, conversation/package CAS, no implicit fallback replacement | IP07 adapter; IP13 mount |
| Package PUT/save, editor sidecar saves, scene-chip/presenter edits | Transaction participant writes and local sequence/revision barrier | IP02 command adapter; IP13 routes |
| Character CRUD/cast and reference assignment routes | Shared transaction, scoped lineage; reject cannot be only chat-prefill | IP05 character routes, IP07 reference application; IP13 mount |
| `/api/run`, `/api/run/approve`, internal `runs.start` | Resolve bound execution authority and consumed slots; old booleans/hash membership rejected as authority | IP04 admission adapter; IP13 `run.mjs`/app integration |
| `takes/routes.mjs` select/revert/verdict/regenerate/regenerate-batch | Shared selection/decision commands; exact authority for fresh inference | IP01 route adapter; IP13 mount |
| Queued regeneration drain and run-completion callbacks | Same admission/ingestion/selection services; no internal bypass | IP03 queue orchestration, IP01 ingestion; IP13 hooks |
| `/api/pipeline/plan`, start, cancel/reconcile; worker restart/resumption | Immutable authorized snapshot, single admission/ledger path; reconciliation alone cannot authorize fresh inference | IP03 lifecycle; IP13 routes |
| `/api/scene/plan`, `/api/scene/render` | Planning side-effect free; preview labelled; any paid render admitted | IP09 media plan; IP13 routes |
| `/api/render`, `/api/render/edited`, `/api/export`, pipeline render/export and completion render | Shared draft/final intent, readiness and complete input fingerprint | IP11 readiness/delivery; IP13 all route/callback wiring |
| Existing video/file/download routes | Serve pinned verified delivery or explicitly labelled draft; no implicit render on GET | IP11 download adapter; IP13 routes |

IP13-A cannot be accepted until closure works for its supported action kinds;
unsupported bound-project entry points return an actionable unsupported response,
not the old unsafe fallback. IP13-B expands capabilities without weakening it.
Tests directly invoke old routes, old hash approvals, `approved:true`, internal
queued work and direct export; they must not bypass decisions, slot consumption,
ledger admission or final review. Unbound legacy packages retain documented legacy
behavior, but binding cannot be removed by a mutation request to evade policy.

### 7.3 Model tools and context

Keep the tool catalog small and capability-gated:

- `production_get`: compact state, pending decisions, selected artifacts, budgets,
  actual capabilities and next eligible actions.
- `research_search` / `research_fetch` / `research_record_claim`: bounded discovery,
  captured evidence, claim mapping. Search can be unavailable while direct URL
  capture still works; announce that limitation.
- `production_propose`: discriminated brief/script/shot/cast/reference/edit/review
  proposal; returns persisted IDs and impact. Reuse existing proposal tool helpers.
- `production_plan_action`: typed auditions, conditioning, native-test, stills,
  shot-batch, regeneration, technical-review, mix, preview-render or delivery plan.
- `production_start_action`: stored plan ID + decision IDs only; service verifies
  actual user authority and freshness. It cannot approve its own proposal.
- `production_get_action`: current state/receipts, not a blocking busy-wait tool.
- `production_record_observation`: structured findings with real evidence IDs and
  explicit modality; no fabricated human-listening result.

Pause/cancel/resume UI commands are deterministic; chat can translate an explicit
user instruction into the same command. User decisions go through authenticated
command resolution, not a model-callable “approve everything” tool.

Runtime context includes pinned brief/script requirements, active selections,
rejected alternatives and reasons, scoped standing preferences, pending decisions,
selected editor scope, latest completed action summaries, capabilities and budget
headroom. Paginate full history/artifacts. Every context fact refers to durable
state, and stale tool output forces reread/rebase. Increment prompt/skill versions
and update actual-request tests when replacing one-voice/upload-only restrictions.

### 7.4 Research and evidence adapters

Implement search/fetch/capture behind injected interfaces with fixture responses.
Bound redirects, response size/type, timeouts and resource use; reject local/private
network targets unless explicitly configured for an authorized local capture.
Keep browser capture separate from page text extraction; prohibit incidental
state-changing requests in read-only product captures. Store URL, timestamp,
content hash and observed DOM/image provenance. Never expose secrets to fetched
content or pass source text as system instructions.

Vision/audio critique is optional per provider capability. Current text-only chat
can reason about supplied measurements and user feedback, but must say when it has
not seen/heard media. Where supported, send bounded actual frames/audio excerpts
with hashes/time ranges and record the exact modality. No provider capability probe
is silently run during an offline/research-only evaluation: probes may be billable.

## 8. Execution, spending and recovery

### 8.1 Authorize, reserve, dispatch, collect

**Spend authority is consumable, not a reusable approved hash.** An approved
decision binds one `executionId`, one immutable `planHash`, and enumerated slots:
`{slotId, targetId, effectiveInputHash, seed, maximumChargeExposure}`. Allocate the
execution identity at proposal time. Batch approval lists every intended initial
generation; the default is one slot per target, with no unspecified new-seed retry.
A changed target/seed/input is a new regeneration plan requiring its own decision.
An explicitly requested larger attempt schedule may be proposed with all concrete
slots/hashes exposed; it is not inferred from a generic retry count or ceiling.

Admission atomically marks each slot consumed by exactly one action/attempt.
Different command/action IDs cannot reuse it, even with the same approved hash.
Retries of the same command recover its existing action. Reconnecting, polling and
collecting the same backend job consume no new slot. A fresh inference submission
after confirmed failure consumes a newly authorized slot; `submission_unknown`
blocks a fresh submission until reconciled. Unused cancelled slots are revoked,
not returned as reusable permission. Funds/reservations and execution authority
have separate lifetimes. All backend auto-retry policies must classify transport
retry versus fresh generation according to these rules.

1. Produce an immutable action plan from effective inputs. Include all shared
   dependencies, model/workflow revisions, selected references and requested edits.
2. Obtain the required exact user decision(s). A project ceiling caps the sum; it
   does not authorize every generation by itself.
3. Under shared admission lock, revalidate revisions/hashes/decision scope,
   acquire the existing operation lease and atomically reserve the upper bound.
4. Persist dispatch intent and attempt identity before invoking the worker.
5. Use the existing planner/backend profile and attempt journal. A lost response
   reconciles known work; `submission_unknown` does not allocate another attempt.
6. Register manifest outputs as immutable artifacts only after local existence,
   byte count/hash and media decode checks. Standardize the collect destination
   before apply. Recovery may use verified scratch receipts.
7. Rebase candidate selection against current package/editor state. Conflicting
   results remain inspectable takes; an approved incumbent is preserved.
8. Settle reservations from supported cost evidence, verify teardown, then emit
   completion/continuation. Output success and compute shutdown are separate facts.

Jobs are asynchronous and bounded by action attempt limits, wall deadlines and
resource policy. Use workflow capability profiles for supported image/audio/video
reference slots; library metadata does not imply execution capability. Ordinary
audio, voice design, exact-line cloning, native FastH3, motion transfer and render
adapters declare their real constraints before planning.

### 8.2 Budget ledger

Ledger entries: authorization grant/amendment, reserve, dispatch liability,
estimated/actual settlement, release, reconciliation adjustment. Each has unique
command/action ID, unit, source evidence and timestamp. Track at least:

```text
ceiling
settledAttributedSpend
unsettledLiability
activeReservations (including collect/stop reserve)
available = ceiling - settledAttributedSpend - unsettledLiability - activeReservations
```

Do not sum reservation and settlement for the same exposure. On settlement,
atomically replace/release the corresponding reservation. Later billing
adjustments are deltas. Preserve liability on failures and across restart; retain
stop reserve while shutdown is unconfirmed. Fix legacy accumulation of prior
`required` before adapting it to this ledger.

Google Colab compute units and model/API currency are separate dimensions.
Expose configured LLM/research cost policy rather than implying the GPU ceiling
covers it. BYO/local compute is external/unmetered, not “free.” Account-balance
deltas may include unrelated activity; label them estimates, retain interval and
runtime evidence, and do not fabricate per-shot actuals. Initially serialize
managed Google Colab work through the existing account lease. Unknown spend or
stop state conservatively blocks additional allocation until reconciled.

### 8.2.1 Per-adapter execution policy

Each installed adapter declares `billingUnit`, `estimateSource`, enforceable
request/token/frame/time caps, cancellation semantics, uncertainty settlement,
and authority type. Missing policy means unavailable for automatic execution.

| Adapter | Authority and bound | Failure/cancellation accounting |
| --- | --- | --- |
| Chat/research model API | Explicit configured standing allowance per provider/production or per-action grant; maximum calls, steps, input/output tokens and conservative currency estimate | Provider usage/receipts settle exposure; abort is not proof of no charge; no automatic retry when allowance is unknown/exhausted |
| Search/capture API | Configured standing allowance for bounded read-only research or per-action grant; request count, response size, capture time | Record provider charge at supported granularity; local fetch still has resource caps |
| Google Colab design/clone/native/motion/render | Exact consumable plan slots plus production compute-unit ceiling; pinned inputs, wall/watchdog and stop reserve | Retain liability until verified teardown and attributable/estimated settlement |
| BYO/local synth/render | Explicit user-configured execution permission and resource caps; metering marked external/unavailable | Do not imply zero cost; cancellation reports process/remote state honestly |
| Mix/rearrange existing music | Authorized reversible edit; local CPU/time cap, no new generation authority | Reuse existing stems/score parameters; invalidate mix/export only |
| New billable music generation | New explicit action grant in that provider's currency, content/version/count/duration cap | Cannot consume a prior “make it more upbeat” mix permission or Google Colab grant silently |

Standing model/research allowances are shown in settings and the project cost
summary; a user's GPU budget is not repurposed as API-currency permission. Defaults
never silently enable an unconfigured paid provider. Rate/token bounds are
conservative admission controls, not promises of exact provider billing. An adapter
without a reliable upper bound requires a separately explicit capped/uncertain-cost
policy and stops automated continuations when exposure cannot be reconciled.

### 8.3 Events and continuations

Production events contain `productionId`, monotonic `sequence`, `eventId`,
`commandId/actionId` where applicable, committed revision and payload references.
Types include artifact registration, decision request/resolution, action progress,
receipt, budget change, conflict, teardown state, edit applied and delivery ready.
Tokens and progress percentages are ephemeral; decisions/receipts are durable.

Client reconnect algorithm: subscribe/buffer, fetch snapshot with sequence S,
apply buffered events greater than S, then replay durable gaps and deduplicate.
Global in-memory SSE IDs are not interchangeable with per-production sequence.
After server restart show reconciliation; resume execution only after proving job
and runtime state. Refresh expired media tickets without losing playhead/selection.

Completion queues one idempotent continuation keyed by production/action/terminal
event. The coordinator first computes deterministic eligible next steps. Invoke
the model only for creative reasoning or unresolved choices. If the user paused,
changed objective or a prerequisite is rejected/stale, stop scheduling and expose
the checkpoint. A failing summarization call cannot undo completed work or hide
the playable artifact. Bound continuation/model-step budgets and prevent recursive
retry loops.

## 9. Casting, conditioning and reference execution

The canonical voice binding records character/version, language/accent, delivery,
approved raw audio artifact/hash/transcript, audition decision, clone model pin,
native-transfer test and decision/evidence. Consolidate character and project voice
schemas; keep the existing narrator mode for legacy explainer projects.

New voice path:

1. Plan a short comparable audition set under the authorized scope.
2. Synthesize and verify raw WAVs; create level-matched dry previews.
3. User chooses/rejects with optional delivery/accent feedback. No full speaking
   batch is eligible until a voice is selected.
4. Create measured exact-line conditioning from that actual recording.
5. Generate one representative native test. Default new-voice policy requires
   the user to accept the native performance before its full speaking batch.
   Existing accepted transfer may be reused when its effective profile is unchanged.
6. Generate per-shot conditioning and native performances with full lineage.

User-directed production may explicitly choose a different native-test review
policy; record it as policy, not a fabricated listening approval. Historical
Hermes B1 technical validation must not be imported as human native approval.
Historical Basil A2's explicit accepted transfer can be imported with that evidence.

Missing selected reference bytes fail with a recovery/recast action. Pure cache
lookup must never synthesize. Verify cached hashes/decode before reuse, coalesce
identical requests and avoid charging again for existing artifacts.

Identity, scene composition, motion and voice have separate bindings. Motion
transfer derives a documented excerpt with original URL/hash, source-in/out,
frame rate, transformations and audio policy. Positive action direction and
physical staging are attached to the shot. Cap unsupported combinations instead
of offering a UI role that the backend cannot execute.

## 10. Scoped revision and editable assembly

### 10.1 Change-impact rules

| Change | Invalidate/recompute | Preserve |
| --- | --- | --- |
| Headline/overlay text | Affected graphic render, delivery fingerprint | Voice, conditioning, native shots |
| Spoken line/speaker | Exact-line conditioning, corresponding native shot, transcript alignment, dependent timing/captions/mix/export | Other shots and unrelated references |
| Selected voice/language | Matching native test and dependent speaking work | Other characters/languages and silent shots |
| Character identity/composition | Referencing shots and their visual review | Unrelated voices/sets |
| Motion excerpt | Dependent motion takes | Speaking shots without that reference |
| Take selection/source trim | That edit's AV ranges, captions, mix/render/export; review if relevant interval changes | Original and rejected takes |
| Music/gain/ducking | Mix and final delivery | Speech/dance generation and their approvals |
| Caption spelling | Caption sidecars and burned-caption renders | Native performance and non-caption picture |
| Scene reorder | Timing, transitions, mix/caption placement and export | Source takes; no automatic speech speed-up |
| Model/workflow revision | Effective generation fingerprint and applicable transfer test | Existing historical artifacts/deliveries |
| Rights/access change | Packaging eligibility and download projection | Media bytes/generation |

Effective hashes include transitive input artifact bytes, model/workflow profile,
direction, seed, geometry, audio transcript and transforms. No invalidation based
only on unchanged asset ID. Store reasons and dependent paths for a useful UI diff.
For shared assets, default scene-scoped feedback offers a fork/new binding rather
than unexpectedly changing every scene that uses it; show the impact explicitly.

### 10.2 Editor safety

Before planning an edit, capture current local editor sequence and package revision.
Before applying/exporting, flush through the existing autosave barrier or surface
offline/conflict choices. The model receives the actual local pending context,
not only an older server package. Apply a verified command batch as one undo step
through `editor/store.ts`; never adopt an entire returned package to implement a
small edit. Rebase disjoint intervening changes; stop on overlapping or locked paths.

Undo restores editorial selections/fields, not billing or external job history.
Generated outputs remain available after undo. Recovery after reload offers local,
server and compare choices before replacing either. New project creation separates
the workspace from the previous package/cast/references and preserves its draft.

Selection is a cross-store command, not a private client preview patch. Its commit
atomically updates the package asset binding, take-sidecar selection and production
selection projection. The result includes a scoped editor command, before/after
selection, base revisions and affected trim compatibility; the client records that
command in undo without replacing the whole document. An event carrying an already
applied command ID acknowledges it rather than applying a second undo entry.

Undo issues a **new compensating selection command** against current revisions.
It restores the old selection without deleting the original decision, quality
verdicts or paid action history. Intervening unrelated manual edits/compatible trims
remain; overlapping selection or incompatible source range changes require a
focused conflict decision. Offline undo is a local pending command labelled unsynced;
final export waits for synchronization/rebase. On reload the pending undo and server
state are recoverable. Test manual trim → agent-proposed replacement confirmed by
user → undo → reload → export, asserting all stores and source ranges agree.

### 10.3 Native audio and composition

Add validated non-destructive media tracks rather than using scene ambience as
dialogue. Each clip has source artifact/hash, source-in/out, timeline start/duration,
sample rate/timebase, role (`dialogue`, `ambience`, `music`, `foley`), gain/envelopes,
fades and optional AV link group. Whole-frame video timing and integer sample
audio timing have an explicit deterministic rounding policy. Default linked trims
preserve sync; deliberate unlink supports J/L cuts and reaction coverage. Prevent
double playback when native audio is extracted from a video background.

Measured native speech anchors captions; conditioning timestamps are provisional
only. Preserve natural-speed performance by default. A replacement too short for
the slot offers trim/hold/ripple/another-take choices; do not silently stretch
speech or hide missing action with a freeze. An intentional hold is editable and
shown as such. Full, incremental and browser paths share source-range calculations.

Use validated composition/overlay primitives for exact typography, product
screens, lower thirds and title cards. Initial recipes cover the demonstrated
commercials; arbitrary model-authored TSX/shell must not execute on the server.
Keep graphics/text/music parameters editable. The source archive may include a
recipe/source representation, but the app must not call flattened baked scenes
fully editable graphics. Add authored/uploaded music with explicit provenance and
parameterized original-score adapters; cost-gate any billable music provider.

## 11. Preview, final review and delivery

Separate readiness predicates:

- `canExecuteAction`: authorized current plan, dependencies/capability/budget ready.
- `canPreview`: safe available media; unreviewed/stale placeholders labelled.
- `canDeliver`: exact saved revision, verified selected files, current required
  reviews, synchronized timing/captions/mix and consistent rights mode; or the
  existing permitted reasoned user review override where applicable.

A final creative override cannot bypass missing/corrupt bytes, invalid schema,
unknown costs, authorization or wrong output fingerprint. Initial generation must
not require every nonexistent final clip to be approved. A browser preview and a
draft render are labelled separately from final delivery; remote draft rendering
still needs cost authorization.

All final routes—normal render/export, edited render, scene composition assembly,
pipeline export and bundle—use the same readiness/input snapshot service. Fingerprint
ordinary packages as well as compositions. Existing video is reusable only with a
matching receipt and actual file hash. Never pair an old render with new captions.

Delivery checks: full decode, expected frame/timebase, captions ordered/nonoverlapping
and in bounds, source/mix duration consistency, configured loudness/true-peak target,
selected takes/variant lineage, ZIP integrity, authenticated playback/range requests
and download hashes. Test the final mixed soundtrack for truncated/repeated or
unexpected speech, including nominally silent shots. Record evidence limits.

Offer two explicit archive modes: **private project archive** (authorized source
material retained for its owner) and **redistributable bundle** (rights policy and
exclusions enforced). Store neither secrets nor transient ticket URLs in archives.
Exports include edit/recipe, captions, eligible selected sources/references/stems,
provenance and replay requirements; playback never depends on a vanished VM.

## 12. Rollout and compatibility

1. **Contract and correctness foundation:** freeze fixtures, repair audit defects,
   add shared command/ledger/recovery boundary; no new paid-autonomy UI yet.
2. **First usable vertical slice:** researched brief → three dry auditions → user
   selection → native test → explicit transfer acceptance → use test take (not
   quality-approved yet) → demonstrate final gate blocked → timecoded correction
   → approve its exact generation plan → select corrected take → explicit quality
   approval (or recorded permitted override) → captioned export. Runs through the
   mounted app using fake adapters first. Minimum assembly is linked native AV,
   source trim and aligned captions; it does not wait for J/L cuts, motion transfer,
   multitrack controls, music generation or advanced graphic recipes.
3. **Full commercial iteration:** multiple characters/shots, references/motion,
   native dialogue edit/mix, exact graphics, selective regeneration, delivery archive.
4. **Migration and capability trials:** opt-in import of existing productions,
   regression checks and separately authorized audible/rendered evaluation.

Use a capability/feature flag for the new production experience. Legacy packages
open unchanged. Import is explicit, idempotent and hash-verified; it creates
production metadata beside the original and does not rewrite owner edits. Preserve
cast/scene/asset/take IDs when valid. Missing provenance or listening approval is
marked unknown; successful past output is not inferred human approval. Old
non-versioned project state gets a baseline snapshot before production mutations.

Do not auto-purge media referenced by decisions, retained source lineage or delivery
manifests. Existing twelve-take eviction needs reference-aware pinning/retention
policy for production-bound projects. An evicted unpinned derivative is marked
unavailable; it does not silently disappear from history. Storage cleanup is separate
from creative rejection.

Feature rollout must update older specs explicitly where behavior changes (voice
scope, generated references, background orchestration, native audio editing). Keep
existing confirmation policy unless the user authorizes a policy revision. No
OpenCode SDK dependency is implied by the OpenCode Go provider name.

## 13. Acceptance and evaluation

Use isolated temp runtimes, deterministic LLM cassettes, fake synthesizers/backend
jobs and checked-in small media fixtures. No live API probe or GPU spend in ordinary
tests. Evaluate the mounted app, not injected DOM or controllers alone.

| Test | Observable acceptance |
| --- | --- |
| Researched brief | URL evidence supports claims; unavailable source is reported; external text cannot authorize actions |
| New project | Previous project/cast/reference/undo state is not mistaken for the new project |
| Audition loop | Actual audio plays; select/reject persists across reload; same decision from chat/control yields same result |
| Voice fidelity | Approved raw hash reused; QC1/QC2 stay rejected; Basil/Molty/Don remain distinct; missing reference blocks |
| Native validation | Voice/ASR/visual/listening statuses separate; new voice full batch obeys explicit transfer policy |
| Duplicate action | Lost response and repeated command/turn produce one recorded effect, reservation and submission |
| Stale decision | Changed referenced bytes/model/script invalidate plan/approval even when IDs match |
| Concurrent edit | Chat/cast/manual edits cannot lose updates; target edit is one undo step preserving unrelated changes |
| Partial failure | Good takes retained; unknown submission reconciles; collection retry never repeats paid inference |
| Ledger | Casting/test/batch/retry share ceiling across restart; race admits at most available funds; failure liability retained |
| Teardown | Stop command without confirmed session absence remains unconfirmed; new allocation is blocked |
| Replay | Duplicate/out-of-order/gapped events converge to snapshot; old-project events do not affect current project |
| Idle media | Playback/seek after ticket expiry and server restart renews access without losing context |
| Scoped revision | Music-only changes make zero generation calls; one dialogue correction changes only dependent artifacts |
| Motion | Excerpt hash/workflow capability bound; wrong role cannot masquerade as executable motion transfer |
| AV edit | J/L cut dialogue continuous across visual cuts; no doubled audio; full/incremental/browser source trims agree |
| Final review | Repeated tail/unexpected silent-shot speech flagged; measured passes never create listening approval |
| Export | All output paths share gates and fingerprint; captions/video/source bundle correspond to same revision |
| Recovery | Reload after offline edit offers exact local recovery; no silent document replacement |
| Mobile/accessibility | At 390px every review/spend/cancel/export action reachable; keyboard/focus/modal/error states tested |
| Migration | Import twice does not duplicate; originals/manual edits/hash-verified selected media remain unchanged |

Add behavioral agent evals for “keep that voice, change the accent,” “make the music
more upbeat,” “only shot three,” “those are good, go for it,” and changing objective
mid-run. Score task completion, preservation, unnecessary generations, repeated
approval prompts, recovery, cost attribution and evidence honesty. Creative quality
requires paired actual listening/render trials and human calibration, separate
from deterministic pass rates. Existing full checks run after each integration
wave; focused package/server/web tests run in owning tasks.

## 14. Implementation handoff

See [subagent work packages](../tasks/ITERATIVE_PRODUCTION_AGENT.md) for dependencies,
file ownership, contract deliverables, test requirements and integration gates.
The highest-value release is the working first vertical slice, not a collection
of unmounted panels or uncallable agent tools.
