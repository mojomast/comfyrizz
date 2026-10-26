# UX00 — Baseline, contracts and compatibility

Packet UX00 of `docs/tasks/UX_RESULTS_REMEDIATION_20261026.md`. Status:
**component verified** (contracts, fixtures and conformance tests; no mounted
behaviour change). Branch base: `d427f9a` on `docs/ux-results-remediation-plan`
(audited tip `f16d188` plus the UX plan docs).

This packet freezes the first-slice shared contracts by extending the existing
production contract conventions. It adds no production framework, no persisted
field and no route. Behaviour fixes belong to UX01–UX21.

## Baseline note for the coordinator

The deployment fix `2de992d` is not in this base. `apps/web/src/easy/steps/index.ts`
still uses `import.meta.glob('./*.ts', { eager: true })`, which also matches
`steps/*.test.ts`. That is outside UX00 and is left for the coordinator.

At this base, `pnpm -C apps/web test` has 9 failing tests, and
`apps/server/test/pipeline-stages.test.mjs` and `apps/server/test/po3-spend.test.mjs`
have 14 failing tests. All of them fail identically with and without this packet.

## Canonical locations

The contracts live in two places. One is the validator module the production
journal already uses. The other is the web module that already owns the
literal. There is no second copy of any data transfer object (DTO).

| Contract | Version tag | Canonical location | Consumers |
| --- | --- | --- | --- |
| Admission/command | `comfyrizz.admission/v1` | `apps/server/src/productions/contract.mjs` | UX01, UX02, UX03, UX10, UX13 |
| Production binding (unbound compatibility) | part of admission | `apps/server/src/productions/contract.mjs` | UX01, coordinator (`app.mjs`) |
| Mutation scope / target set | extends `comfyrizz.iteration-scope/v1` | `apps/server/src/productions/iteration-scope.mjs` | UX09, UX12, UX17 |
| Media source and ticket | `comfyrizz.media-ticket/v1` | `apps/server/src/productions/contract.mjs`; `media-range.mjs` uses its `MEDIA_ID_PATTERN` | UX11, UX12, UX13 |
| Save state / revision | `comfyrizz.save-state/v1` | `apps/web/src/editor/save-state.ts` (literals stay `SaveStatus` in `editor/store.ts`) | UX05, UX08 |
| Project session / readiness | `comfyrizz.easy-session/v1` | `apps/web/src/easy/session-contract.ts` (record stays `EasyState` in `easy/types.ts`) | UX06, UX07, UX08 |

The web code can import the server `.mjs` modules directly, as it already does
with `productions/iteration.mjs` and `iteration-scope.mjs`. The agent package
cannot import outside its `rootDir`. Its mirror must pass the shared JSON
fixtures in `apps/server/test/fixtures/ux00/` instead of copying rules.

### Admission/command (`contract.mjs`)

- **Authority request:** the bound authority is the existing IP24 shape
  `authority { productionId, planId, planHash, actionId }` plus
  `expected.productionRevision`.
  - `validateBoundAdmission` refuses any caller-supplied `approved`, `actor`,
    `userEventId`, `reservationId` or `state` with `CALLER_AUTHORITY_FORBIDDEN`.
    No caller boolean is authority.
- **Command identity:** `admissionCommandId(authority)` returns
  `run-start:<planHash>:<actionId>`, which is the id `run.mjs` already commits.
  A test pins it to the `run.mjs` source so the two cannot drift.
- **Entry points:** `ADMISSION_ENTRY_POINTS` lists `run.start`, `pipeline.start`,
  `take.regenerate`, `take.regenerate_batch`, `take.queue_drain`,
  `chat.correction`, `audition.synthesize` and `action.outbox`.
  Every bound start goes through one of these.
- **Refusals:** `ADMISSION_REFUSALS` maps each refusal code to its HTTP status.
  - It reuses every live `run.mjs` and production-route code unchanged.
  - It adds two codes: `PRODUCTION_NOT_ACTIVE` (409), for an intent other than
    `active` (`ADMITTING_INTENTS`), and `BOUND_ENTRY_UNSUPPORTED` (409), for a
    bound package on an entry point that cannot yet carry journal authority.
- **Refusal shape:** `{ error, code, details? }`.
  - `details` keys are limited to `ADMISSION_REFUSAL_DETAIL_KEYS`.
  - `validateAdmissionRefusal` rejects a refusal that claims a start (`runId`,
    `jobId`, `started`, `queued` and similar), a status that disagrees with the
    table, an unknown code and a leaked filesystem path.
  - `admissionRefusal()` builds one and throws on an unknown code or detail key.
- **Legacy refusal:** `isLegacyBudgetRefusal` recognises the existing unbound
  `/api/run` budget refusal (HTTP 200, `{ refused: true, ... }`) so readers can
  keep accepting it.

### Unbound-project compatibility (`resolveProductionBinding`, `bindingRefusal`)

