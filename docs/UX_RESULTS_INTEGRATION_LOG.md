# UX-RESULTS integration log

**Packet:** UX21F (fix-forward integration, release and documentation).
**Integration branch:** `feat/ux-results`.
**Base:** `3000a4a` (the merged UX21 packet; docs plan tip `d427f9a`, main
`f16d188`). UX21F corrects the command-boundary cancel wiring, error surfacing,
slot defaults and the web turn-context id source without reverting UX21.
**Scope:** mount the exported adapters from UX01–UX20 and record what is actually
bound. This log does not claim a component is fixed because it exists; only the
rows marked *mounted* have a live caller.

## Mount matrix

| Packet | Export / behavior | Mount in this tree | Milestone |
| --- | --- | --- | --- |
| UX00 | `createProductionAdmission`, `resolveProductionBinding`, `bindingRefusal` | `apps/server/src/app.mjs:457` creates the one admission adapter; `:498`-`:504` resolves the chat owner through the same binding; `:535`-`:566` binds take/render commands. | M1 contracts |
| UX01 | `admission.guardRuns(runs, entry)` | `apps/server/src/app.mjs:505` guards `chat.correction`; `:781` guards `take.queue_drain`; `:863` hands `take.regenerate` to `createTakeRoutes`. Bound packages refuse instead of reaching a backend. | M1/M2 |
| UX01/UX03 | `runs.cancel(runId)` | `POST /api/run/:runId/cancel` at `apps/server/src/app.mjs:1735`-`:1748`. The route uses the controller's retained abort handle and returns the same idempotent result as the controller. | M2 |
| UX02 | budget/cap routes (`spend-cap`, `budgetSummary`) | Already mounted through `createProductionRoutes` (`apps/server/src/app.mjs:1149` region) and `createIterationRoutes`; this packet did not add a duplicate route. | M2 |
| UX03 | `createPipelineAdapter`, `createOutboxExecutor` | `apps/server/src/app.mjs:906` creates the adapter over the real pipeline controller; `:907` creates the outbox executor; `:950`-`:999` derives the approved pipeline input from the approved slot only; `:1007`-`:1032` is the one post-commit command hook; `:1037`-`:1041` reconciles claimed actions on startup; `:1092`-`:1114` drains a committed action dispatch. See *Cancel and error wiring* below. | M2 |
| UX04 | hydrated snapshot / event reset | Already served by `createProductionRoutes` (`GET /api/productions/:id`, `GET /api/productions/:id/events` and the reset response). No second snapshot route was mounted. | M2 |
| UX05 | `subscribeSaveState`, revision truth | `apps/web/src/main.ts:134`-`:143` paints the editor header from the save-state snapshot and subscribes to it. A revision is published only after the server acknowledgement. | M1 |
| UX06–UX08 | `mountEasyStudio` and its shell/Ask/settings children | `apps/web/src/main.ts:2761` mounts the existing Easy Studio. This packet does not reopen Super Easy CPU or progress. | M1 |
| UX09 | authoritative scope / target set | Already mounted in `createProjectChat`; the host supplies explicit turn context (`apps/web/src/main.ts:3122`) and sends `targets` only when clip chips exist (`main.ts:670`-`:687`). The chip id from `project-chat.ts` is the only id source; the viewer target supplies the active clip (`main.ts:660`-`:666`). | M1 |
| UX10 | `createTakeRoutes({ production })` | `apps/server/src/app.mjs:858`-`:868` passes the server-resolved binder. Regenerate, regenerate-batch, select and revert reach the production command path for a bound package. | M2 |
| UX11 | ticket resolver / thumbnail / timeline hydrate | Take thumbnails, asset rows and the render bar use the existing clients. **Not fully mounted:** `createTimelineHydrator`, `createTicketResolver` and `createMediaThumbnailClient` have no production caller; the timeline host adapter (`editor/timeline/mount.tsx`, outside the UX21 write set) does not forward the `thumbs` / `onClipOpen` hooks that `SceneTimeline` accepts. Not counted as fixed. | M1 component only |
| UX12 | viewer/compare explicit targets | The viewer/compare mount already exists. The host omits `targets` when no chip names a clip and maps the canonical `clip:<clipId>` chip to its shot (`apps/web/src/main.ts:670`-`:687`); `openClipViewer` records `target.clipId` (`:549`-`:560`) and the active-turn context reads only that field (`:660`-`:666`). | M3 |
| UX13 | honest audition, production/model context | `createAuditionWorker` is created with the real `productionStore` and ledger at `apps/server/src/app.mjs:1138`; `createCharacterRoutes` receives it at the same mount. The **model** half stays unbound: the server has no selected video-model context to pass, so native/prompt audition is not claimed. Kokoro and admission checks are mounted. | M2 component only |
| UX14 | native-transfer continuity | **Component only.** No native-transfer route or Character surface hook is exported for `app.mjs`/`main.ts`; paid native dispatch therefore stays intentionally unbound. This is not counted as fixed. | M4 |
| UX15 | export/delivery routes + production binder | `/api/export`, `/api/render`, `/api/scene/render` and `/api/render/edited` are already mounted through `createRenderRoutes` (`apps/server/src/app.mjs:1166`). The production binder is passed at `:1180`, so bound delivery uses the production command path. **Not fully mounted:** `createDeliveryStore` (versioned bundle publication) has no route/consumer in this tree; snapshot/preflight are mounted, publication is component only. | M3 partial |
| UX16F | `ctx.host.exportArtifactStorage` | `apps/web/src/main.ts:2759` supplies the browser storage; the Easy export step persists the canonical record (name and bytes only). `resolveExportArtifact` stays intentionally unbound because UX15 exposes no stable artifact lookup route. The step reports `not-connected` instead of inventing access. | M3 |
| UX17 | compiled fidelity / timing | No `app.mjs`/`main.ts` mount was required by the packet. Existing compiler calls are unchanged; this log does not count the packet as user-journey accepted. | M3 |
| UX18 | evidence-backed briefs | No `app.mjs`/`main.ts` mount was required by the packet. The existing brief routes are unchanged. | M4 |
| UX19 | shell toast, non-obstructing efficiency | `apps/web/src/main.ts:9`-`:10` loads `createShellToastController` and its CSS; `:130` creates the one controller; all six notices go through it. Export failure carries a persistent Retry action. `:366`-`:374` caches scene cards and changes the active class only when the active scene changes. | M3 |
| UX20 | mounted acceptance fixtures | The packet's fixtures and suites are consumed by their owners. No browser or human-review result is claimed here. | M1–M4 |
| UX21 | integration/docs | This file, `docs/ui/UX_RESULTS.md` and the README capability note. | M4 |

