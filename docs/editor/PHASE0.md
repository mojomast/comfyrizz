# Editor Phase 0: interaction contract, timing semantics and fixtures

**Task:** Q-P1. **Owner:** Pi. **Date:** 2026-10-20. **Gate:** this document plus
`apps/web/test/editor-phase0.test.mjs` are the Phase 0 exit gate in
`docs/FRONTEND_EDITOR_PLAN.md` §8 ("reorder/trim experiment with linked narration
and documented schema/API decisions"). CA-1 is blocked on it.

Everything below is checked against the real compiler
(`packages/planner/src/timeline.ts`), not against a mock. Where this document and
the compiler disagree, the compiler is right and this document is a bug.

---

## 1. Component decision

**Decision: build a small custom React scene timeline. Do not buy a timeline
component, and do not adopt `@xzdarcy/react-timeline-editor` for the first
release.**

| Option | Verdict | Why |
|---|---|---|
| Custom scene timeline (React) | **Chosen** | The unit of editing is a *narration-constrained scene*, not a free clip. Timing is derived by the compiler from measured speech, so a drag has to express "this scene's preference", not "this clip's new in/out". A generic NLE component models the wrong thing and then fights the constraints. |
| Remotion paid Timeline | Rejected for now | It is an interaction component, not a project format, and it would still need a schema adapter that enforces scene constraints. It is also a purchase decision, and nothing in the plan may assume a purchase. Revisit only if Phase 2 drag work exceeds its estimate by more than half. |
| `@xzdarcy/react-timeline-editor` (MIT) | Rejected | Its rows/actions model maps poorly onto linked, reordered narration; its time units are not integer project frames, so every drag needs a lossy round trip; accessibility and maintenance are unverified. |

**Evidence for the decision (this is what the spike bought):** the whole
interaction can be expressed as *package → package* commands plus a compile. The
spike implements reorder, trim, delete and undo that way in
`apps/web/test/editor-phase0.test.mjs` (11 tests) against the real compiler, and
the 12-scene 190-second fixture survives a reorder with its frame count intact.
No view-layer state was needed to get correct timing, which is the property a
purchased component would have been at risk of breaking.

What a purchased component would still buy us later is *zoom, snapping and drag
polish*, not correctness. That is deferred to Phase 2 polish (Q-P3), not to
Phase 1.

---

## 2. Wireframe for Phase 1

Phase 1 builds the shell and the loop, not a full NLE. One selection model drives
every panel; the playhead is separate from the document.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Project name   Saved · Saving · Offline      Undo  Redo      Review & export │
│ Brief | Edit | Generate | Review                              Settings ⚙     │
├───────────────┬──────────────────────────────────────┬───────────────────────┤
│ Scenes        │ Preview (TimelinePlayer)             │ Inspector             │
│  • Opening    │  fit / 100% / safe areas             │  Copy                 │
│  • Feature A  │  ⏮ ◀ ▶ ⏭   frame 435/5700  00:14.500 │  Timing               │
│  • Feature B  │                                      │  Media                │
│  …12 chapters │                                      │  Motion               │
│               │                                      │  Audio                │
│ Script        │                                      │                       │
│ Chat          │                                      │                       │
├───────────────┴──────────────────────────────────────┴───────────────────────┤
│ Select · Split   Snap:on  − ▭ +   zoom 1.0×   00:14.500   4 of 12 selected   │
│ Ruler        │0        5s        10s        15s        20s        …           │
│ Scenes       │[Opening ][Feature A      ][Feature B    ][  … 12 chapters ]   │
│ Visual media │[plate                ][presenter          ]                   │
│ Presenter    │[intro ]                                    [outro ]           │
│ Narration    │[▁▂▃▅▂ sentence chunk ][▂▃▅▇  next chunk        ]              │
│ Captions     │[sentence        ][sentence      ][sentence      ]             │
│ Music / SFX  │[music envelope ▂▃▅▇▆▅▃▂             ]  ♪ cue                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Phase 1 acceptance is the loop, not the picture: **edit → preview → save →
reload → export with matching timing and audio**, plus undo and stale-response
tests. Phase 2 adds the ruler, selection, reorder, constrained trim, duplicate/
delete, snapping, the transition inspector and the linked-lane display.

Rules the wireframe pins down:

- **Scenes are the edit unit.** Lanes (visual media, presenter, narration,
  captions, music) are *read-only projections* in Phase 1 and 2. Independent
  movement of every lane is Phase 3 at the earliest.
- **One selection model.** Selecting in the storyboard, the timeline, the script
  or a chat message selects the same `sceneId`. Seeking is an explicit action,
  not a side effect of selection.
- **Playhead is session state.** It must not be a package field and must not
  recompile anything.
- **Narrow screens:** preview + tabbed inspector, full-width timeline view, and
  every drag has a numeric/menu equivalent (WCAG 2.2 dragging movements).
- **The timeline never claims a number the compiler did not produce.** If the
  inspector says 210 frames, that is `timeline.scenes[i].durationInFrames`.

---

## 3. Timing and trim semantics

### 3.1 The frame model (authoritative, from `packages/planner`)

All positions and durations are integer frames at `format.fps` (normally 30).

```text
narrationFrames(scene) = ceil((Σ chunk.seconds + gap·(chunks−1) + padding) · fps)
                        default gap 0.15 s, padding 0.25 s (sidecar overrides)

duration(scene) = clamp( max( preferredFrames ?? layout.min , narrationFrames ),
                         layout.min,
                         max( layout.max, narrationFrames ) )

total = Σ duration(scene) − Σ transitionOut(every scene but the last)
```

Layout limits (frames @30 fps): `title` 30–450, `hero` 45–600, `stat` 30–300,
`chart` 45–450, `list` 45–600, `split`/`compare`/`code` 45–600.

Consequences the UI must not paper over:

- **Measured speech is a floor, never a ceiling.** `layout.max` only caps
  *preferred pacing*; a long take is allowed to exceed it, because clamping to a
  visual default silently cut narration on export (the reason for that line in
  the compiler).
- **`preferredFrames` is a preference.** It is not an exact trim. A scene whose
  speech needs 210 frames cannot be 60 frames long, and the UI must say
  "requested 60, effective 210 (two sentences of narration)" instead of drawing
  a 60-frame clip over 210 frames of audio.
- **Trimming below `layout.min`** floors at the minimum even when the scene has no
  speech (spike test: `s_close` at 5 frames resolves to 30).
- **Transitions overlap.** With six 150-frame scenes and five 15-frame fades the
  film is 825 frames, not 900. The last scene may not carry a transition
  (`transition-out-of-range`), and a transition may not exceed either neighbour.
  Therefore **every command that changes which scene is last must also clear the
  new tail's `transitionOut`** — reorder and delete included. The spike repairs
  the tail explicitly; silently dropping the fade would be worse than reporting
  it.
- **A tail change is not length-neutral.** Moving the old tail elsewhere removes
  its neighbouring fade from the overlap sum. In the short fixture the same
  reorder that keeps 483 frames when it moves a middle scene produces 495 when it
  moves the tail, and that is correct.
- **Modes:** `duration.mode = "flexible"` grows scenes to fit speech and reports a
  90 s (2700-frame) advisory over the cap — it never speeds up or cuts speech.
  `duration.mode = "target"` grows scenes toward `targetFrames` and reports
  `target.deviationFrames`; any non-zero deviation **requires explicit user
  acceptance** before export. The 190 s fixture is `target: 5700` with zero
  deviation.
- **Media clips are retimed, not re-timed in place.** A 24 fps source in a 30 fps
  project gets `plates[].speed = 1.25`; the source is untouched.
- **Captions** are scene-local in source data and projected to absolute frames.
  Measured chunks produce exact cues (and `words` when the aligner ran);
  otherwise sentences are distributed by character weight and flagged
  `estimated: true`, with a warning. Correcting caption text must not change
  speech; revising the script invalidates that scene's take and alignment.

### 3.2 Override precedence (the single table the UI obeys)

From strongest to weakest:

| # | Source | Effect | Where it lives |
|---|---|---|---|
| 1 | Measured narration chunks | Floor on duration; exact caption cues | `audio/durations.json` sidecar → `CompileOptions.narration` |
| 2 | `scene.preferredFrames` | Pacing preference, clamped by 3 and 4 | package |
| 3 | `layout.min` | Hard floor | compiler constant |
| 4 | `layout.max` | Ceiling on pacing only, lifted by 1 | compiler constant |
| 5 | `duration.targetFrames` | Grow-only target in `target` mode | package |
| 6 | `transitionOut.frames` | Shortens the total; validates against neighbours | package |

Explicitly **not** an override in Phase 1/2: `narration_duration_frames`. It is a
hint consumed by `packages/jobs` for the a2v conditioning window, not a timing
input to the planner. Do not let an editor write it and expect the timeline to
move.

### 3.3 Schema decisions

- **No new schema fields in Phases 1 and 2.** Reorder uses scene array order;
  trim uses `preferredFrames`; delete removes the scene; transitions stay
  `transitionOut`. These already express everything in the Phase 1/2 gate.
- **Source trims, split and per-lane movement (Phase 3) need a versioned change:**
  `scene.media.source = { in_seconds, out_seconds, source_fps }` with a
  schema bump, generated `types.ts`, and a compatibility test for legacy
  packages. Do not smuggle them into `data` or `copy`.
- **UI-only preferences** (zoom, panel sizes, last selection, audition mute) go in
  a versioned sidecar after the package, never into the package, because they
  must not change `timeline.hash`.
- Anything that changes frames is schema-validated, exported, and included in the
  hash.

### 3.4 Compile/API contract for CA-1

```text
POST /api/projects/:id/compile
  → { package, revision, editSequence }
  ← { timeline, revision, editSequence, inputHash }
```

- The server compiles with the package's own measured sidecar; the client never
  passes narration it invented.
- The client **discards any response whose `editSequence` is older than the
  document it currently holds**, and any response whose `revision` is not the one
  it sent.
- Every response echoes `inputHash` (the compiler's `sourceHash`), so a preview
  can be proven to match an export.
- The browser must not import the planner's hashing path (`node:crypto`). Phase 1
  uses the authenticated debounced route; the browser-safe core in a worker is a
  later optimisation, not a second implementation.
- Commands are the only mutation path, agent edits included, and an agent edit is
  one undoable batch:

| Command | Payload | Invariants |
|---|---|---|
| `MoveScene` | `{ id, beforeId \| null }` | stable ids; repairs tail transition; length may change |
| `TrimScene` | `{ id, frames }` | preference only; reports `effective` and `floored` |
| `DeleteScene` | `{ id }` | closes the gap; repairs tail; retires captions with the scene |
| `DuplicateScene` | `{ id, newId }` | new stable id; shared media reused, not copied |
| `SetSceneCopy` | `{ id, copy }` | recompiles the scene; keeps voice and media |
| `SetCaptionText` | `{ sceneId, index, text }` | caption only; never rewrites `scene.narration` |

- **Undo is document snapshots or inverse patches — never arithmetic on frames.**
  The spike's undo pops the previous package and the timeline hash comes back
  identical, which is the property that makes "undo then export" safe.
- **`preview` and `export` must consume the same props.** Extract the composition
  from `Root.tsx` including narration, captions and the audio mix; media URL
  resolution stays an environment adapter.

---

## 4. Fixtures

`apps/web/test/fixtures/editor/` (JSON only — no binary media is committed; the
declared files are placeholders, so the renderer draws its labelled placeholder
panels).

| Fixture | What it is | Shapes it exercises |
|---|---|---|
| `short/` | 3 scenes, 1280×720, 483 frames (16.1 s) | narration-linked trim floor, a 24 fps plate, two sentences in one scene, a middle scene move, delete |
| `hermes-190s/` | 12 chapters, 1920×1080, exactly **5700 frames (190.000 s)** | `duration.mode="target"` with zero deviation, 11 fades with 15-frame overlaps, 24 captions, presenter PiP + bookends, music bed with ducking, `a_presenter` and `a_plate` at 24 fps, a chart and a stat scene with a dataset, a code scene, a split and a compare scene |

Both are regenerated deterministically and validated with
`validatePackage` before use, so a fixture cannot drift into an invalid package.

Loading them (exactly what the spike and CA-1 should do):

```js
const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
const durations = JSON.parse(readFileSync(`${dir}/audio/durations.json`, 'utf8'));
const narration = Object.fromEntries(Object.entries(durations.scenes)
  .map(([id, s]) => [id, s.chunks.map(c => ({ text: c.text, seconds: c.seconds }))]));
compileTimeline(pkg, {
  narration,
  narrationGapSeconds: durations.gapSeconds,
  narrationPaddingSeconds: durations.paddingSeconds,
});
```

`apps/web` `pnpm test` builds `packages/planner` first, because the fixture tests
import the compiled compiler rather than reimplementing timing.

### Invariants the spike proves (Phase 0 gate)

`apps/web/test/editor-phase0.test.mjs`, 11 tests:

1. the short fixture compiles to integer frames and every caption lies inside its
   own scene;
2. moving a middle scene preserves the total, the per-scene caption text and the
   timeline hash changes;
3. moving the tail clears its fade, so the overlap sum changes (495 frames) and
   the command does not throw (`transition-out-of-range`);
4. a trim below measured speech is floored to the speech, not the request;
5. a trim above speech and above the layout floor is honoured exactly;
6. a tiny preference on a silent scene floors at `layout.min`;
7. delete closes the gap, retires that scene's captions and keeps the tail valid;
8. undo restores the identical timeline hash all the way back;
9. the 190 s fixture is 5700 frames, 24 captions, zero warnings, zero target
   deviation, with the 24 fps plate retimed to 1.25×;
10. reordering two chapters of the 190 s project keeps it exactly 190 s and the
    moved chapter keeps its own captions;
11. zoom and playhead mapping round-trips to the same integer frame at three
    scales.

---

## 5. Open decisions and risks

- **Remotion paid Timeline** stays unbought and unrecommended; if Phase 2 drag
  polish overruns, re-evaluate with a licence quote rather than a demo.
- **`node:crypto` in the planner** blocks a browser-only compile. Phase 1's
  authenticated compile route is the answer; a worker port is an optimisation.
- **Authenticated media in native `<video>`/`<audio>`** cannot send `apiFetch`
  headers. Phase 1 needs a per-project media token or a signed URL strategy that
  keeps credentials out of exported files.
- **24/25/30 fps** must appear in the timing tests (the fixtures ship 24 fps media
  in a 30 fps project); a 25 fps project is not yet covered anywhere.
- **`flexible` over the 90 s cap** is an advisory, not an error. The UI must show
  it and must not "fix" it by trimming speech.