- **Who owns a package:** a package is bound to the lowest-id production whose
  `packageId` equals the package id. This matches both live lookups, because
  `store.list()` is sorted by id. When no production claims the package, it is
  **unbound**.
- **Inline `pkg.productionId`:** this field is not part of the package schema,
  but `/api/run` accepts inline packages. It can only make a start stricter.
  - It binds an otherwise unbound package.
  - When it disagrees with the store owner, the result is a `conflict`, which
    `bindingRefusal` reports as `PRODUCTION_MISMATCH`.
  - It can never unbind a package.
- **Refusal order:** `bindingRefusal` checks conflict, then missing production
  (`PRODUCTION_NOT_FOUND`), then non-active intent (`PRODUCTION_NOT_ACTIVE`).
  Plan, action and reservation authority are checked after that. Intent never
  unbinds a package: a paused or cancelled production refuses rather than
  falling back to the legacy path.
- **Unbound packages:** these keep today's behaviour exactly. That covers the
  `approved` flag, in-memory plan-hash approvals, `budgetUnits`, the legacy 200
  budget refusal, `/api/pipeline` and take regeneration. UX01 must keep the
  existing unbound tests green: `legacy-run-closure`, `run-admission` and
  `pipeline-http`.

### Mutation scope (`iteration-scope.mjs`)

- **Id kinds:** `SCOPE_ID_PATTERNS` and `scopeIdKind` classify the canonical
  ids: package, take, character, line (`<shotId>:l<n>`), clip
  (`<shotId>:<assetId>`), shot, asset and cast.
  - The shot, asset and cast patterns are asserted equal to the package-schema
    `$defs`, so named ids such as `s_intro` are legal.
  - Classification is syntactic. Resolving an id against current state is the
    consumer's job, and an id that doesn't resolve is refused with
    `SCOPE_UNRESOLVED`.
- **Target sets:** `normalizeTargetSet` defines what absent and empty mean.
  - Absent is `unscoped`: every shot, still subject to read, intent, lock and
    preserve rules.
  - `{ shotIds: [], lineIds: [] }` is `empty`, and mutation is refused with
    `SCOPE_EMPTY`.
  - Otherwise it is `scoped`. A shot id permits the whole shot; a line id
    permits only that line.
  - **A host with no selected chips omits `targets`; it does not send `[]`.**
- **Allow check:** `targetSetAllows` is the one check that ordinary and
  production tools share.
- **Refusal codes:** `MUTATION_REFUSAL_CODES` is the single refusal vocabulary
  for mutating tools. `REVISION_CONFLICT` and `ITERATION_SHOT_LOCKED` keep their
  existing meaning.
- **Source revision:** `validateIterationScope` accepts an optional
  `sourceRevision { packageRevision?, productionRevision? }`. It is emitted only
  when present.

### Media source and ticket (`contract.mjs`)

- **Durable identity:** the durable identity is a `MediaSource`, one of
  `take{packageId,clipId,takeId}`, `artifact{artifactId|mediaId}`,
  `package_media{packageId,path}` or `thumb{packageId,clipId,takeId}`.
  - `validateMediaSource` refuses `url`, `ticket`, `ticketUrl` or `expiresAt`
    inside a source (`EXPIRING_URL_AS_IDENTITY`). It also refuses absolute and
    local paths.
- **Tickets:** `validateMediaTicket` accepts all three live shapes: the
  `/api/media-ticket` response, the `mint()` result and the take ticket. It
  requires `url === /api/media/<ticket>` and an `expiresAt`.
- **Expiry:** `ticketExpiryState(ticket, now)` returns `fresh`, `renew` (within
  `MEDIA_RENEW_BEFORE_MS`), `expired` or `unknown`. A resolver retries
  `MEDIA_RENEWAL_LIMIT` consecutive renewals before showing the source as
  unavailable.
- **Deduplication:** `mediaSourceKey` is the deduplication and cache key, and it
  ignores property order.
- **Resolver interface:** the `MediaResolver` interface
  (`resolve(source, { signal })`, `invalidate`, `dispose`) is a JSDoc typedef.
  UX11 implements it.

### Save state / revision (`editor/save-state.ts`)

- **Status meanings:** `SAVE_STATUSES` are exactly the existing `SaveStatus`
  literals, with a compile-time exhaustiveness check. `SAVE_STATUS_MEANING` maps
  them:

  | Status | Meaning |
  | --- | --- |
  | `saved` | server-saved |
  | `pending` | saving |
  | `offline` | local draft |
  | `conflict` | conflict |
  | `rejected` | error |

- **Snapshot:** `SaveState` is the snapshot that a `SaveStateSource`
  subscription publishes: status, edit sequence, acknowledged sequence,
  acknowledged revision, conflict revision and rejection reason.
- **Invariants:** `validateSaveState` enforces these:
  - There is no `saved` without a server acknowledgement of the current edit
    sequence.
  - A conflict names the server revision it lost to.
  - A rejection carries the server reason.
  - The revision is not document content: a `package` field is refused.
