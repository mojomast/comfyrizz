# Iterative production integration — subagent implementation work packages

**Status:** proposed execution plan, October 22, 2026. Implementation has not started.
Canonical behavior: [integration specification](../specs/ITERATIVE_PRODUCTION_AGENT.md).
Evidence: [code audit](../research/ITERATIVE_PRODUCTION_CODE_AUDIT_20261022.md) and
[observed production workflow](../research/ITERATIVE_PRODUCTION_WORKFLOW_20261022.md).

## 1. How to execute this plan

The user explicitly requested subagent research and a specification for subagent
integration. These packets define implementation ownership; they are not an
authorization to spend on live model/GPU evaluations or restart deployed services.
Use fake adapters, temporary runtimes and fixture media until separately authorized.
Do not republish the user's existing films or overwrite their workspace edits.

Repository has substantial uncommitted production work. Inventory it before
implementation; do not clean/reset it. Use isolated worktrees where practical and
land dependency-ordered changes through one integration owner. No automatic push
or blanket staging of unrelated work. Read root AGENTS.md and applicable scoped
instructions. The older `docs/tasks/RULES.md` describes an earlier board/hackathon
environment; its stale Node/runtime assumptions and no-subagent wording do not
describe this user-requested parallel plan. Retain its no-live-spend/no-secret and
preserve-other-work principles; use current package engines/tooling.

### Shared rules for every packet

1. Read the spec and referenced audit IDs; confirm the cited issue in current code.
2. Work only in assigned paths. New paths below are proposed, not existing claims.
3. Build on shared contracts from IP00. Consumers use fixtures/adapters until their
   producers land. No private, incompatible copy of a shared record type.
4. Introduce no paid call in tests, startup, capability inspection or cache lookup.
5. Keep backward compatibility for non-production packages and existing exports.
6. Return code changes, focused checks, fixture evidence, migration implications,
   untested assumptions and integration hooks. “Unit controller passes” is not
   equivalent to “mounted user journey works.”
7. Never mark subjective listening or creative approval from technical checks.
8. All integration across `apps/server/src/app.mjs` and `apps/web/src/main.ts` goes
   through IP13. Supply exported adapters plus a wiring patch proposal; do not
   have parallel agents edit those files.

### Contract handoff bundle (IP00)

Deliver versioned schemas/types and deterministic fixtures for:

- Production, shot and character voice binding.
- Artifact version/lineage, source claim, reference derivative.
- Decision proposal/resolution and authority evidence.
- Command envelope/result, conflicts and idempotency.
- Action plan/action/receipt/runtime state and capability profile.
- Budget reservations/liability/settlement with currency/unit distinctions.
- Review observations, user verdict and delivery manifest.
- Editor scope/command proposal and native media-track timing.
- Production snapshot/events, replay cursor and reset behavior.

Include sample states: no package yet; waiting on three auditions; selected voice
with unaccepted native transfer; running batch; failed collection with reusable
receipt; owner-edit conflict; rejected accent; completed export with newer edits.
Specify compatibility and generated-type strategy rather than checking in types
that drift from validators. All packages may consume the same contract entry point.

## 2. Dependency graph and merge waves

| Wave | Packets | Purpose |
| --- | --- | --- |
| 0 | IP00 initial contracts | Freeze minimum-slice contracts and fixtures; retain a standing contract owner for versioned amendments |
| 1, parallel | IP01, IP02, IP03, IP04, IP06; IP14 starts fixtures | Execution correctness, editor safety, durable state, budget and research foundations |
| 2, dependency-ordered | IP05-A → IP09-A; IP07/IP08 against fixtures | Casting/conditioning, one native shot, agent tools and artifact UX |
| 3 | IP10-A → IP11-A → IP13-A; IP14 first-slice acceptance | Minimum linked native AV and captioned export before advanced editing |
| 4 | B parts of IP05/IP09/IP10/IP11, then IP12/IP13-B/IP14 | Full commercial editing, motion, archives, migration and acceptance |

