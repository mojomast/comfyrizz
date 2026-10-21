# Phase 0 decisions

One note, reconciled from CA-1 and Pi's `q/editor-phase0` (`03b428d`). The EditorStore method list in `apps/web/src/editor/store.ts` is the CA-2 / CA-3 contract. Do not change those signatures without saying why in the PR. `Result` may also carry `effective` and `floored` after a single `TrimScene`.

## Reconciled points

| Point | Choice |
|---|---|
| Trim below speech or `layout.min` | **Pi's clamping** (Kyle). The request is accepted as `preferredFrames`. The compiler floors the duration. The result reports `effective` and `floored: true`. There is no `below-speech-floor` or `below-layout-min` rejection. Narration text is not changed. |
| Last-scene transition | **Pi.** Reorder and delete clear the new last scene's outgoing transition (`cut`, 0 frames) so the compiler does not throw `transition-out-of-range`. Duplicate and split do the same. |
| Project fps | **`floor(format.fps)`**. Non-finite or non-positive rates fall back to 30. Source media keeps its own fps. |
| `SetMediaRange` | **CA-1.** Source seconds on the existing schema trim (`background.trim` or `media[i].trim`). Not a new `scene.media.source` field. |
| Caption overrides | **CA-1.** Editor sidecar version 1, included in `compileInputHash`. They do not change `scene.narration`. |
| Fixtures | **CA-1 flat files stay.** Pi's `short/` and `hermes-190s/` directories and `editor-phase0.test.mjs` are added beside them. |
| Compile route | **CA-1 `POST /api/compile`.** Not `POST /api/projects/:id/compile`. |
| `MoveScene` | **CA-1 `toIndex`.** The index after the scene is removed, which is also its final index. Not `beforeId`. |
| Timeline component | **Custom scene timeline.** Not Remotion's paid Timeline, and not `@xzdarcy/react-timeline-editor`. |
| Undo | **CA-1 document patch** of `package` and `editor`. `editSequence` only increases, including on undo and redo. |

## Timeline component

Phase 2 draws a custom scene timeline on `EditorStore`. Commands stay independent of the view. The timeline calls `preview`, `dispatch`, `undo`, and `setSession`.

- The paid Timeline needs a purchase this repo does not have, and it would become a second project model.
- The MIT timeline component measures time in its own units. Integer project frames and narration floors would all be adapters.

Scenes are the edit unit. Narration, captions, presenter, and music lanes are read-only projections. One selection model is `selectedSceneIds`. The playhead is session state (`playheadFrame`) and does not recompile by itself. The drawn length of a scene is `derived.timeline` (`durationInFrames`), never a preference the compiler did not produce.

## Timing and trim

Positions and durations in the compiled timeline are integer project frames at `floor(format.fps)` (default 30).

```text
narrationFrames = ceil((Σ chunk.seconds + gap·(chunks−1) + padding) · fps)
duration       = clamp(max(preferredFrames, narrationFrames or layout.min), layout.min, max(layout.max, narrationFrames))
total          = Σ duration − Σ transitionOut(every scene but the last)
```

Default gap is 0.15 s and padding is 0.25 s unless the measured sidecar says otherwise. `layout.max` caps preferred pacing only. Measured speech can exceed it. `narration_duration_frames` is not a planner input.

`TrimScene` writes the requested integer and nothing else. A request below the speech floor or `layout.min` still succeeds. `dispatch` of that one command returns `effective` (the compiled scene length) and `floored: true` when that length is longer than the request. The timeline says so in its status line (`Requested N, effective M (floored…)`). A drag may still cap at a known source end or layout maximum before it dispatches. `preview(TrimScene)` shows the compiled duration and does not commit. `cancelPreview()` drops it. Undo while a preview is active cancels the preview only.

`toIndex` on `MoveScene` is the scene's index after it is removed. `DuplicateScene` inserts the copy after the source, keeps shared asset ids, and allocates `s…_2`, `s…_3`, …. Locked scenes reject move, trim, duplicate, delete, media range, transition, and split. Copy and caption edits stay available. Delete refuses the last scene.

Reorder, delete, duplicate, and split clear an outgoing transition that would sit on the new last scene.

