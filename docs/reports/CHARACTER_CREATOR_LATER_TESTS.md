# CHARACTER-CREATOR-LATER (CCLT) full test report

Date: 2026-10-21
Node: v22.20.0
pnpm: 12.6.0
Platform: Linux x86_64

Checkout: the provided working tree reports branch `master` at commit `1981494`
("base d61c7f8...") with no configured remotes, so the requested
`feat/character-creator-later` / `origin/main 54a8543` ancestry could not be
verified from git metadata. The test run below was made against this checkout
unchanged.

Environment limitations: `ffmpeg` and `ffprobe` are not installed and no
headless Chromium is available to Remotion. Python 3.12.3 is present, but
`pytest` is not installed and the repository `.venv` does not exist, so the
pipeline Python suite was not run.

## Commands

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass after temporarily allowing the `esbuild` build script; pnpm 12 otherwise exits `ERR_PNPM_IGNORED_BUILDS`. The temporary workspace setting was restored; the tree is clean. |
| `pnpm -r build` | Pass (exit 0) |
| `pnpm -r --no-bail test` | Fail overall: 5 of 13 test packages failed |
| `apps/server`: `node --experimental-strip-types --test 'test/references/**/*.test.mjs' 'test/takes/**/*.test.mjs' 'test/characters/**/*.test.mjs'` | Pass: 437 passed, 0 failed, 3 skipped (440 total) |
| `pipeline-py`: `python -m pytest -q` | Not run: no `python` command, no pytest module, no `.venv` |

## Per-package results

| Package | Tests | Pass | Fail | Skipped |
| --- | ---: | ---: | ---: | ---: |
| apps/renderer | 260 | 235 | 24 | 1 |
| apps/server | 228 | 215 | 10 | 3 |
| apps/web | 221 | 221 | 0 | 0 |
| packages/agent | 167 | 166 | 1 | 0 |
| packages/backends | 146 | 133 | 0 | 13 |
| packages/compositions | 15 | 15 | 0 | 0 |
| packages/jobs | 61 | 61 | 0 | 0 |
| packages/llm | 11 | 11 | 0 | 0 |
| packages/planner | 39 | 39 | 0 | 0 |
| packages/schema | 154 | 147 | 1 | 6 |
| packages/sources | 16 | 16 | 0 | 0 |
| packages/tts | 17 | 16 | 1 | 0 |
| packages/vector | 12 | 12 | 0 | 0 |
| **Total** | **1347** | **1287** | **37** | **23** |

The root `comfyrizz` workspace package has no test script and is not counted.
The targeted `apps/server` references/takes/characters run passes independently
of the full `apps/server` suite.

## Failing tests

`Known on main` values: `schema` and `CPU render/export` are the failures named
as known on main. `no` means the failure is not one of those named knowns;
those rows are environmental (missing media/browser tooling) or branch-specific.
For assertion failures the first line is `Expected values to be strictly equal:`;
the observed comparison is appended after it. Temp paths are normalized to
`<tmp>`.

