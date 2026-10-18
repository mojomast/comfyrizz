# `@comfyrizz/tts` — Kokoro CPU narration and sentence captions

Owner: **Pi** (WS-A, task A4). Spec §6.8/§6.9.

This package turns the package's `scenes[].narration` text into measured speech,
then feeds those measurements into the A2 timeline compiler. There are no
fabricated word timestamps: Kokoro synthesises one sentence at a time, and each
caption cue is the measured chunk duration plus the fixed gaps.

## Pipeline

```
package.json (narration text per scene)
   │  py/synth.py  (Kokoro-82M ONNX, CPU)
   ▼
audio/narration/<scene>.wav + audio/durations.json   # measured seconds, not estimates
   │  scripts/narrate.mjs
   │    ├─ compileTimeline(package, measured chunks)   # packages/planner (A2)
   │    ├─ place each scene wav at timeline.scene.from
   │    ├─ trim the transition overlap from each non-final scene
   │    ├─ ffmpeg loudnorm I=-16 LUFS / TP=-1 dBTP
   │    └─ write captions.srt + captions.vtt from the same cues
   ▼
examples/narrated-demo/timeline.json, captions.srt, captions.vtt, narration-report.json
```

`narration.raw.wav` is the aligned pre-normalisation mix; `narration.norm.wav`
is the graded track used by the example. Per-scene WAVs stay for debugging.

## Pinned CPU stack

| Component | Pin | Notes |
|---|---|---|
| `kokoro-onnx` | **0.4.9** | wrapper; pinned in `py/requirements.txt` |
| `onnxruntime` | CPU build from the wheel | no CUDA extras are installed |
| `kokoro-v1.0.onnx` | sha256 `7d5df8ec…36a6c5` | 311 MiB; **not committed** |
| `voices-v1.0.bin` | sha256 `bca610b8…fbf7d` | 27 MiB; **not committed** |
| phonemizer | `phonemizer-fork` (dependency) | espeak-ng data via `espeakng-loader` |
| voice | `af_heart`, speed 1.0, language `en-us` | recorded in `durations.json` and the audio asset; `voice.language` picks the phonemiser, so French/GB voices are not read as US English |

Fetch the weights into a local cache (outside Git):

```bash
packages/tts/scripts/fetch-models.sh
# or: KOKORO_MODEL_DIR=/path packages/tts/scripts/fetch-models.sh
```

The weights are Apache-2.0 (Kokoro-82M model card; marked **[unverified]** in
the spec until a licence review). Keep the wrapper, voices and phonemizer
notices with any redistribution. Output narration is synthetic; the example's
audio asset records `model_license.id = Apache-2.0`.

A small pronunciation map (`py/pronounce.py`) covers product names and acronyms
(Comfyrizz, Kokoro, SVG, CPU, GPU, LLM, LUFS, dBTP, LTX). It changes only the
synthesised text; captions keep the original spelling.

## Commands

```bash
# one-time
python3 -m venv .venv && .venv/bin/pip install -r packages/tts/py/requirements.txt
packages/tts/scripts/fetch-models.sh

# narration + compiled timeline + captions
.venv/bin/python packages/tts/py/synth.py \
  --package examples/narrated-demo/package.json \
  --out examples/narrated-demo/audio --padding 0.5
npm --prefix packages/tts run build
node packages/tts/scripts/narrate.mjs --example examples/narrated-demo

# checks
npm --prefix packages/tts test          # 11 tests (unit + narrated acceptance)
.venv/bin/python -m pytest packages/tts/py -q   # pronunciation map + voice.language mapping
cd apps/renderer && npm run render:narrated
```

`narrate.mjs` adds `assets.a_narration` and points every narrated scene at it
(`narration_asset` + measured `narration_duration_frames`), so package
validation reports no `WARN_ASSET_UNUSED`. `scripts/fetch-models.sh` is
executable and can be run directly.

`--padding 0.5` matches the 15-frame fade at 30 fps. It guarantees the previous
scene's speech ends exactly when the next scene starts; the mix trims that
overlap rather than letting two sentences collide.

## Recorded evidence (narrated demo)

| Check | Result |
|---|---|
| Synthesis | 6 scenes, 14 sentence chunks, voice `af_heart`, speed 1.0, CPU |
| Audio | 24 kHz mono PCM s16le, 43.733 s, exactly the timeline duration |
| Timeline | **1312 frames @ 30 fps = 43.733 s**, hash `4943e204…19c9`, not provisional |
| Captions | 14 cues; SRT and VTT exported from the same cues; on-screen overlay in `NarratedDemo` |
| Loudness | `loudnorm` output **−16.27 LUFS**, true peak **−1.0 dBTP**; source −22.27 LUFS |
| MP4 | 1920×1080 H.264 + AAC 48 kHz stereo, 1312 frames, 43.733 s |
| CPU render | 96.4 s (~2.2× realtime, concurrency 2) |
| Tests | 11/11 pass (`packages/tts`) |