## Deliberate non-mounts

- **UX13 native/prompt audition model:** `createAuditionWorker` accepts a model
  capability object, but the app has no selected video-model context. Passing a
  fabricated capability would make a modality look available. The production
  ledger and Kokoro path are mounted; native/prompt auditions are not claimed.
- **UX11 timeline hydration and ticket expiry:** `createTimelineHydrator`,
  `createTicketResolver` and `createMediaThumbnailClient` are exported but have no
  production caller. `SceneTimeline` accepts thumbnail/open props, but the host
  adapter does not forward them. Wiring that requires
  `apps/web/src/editor/timeline/mount.tsx`, which is outside this packet's
  assigned files. Timeline filmstrip/open is therefore not counted as a mounted
  UX11 fix.
- **UX15 versioned bundle publication:** `createDeliveryStore` is implemented
  and tested, but no assigned app file consumes it. The mounted export routes
  write the export directory and delivery snapshot; immutable bundle publication
  is therefore component only, not a user journey.
- **UX14 native transfer:** `productions/native-test.mjs` is a validated helper
  story. There is no exported HTTP mount or Characters host hook, so the app does
  not expose a native-transfer control. Do not describe it as delivered.
- **UX16 artifact resolver:** the export route returns a fresh `exportId` but does
  not retain a stable lookup route. The resolver is therefore unbound; a reloaded
  record would say `not-connected`, never a fabricated URL. Passing a fake
  resolver would make a missing artifact look accessible.
- **PB-SCRATCH:** no assigned file in this packet consumes
  `scratch-preflight.mjs`. The renderer/export handoff remains pending; it is not
  counted as fixed.
- **Append-only production events:** production commands commit to the
  production journal and do not publish to the in-memory EventLog. The outbox
  executor is therefore woken from the command commit result
  (`apps/server/src/app.mjs:1007`-`:1032`), not from an `events.publish`
  monkeypatch. It still reconciles claimed actions at startup (`:1037`-`:1041`)
  and does not auto-start a merely queued action when the app opens; a live
  dispatch starts it. This keeps a restart from spending without a current
  claim.

## Cancel and error wiring

- **One command handler.** `apps/server/src/app.mjs:468`-`:472` defines the
  single `commandHandler` object used by the production routes, the chat
  adapter, take/render binding, the action coordinator and the production
  coordinator. `executeProductionCommand` calls the IP18 handler and inspects
  its committed result. A duplicate replay returns the recorded result and
  wakes nothing.