- **Undo:** the acknowledged revision is not undoable. Undo and redo change the
  document, never `acknowledgedRevision`.
- **No server session:** without a server session the state is `offline`, never
  an indefinite `pending`.

### Project session / readiness (`easy/session-contract.ts`)

- **Readiness:** `resultReadiness(evidence)` returns `none`, `preview_ready` or
  `export_ready`, and readiness is never stored as a flag.
  - `export_ready` requires an actual final artifact id whose revision equals
    the current package revision.
  - A compiled preview gives `preview_ready`, never `export_ready`.
- **Late results:** `ProjectSessionRef { generation, packageId, chatId,
  productionId }` and `isCurrentSession` reject late results from another
  generation or project.
- **New project:** `NEW_PROJECT_RESET` and `NEW_PROJECT_CARRY` classify every
  `EasyState` field, checked both at compile time and against
  `defaultEasyState()`.
  - Identity, content, decisions, spend cap, plan hash and export state reset.
  - Only `version`, `offline`, `level`, `levelTouched` and `compute` carry over.

## Old-record behaviour

- **Iteration scopes:** records without `sourceRevision` normalise byte-for-byte
  unchanged (fixture: `scope.json` `iterationScopes.valid[0]`).
- **Legacy viewer `lineId`:** the viewer's legacy `lineId` holds a scene id
  (`apps/web/src/main.ts` around line 577). It is read as a whole-shot target,
  so the host maps it into `shotIds`. A shot-valued `lineIds` entry is refused
  by `normalizeTargetSet`, so a legacy value is never silently widened or
  narrowed.
- **Tickets:** tickets without `expiresAt`, from thumbnails today, are `unknown`
  rather than `fresh`. They are renewed on a load error and never persisted.
  Persisted records keep `mediaId`/`artifactId` (already in `ArtifactVersion`)
  and never a URL.
- **SaveStatus:** the `SaveStatus` literals and `saveStatusText` are unchanged,
  so current readers keep working while UX05 adds the subscription.
- **EasyState:** `EasyState` gains no field, so stored Easy records load
  unchanged. Missing review or provenance stays unknown and is never inferred.
- **Legacy budget refusal:** the unbound `/api/run` budget refusal stays 200 with
  `refused: true`. Only bound refusals use the typed status table.

## Amendment procedure

A packet that needs a shared field or code files an amendment request with
UX00. The request goes through the coordinator and names the producer and the
consumers. UX00 does three things:

- It edits the canonical module and its `fixtures/ux00/*.json` together.
- It bumps the version tag when the meaning of an accepted value changes. Adding
  an optional field or a new refusal code is additive and keeps `v1`.
- It reruns both UX00 contract tests.

Consumers never add a private copy of a contract type.

## Route/mount inventory

The mount points are in `apps/server/src/app.mjs`, which is coordinator-owned.
The full start, cancel, select, revert and export inventory is the machine-checked
matrix `apps/server/test/fixtures/ux00/entry-points.json`. It has 28 rows, each
with its handler file and symbol, browser callers, admission entry point, legacy
flag, binding, authority, idempotency, owning packet and gap. The test fails if a
handler symbol disappears.

| Row | Route | Binding / authority / idempotency | Owner |
| --- | --- | --- | --- |
| start.run.bound | `POST /api/run` (authority) | resolved / journal / action | UX01 |
| start.run.unbound | `POST /api/run` | resolved / boolean / none (legacy) | UX01 |
| start.run.approve | `POST /api/run/approve` | none / boolean / none (legacy) | UX01 |
| start.pipeline | `POST /api/pipeline` | none / gate / revision (legacy) | UX01 |
| start.take.regenerate | `POST /api/package/:id/clips/:clipId/regenerate` | unwired / boolean / none (legacy) | UX01 |
| start.take.regenerate_batch | `POST /api/package/:id/clips/regenerate-batch` | unwired / boolean / none (legacy) | UX01 |
| start.take.queue_drain | internal `drainOneQueued` | none / boolean / none (legacy) | UX01 |
| start.chat.correction | internal `chatRuns` | resolved / none / none | UX01 |
| start.audition | `POST /api/characters/:id/audition` | url / journal / action | UX13 |
| start.production.dispatch | `POST /api/productions/:id/actions` | url / command / command | UX03 |
| start.production.outbox | internal outbox drain | url / journal / action (not mounted) | UX03 |
| start.production.take_request | `take.request` / `render.request` commands | url / command / command | UX03 |
| cancel.production | `production.cancel` command | url / command / command | UX03 |
| cancel.action | `action.cancel` command | url / command / command | UX03 |
| cancel.pipeline | `POST /api/pipeline/:runId/cancel` | none / none / none (legacy) | UX03 |
| cancel.run | none | none (legacy) | UX03 |
| cancel.render | client disconnect on render routes | none | UX15 |
| select.clip | `POST /api/package/:id/clips/:clipId/select` | unwired / none / none (legacy) | UX10 |
| select.production | `take.select` command | url / command / command | UX10 |
| select.auto_ingest | internal `completeRun` | none / none / revision | UX10 |
| select.chat | internal chat select proposal | none | UX10 |
| revert.clip | `POST /api/package/:id/clips/:clipId/revert` | none (legacy) | UX10 |
| export.bundle | `POST /api/export` | unwired / gate / revision | UX15 |
| export.render | `POST /api/render` | unwired / gate / revision | UX15 |
| export.scene_render | `POST /api/scene/render` | unwired / gate / revision | UX15 |
| export.edited_render | `POST /api/render/edited` | unwired / gate / revision | UX15 |
| export.pipeline_files | `GET /api/pipeline/:runId/files/:name` | none (legacy) | UX15 |
| export.run_video | `GET /api/run/:id/video` | none (legacy) | UX15 |