IP13 is a standing integration role. It can wire completed adapters incrementally
rather than waiting for every packet. IP14 defines acceptance fixtures early and
verifies integrations as they land. No paid generation feature is exposed before
the shared admission/command/collection fixes pass.

### 2.1 Independently acceptable adapter seams

A/B parts share their parent packet owner but are separate merge/acceptance points.
These narrower dependencies govern the first slice; parent packets below describe
the complete scope. Fixture success does not establish generated-media quality.

| Part | Hard prerequisite | Required output | Later B scope |
| --- | --- | --- | --- |
| IP05-A | IP00, IP03, IP04 | Auditions, selected raw recording, exact-line conditioning and fake native adapter contract | Multi-character/regional integration and native adapter binding |
| IP09-A | IP01, IP03, IP04, IP05-A | One native-shot/test action with receipts and review evidence | Motion, multi-shot batches and richer review |
| IP10-A | IP00 minimum timing amendment, IP02, IP09-A | Linked native AV, source trim, native-speech captions and playback/render parity | Independent J/L tracks, advanced controls, graphics/music recipes |
| IP11-A | IP01, IP03, IP09-A, IP10-A | Single-shot final gate, universal fingerprint, MP4/captions/manifest download | Full source/stem archives and multishot delivery |
| IP13-A | Foundations, IP05-A, IP06/IP07/IP08, IP09-A/IP10-A/IP11-A, legacy-route closure | Mounted journey with transfer acceptance, retry-spend decision and final-take approval | More capabilities, never delayed authorization fixes |

IP00 remains contract owner through all waves. Amend schemas with versioned fixtures
before consumers land. IP01 consumes a frozen effective-input fingerprint interface;
IP09 supplies workflow-specific inputs later. IP05-A uses a native-test interface
fixture until IP09-A lands, removing the apparent circular integration dependency.

### 2.2 Shared-service ownership and exports

New module names are proposed. All exports use IP00 contracts; changes require an
explicit handoff rather than parallel copies of domain state.

| Module / surface | Owner | Contract |
| --- | --- | --- |
| `production/transactions.mjs`, `store.mjs`, `outbox.mjs` | IP03 | `transact`, `readCommittedSnapshot`, `recover`, `claimOutbox`, `ackOutbox`; commit index and runtime fence |
| `production/bindings.mjs` | IP03 | Atomic production creation and package/conversation/run binding lookup; creation-race handling |
| `production/artifacts.mjs`, `lineage.mjs` | IP03 | Artifact registration, effective fingerprints and dependency-impact calculation |
| `production/preferences.mjs` | IP03 | Scoped persistence/resolution; explicit current decision overrides project-character-language settings, then character/user defaults; report conflicts |
| `production/briefs.mjs`, `shots.mjs` | IP03 | Revisioned brief/script/shot proposal, acceptance and active-version reads |
| `production/budget.mjs` | IP04 | Reservation, execution-slot consumption, liability, settlement and reconciliation as transaction participants |
| `takes/routes.mjs` and take ingestion/selection adapters | IP01 | All select/revert/verdict/regeneration routes mapped to shared commands; no boolean-spend authority |
| `agent-chat.mjs` and agent tools | IP07 | Intent/proposal adapters; domain persistence remains IP03-owned |
| Research/source adapters | IP06 | Evidence proposals; registry and claim persistence through IP03 transactions |
| Renderer composition, `audio-mix-model.js`, `incremental-audio.mjs`, shared native timing helpers | IP10 | Source-range/mix/render engine; IP11 consumes it |
| Web native playback/preview integration modules | IP10 | Native AV projection; IP08 supplies artifact selection, IP13 mounts; identify exact files with IP13 before edits |
| Web production cards/reducer/media access, chat/character/reference/take panels | IP08 | Snapshot/event/command client and ticket refresh; no independent store rewrite |
| `export.mjs`, `production/delivery.mjs`, `readiness.mjs` | IP11 | Delivery fingerprint, gates, receipts and download projection |
| Existing agent tool tests and conversation eval cases | IP07 | Tool/prompt regressions |
| New production acceptance cassettes, server integration and `e2e/production.spec.ts` | IP14 | Independent end-to-end evaluation; request changes to IP07-owned tests through IP07 |
| `app.mjs`, `main.ts`, legacy `run.mjs` call sites and route-closure inventory | IP13 | Exclusive mounting/wiring ownership |

