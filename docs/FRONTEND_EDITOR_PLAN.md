# Frontend editor: research, design and implementation plan

**Date:** 2026-10-19. **Status:** proposed implementation plan; no editor features in this document have been implemented yet.

## 1. Recommendation

Build a **scene-first video editor with linked timeline tracks**, using the existing
Remotion composition and package system. Make the ordinary workflow:

**Brief → rough cut → edit and preview → generate missing media → review → export.**

Users should be able to arrange the story, hear narration, adjust pacing, edit
graphics and see exactly what needs generation before starting a GPU job. Keep
conversational drafting/revision alongside direct manipulation. The two interfaces
must edit the same project through the same revision-aware commands.

The first release should provide a genuinely editable scene timeline, reliable
preview, undo/redo and recovery. Add arbitrary multi-layer clip editing after the
scene/narration timing model is dependable.

## 2. Current implementation audit

This is a source-code audit plus primary-source research. Existing screenshots in
`docs/ui/` provide historical context. A fresh headless screenshot attempt timed
out and the desktop browser was unavailable; no new interactive usability test
or visual verification is claimed.

| Finding | Evidence | Consequence / priority |
|---|---|---|
| Timeline is a scrub control and scene forms | `apps/web/index.html`; `renderStoryboard()` in `apps/web/src/main.ts` | No direct reorder, trim, zoom, split or linked-track editing. P0 |
| Preview mutation copies selected content fields into an existing timeline | `syncTimeline()` / `markDirty()` in `main.ts` | Timing is deferred to export; adding drag handles alone would produce misleading previews. P0 |
| Preview and export share visual rendering, but not the complete composition | `apps/web/src/preview.tsx` mounts `TimelinePlayer`; `apps/renderer/src/Root.tsx` adds narration and music/ambience/SFX | Preview needs full audio/caption/media inputs and the same composition wrapper. P0 |
| Sound-design toggle currently describes the next render/export | `mixBar()` and its handler in `main.ts` | Users cannot confidently judge the final mix while editing. P0 |
| Planner uses measured narration and transition overlap | `packages/planner/src/timeline.ts`; `renderPackage()` in `apps/renderer/scripts/render-package-lib.mjs` | Timeline must show speech constraints and overlapping transitions, not sum independent scene rectangles. P0 |
| Planner imports `node:crypto` | `packages/planner/src/timeline.ts` | Extract browser-safe timing logic or use a compile endpoint; do not create a second timing algorithm. P0 |
| Revision checks and conflict-aware conversational merging already exist | `apps/server/src/store.mjs`, `chat-project.mjs` | Preserve and extend these instead of replacing persistence. P0 |
| No general editor undo/redo or draft autosave/recovery found | `apps/web/src/`; conversation ID persistence in `project-chat.ts` is separate | Add command history, saved-state feedback and recoverable drafts. P0 |
| GPU planning, budget checks, lifecycle events and selective rendering exist | `apps/server/src/run.mjs`, `edit.mjs`; run/spend panels in `main.ts` | Unify their presentation and bind jobs to immutable project inputs. P1 |
| Most orchestration lives in a 1,678-line `main.ts` | `apps/web/src/main.ts` | Extract state, commands and API boundaries before adding editor interactions. P0 |
| Header exposes provider, model, backend and budget alongside editing | `apps/web/index.html` | Make project/editing actions primary; move setup into a project/settings drawer. P1 |

Preserve OpenCode Go / `deepseek-v4.1-flash`, alternative provider configuration,
manual edits, existing package exports, and the working CPU/GPU backend paths.

## 3. Research and implications

Sources accessed 2026-10-19. Recommendations below are adaptations to Comfyrizz,
not claims that another editor's architecture can be copied directly.