Mount findings for the coordinator. These are recorded in the matrix and are
not fixed here:

- **Orphans:** `createPipelineAdapter` and `drainOutbox` are never called from
  `app.mjs`, so a dispatched action only starts if the browser calls `/api/run`.
- **Missing binder:** `createTakeRoutes` and `createRenderRoutes` are built
  without the `production:` binder they already accept. Bound regeneration and
  export therefore take the legacy path.
- **Binding lookup:** `findBoundProduction` in `app.mjs` ignores an inline
  `pkg.productionId`, while `boundProductionFor` in `run.mjs` honours it. Both
  should use `resolveProductionBinding`.
- **Cancel:** `/api/run` has no cancel route, and both run paths create an
  `AbortController` that is not retained. `production.cancel` changes intent
  only, and `action.cancel` only writes a journal entry.
- **Select/revert:** revert has no compare-and-swap (CAS) or command id, and
  production `take.select` never changes the package selection.
- **Intent:** `verifyBoundAuthority` never reads production intent.

## Schema export inventory

| Module | Exports relevant to the first slice |
| --- | --- |
| `apps/server/src/productions/contract.mjs` | Existing: `PRODUCTION_SCHEMA`, `PRODUCTION_INTENTS`, `ARTIFACT_KINDS`, `DECISION_*`, `ACTION_STATES`, `ACTION_TRANSITIONS`, `REVIEW_OBSERVATION_KINDS`, `VERDICTS`, `RECORDED_ACTORS`, `EVENTS`, `COMMANDS`, `ITERATION_*`, `canTransition`, `validate{Production,ArtifactVersion,Decision,ActionPlan,Action,ReviewObservation,CreativeVerdict,Event,CommandEnvelope,RecordedCommand}`. New: `ADMISSION_*`, `ADMITTING_INTENTS`, `validateBoundAdmission`, `validateAdmissionRefusal`, `isLegacyBudgetRefusal`, `admissionRefusal`, `admissionCommandId`, `resolveProductionBinding`, `bindingRefusal`, `MEDIA_*`, `validateMediaSource`, `validateMediaTicket`, `mediaSourceKey`, `ticketExpiryState` |
| `apps/server/src/productions/iteration-scope.mjs` | Existing: `ITERATION_SCOPE_SCHEMA`, `SCOPE_ELEMENTS`, `PRESERVE_KEYS`, `IterationScopeError`, `validateIterationScope`, `toPromptHint`. New: `SCOPE_ID_PATTERNS`, `SCOPE_ID_KINDS`, `MUTATION_REFUSAL_CODES`, `TARGET_SET_MODES`, `scopeIdKind`, `normalizeTargetSet`, `targetSetAllows` |
| `apps/server/src/media-range.mjs` | `mediaIdFor`, `createMediaTickets`, `safeMediaPath`, `mediaContentType`, `serveTicket` (its private media-id pattern now comes from `contract.mjs`) |
| `packages/schema` | `.` (`src/index.mjs`), `./animation`, `./schema` (`package-v1.schema.json`), `./types` (`types.ts`) |
| `apps/web/src/editor/store.ts` | `SaveStatus`, `saveStatusText`, `createEditorStore` (unchanged) |
| `apps/web/src/editor/save-state.ts` | New: `SAVE_STATE_CONTRACT`, `SAVE_STATUSES`, `SAVE_STATUS_MEANING`, `SaveState`, `SaveStateSource`, `isServerSaved`, `validateSaveState` |
| `apps/web/src/easy/types.ts` | `EasyState` (unchanged; UX00-owned) |
| `apps/web/src/easy/session-contract.ts` | New: `EASY_SESSION_CONTRACT`, `RESULT_READINESS`, `ResultEvidence`, `resultReadiness`, `ProjectSessionRef`, `isCurrentSession`, `NEW_PROJECT_RESET`, `NEW_PROJECT_CARRY` |

## Wave 1 write sets and leases

