# Iterative production integration: code audit and design sources

**Date:** October 22, 2026. Four user-requested subagents independently audited the
conversation/server, web UX, production backend, and workflow design literature.
The integration owner spot-checked critical application wiring, accounting,
take-completion and export behavior against source. This is a source audit; no
application behavior or existing test result is claimed as newly executed.

Baseline is commit `c14580c39ce6beb4bb4bfdbfef9ff8e76c44102a` plus the current
working tree, including uncommitted production scripts.
Those scripts are evidence, not assumed committed dependencies. Search tools had
a ripgrep-installation failure; auditors used directory/file reads instead. Findings
are scoped to the cited surfaces rather than an assertion of exhaustive absence.

## 1. Existing components to reuse

| Component | Verified implementation | Integration consequence |
| --- | --- | --- |
| Conversational storyboard | `packages/agent/src/conversation.ts`: `CONVERSATION_TOOLS`, `runConversationTurn`, `patchConversationPlan` | Keep stable IDs, atomic patches, draft/build distinction and bounded context; extend beyond an explainer-centric plan. |
| Project merge | `apps/server/src/chat-project.mjs`: `buildChatProject`; `chat-state.mjs`: `rebaseChatPlans` | Preserve field-level manual-edit/lock handling; share it with production commands. |
| Package CAS | `apps/server/src/store.mjs`: `PackageStore.save` | Existing base-revision comparison is the package mutation boundary. |
| Character library | `apps/server/src/characters/{model,voice,routes}.mjs` | Keep revision-pinned cast snapshots and character direction; consolidate divergent voice schemas. |
| Audition primitives | `apps/server/src/characters/audition.mjs`: cache/coalescing/injected synth | Useful synthesis/cache substrate; not an end-to-end mounted audition feature. |
| References | `apps/server/src/references/model.mjs`; `apps/web/src/references/panel.ts` | Reuse content identities, roles, imports and authenticated thumbnails. |
| Takes | `apps/server/src/takes/{model,store,ingest,select,correction,routes,gate}.mjs` | Real selection, review, correction, scoped regeneration and approved-selection protection already exist. |
| Durable pipeline | `apps/server/src/pipeline.mjs`, `pipeline-contract.mjs`, `pipeline-worker.mjs` | Reuse durable snapshots/journal, worker ownership, operation lease and reconciliation. |
| Job execution | `packages/jobs/src/plan.mjs`; `pipeline-py/comfyrizz_pipeline/attempts.py` | Deterministic plans/cache keys and persisted attempts support selective work and ambiguous-submit reconciliation. |
| Native direction | `packages/jobs/src/fasth3-direction.mjs` | Exact-line conditioning and reaction margin checks; native 24fps/17n+5 execution profile. |
| Editor commands | `apps/web/src/editor/{commands,store,autosave,recovery}.ts` | Apply scoped agent edits as one undoable command batch; preserve local drafts. |
| Take UI | `apps/web/src/takes/panel.ts`; `editor/timeline/Timeline.tsx` | Extend existing comparison and review controls; do not introduce a competing take browser. |
| Audio/export | `apps/renderer/src/audio-mix-model.js`; `apps/server/src/export.mjs` | Retain mixing/packaging infrastructure; add native-dialogue tracks, consistent fingerprints and delivery gates. |

## 2. Concrete integration gaps and defects

Severity here means implementation sequencing, not a claim of observed user harm.
Each item needs a fixture reproducer before its fix is marked complete.

