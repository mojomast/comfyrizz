# Spec: Comfyrizz interactive demo web app

Status: draft v1 (Oct 20, 2026). Branch: `feat/demo-webapp` (off `chore/quick-wins` + `feat/lw-licensing-demo`, `feat/lw-release-scan`, `feat/lw-scene-chips`).

## 1. Goal
A single page, `apps/web/demo.html`, that performs the 2-minute demo in SPEC.md section 11 live and reliably:

| Beat (SPEC §11) | What the page shows |
| --- | --- |
| 1 Hook | Preview player plays the finished launch video (examples/hook-20s) |
| 2 Brief | **Chat panel**: brief typed in chat; agent (model badge: "any OpenAI-compatible model works") proposes a storyboard; **storyboard with scene chips** appears; a chart value is edited and the **preview updates instantly** with no GPU and no server render |
| 3 Assets with receipts | **Licence chips**: an approved CC BY Openverse image with its credit, a refused CC BY-NC one with the reason; a generated asset |
| 4 Compute | **Spend card** (estimate, budget, labelled "estimate") and **activity panel** phase stepper: VM up -> health -> jobs -> collected -> VM stopped (verified) |
| 6 Iterate | "make scene 3 warmer" -> **per-scene re-run**: only scene 3 is marked re-rendering, then ready |
| 7 Open source | Links: repo, workflows folder, CREDITS, package.zip export (existing `/api/export`) |

Beat 5 is narration only.

## 2. Non-goals and boundaries
- Do not touch HyperFrames, Google Colab or GPU rendering code: `packages/backends/**`, `colab/**`, compositions, `apps/renderer/**`, `apps/server/src/pipeline-colab-render.mjs` and friends. Another agent owns those.
- Do not edit `apps/server/**` or `apps/web/src/main.ts`. The demo page is additive and uses the existing APIs only. If an API is missing, the task records it in its result as an open issue; it does not add the API.
- No new dependencies.

## 3. Architecture
- `apps/web/demo.html` + `apps/web/src/demo/*`. Pure logic and render functions are `.mjs` ES modules with no DOM access at import time, and each returns escaped HTML strings or plain data. `mount*` functions take a root element and wire events by delegation.
- **API:** the existing local server (`apps/server/src/app.mjs`), authenticated with the `x-comfyrizz-token` header. The session token arrives once in the URL fragment `#token=` (same contract as `installSessionToken` in `src/main.ts`) and is held in sessionStorage, never in a URL or a log. POSTs must be same-origin.
- **Events:** SSE `GET /api/events`, with frames `{id, at, type, ...}` and replay from `Last-Event-ID` (`apps/server/src/events.mjs`).
- **State:** one store (T03). Events are reduced into it, and render functions read from it.
- **Fixture mode:** `?fixture=1` swaps the API and events for a deterministic offline backend (T12), so the demo and its e2e run with no server, GPU or network.
- **Preview:** reuses the existing Remotion player in `src/preview.tsx`. Instant edits (T09) patch the timeline in memory and call `preview.update()`. Real renders still go through the server.

## 4. Tasks
Each task has disjoint files. Tests are `apps/web/test/demo-*.test.mjs` (picked up by the existing `test/*.test.mjs` glob).