| Package | Test | First error line | Known on main |
| --- | --- | --- | --- |
| apps/renderer | K1: karaoke highlights the spoken word and the highlight moves through the sentence | `remotion render exited 1: s:54:19)` | no |
| apps/renderer | K1: word-pop adds each spoken word to the caption band | `remotion render exited 1: s:54:19)` | no |
| apps/renderer | K1: big-word renders one word at a time and swaps it as the voice moves | `remotion render exited 1: s:54:19)` | no |
| apps/renderer | buildSheet tiles a real clip into a labelled PNG | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | upscaledVariant / preferUpscaledAssets choose only existing media variants | `ffmpeg could not write <tmp>/comfyrizz-a9-WXNTOq/assets/base.png: undefined` | no |
| apps/renderer | preview keeps the working resolution and does not use the variant | `ffmpeg could not write <tmp>/comfyrizz-a9-AQ52S6/assets/base.png: undefined` | no |
| apps/renderer | final render is 1920×1080 and uses the upscaled variant when present | `ffmpeg could not write <tmp>/comfyrizz-a9-2hnmnA/assets/base.png: undefined` | no |
| apps/renderer | analyzeVideo reads every frame and checkVideo clears a moving clip | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | checkVideo flags a static clip and a black first frame | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | checkContrasts flags light copy on a light plate, passes dark copy | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | no narration and no mix leaves the file silent | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | narration + music + SFX are mixed, ducked and normalised to -16 LUFS | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | mixAudio:false keeps only the narration | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | an unchanged incremental export reuses every segment and matches the timeline | `remotion segment s_title exited 1: s:54:19)` | no |
| apps/renderer | split, compare and inset render in 16:9, 9:16 and 1:1, and the code scene types without a black first frame | `ffmpeg -y -hide_banner -loglevel error -f lavfi -i color=c=0xff5a3c:s=512x512 -frames:v 1 <tmp>/comfyrizz-lp2-U3dx75/assets/a_pip.png failed:` | no |
| apps/renderer | the same code frame renders to the same pixels twice | `remotion render exited 1: er.js:54:19)` | no |
| apps/renderer | a fractional-duration loop keeps the bed at its gain on every pass | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | a rendered package with an audio block is mixed and normalised to about -16 LUFS | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | renderPackage renders a placeholder still for showcase-gpu3 without its media (P-fix4) | `remotion render exited 1: er.js:54:19)` | no |
| apps/renderer | a clip with no audio stream is left alone | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | the mix is normalised to about -16 LUFS and the picture is copied | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | G6-11: two-pass linear loudnorm keeps the ducked tail quiet and resamples to 48 kHz | `Expected values to be strictly equal: null !== 0` | no |
| apps/renderer | one-shot and looping background plates preserve the same title layout before the loop boundary | `spawnSync ffmpeg ENOENT` | no |
| apps/renderer | later-scene presenter starts at its own zero and plays speech at native speed | `spawnSync ffmpeg ENOENT` | no |
| apps/server | CPU agent slice -> valid package -> ffprobe-checked MP4 | `remotion render exited 1: s:54:19)` | CPU render/export |
| apps/server | export renders the edited revision to a real CPU MP4 | `{"error":"remotion render exited 1: s:54:19)` | CPU render/export |
| apps/server | X1: scripted model cutdown, CPU render, social pack, and the rights filter | `remotion render exited 1: s:54:19)` | CPU render/export |
| apps/server | a stub-agent one-scene edit re-renders only that scene; a duration edit falls back to a full render | `{"error":"stub segment failed: undefined","renderId":"er_2bee867ec7bc"}` | CPU render/export |
| apps/server | export renders launch-demo into all five bundle files | `{"error":"remotion render exited 1: s:54:19)` | CPU render/export |
| apps/server | a second export reuses the rendered MP4 | `{"error":"remotion render exited 1: s:54:19)` | CPU render/export |
| apps/server | K1: the word-level VTT is only written when a cue carries word timings | `{"error":"remotion render exited 1: s:54:19)` | CPU render/export |
| apps/server | runFrameQa writes a qa.json sidecar and a contact sheet | `error: ''` (empty; stack starts in the ffmpeg helper) | no |
| apps/server | the render path runs the QA gate and serves it from /api/qa | `error: ''` (empty; stack starts in the ffmpeg helper) | no |
| apps/server | a one-scene re-render reuses every other scene segment and keeps the frame count | `{"error":"stub segment failed: undefined","renderId":"sr_b4be93f9d6c5"}` | CPU render/export |
| packages/agent | P-fix5: the committed workflow manifest matches the workflow graphs | `workflows/character_identity_pulid.api.json manifest hash is stale; run node scripts/workflow-manifest.mjs` | no |
| packages/schema | Python and JavaScript agree on new voice settings, including malformed blends | `Expected values to be strictly equal: null !== 0` | schema |
| packages/tts | the normalized narration is 24 kHz mono and matches the timeline duration | `Expected values to be strictly equal: null !== 0` | no |

Remotion messages are stderr tails (the renderer keeps the last 1200 characters),
so the first line can begin mid-stack; the accompanying stack shows
`internalEnsureBrowserUncapped` / `ensure-browser.js`, i.e. Remotion could not
prepare a headless browser. The JSON-wrapped server errors are truncated at
their first escaped newline.

## Known failures on main

- `packages/schema` — `Python and JavaScript agree on new voice settings, including malformed blends` (known schema failure). Here the test spawns `.venv/bin/python`; that interpreter is absent, so the process status is `null` instead of `0`.
- `apps/server` CPU render/export failures (known flake area):
  - `CPU agent slice -> valid package -> ffprobe-checked MP4`
  - `export renders the edited revision to a real CPU MP4`
  - `X1: scripted model cutdown, CPU render, social pack, and the rights filter`
  - `a stub-agent one-scene edit re-renders only that scene; a duration edit falls back to a full render`
  - `export renders launch-demo into all five bundle files`
  - `a second export reuses the rendered MP4`
  - `K1: the word-level VTT is only written when a cue carries word timings`
  - `a one-scene re-render reuses every other scene segment and keeps the frame count`

## Not among the named known failures

- All 24 `apps/renderer` failures are media-tooling failures: `ffmpeg` is absent
  (`ENOENT` or null exit status) or Remotion cannot start a headless browser.
  None reached renderer logic beyond those external tools.
- `apps/server` frame-QA failures (`runFrameQa...`, `the render path runs the QA
  gate...`) fail inside the test's `ffmpeg` helper because `ffmpeg` is absent.
  They are not the named CPU render/export flakes.
- `packages/tts` normalized-narration test runs `ffprobe`; `ffprobe` is absent,
  so the assertion gets a null status.
- `packages/agent` workflow-manifest failure reports
  `workflows/character_identity_pulid.api.json` missing from the manifest
  (`actual: undefined`, expected hash
  `6aac8dea8a7cc77660ecf1820f985d77a2eb1c881173b423d77821216e74be73`). This is
  branch-specific and is not one of the named main failures.

No source or test file was changed. Only this report was added.