| ID | Source-grounded finding | Required treatment |
| --- | --- | --- |
| A01 | `apps/server/src/app.mjs:174` constructs `createProjectChat` without `runs`, `events`, `measuredFor`; chat correction handling in `agent-chat.mjs:486–503` needs run execution. | Shared service wiring, tested through mounted app rather than injected controller alone. |
| A02 | `characters/audition.mjs` exists, but `characters/routes.mjs:937–1079` has no audition handler; web `characters/api.ts` exposes none, and `characters/mount.ts:546–563` supplies no audition implementation. | Real audition route/worker/media delivery and mounted UI test. |
| A03 | `packages/agent/src/character-tools.ts:454–463` says one voice/video, upload-only images and no cloning. | Capability-gated instruction/schema changes alongside implementation, not prompt-only promises. |
| A04 | `conversation.ts` tools build packages but do not execute GPU/audio/export; legacy `tools.ts` is a separate surface and `assets.search` is a stub. | Explicit research/production service tools; do not mistake planned pending assets for rendered media. |
| A05 | `agent-chat.mjs` checks active state before awaited confirmation/context work and adds lock later; final conversation write is not shared CAS. Character cast routes independently rewrite conversation JSON. | Early shared serialization/CAS and durable command ledger across writers. |
| A06 | Chat effects and package save can precede conversation persistence; deduplication remembers only the last turn. | Intent/result journal, idempotency beyond latest turn, recover cross-document partial commits. |
| A07 | `apps/web/src/project-chat.ts` has no clip-confirmation UI path; reference/cast “Reject” callbacks prefill generic chat text instead of rejecting a proposal. | Structured accept/reject/change actions with exact proposal ID; show persisted results. |
| A08 | `editor/timeline/Timeline.tsx` accepts review callbacks, but `editor/timeline/mount.tsx:19–44` does not forward them. | Complete adapter wiring and keyboard/click integration tests. |
| A09 | `main.ts` storyboard/theme mutation bypasses the command store; `adoptChatProject` replaces the document, and `editor/store.ts:117–118` clears undo on replacement. | One editor command/flush barrier for manual and agent edits; scoped diff rather than whole-document replacement. |
| A10 | `editor/autosave.ts` writes IndexedDB recovery, but inspected `main.ts` boot has no restore/compare prompt. New-chat reset does not clear/adopt a new workspace. | Project-specific recovery/new-project semantics and offline-reload tests. |
| A11 | `ui/shell.css:454–463` hides the activity pane below 1100px; it contains run/export/assets operations. | Relocate operations to mobile Activity, not hide capabilities. |
| A12 | Older `run.mjs` holds runs/approvals/spend in memory and checks admission before asynchronous estimate/staging. | Move production submissions through durable reservation/lease; close admission races. |
| A13 | `run.mjs:202` adds `record.budget.required` to `spentEstimate`; `required` already includes previous spend and reserve. Failure paths do not settle similarly. | Durable per-production ledger using incremental settlement; separate reservation from spend. |
| A14 | `app.mjs:239–267` take completion copies outputs to mutable package asset paths and saves a stale package revision; full-run path uses `mergeRunMedia`. | Immutable ingestion first, rebase selection under latest CAS; no overwrite before conflict detection. |
| A15 | `colab-backend.mjs` collects into `scratch/out`; `run-package.mjs:252–284` applies from supplied `outDir` without enforcing that collection destination first. | Single verified collection/apply contract; recover already downloaded output before inference retry. |
| A16 | Take fingerprint in `takes/model.mjs:384–394` omits model revision and transitive referenced bytes. Auditions are not accepted by the image/video-only take extensions. | Effective dependency hash and separate voice artifacts, not hidden WAVs in visual takes. |
| A17 | `media-range.mjs:13–28` tickets expire after ten minutes and are process-local. | Stable artifact IDs plus expiry-aware remint on seek/restart; never persist ticket URL as identity. |
| A18 | `renderGate` is not uniformly used by all export/render paths; full pipeline entry may apply final clip approval before initial generation. | Separate production admission, preview and final-delivery readiness; one final boundary across routes. |
| A19 | `export.mjs:160–195` fingerprints composition extras but can reuse ordinary package `video.mp4` without current input fingerprint, then regenerate current captions. | Fingerprint every render/export input; video and captions must describe the same snapshot. |
| A20 | `audio-mix-model.js:184–253` derives native audio from background scenes as ambience; independent source/timeline ranges for J/L cuts are absent from that bus model. | First-class native dialogue tracks and full/incremental/preview parity tests. |
| A21 | Chat media tools inspect metadata. `packages/llm/src/types.ts` uses string content; actual audiovisual evidence is not attached in live chat. | Report evidence modality honestly; add opt-in capability-supported image/audio critique without fabricated viewing/listening. |
| A22 | Character `model.mjs` language set is narrower than dedicated `voice.mjs`; package projection drops audition metadata. | Canonical voice contract, reference artifact pointers and language/accent scoped decisions. |
| A23 | Reference assignment build writes `runtime/packages/references.json` rather than a package-specific provenance path (`chat-project.mjs:404–409`). | Project-scoped sidecars; simultaneous projects cannot overwrite reference lineage. |
| A24 | Audition `has()` invokes `ensure()`; a nonempty cached WAV is accepted without content verification (`audition.mjs:550–608`). | Pure inspection path, verified cached artifacts and explicit paid synthesis boundary. |
| A25 | Current motion role metadata does not add video-file conditioning to ordinary `plan.mjs` upload parameters; dance scripts construct a separate graph. | Capability profile and native video-reference adapter with derivative hashes. |

