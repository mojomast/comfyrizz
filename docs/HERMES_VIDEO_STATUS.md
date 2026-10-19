# Hermes release video: production status and verification

Checkpoint: **2026-10-19, after graphics run 01 and the corrected-presenter
SyncNet diagnostics**. Branch: `feat/hermes-qwen-video`.

## Deliverable

The researched explainer covers Hermes Agent **v0.22.0** (October 13) and its
latest stable corrective patch **v0.22.2** (October 15). The primary sources,
editorial distinctions and implementation choices are in
[Hermes video research](HERMES_VIDEO_RESEARCH.md).

- Package: `pkg_022440be98a344d6a79531eb08b03e50`.
- Script: 12 scenes, 504 spoken words, initially drafted with OpenCode Go /
  `deepseek-v4.1-flash`, then fact-checked and edited.
- Compiled timeline: **5,700 frames at 30 fps = 190 seconds (3:10)**.
- Voice: **Qwen3-TTS 1.7B**, one VoiceDesign reference reused by Base cloning.
- Captions: **41 sentence cues**, all backed by Qwen3-ForcedAligner timing.
- Planned GPU media: six FLUX stills, six two-stage LTX moving sequences and
  two labeled, audio-driven presenter bookends — 14 jobs total.
- Motion graphics: editable flow/hub diagrams, active-card and connection
  animation, count-up statistics, code typing and scene transitions.

The opening take is available on the test deployment:
[Qwen narration preview](https://mail.tailec998.ts.net:8451/hermes-release/narration-preview.wav).
The final graphics-backed MP4 and bundle are **pending** at this checkpoint.
The successful fake-render MP4 uses placeholder visual media and is not the
finished deliverable.

## Verified results

| Check | Evidence |
|---|---|
| Actual voice engine | `audio/durations.json` records `qwen3-tts`, Base model and VoiceDesign model; no Kokoro fallback |
| Voice consistency setup | One reference WAV plus its text/persona saved; the same clone prompt used across the 12 takes |
| Caption alignment | All 41 chunks record `timing: aligner`; scene-level raw alignment tokens retained |
| ASR QA | Per-scene transcripts and WER flags retained; number/acronym formatting can raise WER without a spoken omission |
| Narration preservation | Every compiled scene fits its measured take; a planner regression covers speech longer than a stat-layout cap |
| Presenter playback | A real rendered color-frame test verifies native speed and a later scene's local clock |
| Workflow conditioning | Tests require the original encoded audio with a zero noise mask in both LTX sampling stages |
| Fake pipeline | All 14 fake jobs collected/applied; a complete 5,700-frame CPU render succeeded |
| Real graphics | All 14 jobs succeeded; 42 files collected/applied; staged token removed; runtime stopped |
| Regression checks | Workspace suites, Python pipeline tests, renderer/web typechecks and the GPU dry run pass |
| Editable export | Targeted export tests cover duration/take sidecars, path confinement and existing variant inclusion |
| Browser seeking | Tailscale HTTP GET with `Range: bytes=0-1023` returns `206`, correct content range and exactly 1,024 bytes |

The forced-aligner integration initially rejected valid output because of
trailing silence and split compound words. The corrected adapter preserves
leading silence, merges exact normalized word matches and holds the final
caption over trailing silence. A separate QA-only GPU run verified the fix on
all recorded takes without generating another voice.

## Presenter quality checkpoint

The previous Comfyrizz presenter was evaluated against its original narration:
SyncNet confidence **0.864**, minimum mean distance **15.483**. The reported
offset was 14 frames at 25 fps (560 ms), but confidence is too low to treat that
as a reliable correction. This is a failed diagnostic, not evidence of sync.

The evaluator was also calibrated on SyncNet's official `example.avi`: it
returned the expected **3-frame offset**, with confidence **10.081** versus
the upstream approximate reference of 10.021.

The original new presenter clips measured −120 ms / confidence **9.637** (opening)
and −160 ms / confidence **9.973** (closing). Both missed the local offset gate.
CPU-only correction candidates add 3 and 4 initial held frames respectively at
24 fps (125 ms and 166.7 ms), retaining the original frame counts and unmodified
narration. Both candidates measure **0 ms** after correction, with confidence
**9.292** and **9.818**. The original clips remain preserved; the candidates have
not yet been applied to the final package.

Reports are in `graphics-run-01/sync-s1/`, `sync-s12/`, `sync-corrected-s1/` and
`sync-corrected-s12/`. Candidate files are `a_presenter_s1-synced.mp4` and
`a_presenter_s12-synced.mp4` in the graphics output root.

The local diagnostic uses an absolute offset limit of **80 ms** and minimum
confidence **3**; these are this test's gates, not universal perceptual-quality
thresholds. Face-crop inspection, end-frame review (the correction trims the tail)
and paired playback remain pending. The desktop browser was disconnected, so
browser playback has not been verified.

## Compute ledger

Authorization: **20 Google Colab compute units cumulative**, including the
previous delivered Comfyrizz video. Balance before that first video: **369.57**.

| Run | Balance before → after | Units | Result |
|---|---|---:|---|
| Previous Comfyrizz video | 369.57 → 368.50 | 1.07 | Delivered; runtime stopped |
| Qwen setup 01 | 368.50 → 368.50 | 0.00 reported | Missing venv support; stopped |
| Qwen setup 02 | 368.50 → 368.50 | 0.00 reported | Kernel Python and apt venv versions differed; stopped |
| Qwen synthesis 03 | 368.50 → 367.77 | 0.73 | Synthesis and QA completed; stopped |
| Qwen alignment 04 | 367.77 → 367.57 | 0.20 | Corrected alignment verified; stopped |
| Graphics 01 | 367.57 → 365.95 | 1.62 | 14/14 jobs succeeded; runtime stopped |

**Completed spend: 3.62 units; 16.38 units remain authorized.** The account
balance is the authority for cumulative usage. After graphics 01, `colab usage`
reported balance **365.95**, **0.00 units/hour** and **0 active assignments**;
`colab sessions` reported no active sessions. The staged token file was removed.

## Reproduction and artifacts

1. Configure strict Qwen voice selection using the
   [TTS setup guide](../packages/tts/README.md#optional-qwen3-tts-r3).
2. Run the Qwen upload dry run, then the authorized synthesis job. Extract its
   `audio.zip` beside `package.json` and run `packages/tts/scripts/narrate.mjs`.
3. If alignment/ASR needs another pass, use `--qa-only` with a fresh output
   directory; extract the result and compile narration again.
4. Finalize scene timing, then cut presenter input from the exact final narrator
   track at each scene's origin. Pad only to the LTX frame lattice.
5. Validate the package and run `scripts/gpu6/g6_run.mjs --fake --package ...`.
6. Run authorized graphics with `--no-render`, then verify GPU teardown before
   CPU composition, SyncNet/media review and export.

This host's retained artifacts are under
`~/comfyrizz-gpu-tests/hermes-20261019/`: `package/`, `qwen-run-01/` through
`qwen-run-03/`, `qwen-align-04/`, `fake-run-02/`, `graphics-run-01/`,
`sync-baseline/` and `sync-calibration.json`.

These runtime artifacts and model weights are not repository fixtures. The
model revision pins are committed in `colab/qwen-models.lock.json`; the setup,
QA, renderer fixes and regression tests are committed on the feature branch.

## Next checks

Visually review and apply the corrected presenter candidates; render and inspect the real MP4;
check final audio/media geometry and exported archive paths/hashes; publish
the player, MP4 and editable bundle, then update this report with those results.
