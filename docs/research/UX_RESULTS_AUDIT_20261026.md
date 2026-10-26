# ComfyRizz: user experience and production-result improvement audit

Date: October 26, 2026. Scope: current upstream `f16d188` plus deployment fix
`2de992d` (exclude test files from the eager Easy Studio step loader).

Execution plan: [subagent remediation packets, dependencies and acceptance gates](../tasks/UX_RESULTS_REMEDIATION_20261026.md).

The user requested parallel subagent review and contextual best-practice research.
This is an improvement assessment, not authorization for implementation or paid
generation. The previous October 22 integration proposal is historical context;
current source must establish whether a gap still exists.

## Evaluation goal

Help users produce the video they actually intended, make informed creative and
cost decisions, correct one thing without breaking others, and return to a usable
project after interruption. Completing a generation request is only one part of
that outcome.

Prioritize by consequence, reach, confidence and implementation cost:

- **P0:** blocked core journey, wrong project/output, lost decisions/edits or
  unauthorized/duplicate work.
- **P1:** materially weaker output or substantial friction in a common journey.
- **P2:** useful efficiency, accessibility or clarity improvements with narrower
  impact. Accessibility blockers may be P0/P1; they are not inherently polish.

Evidence levels: reproduced in browser; traced through mounted source; isolated
unit contract; documentation/design proposal; research-derived hypothesis. Do not
describe a source-audit risk as a reproduced runtime incident.

## Production-derived acceptance stories

These stories come from actual collaboration, not a claim that the current app
implements or fails every step:

1. **Research before invention:** a `.host` URL turns out to be a source-linked
   software journal. The film must not invent hosting prices or uptime claims.
2. **Cast a performance:** compare short dry auditions, choose C1, retain that
   actual recording and validate its native audiovisual transfer.
3. **Change appearance only:** “make her new” replaces the silver-haired host with
   the selected dark-curly-haired creative director while retaining C1. A new
   still is reviewed before spending on another speaking shot.
4. **Approve and continue:** “this works, generate it” resolves the visible current
   proposal, starts only authorized scoped work and does not require repeated
   status-only messages from the user.
5. **Fix locally:** remove a repeated “guitar rigs” tail through a trim; preserve
   the original. A one-line correction does not regenerate the rest of the film.
6. **Recover honestly:** a model still mispronounces a word after a retry. Surface
   an editorial alternative and its script consequence; do not claim the original
   line passed or spend indefinitely.
7. **Separate evidence:** transcript/loudness/decode checks cannot approve accent,
   acting or lip sync. A muted playback check is not listening approval.
8. **Finish usefully:** provide a verified playable film, captions, sources and an
   editable cut; explain what is baked into clips versus independently editable.
9. **Return safely:** old owner edits, rejected voices, approved reference hashes,
   accumulated costs and delivered versions survive reload/update/new projects.

## Review workstreams

Six user-requested subagents cover creation journey, agent/output quality,
casting/review/delivery, recovery/budget correctness, accessible responsive
interactions, and primary-source best practices. Code reviews were read-only.
Their findings, research mapping and prioritized implementation backlog are
consolidated below.

## Findings received: creation journey and media review

Evidence below is static source tracing, not a newly reproduced runtime incident.
Paths are relative to the audited release root. Priorities reflect the consolidated
independent reports and should be revalidated against implementation reproducers.