| Task | Title | Files | Depends on |
| --- | --- | --- | --- |
| T01 | Typed API client for the demo page | `apps/web/src/demo/api.mjs`, `apps/web/test/demo-api.test.mjs` | - |
| T02 | SSE events client with resume | `apps/web/src/demo/events.mjs`, `apps/web/test/demo-events.test.mjs` | - |
| T03 | Demo state store | `apps/web/src/demo/store.mjs`, `apps/web/test/demo-store.test.mjs` | - |
| T04 | Chat panel | `apps/web/src/demo/chat-panel.mjs`, `apps/web/src/demo/chat-panel.css`, `apps/web/test/demo-chat-panel.test.mjs` | - |
| T05 | Storyboard with scene chips and per-scene status | `apps/web/src/demo/storyboard.mjs`, `apps/web/src/demo/storyboard.css`, `apps/web/test/demo-storyboard.test.mjs` | - |
| T06 | Licence chips for assets | `apps/web/src/demo/licence-chips.mjs`, `apps/web/src/demo/licence-chips.css`, `apps/web/test/demo-licence-chips.test.mjs` | - |
| T07 | Spend card | `apps/web/src/demo/spend-card.mjs`, `apps/web/src/demo/spend-card.css`, `apps/web/test/demo-spend-card.test.mjs` | - |
| T08 | Activity panel | `apps/web/src/demo/activity-panel.mjs`, `apps/web/src/demo/activity-panel.css`, `apps/web/test/demo-activity-panel.test.mjs` | - |
| T09 | Instant preview edits without GPU | `apps/web/src/demo/instant-edit.mjs`, `apps/web/test/demo-instant-edit.test.mjs` | - |
| T10 | Preview player mount | `apps/web/src/demo/preview-frames.mjs`, `apps/web/src/demo/preview-mount.tsx`, `apps/web/test/demo-preview-mount.test.mjs` | - |
| T11 | Per-scene re-run flow | `apps/web/src/demo/scene-rerun.mjs`, `apps/web/test/demo-scene-rerun.test.mjs` | T01 |
| T12 | Offline fixture mode | `apps/web/src/demo/fixture.mjs`, `apps/web/test/demo-fixture.test.mjs` | - |
| T13 | Demo page shell and wiring | `apps/web/demo.html`, `apps/web/src/demo/main.mjs`, `apps/web/src/demo/demo.css`, `apps/web/vite.config.ts`, `apps/web/test/demo-shell.test.mjs` | T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12 |
| T14 | Playwright demo e2e in fixture mode | `apps/web/e2e/demo.spec.ts` | T13 |
| T15 | Demo runbook | `docs/DEMO_WEBAPP_RUNBOOK.md`, `apps/web/README.md` | T13 |

Waves: T01-T10 and T12 have no dependencies. T11 needs T01. T13 needs everything before it. T14 and T15 need T13.

### T01 Typed API client for the demo page
**Files:** `apps/web/src/demo/api.mjs`, `apps/web/test/demo-api.test.mjs`  
**Depends on:** none

createApi({fetch, baseUrl, token}) with: sessionToken(location, storage) that reads #token=... once from the URL fragment, stores it in sessionStorage and strips it from the URL (same contract as installSessionToken in src/main.ts, reimplemented); request(path,{method,body}) that sends x-comfyrizz-token and JSON, throws ApiError{status,message} on non-2xx; helpers agent(message, history) -> POST /api/agent, brief(body) -> POST /api/brief, sceneChips(packageId) -> GET /api/scene/chips, scenePlan(body) -> POST /api/scene/plan, sceneRender(body) -> POST /api/scene/render, run(body) -> POST /api/run, approve(body) -> POST /api/run/approve, runs() -> GET /api/run, colabStatus() -> GET /api/colab/status, providers() -> GET /api/providers, health() -> GET /api/health. Read apps/server/src/app.mjs to get each route's exact request/response fields and document them in JSDoc.

**Acceptance:**
- token header sent on every call and never put in a URL
- fragment token stored then removed from location
- non-2xx -> ApiError with status and server error text
- each helper hits the right method+path (fake fetch records calls)
- only the assigned files change
- `cd apps/web && npm test` stays green

### T02 SSE events client with resume
**Files:** `apps/web/src/demo/events.mjs`, `apps/web/test/demo-events.test.mjs`  
**Depends on:** none

connectEvents({EventSourceImpl, url, token, onEvent, onState}) subscribing to /api/events (see apps/server/src/events.mjs: frames carry id, type, at), passing the token as ?token= ONLY if EventSourceImpl cannot set headers (document why), tracking lastEventId and reconnecting with lastEventId after errors with capped backoff (1s,2s,5s,10s); onState('connecting'|'open'|'retrying'); close(). Deliver each parsed event exactly once even after replay.