IP13 inventories every existing reader/writer and internal drain before IP13-A,
using spec §7.2.1. Production binding is server-resolved. Unsupported legacy paths
are unavailable for bound projects rather than falling back to unsafe execution.
Negative tests include `approved:true`, reusable old hash approvals, queued
regeneration and direct export. Cross-route enforcement is an IP13-A prerequisite.

## 3. Implementation packets

### IP00 — Contracts and compatibility

**Owner:** contract/schema subagent. **Depends on:** none.

**Owns:** proposed `packages/schema/production-v1.schema.json`, shared production
types/validator exports and fixtures/tests under `packages/schema/`; any package-
schema changes required by native editing are made by this owner in consultation
with IP10. Shared root package/build changes are integration-owner reviewed.

**Task prompt:**

> Translate spec §§6–11 into validated, versioned contracts. Separate mutable
> selections from immutable artifacts and technical evidence from user decisions.
> Define canonical hashing inputs, authority records and stable IDs. Extend only
> the render fields actually needed; keep production history outside package-v1.
> Supply fixtures and compatibility rules used by all remaining packets.

**Acceptance:** malformed IDs/cross-project references/invalid states rejected;
canonical ordering/hash stable; decisions bind exact artifacts; voice schemas can
represent regional approval and cloning; no ticket URL/path used as identity;
existing package fixtures remain valid. Native timing conversions have specified
integer rounding and source-bound invariants. No silent truncation to twelve shots.

### IP01 — Verified outputs, immutable takes and freshness

**Owner:** execution/backend correctness subagent. **Depends on:** IP00.

**Owns:** `packages/backends/src/run-package.mjs`, collection helpers in
`colab-backend.mjs`, `apps/server/src/takes/{model,store,ingest,select}.mjs`, associated
tests; proposed immutable ingestion/selection adapter. Coordinate job fingerprint
inputs with IP09. Excludes `app.mjs` and budgeting owned by IP04.

**Task prompt:**

> Reproduce audit A14–A16 and A24's collection/cache boundary implications. Make
> collected bytes verified before apply; recover local receipts before inference
> retries. Ingest immutable takes independently of choosing them. Prepare a
> revision-safe selection/rebase adapter for IP13 to replace unsafe take completion.
> Include model/profile and transitive artifact hashes in freshness. Pin artifacts
> referenced by decisions/deliveries against take eviction.

**Acceptance:** different scratch/out paths work; corrupt/missing output cannot be
applied; partial batch preserves good outputs; selecting a new take invalidates
only a stale upscale; owner edits cannot be overwritten before a conflict response;
approved incumbent survives failed/new candidate; same bytes deduplicate; protected
artifacts survive take-cap cleanup. Return mounted-completion test fixture to IP13.

### IP02 — One editor mutation and recovery path

**Owner:** editor-state subagent. **Depends on:** IP00.

**Owns:** `apps/web/src/editor/{commands,store,autosave,recovery}.ts`, relevant editor
sidecar/scope helpers and editor tests; proposed `agent-edit.ts` command adapter.
Shared server/editor route integration is supplied to IP13, not edited in parallel.

**Task prompt:**

> Address A09/A10. Implement selected-scope capture, autosave flush barriers,
> revision-aware edit proposals and one-undo-step command batches. Provide adapters
> for current storyboard/theme/chat mutation paths. Expose local recovery comparison
> data and new-project transition behavior without discarding old drafts.

**Acceptance:** changing only a headline preserves narration/media; overlapping
manual change conflicts, disjoint change rebases; locks respected; undo retains
earlier manual history; offline reload offers exact local recovery; undo never
tries to undo a paid job. Existing timeline/caption/trim tests stay green.