`SetCaptionText` stores `{ sceneId, index, text }` on the editor sidecar. `text: null` removes the override. Compile copies the text onto the cue and leaves cue frames alone.

`dispatch([cmd, cmd])` is one undo step and is atomic. Undo restores `package`, `editor`, and the selection.

The timeline and the script panel call this store. Extra commands, with the same undo patch:

- `SetTransition` rejects a last-scene outgoing transition and a length outside 0–120 frames.
- `SplitScene` cuts a sidecar narration take at a project frame and keeps playback rate 1.
- `SetNarrationText` and `SetVoice` change the package fields the freshness check reads. Caption overrides for that scene are cleared on a narration edit. They are not speech.

Takes, alignment, and presenter clips stay on editor sidecar version 1, beside `captionOverrides`. Undo does not rewind `editSequence`, so the save line stays pending until that new sequence is acknowledged.

## Editor sidecar (not a schema change)

```json
{ "version": 1, "captionOverrides": [{ "sceneId": "s1", "index": 0, "text": "…" }] }
```

Takes, alignment, and presenter clips may sit beside `captionOverrides` when they are plain objects. None of these are fields on `package-v1`. Legacy packages keep validating, and `unevaluatedProperties` stays strict. Caption overrides are render-affecting: they are included in `compileInputHash`, checked by the editor and by `PATCH` before they are written, stored beside the package, and returned on `GET` when present.

## Fixtures

Flat CA-1 files in `apps/web/test/fixtures/editor/`:

| File | Role |
|---|---|
| `short.json` | Three scenes, one overlap. The small parity case. |
| `hermes-standin.json` | 12 scenes, 5700 frames (190 s at 30 fps). No media binaries. |
| `fps-media.json` | Plates at 24, 25, and 30 fps inside a 30 fps project. |
| `narration.json` + `narration-durations.json` | Measured chunks, padding, and word alignment. |

Pi's directory fixtures, checked by `apps/web/test/editor-phase0.test.mjs` against the real compiler:

| Directory | Role |
|---|---|
| `short/` | 3 scenes, 483 frames. Narration floor, a 24 fps plate, reorder, delete. |
| `hermes-190s/` | 12 chapters, exactly 5700 frames. Target mode, fades, presenter, music. |

`node build.mjs` in that directory regenerates Pi's two packages and validates them. No binary media is committed.

## Compile and media

`POST /api/compile` is authenticated with the same token as the rest of `/api`. The body is the project document (or a package), measured durations, `revision`, and `editSequence`. The response echoes `revision`, `editSequence`, and `inputHash`, plus the timeline. The browser debounces (`createCompileClient`) and drops a response whose generation was superseded or whose `editSequence` is older than one already applied. `applyCompileResult` also requires the input hash to match the visible document.

Measured `audio/durations.json` is loaded through `measuredFromReport` on every server compile that has a package directory. Callers that already pass narration options keep that override.

Preview and MP4 render share `resolvePackageComposition` / `PackageComposition`. Media URLs are an adapter: export and the bundled player use Remotion `staticFile`. A server-backed preview may pass `mediaSources` containing pre-resolved blob URLs or short-lived `/api/media/<ticket>` URLs. Mint tickets or fetch package media using header authentication; the session token is never put in a media URL. Preview source maps are not written into export props.

## Save

Autosave is serialized and debounced. `saveStatus()` is `saved`, `pending`, `offline`, `conflict`, or `rejected`. The status line is in the shell (`#save-status`, `role="status"`), and the same text is on the timeline and the script panel. A save echoes the `editSequence` it accepted. An older acknowledgement does not mark newer edits saved. A failed attempt does not retry that same sequence. IndexedDB (memory in tests) keeps a draft and, on revision conflict, a recovery copy. The local document is not replaced.

A server 400 or 422 is `rejected`, not an in-progress save. The status line reads `Save rejected: <reason>` (the response error, plus validation details when the server sent them). The edit stays in the local document. A later edit, including undo, has a new `editSequence` and can save. `noteSave({ type: 'rejected', error })` is the additive notice for that; conflict still blocks further saves.

`preferredFrames` below the speech floor or `layout.min` is a valid package value. The schema minimum is 1, and the preference is a scene field, not an editor-sidecar field. The server stores it. The compiler floors the compiled duration. A PATCH of that document is not a 422.