## 3. UX details to preserve and correct

- Selection and playhead are distinct. New takes must not steal preview focus.
- Previewing an A/B take must not select or approve it.
- “Reject,” “Request a change,” “Plan regeneration” and “Generate” are different
  commands. Existing storyboard “Regenerate media” currently shows a dry-run plan.
- Caption correction and narration rewrite remain separate edits.
- Editor voice-preview demo samples are not an audition of the user's chosen voice.
- Character drawer modal semantics need focus containment and return-focus tests.
- Pipeline run restoration and incoming events must be scoped to production/project/
  run identity; late events must not change another open project's status.
- Header status/title should derive from current state, not static step markup.

## 4. Existing test coverage and limits

`apps/web/e2e/editor.spec.ts` exercises reorder/trim/undo, narration freshness,
caption separation, saves, conflict/offline state, export/reimport and initial-page
accessibility. `e2e/playback.spec.ts` tests warm cuts and cold seeks in a playback
harness. `test/takes-panel.test.ts` tests scoped correction and explicit spend.
These are reusable fixtures, not proof every production mount is wired.

Important test corrections for implementation:

- Default-project e2e helpers inject missing look/history DOM; those injected labels
  cannot establish that the production app renders those features.
- Demo-page mobile tests do not establish main-editor mobile operation access.
- Controller tests with injected audition callbacks do not establish a mounted route.
- An offline edit surviving in the current page is not recovery after reload.
- A/B button state alone is not evidence that the decoded media changed.
- Initial-page axe checks do not cover review, approval, conflict and modal states.
- No source-audit finding here claims audible quality from automated playback.

## 5. Primary external design references

All retrieved by the research subagent on October 22, 2026. These sources inform
design; none proves ComfyRizz's implementation or creative quality.

| Source | Supported practice | Boundary |
| --- | --- | --- |
| [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | Persisted human decisions, structured resume payloads; side effects may re-execute on resume | Reuse the concept, not necessarily the framework; persistence does not guarantee exactly-once external billing. |
| [W3C PROV overview](https://www.w3.org/TR/prov-overview/) | Entities, activities, derivation and attribution | Lightweight IDs/hashes suffice; RDF adoption is unnecessary; provenance is not truth verification. |
| [Microsoft Human-AI Interaction Guidelines](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/) and [summary](https://www.microsoft.com/en-us/research/blog/guidelines-for-human-ai-interaction-design/) | Efficient correction/dismissal, contextual interruption, granular feedback and consequences | General UX research; the voice approval rules come from this project's user requirements. |
| [WHATWG server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) | Event IDs, reconnection and Last-Event-ID transport | Application replay, durable cursors and deduplication still need implementation. |
| [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Evaluate actual outcomes, combine deterministic/model/human grading, preservation and task quality | Engineering guidance, not a guarantee of creative quality; audible human calibration remains necessary. |

## 6. Decisions this audit supports

1. Extend existing pipeline/take/editor services behind one production coordinator.
2. Persist artifacts, decisions, intent, budget and actions outside chat history.
3. Fix mounted wiring and revision/accounting/collection hazards before expanding
   paid agent autonomy.
4. Keep exact plan approval per paid regeneration, allowing explicitly scoped
   batches; a project ceiling is not blanket approval.
5. Add native dialogue editing and structured graphic recipes to reach the actual
   workflow, rather than only importing flattened finished scene clips.
6. Evaluate the mounted full loop with fixtures and fault injection, then run
   separately authorized listening/creative trials against generated media.
