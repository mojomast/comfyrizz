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