### IP03 — Durable production commands and coordinator

**Owner:** production-state subagent. **Depends on:** IP00.

**Owns:** proposed `apps/server/src/production/{store,commands,service,actions,events,routes}.mjs`,
durable pipeline lifecycle adapters in `pipeline*.mjs` and their tests. Coordinate
reconciliation with IP01 and reservations with IP04; no direct `app.mjs` edits.

**Task prompt:**

> Implement spec §§6.5–8.3 on existing durable pipeline ownership/journal patterns.
> Persist command intent, decisions, actions and receipts. Add shared CAS/serialization
> usable by all conversation/cast/take writers. Recover cross-file partial commits
> before admitting more mutations. Schedule bounded completion continuations and
> distinguish execution from browser connection state. Return service adapters for
> legacy routes and background tasks; avoid a new general workflow framework.

**Acceptance:** duplicate IDs replay once; mismatched payload conflicts; crash after
submit reconciles known attempt; conversation summary failure preserves effects;
provider completion cannot manufacture approval; restart produces honest interrupted/
reconciling state; gap replay deterministic; objective change/pause stops downstream
scheduling; no busy-wait LLM loops; shared operation lease closes await-gap races.

### IP04 — Persistent budget and resource admission

**Owner:** budget/operations subagent. **Depends on:** IP00; integrates with IP03.

**Owns:** proposed `apps/server/src/production/budget.mjs`,
`packages/backends/src/budget.mjs`, budget tests and legacy admission adapter.
Changes to `run.mjs` mounting/accounting call sites are handed to IP13.

**Task prompt:**

> Reproduce A12/A13 and implement a production-scoped reservation/settlement ledger.
> Preserve exact plan approval per regeneration, phase ceilings and runtime shutdown
> liability. Do not add prior cumulative required values as new spend. Keep account
> estimates distinct from attributable actuals and model currency distinct from GPU
> units. Implement concurrent admission and recovery fixtures.

**Acceptance:** two concurrent plans cannot overreserve; failed auditions/tests/
batches/retries retain exposure; restart cannot reset headroom; settlement replaces
reservation rather than double-counting; uncertain stop keeps reserve and blocks
new allocation; BYO not labelled free; a ceiling alone is not plan approval.

### IP05 — Casting, approved recordings and native validation

**Owner:** voice/character service subagent. **Depends on:** IP00, IP03, IP04;
native-test integration with IP09.

**Owns:** `apps/server/src/characters/{model,voice,audition,routes}.mjs`, casting/
conditioning adapters, relevant `packages/tts/` or bounded workers and tests.
Frontend mounted audition controls are IP08; job profile changes are IP09.

**Task prompt:**

> Close A02/A22/A24. Consolidate voice validation, add real designed-audition and
> approved-reference clone operations, dry previews, actual immutable audio identity,
> language/accent-scoped decisions and native-test binding. Reuse cache/coalescing
> primitives but make inspection pure and cached bytes verified. Keep legacy
> narrator mode. Do not encode Basil as the universal default.

**Acceptance:** mounted service returns playable fixture auditions; identical
requests synthesize once; corrupt cached WAV regenerates only after explicit action
admission; A2 reference/hash reused; QC1/QC2 stay rejected; Molty/Don direction kept;
missing approved recording blocks; conditioning and final audio stay distinct;
selected voice alone does not bypass default native-transfer review policy.

### IP06 — Research, claims and source capture

**Owner:** research/source service subagent. **Depends on:** IP00; service mounting
uses IP03 contracts.

**Owns:** proposed `apps/server/src/production/research.mjs`, `packages/sources/`
research/capture adapters and tests; claim/artifact integration fixtures.

**Task prompt:**

> Implement bounded injected search, page fetch and read-only browser capture, with
> immutable snapshots and supported-claim records. Use the ussy.host catalog and
> Hermes/OpenClaw comparison as offline fixtures. Treat source content as evidence,
> not instructions. Make unavailable search distinct from available direct URL
> fetch. Keep credentials and local file paths out of model-facing results.

