# Comfyrizz explainer: full-pipeline test

Run date: 2026-10-19. GPU-run code: `43e885d` (on main merge `dc822e3`).

## Result

A fresh DeepSeek v4.1 Flash conversation produced a four-scene Comfyrizz
storyboard. Kokoro synthesized measured narration on the CPU; six real G4
jobs generated two illustrations, a synthetic portrait, an LTX background,
an upscale, and an audio-driven presenter. Remotion rendered the composition.

- Package: `pkg_a4817e3a739342308a68fd5779ce9892`
- Output: 876 frames, 29.2 seconds, H.264 1920×1080 at 30 fps; AAC stereo 48 kHz.
- MP4: 9,866,504 bytes; ten sentence caption cues and word-level VTT.
- Narration-envelope correlation against the measured source: 0.999949.
- Presenter frame samples show mouth movement and blinks, with an AI PRESENTER label.
- Six of six GPU jobs succeeded. Total run including CPU render: 7.74 minutes.
- Balance: 369.57 → 368.50 compute units (**1.07 units spent**).
- User authorization: 20 units cumulative; first-run ceiling: 3 units.
- Teardown verified: no active sessions, zero assignments, zero usage rate.
- Protected token staging was cleaned after the run.

Local artifacts are under
`~/comfyrizz-gpu-tests/comfyrizz-20261019-174606/gpu-run-01/`.
The test deployment serves the player at
`https://mail.tailec998.ts.net:8451/comfyrizz-test/index.html`.
These are deployment artifacts, not committed fixtures.

## Verification and limitations

Before allocation: workspace builds/tests, Python tests, web/renderer
typechecks, GPU harness tests, the 43-check dry run, and an exact-package fake
run passed. The fake run preserves real narration and substitutes only generated
job outputs. Both gated model repositories were checked before allocation.

After collection: ffprobe verified output codecs/frame count and source media
dimensions; audio measurements verified narration in the mix; contact sheets
were inspected for framing and presenter motion. Archive verification checks
each declared base/variant media path and its SHA-256 against the actual ZIP.

The upscale source is **1920×1024**, despite the planner requesting 1920×1080.
The other generated dimensions match their plans. The renderer probes the
actual source size and fits it into the correct 1920×1080 composition. This
reproduces the existing G6-14b geometry mismatch; the planner/workflow geometry
is not fixed by this test.

Changing mouth shapes demonstrate animation, not measured phoneme-level
lip-sync. The music bed is deliberately quiet; narration/pause measurements
do not by themselves prove subjective ducking quality. No independent
audio-visual playback assessment was completed.

## Fixes discovered during the test

1. Agent FLUX assets carried FLUX.1-schnell/Apache metadata despite planning
   FLUX 3 Klein. Model-license metadata now names the actual model and license.
2. The GPU harness only accepted its built-in package and overwrote ready
   narration in fake mode. `--package` now stages prepared inputs; fake media
   replacement is limited to generated job assets.
3. The export archive renamed `audio/...` files to `assets/...` without
   updating project references and omitted declared upscale variants. The
   archive now preserves safe relative paths, records fallback paths, includes
   variant bytes under the parent asset's rights, checks variant hashes, and
   reports missing variants as incomplete. Regression tests cover extraction,
   missing/corrupt variants, blocked parent assets, and unsafe paths.

No additional GPU run was needed for the archive correction.

## Follow-up: longer Hermes example

The subsequent [Hermes production test](HERMES_VIDEO_STATUS.md) uses Qwen3-TTS
and a longer, more animated storyboard. Investigation of this earlier presenter
found missing frozen-audio conditioning and playback-clock/speed issues. Those
code fixes and their evidence are documented in the
[presenter research notes](HERMES_VIDEO_RESEARCH.md#presenter-synchronization).
The old video's sampled mouth movement should not be read as a lip-sync pass.