- **Cancel reaches execution.** For a non-duplicate committed result the hook
  fans `production.cancelled` / `production.intent_changed`
  (`data.intent === 'cancel_requested'`) to
  `outboxExecutor.onEvent` (`:1011`-`:1016`). When the commit enqueued outbox
  entries, the same hook drains that production (`:1018`-`:1029`), so an
  `action.cancel` entry is acknowledged by its own command instead of waiting
  for an unrelated dispatch.
- **Dispatch has one trigger.** `action.dispatch` is committed inside
  `productions/actions.mjs`, not through the command handler, so
  `productionRouteActions.dispatch` remains the single drain trigger for that
  commit (`apps/server/src/app.mjs:1092`-`:1114`). It is not a second path for
  command commits.
- **Errors are visible.** `reportExecutionFailure` (`:920`-`:941`) logs once
  with the stable `[ux03-outbox]` prefix and publishes a typed
  `production.execution_error` EventLog entry carrying `productionId`, `code`
  and `message`. It is used for cancel fan-out, outbox drains, startup
  reconciliation and pipeline-preflight failures. `findBoundProduction`
  (`:498`) now reuses `productionBindingFor` (`:535`), so a journal read failure
  refuses with `503 BOUND_AUTHORITY_UNAVAILABLE` instead of looking unbound.
- **No fabricated slot defaults.** `pipelineDrainContext` (`:950`-`:999`)
  derives `backendId` and `budgetUnits` only from the approved plan slot. A slot
  without a string `backendId` or a finite `upperBound` returns
  `{ refused: 'SLOT_INCOMPLETE' }` and starts nothing; there is no Google Colab
  or zero-budget fallback. `approvedPlanHash` is recomputed only while the
  action is `queued`/`dispatching`, because the IP20 coordinator already
  consumed spend authority (see `productions/pipeline-adapter.mjs`).

## Milestone evidence

This is code and test evidence, not browser or human review.

### M1 — first result and trust

- The existing `pnpm -C apps/server test` suites for `legacy-run-closure`,
  `run-admission`, `pipeline-http`, `ux01-run-admission`, `ux01-run-cancel` and
  `ux01-pipeline-admission` pass after the mounts.
- The focused web contract suite for save state and the Easy shell is unchanged;
  `apps/web` typecheck passes.

### M2 — durable execution

- `node --test apps/server/test/productions/{actions,execution-restart,pipeline-adapter}.test.mjs`
  passes. The outbox executor is now created by `createApp`, not only by its unit
  tests.
- The temporary mount reproducer
  (`POST /api/run/:runId/cancel`) failed on the base with `404 not found` and
  passes after the route mount. A second case posts a bound regenerate without a
  command id and now receives `400 MISSING_COMMAND_ID` instead of entering the
  legacy run path. A third approves and dispatches one production slot through
  the mounted HTTP routes and observes exactly one `pipelineLaunch` call, so the
  dispatch-to-outbox-to-pipeline path is mounted rather than unit-only.
- UX21F adds `apps/server/test/ux21-app-mounts.test.mjs`. On base `3000a4a` the
  R1 cancellation cases (production.cancel and action.cancel) and the R3
  incomplete-slot case fail: no cancel reaches the fake controller, the cancel
  outbox entry stays pending and no typed execution error is published. After
  the command-boundary hook and slot refusal the same suite passes.

### M3 — faithful correction and delivery

- The viewer/compare and export mounts use the existing packets; the new wiring
  only adds explicit chip targets, save-state truth, the shell toast and the
  production binder for delivery.
- `apps/web` typecheck passes. The UX16 artifact resolver remains unbound as
  described above.

### M4 — quality and continuity

- README and `docs/ui/UX_RESULTS.md` now keep generated, auto-selected,
  technically checked and human-reviewed states separate.
- Voice and native transfer are described by their mounted capability only.
  Human voice quality and native transfer acceptance remain manual and are not
  claimed.

## Compatibility and rollback

- Unbound packages keep the legacy `/api/run` flow. The admission adapter returns
  `unbound` and the guarded controllers delegate unchanged.
- Bound packages keep the production journal as the only authority. A paused,
  cancelled or archived production refuses rather than falling back to legacy.
- The cancel route is additive: existing `GET /api/run/:id` and
  `/api/run/:id/video` routes are unchanged. A terminal run returns the
  controller's idempotent result.
- The outbox executor is additive. If it is unavailable, a dispatch still
  commits its durable outbox entry; startup reconciliation repairs claimed work
  and the command-boundary hook handles cancellation within the existing
  contract. A background failure is reported as `production.execution_error`
  rather than discarded.
- Fixtures cover pre-existing packages, terminal runs and unbound takes. No
  persisted schema changed in this packet, so a rollback is a code rollback plus
  the existing runtime backup; there is no migration.
- Compatibility was exercised with local fixtures and fake backends only. No
  Google Colab VM, paid model or network provider was contacted.