Each lease is granted against base `d427f9a`. A worker edits only its leased
paths and creates new files only where listed. UX00-owned contract modules and
fixtures are read-only for every Wave 1 packet. A needed change goes through the
amendment procedure. `apps/server/src/app.mjs`, `apps/web/src/main.ts` and root
tooling stay coordinator-owned. Workers hand back exported adapters and exact
wiring instructions.

### UX01 — Universal generation admission

- **Write:**
  - `apps/server/src/pipeline.mjs`
  - the admission portions of `apps/server/src/run.mjs` (`verifyBoundAuthority`,
    `boundProductionFor`, `start` up to backend allocation). The lease passes to
    UX03 on merge.
  - new `apps/server/src/productions/admission.mjs`: the adapter that turns
    `resolveProductionBinding` and `bindingRefusal` into the `production:`
    binder for take routes, the queue drain and chat runs.
- **Tests:**
  - new `apps/server/test/ux01-*.test.mjs`
  - `apps/server/test/pipeline-http.test.mjs`
  - `apps/server/test/run-admission.test.mjs`
  - `apps/server/test/legacy-run-closure.test.mjs`
- **Read-only:**
  - `apps/server/src/takes/routes.mjs` (UX10)
  - `apps/server/src/productions/{actions,commands}.mjs` (UX02 → UX03)
  - `apps/server/src/agent-chat.mjs` (UX09)
- **Coordinator wiring in `app.mjs`:**
  - `/api/pipeline` admission
  - `chatRuns`
  - `drainOneQueued`, which refuses bound packages with
    `BOUND_ENTRY_UNSUPPORTED`
  - the `createTakeRoutes` binder
  - replacing `findBoundProduction`

### UX05 — Undo, revision and save-state truth

- **Write:**
  - `apps/web/src/editor/store.ts`, which implements `SaveStateSource`
  - `apps/web/src/editor/autosave.ts`
  - `apps/web/src/editor/commands.ts`, serialization only
  - the save request in `apps/web/src/editor/api.ts`
- **Tests:**
  - `apps/web/test/editor/store.test.ts`
  - `apps/web/test/editor/autosave.test.ts`
  - `apps/web/test/editor/autosave-retry.test.ts`
  - new `apps/web/test/editor/ux05-*.test.ts`
- **Read-only:**
  - `apps/web/src/editor/save-state.ts` (UX00)
  - `apps/web/src/easy/shell.ts` (UX08)
  - editor timeline and inspector consumers
- **Coordinator wiring in `main.ts`:** subscribe the editor header to
  `subscribeSaveState`. The Studio badge waits for UX08.

### UX06 — First useful result and stable progress

- **Write:**
  - `apps/web/src/easy/mount.ts`
  - `apps/web/src/easy/cpu-path.ts`
  - `apps/web/src/easy/super-easy/{session,mount,progress-view}.ts`
  - `apps/web/src/easy/store.ts`, only for helpers the CPU path or session
    needs. The lease passes on to UX07.
- **Tests:**
  - `apps/web/test/easy-cpu-path.test.ts`
  - `apps/web/test/easy-super-easy-wiring.test.ts`
  - `apps/web/src/easy/super-easy/{session,mount,progress-view}.test.ts`
  - new `apps/web/test/ux06-*.test.ts`
- **Read-only:**
  - `apps/web/src/easy/types.ts` and `session-contract.ts` (UX00)
  - `apps/web/src/easy/steps/export.ts` (UX16)
  - `apps/web/src/easy/super-easy/run.ts` and `apps/web/src/easy/approve-generate.ts` (UX07)
- **Lease order:** the `easy/mount.ts` lease goes UX06 → UX07 → UX08.

### UX09 — Authoritative scope across agent tools

- **Write:**
  - `apps/server/src/agent-chat.mjs`
  - `packages/agent/src/{conversation,production-tools,production-planner}.ts`
  - new `packages/agent/src/mutation-policy.ts`, which mirrors
    `normalizeTargetSet`, `targetSetAllows` and `MUTATION_REFUSAL_CODES`
- **Tests:**
  - `apps/server/test/agent-chat-scope.test.mjs`
  - `apps/server/test/agent-chat-production.test.mjs`
  - `packages/agent/test/{production-scope,production-tools,production-guardrails,conversation-production}.test.ts`
  - new `ux09-*` tests
  - The agent mirror must pass `apps/server/test/fixtures/ux00/scope.json`.
- **Read-only:**
  - `apps/server/src/productions/iteration-scope.mjs` (UX00)
  - `apps/server/src/chat-project.mjs` (UX17)
- **Coordinator wiring in `main.ts`:** send `targets` only when chips exist, and
  map the legacy scene-valued `lineId` into `shotIds`.

### Overlap check

No path appears in two Wave 1 write sets. UX01 is the only Wave 1 writer under
`apps/server/src/run.mjs` and `pipeline.mjs`, and UX09 is the only one in
`agent-chat.mjs` and `packages/agent/src`. Every UX05 write is under `apps/web/src/editor/` and
every UX06 write is under `apps/web/src/easy/`. The two test write sets are disjoint
directories and file names. The only shared inputs are the read-only UX00
modules and fixtures.