| Priority | Finding and source | Recommended change / acceptance |
| --- | --- | --- |
| P0 | Super Easy CPU completion has no usable handoff: `apps/web/src/easy/mount.ts:131–152` supplies a no-op `go`; `cpu-path.ts:176–211` produces a preview and calls Review; `super-easy/session.ts:120–136` waits for a final artifact. Errors target a shell destroyed at `mount.ts:178–198`. | Represent preview-ready separately from final-ready. Expose Review/Export, direct errors and an escape. Test the real mount with mocked CPU completion and planning failure. |
| P1 | Brief edits can be marked planned without rebuilding: `easy/steps/idea.ts:158–166`, `easy/plan-writer.ts:56–60,83–96,124–140`. | Separate changed brief from edited scene text. Idea B must reach the builder and displayed scenes; headline-only edits should preserve the package. |
| P1 | New video can inherit persistent project state: `easy/home.ts:18–20,74–76`, `easy/mount.ts:55–60,188–198`, `easy/store.ts:197–200,282–291`, `easy/super-easy/mount.ts:126–132`. | Shared explicit start-new operation resets IDs, cast, decisions and export state while preserving the old project. Test both New video and Make another. |
| P1 | Ask always shows no-provider guidance: `easy/mount.ts:300–313`; real drawer exists in `easy/ask-drawer.ts`. | Mount the provider-aware conversation for the current project. Test connected and disconnected cases. |
| P1 | Connect AI can open a hidden inspector: `main.ts:2670–2676`, `agent-settings.ts:106–114,189–201`, `easy/mount.ts:452–461`. | Mode-independent visible settings API, replacing synthetic clicks. Verify fields and return focus from Studio. |
| P1 | Successful export loses its download on reload: `easy/steps/export.ts:325–331,457–464,583–588,709–721`. | Persist artifact ID and retrieve it; reopening must not render again. Explicitly handle expired/unavailable artifacts. |
| P1 | Studio Saved badge is constant: `easy/mount.ts:434–438`; actual save subscription is `main.ts:128–142`. | Wire authoritative saving/conflict/error state. Distinguish local draft persistence from server save. |
| P1 | Mounted ordinary audition expects `audition`, API exposes `requestAudition`: `characters/editor.ts:1098–1113`, `characters/api.ts:651–690`. Describe can fall back to Kokoro because model capability is not supplied: server `app.mjs:1747–1753`, `characters/audition.mjs:1657–1684,1742–1759`. | Adapt ordinary route; resolve actual model and expose prompt-plan status. Described voice must not silently synthesize a stock voice. Test through the mounted Characters tab. |
| P1 | Production inspector defaults to synthetic waveform/voice: `main.ts:2564–2568`, `editor/inspector/panel.ts:48,396–409,514–518`, `editor/inspector/demo.ts:3–10`, `editor/audio/voice-preview.ts:15–44`. | Decode actual selected audio and identify its hash/take; otherwise show unavailable. Never label a tone Selected take. |
| P1 | Caption override sidecar is preview-only in export path: `editor/commands.ts:33–45,124–129`, `editor/store.ts:268–277`, `main.ts:2155–2167`; server `export.mjs:228–252,315–341`; renderer `scripts/render-package-lib.mjs:114–118,172–189`. | Canonical package+editor+take+timing export snapshot. Caption-only correction must agree in preview, burned video, SRT, VTT and reopened ZIP, without resynthesizing speech. |
| P1 | Viewer correction sends a take ID as asset ID: `main.ts:503–524,563–568`, `viewer/asset-viewer.ts:620–629`. | Separate immutable shot/clip/take/asset target fields. Test historical nonselected takes and navigation before submission. |
| P1 | Compare can retain previous-shot takes under a new shot title: `main.ts:550–559`, `viewer/asset-viewer.ts:656–665`, `takes/compare.ts:346–355,380–399`. | Clear/load takes on navigation; disable Keep until loaded and reject stale responses. Test disjoint IDs and rapid navigation. |
| P1 | Compare mutes both videos, uses duration percentage and rebuilds players: `takes/compare.ts:445–455,574–594,636–647,684–688`. Individual viewer does allow listening. | One audible monitored take, stable players and common time/frame comparison. Selection must remain distinct from acting approval. |
| P1 | Approved-recording/native-transfer workflow is unsupported in reusable-character surface: server `characters/voice.mjs:48–72,681–706`, `characters/audition.mjs:106–127`, `productions/native-test.mjs:113–120,151–156,310–315`; UI `characters/voice-mode.ts:181–184` implies clip reuse. | Disclose current support accurately; add reference asset/hash/provenance and transfer approval binding. A2 must remain the approved bytes; rejected references and other characters must not silently inherit it. |
| P1 | Export paths differ in readiness and aspect: server `routes/render.mjs:246–275,414–422,542–549`, `app.mjs:508–512,940–963`; renderer `render-package-lib.mjs:63–65,98–105,205–219`. | Shared preflight and snapshot; preserve 9:16 in both export paths. Distinguish draft output and final review; disclose archive exclusions. |
| P2 | More control drops unsent prompt: `easy/super-easy/mount.ts:89,135–142,165–176`. | Persist textarea before mode handoff; no generation on navigation. |
| P2 | Plan decision radios are not submitted: `easy/steps/plan.ts:183–216,365–368,536–572`, `easy/approve-generate.ts:105–107`. | Persist proposal-bound decisions and pass context into approval; invalidate on proposal change. |
| P2 | New-project header can display seeded Pip name; rename component is not mounted: `easy/mount.ts:331–333,434–438`, `easy/project-name.ts`. | Untitled until authoritative project exists; mount rename and verify reload/recent/export agreement. |
| P2 | Standalone audition comparison plays character/line without row candidate config: `characters/audition-panel.ts:615–625,716–725`. It is not mounted as the real editor comparison. | Fix candidate identity before mounting: auditioned and selected candidate must have identical config/audio hash. |
| P2 | Region annotation uses host bounds despite letterboxing/zoom: `viewer/asset-viewer.ts:338–344,547–579`. | Map to source-media coordinates; test portrait, zoom and controls. Explain guidance versus actual spatial masking. |