**Acceptance:** site nature derives from evidence, not domain name; returned claims
point to exact snapshot/excerpt; redirect/private-network/type/size/time limits;
capture does not post shared state; unsupported claims remain uncertain; malicious
page text cannot create decisions or spend; no live requests in standard tests.

### IP07 — Agent tools, decisions and scoped creative iteration

**Owner:** conversational-agent subagent. **Depends on:** IP00, IP02, IP03; consumes
IP04–IP06/IP09 capability adapters (fixtures until landed).

**Owns:** `packages/agent/src/conversation.ts`, new production tools, existing
reference/character/clip tool adapters, bundled skills, agent tests/evals;
`apps/server/src/{agent-chat,chat-state,chat-project}.mjs` integration logic.
Does not edit `app.mjs` or web chat.

**Task prompt:**

> Implement spec §7.3 and scoped feedback rules. Route effects through shared
> commands rather than request-lifetime side effects. Replace incompatible
> one-voice/upload-only instructions only for supported capabilities. Make exact
> user-originating selections resolvable without a second model call, while model
> proposals remain proposals. Pass editor scope/revisions and persist constraints,
> decisions and rejected candidates outside bounded history. Correct project-scoped
> reference lineage and character-draft acceptance semantics.

**Acceptance:** model cannot approve itself; stale “go for it” refuses changed plan;
empty library can create a fictional cast draft; line/music-only feedback preserves
unrelated media; provider failure after decision/build is recoverable; selected
scope survives history truncation; actual model requests include new capability
rules; no claims to see/hear absent evidence; no deterministic demo fallback
silently replaces an approved production after model failure.

### IP08 — Artifact cards, casting and review UX

**Owner:** production UX subagent. **Depends on:** IP00, IP02, IP03; works against
fixtures for IP05/IP07/IP09.

**Owns:** proposed `apps/web/src/production/` client/reducer/cards/workspace,
`project-chat.ts`, character web API/editor/mount, reference/take panel changes,
timeline mount review callbacks, focused tests and styles. Excludes `main.ts`,
editor command core (IP02) and native-track engine (IP10).

**Task prompt:**

> Implement spec §2 using the existing chat/inspector/timeline. Cards reflect shared
> artifact/decision state and support actual media, select/reject/change, comparison,
> pending/superseded/error states and context chips. Fix misleading Reject/Redo/
> dry-run labels and forward review callbacks. Add expiry-aware media lookup and
> snapshot/event reconciliation. Supply responsive Chat/Workspace/Activity panels
> without hiding paid-operation controls.

**Acceptance:** real mounted fake audition route, not demo samples; reject persists
exact proposal ID; preview never selects; timeline opens correct take; new output
does not steal focus; stale events cannot affect another project; playback remints
after expiry; keyboard/focus/mobile states work; controls do not need an LLM call.

### IP09 — Native speaking/motion adapters and technical review

**Owner:** media-workflow subagent. **Depends on:** IP00, IP01, IP03, IP04, IP05.

**Owns:** `packages/jobs/src/plan.mjs`, `fasth3-direction.mjs`, supported workflow
profiles and parameter schemas; proposed production media/review adapters and
worker tests. Coordinate schema changes through IP00; take ingestion remains IP01.

**Task prompt:**

> Promote the reusable concepts from Hermes/Basil/dance scripts into bounded action
> adapters, not hard-coded production scripts. Add exact-line/native-test/batch and
> video-motion-reference capability planning, derivative provenance, canonical output
> receipts and structured review jobs. Review final native speech independently of
> conditioning, including nominally silent clips and tails without relying on VAD.

**Acceptance:** one target retry creates no unrelated jobs; `17n+5`/24fps and duration
constraints checked before allocation; motion graph consumes the intended video;
output collector excludes input previews; raw/normalized transcript differences
retained; natural speed preserved; technical pass cannot set creative verdict;
reconciliation differs from creative new-seed retry; unsupported workflow rejected.

### IP10 — Editable native AV, graphics and music

**Owner:** planner/renderer subagent. **Depends on:** IP00, IP02, IP09.