## Wave 2 write sets and leases

Each lease is granted against base `f7f5387` (feat/ux-results tip after PB-BOOTSTRAP
follow-up; includes merged UX00/UX05/UX06/UX09/UX20 and PB-BOOTSTRAP/PB-COLLECT).
A worker edits only its leased paths and creates new files only where listed. UX00
contract modules and fixtures stay read-only. `apps/server/src/app.mjs`,
`apps/web/src/main.ts` and root tooling stay coordinator-owned (UX21).

**Still exclusive / do not touch:** UX01 held-cloud write set
(`pipeline.mjs`, admission portions of `run.mjs`, `productions/admission.mjs` and
its UX01 tests); UX05 merged editor save/autosave paths except as listed for UX11
media adapters; UX06 Super Easy CPU/progress modules except the explicit
`easy/mount.ts` / `easy/store.ts` handoff to UX07; UX09 agent-chat / packages/agent
scope modules; PB-SCRATCH remains held until UX15.

### UX02 — Budget effects and recoverable accounting (incl. PB03)

- **Write:**
  - `apps/server/src/productions/ledger.mjs`
  - new `apps/server/src/productions/budget-effects.mjs` (cap effect, orphan-hold
    reconciliation, settlement/release retries, PB03 stage liabilities)
  - `apps/server/src/routes/productions.mjs` (budget/cap surfaces only)
  - `apps/server/src/productions/iteration-routes.mjs` (budget exposure only)
  - `apps/server/src/productions/actions.mjs` and `commands.mjs` (lease before UX03;
    accounting identity and effect APIs only — no admission/pipeline)
- **Tests:**
  - new `apps/server/test/productions/budget-effects.test.mjs`
  - ledger / productions route tests under the same write set as needed
- **Read-only:**
  - `apps/server/src/pipeline.mjs`, `run.mjs`, `productions/admission.mjs` (UX01)
  - UX00 contract modules/fixtures
- **Coordinator wiring in `app.mjs`:** mount budget/cap routes once UX02 exports
  adapters; UX03 adopts executor-facing APIs into `run.mjs` after this merges.

### UX07 — Project identity, replanning and approval handoff (Easy escape follow-ons)

- **Write (prefer Easy UI outside UX06-exclusive Super Easy CPU/progress files):**
  - `apps/web/src/easy/mount.ts` (lease transferred from merged UX06 → UX07 → UX08)
  - `apps/web/src/easy/store.ts` (identity/session helpers only; lease from UX06)
  - `apps/web/src/easy/home.ts`
  - `apps/web/src/easy/plan-writer.ts`
  - `apps/web/src/easy/approve-generate.ts`
  - `apps/web/src/easy/steps/idea.ts`, `apps/web/src/easy/steps/plan.ts`
- **Tests:**
  - new `apps/web/src/easy/project-identity.test.ts` (and `ux07-*` as needed)
- **Read-only / do not reopen UX06 exclusives:**
  - `apps/web/src/easy/cpu-path.ts`
  - `apps/web/src/easy/super-easy/{session,mount,progress-view}.ts` and their tests
  - `apps/web/src/easy/types.ts`, `session-contract.ts` (UX00)
  - `apps/web/src/easy/steps/export.ts` (UX16)
- **Lease order:** `easy/mount.ts` continues UX06 → **UX07** → UX08. Extend
  carefully: no parallel writers on Super Easy CPU/progress modules.

### UX11 — Media access, real narration and timeline hydration

- **Write:**
  - `apps/web/src/takes/api.ts`
  - new `apps/web/src/media/ticket-resolver.ts`
  - new `apps/web/src/media/thumbnail-client.ts`
  - new `apps/web/src/editor/audio/preview.ts` (real narration decode; not UX05
    save/autosave)
  - new `apps/web/src/editor/timeline/hydrate.ts` (timeline mount adapter)
- **Tests:**
  - new `apps/web/src/media/ticket-resolver.test.ts`
  - new `apps/web/src/editor/timeline/hydrate.test.ts`
  - `ux11-*` as needed
- **Read-only:**
  - UX00 media contract fixtures
  - UX05 `editor/store.ts`, `autosave.ts`, save-status paths
  - server take routes (UX10) — consume frozen fixtures until UX10 merges
- **Coordinator wiring in `main.ts`:** thumbnail/open hooks and timeline mount
  once UX11 exports adapters.

### Overlap check (Wave 2 vs in-flight / merged Wave 1)

| Packet | Collides UX01 held-cloud? | Collides UX05/06/09 exclusives? |
| --- | --- | --- |
| UX02 | No — ledger/budget/actions/commands only | No |
| UX07 | No | Only intentional `mount.ts`/`store.ts` handoff; Super Easy CPU/progress left read-only |
| UX11 | No | No — new media/timeline/audio preview modules |

