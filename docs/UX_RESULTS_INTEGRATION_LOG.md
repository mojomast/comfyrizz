# UX-RESULTS integration log

**Packet:** UX21 (integration, release and documentation).
**Integration branch:** `feat/ux-results`.
**Base:** `243b5c4` (the feat/ux-results tip handed to this packet; docs plan tip
`d427f9a`, main `f16d188`).
**Scope:** mount the exported adapters from UX01–UX20 and record what is actually
bound. This log does not claim a component is fixed because it exists; only the
rows marked *mounted* have a live caller.

## Mount matrix

| Packet | Export / behavior | Mount in this tree | Milestone |
| --- | --- | --- | --- |
| UX00 | `createProductionAdmission`, `resolveProductionBinding`, `bindingRefusal` | `apps/server/src/app.mjs:457` creates the one admission adapter; `:488` resolves the chat owner through it; `:530` binds take/render commands through it. | M1 contracts |
| UX01 | `admission.guardRuns(runs, entry)` | `apps/server/src/app.mjs:500` guards `chat.correction`; `:776` guards `take.queue_drain`; `:853`-`:859` hands `take.regenerate` to `createTakeRoutes`. Bound packages refuse instead of reaching a backend. | M1/M2 |
| UX01/UX03 | `runs.cancel(runId)` | `POST /api/run/:runId/cancel` at `apps/server/src/app.mjs:1651`-`:1664`. The route uses the controller's retained abort handle and returns the same idempotent result as the controller. | M2 |
| UX02 | budget/cap routes (`spend-cap`, `budgetSummary`) | Already mounted through `createProductionRoutes` (`apps/server/src/app.mjs:1065` region) and `createIterationRoutes`; this packet did not add a duplicate route. | M2 |
| UX03 | `createPipelineAdapter`, `createOutboxExecutor` | `apps/server/src/app.mjs:901` creates the adapter over the real pipeline controller; `:902` creates the outbox executor; `:917`-`:946` derives the approved pipeline input; `:1019`-`:1029` drains after a committed action dispatch; `:965`-`:971` reconciles claimed actions on startup; `:953`-`:961` routes cancellation intents to the same executor. | M2 |
| UX04 | hydrated snapshot / event reset | Already served by `createProductionRoutes` (`GET /api/productions/:id`, `GET /api/productions/:id/events` and the reset response). No second snapshot route was mounted. | M2 |
| UX05 | `subscribeSaveState`, revision truth | `apps/web/src/main.ts:134`-`:143` paints the editor header from the save-state snapshot and subscribes to it. A revision is published only after the server acknowledgement. | M1 |
| UX06–UX08 | `mountEasyStudio` and its shell/Ask/settings children | `apps/web/src/main.ts:2753` mounts the existing Easy Studio. This packet does not reopen Super Easy CPU or progress. | M1 |
| UX09 | authoritative scope / target set | Already mounted in `createProjectChat`; the host now supplies explicit turn context (`main.ts:3114`) and sends `targets` only when clip chips exist (`main.ts:659`-`:697`). | M1 |
| UX10 | `createTakeRoutes({ production })` | `apps/server/src/app.mjs:853`-`:860` passes the server-resolved binder. Regenerate, regenerate-batch, select and revert reach the production command path for a bound package. | M2 |
| UX11 | ticket resolver / thumbnail / timeline hydrate | Take thumbnails, asset rows and the render bar use the existing clients. **Not fully mounted:** `createTimelineHydrator`, `createTicketResolver` and `createMediaThumbnailClient` have no production caller; the timeline host adapter (`editor/timeline/mount.tsx`, outside the UX21 write set) does not forward the `thumbs` / `onClipOpen` hooks that `SceneTimeline` accepts. Not counted as fixed. | M1 component only |
| UX12 | viewer/compare explicit targets | The viewer/compare mount already exists. The host now omits `targets` when no chip names a clip and maps a clip chip to its shot (`main.ts:659`-`:697`). | M3 |
| UX13 | honest audition, production/model context | `createAuditionWorker` is created with the real `productionStore` and ledger in `apps/server/src/app.mjs:1054` region; `createCharacterRoutes` receives it at the same mount. The **model** half stays unbound: the server has no selected video-model context to pass, so native/prompt audition is not claimed. Kokoro and admission checks are mounted. | M2 component only |
| UX14 | native-transfer continuity | **Component only.** No native-transfer route or Character surface hook is exported for `app.mjs`/`main.ts`; paid native dispatch therefore stays intentionally unbound. This is not counted as fixed. | M4 |
| UX15 | export/delivery routes + production binder | `/api/export`, `/api/render`, `/api/scene/render` and `/api/render/edited` are already mounted through `createRenderRoutes` (`apps/server/src/app.mjs:1082`). This packet adds the production binder at `:1096`, so bound delivery uses the production command path. **Not fully mounted:** `createDeliveryStore` (versioned bundle publication) has no route/consumer in this tree; snapshot/preflight are mounted, publication is component only. | M3 partial |
| UX16F | `ctx.host.exportArtifactStorage` | `apps/web/src/main.ts:2751` supplies the browser storage; the Easy export step persists the canonical record (name and bytes only). `resolveExportArtifact` stays intentionally unbound because UX15 exposes no stable artifact lookup route. The step reports `not-connected` instead of inventing access. | M3 |
| UX17 | compiled fidelity / timing | No `app.mjs`/`main.ts` mount was required by the packet. Existing compiler calls are unchanged; this log does not count the packet as user-journey accepted. | M3 |
| UX18 | evidence-backed briefs | No `app.mjs`/`main.ts` mount was required by the packet. The existing brief routes are unchanged. | M4 |
| UX19 | shell toast, non-obstructing efficiency | `apps/web/src/main.ts:9`-`:10` loads `createShellToastController` and its CSS; `:130` creates the one controller; all six notices go through it. Export failure carries a persistent Retry action. `:366`-`:379` caches scene cards and changes the active class only when the active scene changes. | M3 |
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
- **Append-only production events:** the outbox executor receives cancellation
  intents from the server event stream and reconciles claimed actions at startup.
  It does not auto-start a merely queued action when the app opens; a live
  dispatch starts it. This keeps a restart from spending without a current
  claim.

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
  and the event hook handles cancellation within the existing contract.
- Fixtures cover pre-existing packages, terminal runs and unbound takes. No
  persisted schema changed in this packet, so a rollback is a code rollback plus
  the existing runtime backup; there is no migration.
- Compatibility was exercised with local fixtures and fake backends only. No
  Google Colab VM, paid model or network provider was contacted.