**Owns:** `packages/planner/`, renderer source/mix/incremental-audio logic,
native-track editor modules and tests. Request validated schema changes from IP00;
IP08 provides surrounding controls; IP11 owns delivery/export service.

**Task prompt:**

> Implement spec §10.3: independent source/timeline ranges, linked/unlinked native
> dialogue, J/L cuts, correct trim parity, native-speech caption anchors, editable
> exact-text graphics and music/ducking parameters. Keep current explainer layouts.
> Provide bounded recipes for product screenshots/title cards instead of executing
> arbitrary model-written TSX. Music-only edits must remain CPU/mix operations.

**Acceptance:** fixture J/L cuts preserve continuous speech with no doubling;
browser/full/incremental render agree; frame/sample rounding tested; shot replacement
does not silently retime dialogue; captions valid/nonoverlapping; overlay and music
edits remain independently editable; no network calls at render time.

### IP11 — Consistent final gates and versioned delivery

**Owner:** delivery/quality subagent. **Depends on:** IP00, IP01, IP03, IP09, IP10.

**Owns:** `apps/server/src/export.mjs`, proposed delivery/readiness services,
review-gate extensions, download/verification adapters and tests. Route attachment
and all-path wiring are supplied to IP13.

**Task prompt:**

> Fix A18/A19 at the service boundary. Distinguish first generation, draft preview
> and final readiness. Fingerprint all current package/editor/media/mix/caption
> inputs, including ordinary non-composition exports. Produce immutable delivery
> manifests and explicit private versus redistributable archives. Verify actual
> output and never declare success because an old video.mp4 exists.

**Acceptance:** every final route shares policy; old-video/new-caption mismatch
reproduced then prevented; missing/corrupt media cannot be overridden; allowed
creative overrides recorded; archive CRC/hash/frame/caption checks; private sources
and rights exclusions correct; delivery history survives further edits; browser
downloads served bytes rather than only filenames/paths.

### IP12 — Opt-in import and reference-aware retention

**Owner:** migration/provenance subagent. **Depends on:** IP00, IP01, IP03, IP05,
IP10, IP11.

**Owns:** proposed `apps/server/src/production/import.mjs`, local import command,
synthetic production manifests/fixtures and import tests. Reads demos but does not
mutate actual production roots or copy private media into Git.

**Task prompt:**

> Import an existing package plus explicit production manifests into the new model.
> Preserve original IDs/edits and hash-verify files. Import only supported evidence:
> Basil's approved transfer differs from Hermes's technically checked native test.
> Mark unknown provenance/review honestly. Pin referenced artifacts against purge.

**Acceptance:** second import is a no-op/idempotent; originals unchanged; missing
approved source offers recovery instead of preset fallback; rejected takes remain
rejected; private source permissions survive; fixture based on owner revision 10
retains manually extended shot and timeline order.

### IP13 — Integration owner and mounted vertical slices

**Owner:** lead/integration agent. **Depends on:** progressive adapter readiness;
must not wait until the end to discover missing mounts.

**Owns exclusively:** `apps/server/src/app.mjs`, `apps/web/src/main.ts`, shell/index
wiring, old `run.mjs` compatibility/admission call sites, root build/config changes,
feature flag and cross-subagent interface resolution. Delegated modules remain
owned by their packets. IP13 coordinates any shared-file conflict explicitly.

**IP13-A:** mount contracts/state/ledger/research/casting/agent/cards and one native
action, including spec §7.2.1 legacy-route closure. Demonstrate: new project →
evidence-backed brief → three fixture auditions → voice selection → native test →
explicit transfer acceptance → select test take → final gate blocked pending
quality verdict → correction → approve exact retry plan → generate/select corrected
take → explicit quality approval → captioned export. Reload mid-flow and deliberately
lose a submission response. Selection and transfer acceptance alone cannot unlock
final delivery. No paid calls; advanced IP10-B editing is not a prerequisite.

