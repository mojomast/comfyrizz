# `@comfyrizz/tts` — Kokoro and Qwen narration with measured captions

Owner: **Pi** (WS-A, task A4). Spec §6.8/§6.9.

This package turns the package's `scenes[].narration` text into measured speech,
then feeds those measurements into the A2 timeline compiler. Sentence captions
stay measured, not estimated: Kokoro synthesises one sentence at a time, and each
caption cue is the measured chunk duration plus the fixed gaps. The optional
Qwen backend synthesises a scene per take; its separate forced-alignment pass
provides sentence and word timing within that take.

K1 adds optional per-word timings inside each measured sentence. `py/synth.py`
writes a `words[]` list (`{text, start, end}`, sentence-relative seconds) next to
each chunk in `audio/durations.json`; a syllable-proportional fallback spreads the
measured sentence over its words, and a real aligner (PyTorch `KPipeline`, R3's
Qwen3-ForcedAligner) can supply exact tokens through `word_timings(text, seconds,
tokens)`. The words are always monotonic, inside the sentence, and sum to the
measured sentence duration (tolerance 0.02 s). A package with no `words` compiles
exactly as before, so the default sentence captions are byte-identical.

## Pipeline

```
package.json (narration text per scene)
   │  py/synth.py  (Kokoro-82M ONNX, CPU; or Qwen3-TTS)
   │  py/qa_qwen.py  (Qwen: separate ASR + forced alignment)
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

## Optional Qwen3-TTS (R3)

Kokoro stays the default and the no-GPU fallback. Set `voice.engine` to
`qwen3-tts` to use Qwen3-TTS 1.7B instead. With no engine change, `synth.py`
does not import that backend.

`py/qwen.py` is a thin adapter. VoiceDesign runs once per package from
`voice.persona` and caches a `voice_clone_prompt`; every scene is then one
Base clone of that prompt (the scene's sentences in a single call). Base does
not support emotion instructions: persona belongs to VoiceDesign; punctuation
and wording control scene delivery. `voice.lang` or `voice.language`
selects English or French. `torch`, `qwen-tts` and the weights are imported
only inside the real adapter, and they are not in `py/requirements.txt`.

If that runtime is missing, the run falls back to Kokoro and records
`engineFallback`. `voice.strict: true` stops the run instead of falling back.

Word timings stay on the K1 hook. `Qwen3-ForcedAligner-0.6B` returns batched
tokens with `start_time`/`end_time`; the adapter converts these to the common
timing interface. Exact normalized matches merge split compound words, leading
silence is preserved, and the last caption holds through trailing silence.
Invalid tokens fall back to syllable timing, recorded explicitly in each
chunk's `timing` field. The timeline compiler turns `words[]` into highlights.

`narration_spoken` (alias `spoken_text`) is the line that is synthesised.
Captions keep `narration`. When neither field is set, `pronounce.py` still
respells. When an ASR adapter is available inside the synthesis process, it
computes word error rate against the spoken form and retries with the next seed
above 5% WER or when a pronunciation-map phrase is missing (at most three
takes). In the recommended isolated environments, synthesis and QA are separate:
`qa_qwen.py` records the transcript, WER, flags and alignment tokens without
regenerating takes. Review number/acronym formatting differences as well as
actual omissions before deciding to regenerate.

Example voice block:

```json
{
  "enabled": true,
  "engine": "qwen3-tts",
  "strict": true,
  "voice": "documentary-narrator",
  "persona": "An adult female documentary narrator with a warm low-mid register, clear neutral American English and a steady conversational pace.",
  "language": "en-us",
  "speed": 1
}
```

Put this object at `package.voice`. `voice` is a project-local identity label;
`persona` designs the reference voice. The cloned prompt is reused within the
synthesis process; saving the reference WAV does not automatically reuse it on
a later fresh synthesis invocation.

Tests never download weights and never start a GPU or a Google Colab runtime.
They pass a fake synth (a tone of known length), a fake aligner (known tokens)
and a fake ASR (a known transcript). Adapter tests also check the documented
batched `qwen-asr` interface and `start_time` / `end_time` token fields.

Optional install, separate from the default venv. The pinned upstream packages
require different Transformers versions, so use two environments:

```bash
python3 -m venv .venv-qwen-tts
.venv-qwen-tts/bin/pip install qwen-tts==0.1.1
python3 -m venv .venv-qwen-asr
.venv-qwen-asr/bin/pip install qwen-asr==0.0.6
# Install the PyTorch build appropriate for your GPU in each environment.
# Set voice.engine=qwen3-tts, voice.strict=true, voice.voice=<your-project-name>,
# voice.persona=<voice description>, voice.speed=1 in the package first.
.venv-qwen-tts/bin/python packages/tts/py/synth.py --package /path/package.json --out /path/audio --padding 0.5
.venv-qwen-asr/bin/python packages/tts/py/qa_qwen.py --package /path/package.json --out /path/audio
node packages/tts/scripts/narrate.mjs --example /path
```

`COMFYRIZZ_QWEN_DEVICE=cuda:0` selects GPU execution; default is CUDA when
available, otherwise CPU. `COMFYRIZZ_QWEN_MODELS` can point at pinned local
snapshots named after each model's repository basename. The runtime uses BF16
and PyTorch SDPA on CUDA, avoiding a FlashAttention source build.

For Google Colab, `scripts/tts/qwen_colab.mjs` uploads a minimal package,
installs isolated environments and downloads the exact public model revisions
in `colab/qwen-models.lock.json`. It uses the existing ownership registry,
detached watchdog, collection and verified teardown:

```bash
node scripts/tts/qwen_colab.mjs --dry-run --package /path/package.json --out /path/qwen-run
# Paid execution, only after authorizing the displayed run budget:
node scripts/tts/qwen_colab.mjs --package /path/package.json --out /path/qwen-run --units-ceiling 4
unzip /path/qwen-run/audio.zip -d /path
node packages/tts/scripts/narrate.mjs --example /path
```

To recheck existing takes without synthesising a new voice, use a fresh output
directory and `--qa-only` (still a paid GPU job):

```bash
node scripts/tts/qwen_colab.mjs --dry-run --qa-only --package /path/package.json --out /path/qwen-qa --units-ceiling 2
node scripts/tts/qwen_colab.mjs --qa-only --package /path/package.json --out /path/qwen-qa --units-ceiling 2
unzip -o /path/qwen-qa/audio.zip -d /path
node packages/tts/scripts/narrate.mjs --example /path
```

The runner accepts a per-run ceiling greater than zero and at most four units.
The default four-unit run uses a 24-minute watchdog; a two-unit run uses
11 minutes. `run.json` records balances, spend, errors and verified teardown.
Keep a cumulative ledger when conducting several runs under one authorization.

Review `audio/durations.json` for the actual engine, per-scene ASR transcript,
WER flags and alignment method. The separated QA pass flags takes for review;
it does not automatically regenerate them. The synthetic reference WAV and
its text/persona are saved for reproducibility. No HF token is needed for these
public Qwen models. Keep scene takes short and use the same reference across
the film. An animated presenter must consume the exact final scene audio,
with a frozen audio latent in both LTX stages and playback at speed 1.

The Hermes production test verified actual Qwen synthesis and alignment on G4:
12 scene takes, 41 aligned sentence cues, and a 5,700-frame / 190-second compiled
timeline. See [recorded status and evidence](../../docs/HERMES_VIDEO_STATUS.md).
Editable exports retain `audio/durations.json`, the referenced scene takes and
the saved Qwen reference when the narration is redistributable.

**VoxCPM2** (2B, Apache-2.0, 48 kHz, voice design with style prefixes) is a
documented alternative only. There is no VoxCPM2 code in this repository. A
listening comparison against Qwen3-TTS would be a later GPU job, including on
Google Colab, and is not part of this package.

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
.venv/bin/python -m pytest packages/tts/py -q   # pronunciation map, voice.language, Qwen3 fakes
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
