# Phase 0 decisions

Pi's Phase 0 note was not in the tree. These decisions are the ones CA-1 is built on.
Later phases should follow them. The EditorStore method list in `apps/web/src/editor/store.ts`
is the CA-2 / CA-3 contract; do not change those signatures without saying why in the PR.

## Timeline component: build

Phase 2 draws a **custom scene timeline** on top of `EditorStore`. It does not adopt
Remotion's paid Timeline, and it does not adopt `@xzdarcy/react-timeline-editor`.

- The paid Timeline needs a purchase this repo does not have, and it would become a second project model.
- The MIT timeline component measures time in its own units. Integer project frames, narration floors, and scene locks would all be adapters. It was not runtime-tested here.
- Commands stay independent of the view. This phase ships no timeline UI. CA-2 renders ruler, selection, reorder, and trim by calling `preview`, `dispatch`, `undo`, and `setSession`.

## Timing and trim

Positions and durations in the compiled timeline are **integer project frames** at `floor(format.fps)` (default 30). Source media keeps its own fps, frame count, and sample rate. `SetMediaRange` writes source seconds on the existing schema trim (`background.trim` or `media[i].trim`). Derived `mediaRanges` adds integer source frames: `round(seconds × asset.media.fps)`.

`preferredFrames` is a preference. `TrimScene` writes that integer and nothing else.

| Situation | Lower bound | Command |
|---|---|---|
| Measured narration for the scene | Frames of chunk seconds + gaps + padding (`ceil` of seconds × fps). Layout max grows so speech is not cut. | Reject with `below-speech-floor`. Do not change `scene.narration`. The inspector should offer a script revision. |
| No measured narration | Layout minimum (`LAYOUT_LIMITS`) | Reject with `below-layout-min`. |

The compiler can still make the scene longer than `preferredFrames` (layout minimum, measured speech, target mode). The effective duration is `derived.timeline`. During a drag, `preview(TrimScene)` shows that duration; `cancelPreview()` drops it; one `dispatch` on release commits a single undo step. Undo while a preview is active cancels the preview only.

`toIndex` on `MoveScene` is the scene's index in the list **after** it is removed (also its final index). `DuplicateScene` inserts the copy after the source, keeps shared asset ids, and allocates `s…_2`, `s…_3`, … Locked scenes reject move, trim, duplicate, delete, and media range. Copy and caption edits stay available. Delete refuses the last scene.

`SetCaptionText` stores `{ sceneId, index, text }` on the editor sidecar. It does not change `scene.narration`, so the voice take stays valid. `text: null` removes the override. Compile copies the text onto the cue and leaves cue frames alone.

`dispatch([cmd, cmd])` is one undo step and is atomic. That is the agent batch boundary. Undo restores `package` and `editor` and the selection. `editSequence` only increases (including on undo and redo); it is the save/compile cursor, not part of the document patch.

## Editor sidecar (not a schema change)

Caption overrides and other editor metadata live in a versioned sidecar, `editor` version 1:

```json
{ "version": 1, "captionOverrides": [{ "sceneId": "s1", "index": 0, "text": "…" }] }
```

They are not fields on `package-v1`. Legacy packages keep validating, and `unevaluatedProperties` stays strict. The sidecar is render-affecting: it is included in `compileInputHash`, checked by the editor and by `PATCH` before it is written, stored beside the package, and returned on `GET` when present. A schema revision can absorb it later; until then this sidecar is the source of those edits.

## Fixtures

`apps/web/test/fixtures/editor/`

| File | Role |
|---|---|
| `short.json` | Three scenes, one overlap. The small parity case. |
| `hermes-standin.json` | 12 scenes, 5700 frames (190 s at 30 fps). No media binaries. |
| `fps-media.json` | Plates at 24, 25, and 30 fps inside a 30 fps project. |
| `narration.json` + `narration-durations.json` | Measured chunks, padding, and word alignment. |

## Compile and media

`POST /api/compile` is authenticated with the same token as the rest of `/api`. The body is the project document (or a package), measured durations, `revision`, and `editSequence`. The response echoes `revision`, `editSequence`, and `inputHash`, plus the timeline. The browser debounces (`createCompileClient`) and drops a response whose generation was superseded or whose `editSequence` is older than one already applied. `applyCompileResult` also requires the input hash to match the visible document.

Measured `audio/durations.json` is loaded through `measuredFromReport` on every server compile that has a package directory (export, render, edit diff, scene assets, agent response). Callers that already pass narration options keep that override.

Preview and MP4 render share `resolvePackageComposition` / `PackageComposition` (narration, measured captions, audio mix). Media URLs are an adapter: export and the bundled player use Remotion `staticFile`. A server-backed preview may pass `mediaAuth` and gets `/api/package/:id/media?path=&token=`, served with the existing byte-range helper. The token is the local session token (media elements cannot set headers). It is not written into export props.

## Save

Autosave is serialized and debounced. `saveStatus()` is `saved`, `pending`, `offline`, or `conflict`. The status line is in the shell (`#save-status`, `role="status"`). A save echoes the `editSequence` it accepted; an older acknowledgement does not mark newer edits saved. A failed attempt does not retry that same sequence: status publishes are not new edits. A newer edit schedules another attempt. IndexedDB (memory in tests) keeps a draft and, on revision conflict, a recovery copy. The local document is not replaced, and further edits stay in conflict until the user resolves it.