| Source | Relevant practice | Application here |
|---|---|---|
| [Apple: Magnetic Timeline](https://support.apple.com/guide/final-cut-pro/intro-to-the-magnetic-timeline-verb8fcfc133/mac) | A primary storyline with connected media keeps related material together during edits | Scenes form the primary storyline; narration, captions and presenter items have explicit scene anchors |
| [Adobe: track targeting](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/work-with-clips-on-the-timeline-using-track-targeting.html) | Editing actions operate on visibly targeted tracks | Selection, track locks and action scope must be visible. Search excerpt reviewed; full page returned HTTP 403 |
| [Descript: edit like a doc](https://help.descript.com/getting-started/edit-like-a-doc) | Script-linked, non-destructive media editing | Sentence selection seeks the preview; distinguish changing synthesized speech from correcting caption text |
| [Remotion: building a timeline](https://www.remotion.dev/docs/building-a-timeline) | Item/track state and Player synchronization | Use frame-based item projections over the canonical package; keep one playback clock |
| [Remotion: Player best practices](https://www.remotion.dev/docs/player/best-practices) | Avoid re-rendering the Player whenever the current time changes | Isolate playhead state from composition state; stable input props and targeted subscriptions |
| [Remotion Timeline](https://www.remotion.dev/docs/timeline) | Ready-made multi-track drag/zoom/selection component; paid, specific licensing | Evaluate as an interaction component, not as a replacement project format |
| [NN/g: progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) | Show common actions first and reveal advanced controls when needed | Contextual inspector, secondary settings drawer, collapsed run diagnostics |
| [NN/g: visibility of system status](https://www.nngroup.com/articles/visibility-system-status/) | Timely, understandable feedback supports control and trust | Persistent save state, generation stages, stale-media indicators and actionable errors |
| [WCAG 2.2: dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) | Drag actions need a single-pointer, non-drag alternative | Move-before/after menu, numeric trim fields and move buttons, plus keyboard controls |
| [WCAG 2.2: target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | Minimum target-size requirements, with defined exceptions | Provide sufficiently large hit areas and alternate controls for narrow trim handles |

### Build versus buy

**Recommended starting point:** a small custom React scene timeline, with editor
commands independent of its view. React is already used by the preview; introduce
an editor root incrementally while keeping the existing settings/chat adapters.

Run a bounded one-to-two-day interaction spike before choosing the production
timeline component:

| Option | Benefit | Required evaluation |
|---|---|---|
| Custom scene timeline | Best fit for narration-constrained scenes and editable graphics | Pointer capture, zoom, scrolling, snapping, keyboard and touch effort |
| Remotion paid Timeline | Existing multi-track interaction and Player integration | License/purchase decision, accessible controls, schema adapter and ability to enforce scene constraints |
| [`@xzdarcy/react-timeline-editor`](https://github.com/xzdarcy/react-timeline-editor) | MIT component with rows/actions | React compatibility, integer-frame round trips from its time units, accessibility, performance and maintenance; README/license inspected, runtime not tested |

The spike must demonstrate a 12-scene reorder/trim, linked audio, undo and zoom
without introducing a second authoritative timeline. Do not choose a library
solely because its demo resembles a video editor. Any purchased dependency needs
an explicit purchasing decision; no purchase is assumed by this plan.

## 4. Proposed workspace

```text
Project name  Saved / Saving / Offline       Undo Redo     Review & export
Brief | Edit | Generate | Review             Project settings
┌──────────────────┬───────────────────────────┬──────────────────────┐
│ Scenes / Media / │ Preview                   │ Selection inspector  │
│ Script / Chat    │ safe areas, fit, quality  │ Copy / Timing /      │
│                  │ play, frame step, timecode│ Media / Motion / Audio│
├──────────────────┴───────────────────────────┴──────────────────────┤
│ Select / Split   Snap   Zoom / Fit     timecode     generation state│
│ Ruler and playhead                                                  │
│ Scenes        [Opening][Feature A][Feature B]...[Conclusion]        │
│ Visual media  [Still  ][Generated footage   ]                       │
│ Presenter     [Intro  ]                          [Outro]            │
│ Narration     [waveform and sentence boundaries                    ]│
│ Captions      [sentence][sentence][sentence]                        │
│ Music / SFX   [music envelope                ] [cue]                │
└────────────────────────────────────────────────────────────────────┘
```

- Resizable panels; preview remains visible while editing. Remember panel sizes
  and timeline zoom per project as editor preferences.
- One selection model synchronizes storyboard, timeline, script and inspector.
  Clicking a sentence seeks playback; clicking a scene reveals its fields.
- Scene names/headline thumbnails replace internal IDs as primary labels.
- The left rail is tabbed rather than four permanently expanded panels. Chat can
  act on the selection: “Shorten this scene” or “Make these graphics calmer.”
- Right inspector shows only relevant controls. Advanced workflow/model details
  are available through disclosure, with readable presets in the default view.
- On narrow screens use preview + tabbed inspector/script, and a full-width
  timeline view. Preserve numeric and menu editing when dragging is impractical.
- Empty state offers a new brief, example project or import. Reopening a project
  restores its last saved cut and offers a newer recoverable local draft.

## 5. Editing behavior and invariants

### First usable timeline

1. **Navigate:** ruler, draggable playhead, frame step, scene-boundary jumps,
   zoom around the playhead/pointer, fit project/selection, horizontal scrolling.
2. **Select:** click, multi-select, explicit scene/track highlights; inspector
   updates without seeking unless the action requests it.
3. **Reorder:** drag scenes or use Move before/after. Scene-attached content moves
   together; the primary storyline closes gaps. Show the insertion position.
4. **Trim:** scene edge drag and numeric duration controls. Show proposed duration,
   effective duration and delta before committing. Measured speech plus required
   padding is a visible lower bound. Offer script revision when it prevents a trim.
5. **Duplicate/delete:** transactional commands with stable new IDs on duplication;
   delete closes the scene gap and moves its attachments into undo history.
   Shared media files remain reusable.
6. **Snap:** scene edges, playhead and caption/sentence boundaries; threshold in
   screen pixels so zoom does not change the physical feel. Toggle and temporary
   bypass; label the snap target. Do not snap to a hidden locked target accidentally.
7. **Transitions:** visible overlap handles and inspector fields. The compiler
   remains authoritative for `sum(scene lengths) − overlaps`; edits must account
   for outgoing speech, incoming speech and the existing transition constraints.
8. **Undo/redo:** one gesture = one command; text typing groups into sensible edits.
   Escape cancels a drag. Restore selection along with document edits.

### Linked media and audio

- Scenes are the initial edit unit. Show narration/caption/presenter lanes from
  existing compile output before enabling independent movement of every item.
- Narration takes are non-destructive source media, identified by take ID and
  content hash. Store source in/out separately from timeline placement.
- Reorder repositions/rebuilds the assembled narration from per-scene takes.
  It must never leave the old combined narration WAV attached to the new order.
- Caption alignment stays scene-local in source data and is projected into
  absolute frames by the compiler. Caption wording correction does not change
  speech; script revision marks the relevant voice take and alignment stale.
- Presenter audio and video remain linked at native speed. A scene reorder with
  identical local audio can reuse the clip; a changed conditioning segment marks
  it stale. Persist a measured sync correction as an explicit media transform,
  keeping original assets and diagnostics, rather than silently replacing them.
- Music can use project-time anchors; SFX can use scene-relative anchors. Their
  anchor type must be explicit so ripple edits have predictable behavior.
- Track mute/solo is an audition state unless explicitly applied to export.
  Track locks prevent direct manipulation; they do not silently detach linked
  narration during a scene move. Reject a conflicting operation with its reason.
- Split comes after source-range support: split at the playhead, favor sentence
  boundaries, preserve source ranges and handle a caption crossing the cut.
  A copied full narration take in both halves is not an acceptable split.

### Shortcuts and accessibility

Space play/pause; arrows frame-step; modified arrows step farther; standard
undo/redo; Delete selection; Escape cancel; zoom and fit shortcuts. Expose these
in tooltips/help. Shortcuts must not intercept typing in inputs or chat. Start
with forward playback; add J/K/L shuttle only when reverse behavior is supported.

Every drag operation also has clickable controls and numeric/menu alternatives.
Provide visible focus, selection labels, status announcements, focus restoration
after dialogs, text plus color for state, and reduced-motion UI transitions.

## 6. Preview and pre-GPU workflow

### Three explicit preview states

| State | What users see/hear | Work required |
|---|---|---|
| Rough cut | Real typography/diagrams/transitions, placeholders or existing media, estimated speech timing | CPU/browser work; generation is a separate action |
| Voice-timed cut | Actual selected voice, waveforms, measured captions, accurate duration | Existing takes, or explicit narration generation; Qwen may use GPU |
| Generated-media cut | Collected moving media/presenter clips, full mix | Generate only missing/stale selected media, then review |

Show estimated versus measured timing and placeholder versus final media clearly.
A CPU temporary voice can be an explicit audition option; it must not silently
replace the selected Qwen voice or be described as final-quality timing.

### Generate panel

Rename ambiguous actions around the actual operations: **Generate media**,
**Render preview**, **Export video**, and **Download editable project**. GPU
generation and the current CPU MP4 rendering stage get separate progress states.

The Generate panel shows:

- The saved project revision and scene/media selections included in this run.
- Ready/reusable, missing, stale and failed assets, with thumbnails and reasons.
- Dependencies: voice → alignment → presenter; independent still/video jobs.
- Selected backend, estimated units/time with uncertainty, budget remaining and
  the existing metered-compute approval control.
- A clear summary such as “Generate 2 clips; reuse 10 assets.”
- Setup, queued, generating, collecting, applying and shutdown states; failures
  identify the asset and offer retry of that work. Estimates are not exact bills.
- Cancel enters “Stopping”; completion reports verified shutdown or the existing
  unconfirmed-stop state. Closing a panel is not presented as cancelling a run.

Before generation, validate missing inputs, required narration, media bounds and
the selected budget. Visual rough-cut work remains usable with placeholders.
Before final export, explicitly resolve use of stale voice/presenter media or
choose a clearly labeled draft export.

Users may continue editing during a job. Results belong to the job's immutable
input revision and fingerprints. Apply automatically only where those inputs
still match; otherwise retain the output as an available take and show why it
was not applied. Any changed job inputs require a newly computed plan/hash.

## 7. Technical design

### State and command boundaries

Create proposed `apps/web/src/editor/` modules for the store, commands, timeline,
inspector, media, transport and generation UI. Extract the authenticated API
client from `main.ts`; use existing chat/settings modules through adapters first.

Keep three state classes distinct:

1. **Project document:** canonical package and versioned editing metadata, source
   takes/ranges, explicit timing choices and asset fingerprints.
2. **Derived state:** compiled timeline, dependency plan, diagnostics, preview
   manifest and waveforms/thumbnails keyed by source hash.
3. **Session state:** selection, playhead, scroll, zoom, panel sizes and audition.

Use typed commands such as `MoveScene`, `TrimScene`, `SetSceneCopy`, `SetMediaRange`
and `SetCaptionText`, with inverse operations or before/after patches. A pointer
gesture previews transient state and commits once on release. Agent changes use
the same command application/validation boundary and are one undoable batch.
Undo reverses document choices, not a completed GPU charge or an external run.

### Compiler and composition parity — prerequisite

- Extract pure timing/layout projection from the Node hashing wrapper in
  `packages/planner`. Initially add an authenticated, debounced server compile
  route; then use the shared browser-safe core in a worker for responsive drags.
- Every response includes package revision, client edit sequence and input hash.
  Discard out-of-order responses. Server revalidates at save/generation/export.
- Pass measured durations/alignment into all compilation paths, including chat
  responses; invalidate old measurements when their source fingerprint changes.
- Extract a shared package composition from `Root.tsx`, including narration,
  captions and audio mix. The Player and MP4 renderer consume the same resolved
  props; media URL resolution is an environment adapter.
- Browser media delivery must work with the existing authenticated, byte-range
  server. Define an authenticated media URL/session strategy for native media
  elements (which cannot attach `apiFetch` headers); avoid loading entire long
  videos into memory just to preview them. Keep credentials out of exported files.
- Store all timeline positions/durations in integer project frames; keep source
  sample/frame units explicit for 24-fps clips, 30-fps projects and audio samples.
  Preview proxies must retain identical duration/time mapping to source media.
- Do not import Node filesystem/render helpers into the browser bundle.

### Schema and persistence

The package remains the source of truth. Derived `timeline.json` is an output,
not a second independently editable project.

First use existing scene order, narration, media and duration fields. Define
schema extensions for explicit duration overrides, source trims and anchors only
where existing fields cannot represent the edit. `preferredFrames` is a preference
subject to compiler constraints; the UI must not claim it is an exact trim.
Document override precedence and speech bounds before implementing handles.

Change `packages/schema/package-v1.schema.json` and regenerate its types; never
hand-edit generated `types.ts`. Test legacy packages. Use a versioned sidecar for
UI-only preferences; render-affecting metadata must be schema-validated, exported
and included in hashes. Choose a new schema version if compatibility requires it.

Retain the store's base-revision checks and atomic replacement. Add serialized,
debounced autosave, pending/saved/offline indicators and IndexedDB draft recovery.
A save acknowledges its own edit sequence; a delayed response must not mark
newer edits saved. On conflict offer comparison/rebase of non-overlapping edits
or a recovery copy, preserving manual changes. Persist useful revision checkpoints.

### Dependency invalidation

| Edit | Required downstream work |
|---|---|
| Headline, palette or diagram values | Recompile visual scene; reuse voice and generated media unless their declared generation inputs changed |
| Scene reorder | Recompute placements, captions, assembled audio and render ranges; reuse matching scene-local sources |
| Scene duration/transition | Recompile timing and mix; validate source bounds and presenter conditioning window |
| Narration text/voice | Invalidate affected takes, alignment and audio-conditioned presenter media; reflow measured timing |
| Media prompt/model/seed/source | Invalidate that generated asset and dependent outputs |
| Presenter placement only | Re-render composition; reuse the same matching presenter media |

Use explicit content fingerprints for generation separately from composition
segment hashes. Retain the current full-render fallback when frame grids change
until incremental timing edits have their own correctness tests.

### Performance

Use Player events as the playback clock. Updating the playhead must not rebuild
the project or rerender every inspector field. Memoize composition inputs; use
requestAnimationFrame for transient drag visuals and compile outside pointermove.
Cache downsampled waveform peaks and thumbnails by source hash. Virtualize long
timelines and large asset bins once profiling demonstrates the need.

## 8. Phased backlog and acceptance gates

Estimates are planning ranges for one experienced engineer, including integration
and verification, not a deadline commitment. Re-estimate after Phase 0.

| Phase | Deliverables / main locations | Exit gate | Estimate |
|---|---|---|---|
| 0 — Interaction and contract spike | Timeline component decision, wireframe, timing/trim semantics, representative fixtures | Reorder/trim experiment with linked narration and documented schema/API decisions | 1–2 days |
| 1 — Reliable editor foundation | Editor store/commands/API extraction; shared compile and complete preview composition; save/recovery/conflicts | Edit → preview → save → reload → export has matching timing/audio; undo and stale-response tests pass | 4–6 days |
| 2 — Scene timeline MVP | Ruler, zoom, selection, reorder, constrained trim, duplicate/delete, snapping, transition inspector, linked lane display | Complete a rough-cut editing task without GPU; correct narration/captions after reorder and undo | 4–6 days |
| 3 — Script/audio/media editing | Waveforms, sentence seek, take status, caption correction, voice preview, source-range split, mix audition | Split/reorder preserves source speech and sync; audition corresponds to documented export mix | 4–6 days |
| 4 — Generation workspace | Dependency-aware readiness, reusable/stale assets, selection-scoped run, immutable input handling, recovery | Changing one media prompt plans only its dependents; stale run results cannot overwrite newer edits | 3–5 days |
| 5 — Frontend polish and release | Responsive panels, onboarding, shortcuts, project recovery UX, export presets, accessibility/performance validation | Usability sessions and reference-project round trip meet the release gates below | 3–5 days |

**Total planning range: 19–30 engineer-days.** Phases 0–2 are the first usable
editor milestone (9–14 days), with a thin end-to-end rough-cut workflow. Surface
existing generation status during that milestone; deeper run management follows.
Accessibility, save-state feedback and error handling are part of each phase.

Deferred expansion: arbitrary overlapping clip tracks, advanced keyframe curves,
J/L cuts, speed ramps and collaborative editing. The initial design should not
prevent these, but they should not delay a trustworthy scene editor.

## 9. Verification and release criteria

Use the existing short example plus the 12-scene, 190-second Hermes project as
acceptance fixtures. Keep local production media/credentials outside the repo;
use lightweight generated substitutes for automated tests.

- **Timing:** integer-frame tests for reorder, overlap, minimum speech duration,
  duplicate/delete and undo; compare browser/server compile results, including
  narration sidecars and 24/25/30-fps media cases.
- **Round trip:** save/reload and editable ZIP reimport reproduce frame count,
  scene starts, captions, source ranges and media identities; render selected
  boundaries and compare with the shared Player composition.
- **Speech:** no duplicated, dropped or silently time-stretched narration after
  reorder/split. Test captions crossing cuts and changed presenter conditioning.
- **Concurrency:** typing during autosave, stale compile results, server revision
  conflict, agent edits against manual changes and GPU completion after edits.
- **Interaction:** actual browser tests for drag/trim/zoom, cancelled gestures,
  keyboard commands, non-drag alternatives and focused text inputs.
- **Generation:** fake backend verifies exact selected jobs, invalidation, reuse,
  budget-plan freshness, retry/cancel and teardown states before any live run.
- **Accessibility:** automated checks plus keyboard-only and screen-reader task
  passes; focus visibility, target sizes, status text and reduced UI motion.
- **Performance targets:** selection feedback within 100 ms; ordinary edit-to-
  preview p95 below 250 ms once assets are ready; smooth playhead/drag updates on
  the reference desktop. Record hardware/browser and measure a 100-scene stress
  project separately. These are proposed targets, not current measurements.
- **Usability:** test with 3–5 users unfamiliar with the code. Ask each to reorder
  scenes, shorten a beat, correct a caption, replace one asset, undo a mistake,
  identify expected GPU work and export. Record completion, misclicks and places
  requiring explanation; target at least 4/5 independent task completion when
  testing with five users, and resolve data-loss/timing issues before release.

## 10. Implementation starting point

Start with Phase 0, then land small reviewable changes in this order:

1. Shared compilation/preview contract and parity fixtures.
2. Editor command store, revision-aware autosave, recovery and undo.
3. Readable linked-track timeline, then reorder and constrained trim.
4. Context inspector/script/audio controls and media-source editing.
5. Generation workspace and the rest of the navigation/export polish.

This order makes the timeline reliable before making it more powerful. It also
lets the current chat, provider settings and generation backend stay useful
throughout the migration.