No path appears in two Wave 2 write sets. UX17 (deps met via UX09) is **not**
unlocked in this wave slot without its own lease table entry.

## Wave 3 write sets and leases

Each lease is granted against base `963d9c1` (feat/ux-results tip after Wave 2
landed: UX02@978b76e, UX11@44c1113, UX07@963d9c1). A worker edits only its leased
paths and creates new files only where listed. UX00 contract modules and fixtures
stay read-only. `apps/server/src/app.mjs`, `apps/web/src/main.ts` and root tooling
stay coordinator-owned (UX21).

**Still exclusive / do not touch:** UX21 held-coordinator write set (`app.mjs`,
`main.ts`, integration/docs). PB-SCRATCH remains held until UX15. Merged Wave 1/2
exclusives that Wave 3 must not reopen: UX05 editor save/autosave; UX06 Super Easy
CPU/progress modules (`easy/cpu-path.ts`, `easy/super-easy/{session,mount,progress-view}.ts`);
UX09 agent-chat / `packages/agent` scope modules (`agent-chat.mjs`,
`conversation.ts`, `production-tools.ts`, `production-planner.ts`,
`mutation-policy.ts`); UX01 admission helpers (`pipeline.mjs`,
`productions/admission.mjs`) except as UX03 adopts the transferred `run.mjs` lease.

**Lease transfers into this wave:**
- `apps/server/src/run.mjs`: UX01 → **UX03** (on UX01 merge).
- `apps/server/src/productions/{actions,commands}.mjs`: UX02 → **UX03**.
- `apps/web/src/easy/mount.ts`: UX07 → **UX08** (continues UX06 → UX07 → UX08).

**NOTES (amendment):** A parallel docs commit (`61afc5a`) briefly duplicated this
Wave 3 table without the `actions.mjs`/`commands.mjs` → UX03 and `easy/mount.ts` →
UX08 transfers. That duplicate section was removed; this table is authoritative.
Base for bees remains `963d9c1` content; tip after lease docs is current
`feat/ux-results` HEAD.

### UX03 — Server-owned execution, cancellation and restart (incl. PB07 half)

- **Write:**
  - `apps/server/src/run.mjs` (lease transferred from merged UX01; executor cancel /
    restart / adopt / settlement — not a second admission writer)
  - new `apps/server/src/productions/pipeline-adapter.mjs`
  - new `apps/server/src/productions/outbox-execution.mjs`
  - `apps/server/src/productions/actions.mjs` and `commands.mjs` (lease transferred
    from merged UX02; executor-facing cancel/restart APIs only — no budget rewrite)
- **Tests:**
  - new `apps/server/test/productions/execution-restart.test.mjs`
  - new `apps/server/test/run-execution.test.mjs`
- **Read-only:**
  - `apps/server/src/pipeline.mjs`, `productions/admission.mjs` (UX01 merged)
  - UX00 contract modules/fixtures
  - `apps/server/src/app.mjs` (UX21 mounts startup/event drain and cancel route)
- **Coordinator wiring in `app.mjs`:** mount pipeline adapter / outbox drain and
  `/api/run` cancel → `runs.cancel` once UX03 exports adapters (UX01 handoff notes).
  Cancel route wiring stays UX21; pipeline adapter/outbox drain is UX03 work product.

### UX08 — Ask, visible settings and truthful Studio header

- **Write:**
  - `apps/web/src/easy/mount.ts` (lease transferred from merged UX07; shell/Ask/
    header mount only — do not reopen Super Easy CPU/progress)
  - `apps/web/src/easy/ask-drawer.ts`
  - `apps/web/src/easy/agent-settings.ts`
  - `apps/web/src/easy/project-name.ts`
  - `apps/web/src/easy/shell-save.ts`
- **Tests:**
  - `apps/web/src/easy/ask-drawer.test.ts`
  - `apps/web/src/easy/shell-save.test.ts`
  - new `ux08-*` as needed
- **Read-only / do not reopen:**
  - `apps/web/src/easy/cpu-path.ts`
  - `apps/web/src/easy/super-easy/{session,mount,progress-view}.ts` and their tests
  - `apps/web/src/easy/store.ts`, `home.ts`, `plan-writer.ts`, `approve-generate.ts`,
    `steps/idea.ts`, `steps/plan.ts` (UX07 merged)
  - `apps/web/src/editor/store.ts`, `autosave.ts` (UX05 — consume save-state API)
  - `apps/web/src/easy/types.ts`, `session-contract.ts` (UX00)
  - `apps/web/src/easy/steps/export.ts` (UX16)
- **Lease order:** `easy/mount.ts` completes UX06 → UX07 → **UX08**.
- **Coordinator wiring in `main.ts`:** Ask/settings/header mount once UX08 exports
  adapters.

### UX10 — Take selection transactions and reference freshness

- **Write:**
  - `apps/server/src/takes/model.mjs`
  - `apps/server/src/takes/gate.mjs`
  - `apps/server/src/takes/select.mjs`
  - `apps/server/src/takes/routes.mjs`
  - `apps/server/src/takes/ingest.mjs`