Existing capabilities to retain: seven Studio steps, references and role validation,
cost/cap controls, editable script, take selection, scoped iteration schema,
revision-aware export freshness, character revisions, prompt-voice approval helpers,
and archived composition sources. Motion-reference assignment currently uses a
selected first frame plus prompt guidance, not native video motion conditioning
(`apps/server/src/references/assign.mjs:301–314,341–354`). Show the actual use of
each reference rather than implying unsupported conditioning.

## Contextual best practices

Sources accessed October 26, 2026 by the research subagent. Their applicability
does not establish that a particular implementation works or quantify its benefit.

1. **Consistent truth across modes.** Generated, automatically selected, technically
   checked and human-reviewed are independent facts. Preserve them through export.
   Microsoft [Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/)
   (CHI 2019) supports expectation-setting, correction, feedback and communicating
   consequences. Its evaluation involved 49 practitioners and 20 AI products;
   it does not validate this application's native-video workflow.
2. **Progressive disclosure with continuity.** Hide secondary controls, not state,
   context or recovery. [NN/g Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
   (2006) cautions about deep levels and rigid sequences for interdependent tasks.
   Test switching modes without losing the brief, selection or current project;
   three modes are not inherently a defect.
3. **Meaningful progress and cost.** Distinguish estimates, reserved maximum,
   actual/estimated spend and remaining allowance; show stage counts and shutdown
   status. [NN/g Response Times](https://www.nngroup.com/articles/response-times-3-important-limits/)
   supports feedback and interruption, not fabricated overall percentages or ETAs.
4. **Safe retries preserve intent.** [AWS Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
   supports request identity, atomic deduplication, equivalent retry responses and
   rejecting parameter mismatch. Reconnect, recover a download and generate another
   take must be distinct actions. Local deduplication is not proof of end-to-end
   exactly-once execution.
5. **Accessible editor and output.** [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
   covers keyboard, visible/unobscured focus, drag alternatives, target size,
   status messages and media alternatives. [W3C ATAG overview](https://www.w3.org/WAI/standards-guidelines/atag/)
   explicitly covers both accessible authoring and accessible authored content.
   Test complete review/correction/export journeys, not just automated page scans.
6. **Evaluate outcomes, not activity.** [Anthropic, Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
   (January 9, 2026) supports actual-outcome grading, balanced cases, deterministic
   checks and human-calibrated quality assessment. This is vendor engineering
   guidance, not an independent experiment proving these recommendations.
7. **Casting is a user-specific production requirement.** Dry auditions followed
   by one native speaking validation come from this user's approved workflow,
   not a universal externally proven rule. Actual references and separate
   character directions matter; transcript/loudness checks cannot approve acting.

Research questions to resolve in implementation: documentation disagrees about
the default landing mode and default iteration selection; release voice support
differs from the active workspace production standard; quality-pipeline documents
describe checks not fully mounted in render-core. Actual mounted capability must
govern UI claims.

## Agent quality and scoped-edit contracts

All entries are source-traced. Agent paths below are under `packages/agent/src/`;
server paths are under `apps/server/src/` unless stated otherwise.

| Priority | Finding / evidence | Remedy and meaningful verification |
| --- | --- | --- |
| P1 | Viewer scope is validated but omitted from production tool context: server `agent-chat.mjs:370–398,835,1291–1338`; agent `production-tools.ts:685,714–764`. | Pass canonical scope into the tool context and derive targets from it. Mounted chat must accept exactly the allowed target/preserve list and reject expansion. |
| P1 | Ordinary project tools bypass production read/intent/scope guards: agent `conversation.ts:617–631,675–690`; guards only in `production-tools.ts:564–588`. | Central mutation policy across all tools. Scripted model must fail on unrelated patch, paused mutation and build-before-read without changing project state. This is not proof of a paid-execution bypass. |
| P1 | Scope parsing only recognizes numeric IDs although schema permits `s_intro`: agent `production-planner.ts:8–35,199–207`; server `agent-chat.mjs:310–325`. | Resolve structured IDs against current production; distinguish absent and explicitly empty scope. Test named scene and line IDs. |
| P1 | Non-hero SVG storytelling becomes a 12%-width decoration: server `chat-project.mjs:795–803`; agent `conversation.ts:141–161`. | Bounded visual role/placement or layout-specific rectangles. Compile existing diagram/comedy fixtures and inspect phone-sized rendered output. |
| P1 | Quality warnings can be bypassed in update+build batches; measured timing/coverage absent from agent context: agent `conversation.ts:436–454,647–700`; server `agent-chat.mjs:165–214,361–365,635–650`. | Structured timing report distinguishes estimated/measured/stale and checks before build. Preserve point-edit scope and intentional holds. |
| P1 | Requested duration is not a typed constraint; eval checks scene sum instead of overlap-aware output: agent `conversation.ts:227–236`; server `chat-project.mjs:97–106,743–746`; `packages/agent/scripts/eval-conversation.mjs:33`. | Persist target duration and compare compiled frame count. Test cut/fade variants and disclose deviations. |
| P2 | Sourced/approved values are model assertions without source retrieval in this conversation toolset: agent `conversation.ts:49–58,254–257,516,621–627`, `brief.ts:72`. | Claim/source ledger with excerpt/date/qualification and server-owned consent. Unsupported current facts require a source, omission or explicit hypothetical treatment. |
| P2 | Brief defaults lose explicit preferences and mislabel user answers as agent choices: agent `brief.ts:278–279,317–359,388–432`; server `brief.mjs:59–65`. | Explicit/inferred/defaulted/unresolved field provenance; preserve style/language/voice and prioritize missing evidence. |
| P2 | Deterministic outline forces generic hooks/stats and English or spoken scaffolding: agent `brief.ts:482–488,540–607`. | Clearly label scaffold; adapt to nonnumeric, French, silent and fictional briefs. |
| P2 | Planner allocates total rather than remaining take capacity, and element branch misses locks: agent `production-planner.ts:295–325,471–565,607–620`. | Shared remaining-capacity/lock logic between planner and guard; test partially used multi-shot plans. |
| P2 | Split/compare `scene.media` omitted from generation reference traversal: server `productions/plan-from-package.mjs:42–52`, `chat-project.mjs:774–794`. | Canonical scene-asset traversal; two-image comparison must produce correct generation coverage. |
| P2 | Evals stop at draft structure and lack real production binding/scope: `packages/agent/scripts/eval-conversation.mjs:22–62`, `evals/conversation-cases.json:42–82`. | Scripted-model mounted integration plus compiled/rendered evidence. Separate structural, behavioral and human quality results. |

Further conditional audit target: legacy `agent-runner.mjs:134–143` can replace
valid output lacking its demo-specific asset counts with a showcase. This is not
the modern conversation path; establish reachability before changing it. Any demo
fallback must be explicitly labelled rather than substituted for the user's topic.

Preserve current strengths: specific native-video direction skills, capability
honesty, partial motion edits, locked/manual-edit preservation, and strong guards
within the intended production-tool path. Improve integration rather than replace
these foundations.

## Reliability, budget and recovery

Paths are relative to `apps/server/src/` unless prefixed otherwise. These are
static failure traces and proposed fault-injection tests, not observed spending
incidents in the user's production.

| Priority | Finding / evidence | Remedy and acceptance |
| --- | --- | --- |
| P0 | Full pipeline admission bypasses bound production allowance/intent/action: `app.mjs:521–526,1131–1144`, `pipeline.mjs:257–306`; compare guarded `run.mjs:298–400`. | Require admitted production authority for bound packages. Mounted route tests: exhausted/paused/cancelled/rejected/missing authority all launch zero work. |
| P1 | Dispatch reserves and journals work but app does not drain production execution outbox: `productions/actions.mjs:1018–1115`, `app.mjs:256–285,876–890`; browser separately starts at `apps/web/src/easy/approve-generate.ts:139–165`. | Server-owned recoverable dispatcher; reload/crash at each boundary gives one execution or explicit reconciliation and closes holds. |
| P1 | Production Cancel changes intent without aborting work; legacy admission omits intent: `productions/commands.mjs:414–450,612–655`, `run.mjs:298–400,1151–1189,1402,1506,1562`. | Durable cancel fan-out and retained AbortControllers; enforce intent before consuming queued actions. Distinguish requested, stopped and shutdown-unconfirmed. |
| P1 | Undo after successful autosave restores obsolete CAS revision: `apps/web/src/editor/store.ts:215–216,308–319,396–417,475–479`, `editor/autosave.ts:89–95`. | Keep acknowledged revision outside undoable content. Test save→undo→save→redo→save without false conflict. |
| P1 | Final take gate and clips API omit reference index, allowing changed reference bytes to remain approved: `takes/model.mjs:430–545`, `takes/gate.mjs:59–63`, `takes/routes.mjs:231–241`. | Reference-aware fingerprints at ingest and derivation; direct/transitive hash change marks stale. Define legacy migration behavior. |
| P1 | Take selection/revert lacks caller CAS and idempotency; package/sidecar writes split: `app.mjs:797–804`, `takes/routes.mjs:667–743`, `takes/select.mjs:183–207`. | Expected revision/selection and command ID with repairable journal. Test two tabs, duplicate Revert and crash between writes. |
| P1 | Reserve-before-action and failed-settlement recovery can strand holds: `productions/actions.mjs:1022–1119`, `run.mjs:803,820–836,885–900`. | Independently durable settlement/release work and orphan reconciliation. One failed settlement must retry even for terminal actions. |
| P1 | Generic budget command records success without ledger cap effect: `routes/productions.mjs:433–475`, `productions/commands.mjs:445–446,638–649`. | Single durable cap effect or reject unsupported generic endpoint; test both paths and crash boundary. |
| P2 | Iteration estimates ignore ledger and may assume zero duration: `productions/iteration-routes.mjs:136–197`, `app.mjs:454`, `apps/web/src/productions/client.ts:693–706`. | Bound-package durations and available allowance (spent/reserved separate); test near-exhausted and fully reserved states. |
| P2 | Reload snapshot lacks action/plan projections but advances event cursor: `routes/productions.mjs:198–212`, `apps/web/src/productions/client.ts:411–430,881–888`, `easy/events.ts:103–113`. | Authoritative projections or explicit history hydration before ready; reconstruct actionable pre-reload state. |
| P2 | SSE IDs restart and replay silently truncates: `events.mjs:6–10,28–43`. | Epoch/cursor-expiry signal with snapshot reset. Empty replay must not imply no change. |
| P2 | Export snapshots package JSON but reads live media and publishes files in place: `export.mjs:87–93,225–226,254–343`. | Immutable input staging and atomic versioned bundle publication; interrupted export leaves prior delivery usable. |
| P2 | Take route can classify authority/conflict errors as queued/started: `takes/routes.mjs:280–286,356–387`; budget errors discard useful numbers: `productions/actions.mjs:386–387`, `routes/productions.mjs:35–47`. | Explicit error codes, valid run ID required for started, and safe structured shortfall/recovery details. |

Preserve command identity/CAS, immutable plan hashes, conservative settlement,
uncertain-run adoption without automatic resubmission, retained interrupted-run
artifacts, and manual-edit baselines. Existing isolated crash tests do not prove
that the mounted app invokes all the tested primitives.

## Accessibility, responsive review and performance

Paths below are under `apps/web/src/` unless stated otherwise. Static evidence
does not establish measured latency, actual screen-reader output or conformance.

| Priority | Finding / evidence | Remedy and acceptance |
| --- | --- | --- |
| P1 | Viewer capture handler intercepts Space on buttons and modifier shortcuts: `viewer/asset-viewer.ts:99–111,716–754,831`, `viewer/model.ts:230–241`. | Exclude interactive targets/modifiers or scope shortcuts to media. Native Space/Enter must activate each focused control. |
| P1 | Characters section claims modal without containment/inert background: `characters/mount.ts:452–455,492–525,692–739`. | Native modal dialog or complete modal behavior; test Tab loop, background exclusion, nested Escape and opener restoration. |
| P1 | Super Easy progress replaces focused controls/media/live regions: `easy/mount.ts:142–148`, `easy/super-easy/mount.ts:179–210`, `progress-view.ts:64–76,123–128,165`. | Stable keyed DOM and one persistent status region; playback and focus survive frequent updates. |
| P1 | Ticket expiry is discarded and URLs cached indefinitely: `takes/api.ts:213–240`, `main.ts:709–744`, `thumbs/client.ts:282–311`. | Shared expiring-ticket resolver, bounded error renewal preserving playback state; test idle/seek/background resume. Server TTL not independently verified. |
| P1 | Timeline mount drops supplied thumbnails/open hooks: `main.ts:2618–2639`, `editor/timeline/mount.tsx:23–59`, `Timeline.tsx:57–60,559`. | Forward hooks; mounted timeline shows bounded thumbnail requests and opens viewer once. |
| P2 | Files viewer lacks audio/video source resolution: `main.ts:385–408,458–463`, `viewer/asset-viewer.ts:462–493`. | On-demand tickets and visible loading/error/retry; test all media types and navigation. |
| P2 | Viewer playback state misses audio time/end/error updates and cleanup: `viewer/asset-viewer.ts:365–379,433–444,469–516,686–695`. | Central lifecycle listeners and teardown; test rejection/end/seek and 50 open-close cycles for bounded nodes and no residual audio. |
| P2 | Fixed mobile footer can exceed reserved 88px and obscure focus: `easy/easy.css:119–131,166–180`, `easy/easy-mobile.css:23–55`. | In-flow footer or measured reserve/safe area; test 320px, zoom, long errors and software keyboard. |
| P2 | Narrow-editor warning overlays still-focusable controls: `ui/shell.css:789–815`, `main.ts:2527–2530`. | In-flow dismissible advisory or accessible alternate view; no hidden keyboard focus at 390px/400% zoom. |
| P2 | Serial preview hydration and per-frame scene-card scans: `main.ts:503–514,725–744,2653–2661`. | Bounded concurrent prioritized hydration, immediate loading surface, active-scene-only DOM changes. Measure on delayed 100-shot fixture. |
| P2 | Actionable toast expires while focused: `ui/toast.ts:12,39–41,55,63–82`. | Persistent action or paused expiry with persistent equivalent; test focused action after six seconds and concise announcement. |

Additional standard references: WAI-ARIA APG
[modal dialogs](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/),
[buttons](https://www.w3.org/WAI/ARIA/apg/patterns/button/), and
[splitters](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/).
The interaction reviewer cited these established patterns without a new online
research pass. Favor roughly 44px frequent touch controls; 24px WCAG AA target
baseline is not an optimal-touch-size claim.

Preserve native Easy dialogs, splitter keyboard controls, focus rings, reduced
motion tokens, preview premounting, bounded thumbnail queue and timeline keyboard
editing. Current browser config is Chromium-only; viewport emulation is not iOS
Safari coverage. Axe thresholds and static modal markup tests do not establish
complete keyboard/AT behavior. Extend to Firefox/WebKit and manual NVDA/VoiceOver
and actual mobile background/keyboard/download cases.

## Consolidated implementation order

1. **Trust and first useful result:** close production-bound pipeline admission;
   repair Super Easy CPU result/error handoff; truthful Saved/ready states; undo
   revision correctness. Exit: mounted fixture journeys finish and preserve work.
2. **Durable paid execution:** server-owned dispatch, cancellation, settlement and
   cap effects; snapshot hydration and explicit recovery. Exit: fault injection
   across each boundary cannot duplicate work or strand an unexplained reservation.
3. **Faithful editing and delivery:** canonical caption/editor/export snapshot,
   immutable media staging, consistent aspect/preflight, durable downloads and
   reference-aware freshness. Exit: preview and delivered/reopened artifacts agree.
4. **Useful creative iteration:** scope propagation and cross-tool policy, named
   target IDs, new-project reset, brief rebuild, mounted Ask/settings, exact take
   correction/compare IDs. Exit: one requested change preserves unrelated content.
5. **Trustworthy performance review:** real decoded voice/waveforms, correct
   audition routes, approved-reference/native-test support, audible stable compare,
   explicit reference-use receipts. Exit: selected audio is what users heard.
6. **Better authored results:** preserve SVG composition, measured timing/coverage,
   overlap-aware duration, source ledger and explicit preference provenance. Exit:
   rendered task fixtures meet their brief, not merely schema assertions.

Accessibility and responsive acceptance belong in every packet: stable focus and
media, correct modal/keyboard behavior, ticket renewal, mobile non-obstruction.
They are not deferred to a final polish phase. Use the companion
[evaluation plan](UX_RESULTS_EVALUATION_20261026.md) for test layers and outcome
metrics. No numerical improvement or full conformance is claimed without baseline
measurement and task-based evaluation.

## Review completion

All six requested subagents completed. This report consolidates independent static
code reviews and a primary-source research review. No new production generation,
paid calls, app implementation changes or deployment changes were performed by
this audit. Browser/test acceptance cases above are proposed, not newly executed.
The two research documents were prepared in the release worktree and are now
submitted with the remediation plan in a documentation-only PR. Prior production
files and the earlier spec branch remain intact.
