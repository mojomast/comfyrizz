# Hermes release video: production status and verification

Checkpoint: **2026-10-19, after Qwen alignment and the full fake render, while
graphics run 01 is executing**. Branch: `feat/hermes-qwen-video`.

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

The new presenter clips must still be collected and evaluated. The local
diagnostic uses an absolute offset limit of **80 ms** and minimum confidence
**3**; these are this test's gates, not universal perceptual-quality thresholds.
Face-crop inspection and paired playback remain important. The desktop browser
was disconnected at this checkpoint, so browser playback has not been verified.

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
| Graphics 01 | Pending | Pending | G4; 5-unit ceiling, 30-minute watchdog |

**Completed spend: 2.00 units; 18.00 units remained before graphics 01.** Its
unsettled spend is not included in that figure. The account balance is the
authority for cumulative usage. The completed Qwen runs each verified no active
assignments and zero usage rate after teardown; graphics 01 is still active at
this checkpoint.

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

Collect all real graphics, settle the compute ledger and verify teardown;
evaluate both corrected presenter clips; render and inspect the real MP4;
check final audio/media geometry and exported archive paths/hashes; publish
the player, MP4 and editable bundle, then update this report with those results.