**IP13-B:** connect full native AV/graphics/delivery/import, extend the already enforced cross-route policies,
mobile activity, offline recovery and current-project event scoping. Reconcile
old policy docs without silently broadening approval authority.

**Acceptance:** no unmounted functionality advertised; no old route bypasses
budget/final gate for production-bound packages; actual default factory wiring
works; all source-audit critical regressions reproduced and fixed; all UX actions
reachable with mocks in mounted app; current non-production paths still work.

### IP14 — Behavioral evals, fault injection and UX acceptance

**Owner:** independent test/evaluation subagent. **Depends on:** IP00 for fixtures;
IP13-A/B for final browser coverage. Starts in wave 1.

**Owns:** new server production integration tests/cassettes, agent eval scenarios,
web e2e production tests/accessibility state matrix, acceptance report. Coordinate
existing tests with owners; do not patch DOM to make missing features pass.

**Task prompt:**

> Turn spec §13 and W01–W18 into mounted-app regressions and agent cassettes. Inject
> dropped responses, crashes around side effects, stale hashes, concurrent edits,
> expired tickets, partial collection, delayed billing and unknown teardown. Assert
> preservation and actual decoded fixture identity, not just status labels.

**Acceptance:** complete first and full vertical slices without external calls;
fake provider cannot self-approve; mobile actions reachable; accessible review,
approval/error/recovery dialogs; checks across restart/offline reload; distinct
creative evaluation rubric and explicit authorization needed for real listening/
generation trials. Report observed checks and untested subjective quality separately.

### Review-driven acceptance additions (all owners)

- IP00/IP03/IP04: bind a spend decision to one execution identity and enumerated
  consumable generation slots. Same hash with a different command/action cannot
  spend again. Confirmed failure does not authorize fresh inference; unknown
  submission reconciles first. Changed seed requires a new exact authorized slot.
- IP03/IP04/IP13: implement spec §6.6 commit-index/read-visibility/outbox protocol.
  Crash after each participant write, commit, projection, event publication and
  continuation enqueue; then read state and invoke a legacy mutation. All readers
  must see committed state, and no completion notification can be permanently lost.
- IP01/IP02/IP03/IP08: selection updates package, take sidecar and production
  projection atomically. Undo is a compensating command, not deletion of history.
  Test manual trim → confirmed replacement → undo → reload → export, including
  offline pending undo and overlapping concurrent selection.
- IP04/IP06/IP07/IP10: implement spec §8.2.1 adapter policy with billing unit,
  estimate source, enforceable request/token/time limits, authorization type and
  uncertain-charge handling. Mixing existing music remains CPU-only; generating
  new billable music is a distinct explicitly authorized action.
- IP08/IP14: verify the decision-effects matrix in spec §6.3, including rejection
  of a selected take, approval of an unselected take and native-transfer acceptance
  without implicit final-take approval. Test compound controls as explicit effects.

## 4. Test commands and deployment discipline

Use the package's existing scripts and focused tests during development:

```bash
pnpm -C packages/schema test
pnpm -C packages/agent test
pnpm -C apps/server test
pnpm -C apps/web test
pnpm -C apps/web typecheck
pnpm -C apps/renderer test
pnpm -C apps/web test:e2e -- production.spec.ts
pnpm run check
```

`production.spec.ts` is the proposed IP14 fixture journey, not an existing test.
Run builds and browser servers in an isolated checkout/output directory: live
`apps/web/dist` may contain private delivery symlinks. Do not run the server start
script against the user's runtime or overwrite deployed output while testing.
The integration owner broadens to existing full checks at wave boundaries; each
subagent runs relevant focused tests first. A docs-only handoff does not require
live application builds or paid experiments.

## 5. Completion definition

The integration is complete only when the user can perform the whole fixture
journey in the mounted app, reload/recover mid-iteration, make scoped changes
without unnecessary generation or lost edits, and download a correctly versioned
editable result. Separate authorized real-media trials then establish whether the
voices, native transfer, action and final mix meet the user's creative expectations.
Shipping a tool schema, a card controller or a happy-path demo alone is insufficient.