**Acceptance:**
- events delivered once across a reconnect with replay
- lastEventId sent on reconnect
- backoff sequence capped
- close() stops reconnects
- only the assigned files change
- `cd apps/web && npm test` stays green

### T03 Demo state store
**Files:** `apps/web/src/demo/store.mjs`, `apps/web/test/demo-store.test.mjs`  
**Depends on:** none

createStore(initial) with get(), set(patch), subscribe(fn)->unsubscribe, and reduceEvent(state, event) handling: package.updated, brief.planned, brief.outline, run.log, run.* status, scene.* status, colab.* (read event types published in apps/server/src/*.mjs). State: {packageId, pkg, timeline, chat:[{role,text,at}], activity:[{at,phase,text}], spend, scenes:{[id]:{status}}, selectedScene, backend}. Immutable updates.

**Acceptance:**
- subscribers notified once per set
- reduceEvent pure and covers every listed event type
- activity capped at 200 newest-first
- unknown events ignored
- only the assigned files change
- `cd apps/web && npm test` stays green

### T04 Chat panel
**Files:** `apps/web/src/demo/chat-panel.mjs`, `apps/web/src/demo/chat-panel.css`, `apps/web/test/demo-chat-panel.test.mjs`  
**Depends on:** none

renderChat(messages, {modelLabel, pending}) -> HTML: message list with role classes, minimal markdown (paragraphs, **bold**, `code`, - lists) after escaping, a model badge reading '<model> - any OpenAI-compatible model works', pending indicator; mountChat(root, {onSend}) wiring a textarea+button (Enter sends, Shift+Enter newline, disabled while pending). Pure render function, mount takes a root element.

**Acceptance:**
- XSS: <script> and attribute injection escaped
- markdown subset renders
- model badge text exact
- onSend called with trimmed text, not when empty
- only the assigned files change
- `cd apps/web && npm test` stays green

### T05 Storyboard with scene chips and per-scene status
**Files:** `apps/web/src/demo/storyboard.mjs`, `apps/web/src/demo/storyboard.css`, `apps/web/test/demo-storyboard.test.mjs`  
**Depends on:** none

Build on apps/web/src/scene-chips.mjs (import sceneChips/formatDuration; do not edit it). renderStoryboard(timeline, {scenes, selectedId}) -> HTML: chip per scene with status badge (ready|stale|rerendering|failed), a 'Re-run' button per chip (data-action=rerun data-scene-id), selected chip aria-current; mountStoryboard(root, {onSelect, onRerun}) with event delegation and Left/Right arrow keyboard navigation.

**Acceptance:**
- uses real examples/launch-demo/timeline.json
- status badges and rerun buttons per scene
- delegated click calls onRerun(sceneId) / onSelect(sceneId)
- arrow keys move selection
- only the assigned files change
- `cd apps/web && npm test` stays green

### T06 Licence chips for assets
**Files:** `apps/web/src/demo/licence-chips.mjs`, `apps/web/src/demo/licence-chips.css`, `apps/web/test/demo-licence-chips.test.mjs`  
**Depends on:** none

licenceChips(pkg) -> [{assetId, label, tone:'ok'|'warn'|'blocked', detail, sourceUrl}] mirroring packages/sources licence policy (README table): CC0/PDM ok, CC BY ok only when approved with attribution else warn 'needs approval', BY-SA/NC/ND/unknown blocked with reason, generated ok 'generated (CC0)', uploads by shareable flag. renderLicenceChips(chips) -> escaped HTML with title=detail and a link to sourceUrl (rel=noopener). Pure; no import of packages/sources.

**Acceptance:**
- examples/licensing-demo/package.json -> one ok CC BY chip with creator, one blocked NC chip with reason
- generated + CC0 cases
- escaping of titles/URLs; javascript: URLs dropped
- only the assigned files change
- `cd apps/web && npm test` stays green

### T07 Spend card
**Files:** `apps/web/src/demo/spend-card.mjs`, `apps/web/src/demo/spend-card.css`, `apps/web/test/demo-spend-card.test.mjs`  
**Depends on:** none

renderSpendCard(spend, {backendLabel}) where spend is the /api/run dry-run plan shape ({planHash, backendId, estimate, budget, jobs}; read apps/server/src/run.mjs and the spend section of src/main.ts for fields). Shows backend, job count, estimated units/time, budget ceiling and remaining, an 'estimate' label on every number, a warning tone when estimate > 80% of budget and blocked when over; renders 'BYO ComfyUI - no spend' for byo and 'CPU - free' for cpu. Pure.

**Acceptance:**
- fixture plan renders all fields with 'estimate' labels
- over-budget -> blocked tone and text
- cpu/byo variants
- missing fields render dashes not 'undefined'
- only the assigned files change
- `cd apps/web && npm test` stays green

### T08 Activity panel
**Files:** `apps/web/src/demo/activity-panel.mjs`, `apps/web/src/demo/activity-panel.css`, `apps/web/test/demo-activity-panel.test.mjs`  
**Depends on:** none

activityRows(events) -> [{at, phase, text, tone}] mapping server events to phases VM up -> health -> jobs -> collected -> VM stopped (verified) using run.log line text and run/colab status events (read apps/server/src/run.mjs, pipeline*.mjs for line formats; do not edit them), plus brief/package/scene rows; phaseProgress(rows) -> ordered phase list with done/current/pending; renderActivity(rows, progress) -> escaped HTML with a phase stepper and a 'sped up' label slot.

**Acceptance:**
- a canned Google Colab run log yields all 5 phases in order
- VM stopped only marked verified when the stop event says verified
- escaping
- newest-first, max 200
- only the assigned files change
- `cd apps/web && npm test` stays green

### T09 Instant preview edits without GPU
**Files:** `apps/web/src/demo/instant-edit.mjs`, `apps/web/test/demo-instant-edit.test.mjs`  
**Depends on:** none

applyInstantEdit(pkg, timeline, edit) -> {pkg, timeline, changedScenes} for edit kinds {kind:'text', sceneId, field:'headline'|'subhead'|'caption', value}, {kind:'chart', sceneId, index, value}, {kind:'colour', sceneId, role, hex}; immutable, validates (hex format, numeric chart values, unknown scene -> error) and returns which scenes changed so only those are marked stale. Read packages/schema/types.ts and examples/launch-demo/{package,timeline}.json for where these values live.

**Acceptance:**
- chart value change on launch-demo changes only that scene
- invalid hex / unknown scene rejected with message
- inputs not mutated
- changedScenes correct
- only the assigned files change
- `cd apps/web && npm test` stays green

### T10 Preview player mount
**Files:** `apps/web/src/demo/preview-frames.mjs`, `apps/web/src/demo/preview-mount.tsx`, `apps/web/test/demo-preview-mount.test.mjs`  
**Depends on:** none

mountPreview(root, {timeline, pkg}) -> {update(timeline,pkg), seekToScene(sceneId), destroy()} reusing the existing player from apps/web/src/preview.tsx (import, do not edit). update() must re-render the player in place (no reload) so instant edits show immediately; seekToScene converts the scene start to a frame. Put the pure sceneStartFrame(timeline, sceneId) in preview-frames.mjs (imported by the .tsx) and test that in demo-preview-mount.test.mjs (the .tsx is not imported by node tests; it is type-checked by the web build).

**Acceptance:**
- sceneStartFrame correct on launch-demo
- unknown scene -> 0 with no throw
- pnpm --filter ./apps/web exec tsc --noEmit (or the web build) accepts preview-mount.tsx
- only the assigned files change
- `cd apps/web && npm test` stays green

### T11 Per-scene re-run flow
**Files:** `apps/web/src/demo/scene-rerun.mjs`, `apps/web/test/demo-scene-rerun.test.mjs`  
**Depends on:** T01

createSceneRerun({api, store}) -> rerun(sceneId, {instruction}) that calls api.scenePlan then api.sceneRender for ONLY that scene (read /api/scene/plan and /api/scene/render in apps/server/src/app.mjs and scene.mjs), sets store.scenes[sceneId].status rerendering -> ready|failed, refuses a second concurrent rerun of the same scene, and records an activity row. Uses the T01 api shape (inject a fake in tests).

**Acceptance:**
- only the requested scene is planned/rendered
- status transitions incl. failure
- duplicate rerun refused
- activity row added
- only the assigned files change
- `cd apps/web && npm test` stays green

### T12 Offline fixture mode
**Files:** `apps/web/src/demo/fixture.mjs`, `apps/web/test/demo-fixture.test.mjs`  
**Depends on:** none

createFixtureBackend({pkg, timeline}) implementing the same method names as the T01 api (agent, sceneChips, scenePlan, sceneRender, run, approve, colabStatus, health) with deterministic canned responses, plus fixtureEvents() -> an ordered canned event stream for a Google Colab run (VM up, health, 3 jobs, collected, VM stopped verified) so the demo works with no server, GPU or network (?fixture=1). Loads data passed in; no fs at import time.

**Acceptance:**
- same method names as spec'd T01 helpers
- canned stream contains every activity phase in order
- deterministic (two runs equal)
- only the assigned files change
- `cd apps/web && npm test` stays green

### T13 Demo page shell and wiring
**Files:** `apps/web/demo.html`, `apps/web/src/demo/main.mjs`, `apps/web/src/demo/demo.css`, `apps/web/vite.config.ts`, `apps/web/test/demo-shell.test.mjs`  
**Depends on:** T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12

demo.html with regions: chat, preview, storyboard, licence chips, spend card, activity. main.mjs wires api (or fixture backend when ?fixture=1), events -> store, store -> renders, chat onSend -> api.agent, storyboard onRerun -> scene-rerun, instant edits -> preview.update. vite.config.ts: add build.rollupOptions.input {main:'index.html', demo:'demo.html'} and nothing else.

**Acceptance:**
- vite build emits demo.html
- test: demo.html has all 6 region ids; main.mjs imports every demo module
- fixture mode boots without network (jsdom-free smoke via pure functions)
- only the assigned files change
- `cd apps/web && npm test` stays green

### T14 Playwright demo e2e in fixture mode
**Files:** `apps/web/e2e/demo.spec.ts`  
**Depends on:** T13

Playwright spec (reuse apps/web/e2e/playwright.config.ts and fixture.mjs conventions) loading /demo.html?fixture=1: storyboard shows 6 chips, licence chips show 1 ok + 1 blocked, typing in chat shows a reply, changing a chart value updates preview without network render, re-run scene 3 marks only scene 3 rerendering then ready, activity stepper reaches 'VM stopped (verified)'.

**Acceptance:**
- spec runs green locally with the repo's playwright setup
- no external network
- only the assigned files change
- `cd apps/web && npm test` stays green

### T15 Demo runbook
**Files:** `docs/DEMO_WEBAPP_RUNBOOK.md`, `apps/web/README.md`  
**Depends on:** T13

Runbook: how to start the server + demo page, fixture mode, the 7-beat demo script mapped to UI actions (spec section 11), troubleshooting; add a short 'Demo page' section to apps/web/README.md linking it.

**Acceptance:**
- every command in the runbook exists in package.json/scripts
- beats map 1:1 to section 11
- only the assigned files change
- `cd apps/web && npm test` stays green

## 5. Definition of done
- All tasks merged on `feat/demo-webapp`.
- `pnpm test:all` is green from a clean clone.
- `vite build` emits `demo.html`.
- The T14 e2e passes in fixture mode.
- The runbook (T15) walks the section 11 script end to end.
- No merge to main and no tag until Kyle reviews.