- **Tests:**
  - new `apps/server/test/takes/selection-cas.test.mjs`
  - new `apps/server/test/takes/reference-freshness.test.mjs`
- **Read-only:**
  - UX00 take/media contract fixtures
  - `apps/web/src/takes/api.ts` and media clients (UX11 merged — consume server contract)
  - `apps/server/src/pipeline.mjs`, `productions/admission.mjs` (UX01)
  - `apps/server/src/app.mjs` (UX21 wires production binding into take routes)
- **Coordinator wiring in `app.mjs`:** production binding / guardRuns into
  `createTakeRoutes` once UX10 exports adapters (shared with UX01 handoff).

### UX13 — Honest auditions and accessible character editor

- **Write:**
  - `apps/web/src/characters/editor.ts`
  - `apps/web/src/characters/audition-panel.ts`
  - `apps/web/src/characters/mount.ts` (characters surface — **not** `easy/mount.ts`)
  - `apps/server/src/characters/audition.mjs`
  - `apps/server/src/characters/routes.mjs`
- **Tests:**
  - `apps/web/src/characters/audition-panel.test.ts`
  - new `apps/server/test/characters/audition-honest.test.mjs`
  - new `ux13-*` as needed
- **Read-only:**
  - UX00 media/ticket fixtures; UX11 media resolver / thumbnail clients (consume)
  - paid/native audition dispatch activation waits UX03 + UX21 wiring — do not edit
    `app.mjs` / `main.ts`
- **Coordinator wiring in `app.mjs` / `main.ts`:** production/model context for
  auditions once UX13 exports adapters. Paid prompt/native dispatch stays gated.

### UX17 — Compiled visual fidelity, timing and duration (incl. PB04 half)

- **Write:**
  - `apps/server/src/chat-project.mjs`
  - `apps/server/src/productions/plan-from-package.mjs`
  - `packages/agent/src/scene-build.ts`
  - new `packages/agent/src/timing-coverage.ts`
- **Tests:**
  - new `packages/agent/test/timing-coverage.test.ts`
  - new `apps/server/test/chat-project-fidelity.test.mjs`
- **Read-only / amendment note:**
  - `apps/server/src/agent-chat.mjs` and UX09 scope modules remain read-only
    (merged UX09 exclusives). Remediation mentions agent-chat context — **do not**
    reopen that file in Wave 3; compile/timing work stays in the leased helpers.
  - UX00 fixtures; UX15 export snapshot inputs (coordinate later; no UX15 files here)
- **Coordinator wiring:** none in `app.mjs`/`main.ts` for this packet.

### Overlap check (Wave 3 vs held / merged)

| Packet | Collides UX21 `app.mjs`/`main.ts`? | Collides other Wave 3? | Collides held/merged exclusives? |
| --- | --- | --- | --- |
| UX03 | No — adapters only | No | No — `run.mjs`/actions/commands transferred; admission stays UX01 |
| UX08 | No | No — `easy/mount.ts` only (not characters mount) | Super Easy CPU/progress + UX07 journey files read-only |
| UX10 | No | No — server `takes/*` only | No — UX11 web takes/media read-only |
| UX13 | No | No — `characters/mount.ts` ≠ `easy/mount.ts` | UX11 media consume-only; paid dispatch gated |
| UX17 | No | No | agent-chat / UX09 scope modules deliberately omitted |

No path appears in two Wave 3 write sets. UX21 and PB-SCRATCH stay held.

## Verification

All checks are local, use isolated temporary runtimes, and make no network,
provider or Google Colab calls.

| Command | Result |
| --- | --- |
| `pnpm run build:libs` | pass |
| `node --test apps/server/test/productions/ux00-contracts.test.mjs` | 17/17 pass |
| `node --test` over `apps/server/test/productions/*.test.mjs`, `legacy-run-closure`, `media-range`, `media-ticket`, `run-admission`, `run-media-merge`, `takes/*`, `thumbs/*` | 699/699 pass |
| `pnpm -C apps/server test` (full) | 1608 pass, 14 fail, 4 skipped. The 14 failures (`pipeline-stages`, `po3-spend`) fail identically at base `d427f9a`; render/export failures seen in one earlier run did not reproduce. |
| `node --experimental-strip-types --test apps/web/test/ux00-contracts.test.ts` | 8/8 pass |
| `pnpm -C apps/web test` (same globs) | 1224/1233 pass; the 9 failures are identical at base (1216/1225) |
| `pnpm -C apps/web typecheck` | pass |
| `pnpm test:scan` | clean |

The mounted case in the server contract test does three things. It starts the
real `createApp` with a backend factory that counts calls. It posts three bound
`/api/run` starts to it: one with `approved: true` and no authority, one naming a
missing production, and one naming a mismatched production. It then asserts that
each response is a valid typed refusal with the table status and that the backend
was called 0 times.
