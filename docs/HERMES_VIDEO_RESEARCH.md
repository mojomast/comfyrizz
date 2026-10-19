# Hermes release explainer: research and production decisions

Research checked 2026-10-19. Primary topic: Nous Research's **Hermes Agent**,
not the similarly named language-model releases.

For completed-run measurements and the current production checkpoint, see
[Hermes video status](HERMES_VIDEO_STATUS.md).

## Editorial source ledger

- [Latest stable API](https://api.github.com/repos/NousResearch/hermes-agent/releases/latest):
  v0.22.2, published 2026-10-15, release commit
  `d923a5eb487a17c0a68801bba9ef0f56c81040a8`.
- [v0.22.2 release notes](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.2):
  corrects a v0.22.1 build from the wrong commit; fixes gateway boot/PID
  identification and long local-model turns on laptops. Known issue: sessions
  run under the v0.22.1 gateway cannot be deleted in v0.22.2. Main-only work is
  intended for v0.23.0, not part of this stable release.
- [v0.22.0, The Threshold Release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0),
  published 2026-10-13: guided desktop setup and one-time trial; hosted
  connectors with multiple named accounts; hardware-matched local llama.cpp
  runtime; tested stable channels; signed desktop packages and transactional
  package environments; a release-note count of 600 reviewed/pinned plugins;
  password-manager integration; Bot Screen human takeover; shared gateway and
  profile-specific state; visible, steerable subagent work.

The film distinguishes the major feature release from the latest patch.
Generated shots are conceptual illustrations, not recordings of the Hermes UI.
No invented performance numbers. Local inference does not make hosted tools
offline. A reviewed plugin entry is not an unconditional security guarantee.
Update instructions depend on the installation channel.

## Qwen voice

Primary sources:

- [Official Qwen3-TTS repository](https://github.com/QwenLM/Qwen3-TTS)
- [Qwen3-TTS technical report](https://arxiv.org/abs/2601.15621)
- [Official Qwen3-ASR and forced aligner](https://github.com/QwenLM/Qwen3-ASR)

Use VoiceDesign **once**, then reuse its reference through the 1.7B Base clone
model. This is the official recommended route for a consistent designed
character across many lines. Keep scene takes short, retain the reference WAV,
and run transcription/forced alignment against the actual synthesized audio.
Use spoken respellings for versions and acronyms while keeping editable display
copy. Base cloning does not implement VoiceDesign's instruction-following API.

The original optional adapter had several unverified assumptions: implicit CPU
loading, a forced-aligner import from the wrong package, separate sample-rate
arguments where upstream expects audio tuples, and unhandled batched results.
These are corrected and covered by mocked upstream-contract tests.

PyPI `qwen-tts==0.1.1` pins Transformers 4.57.3; `qwen-asr==0.0.6` pins 4.57.6.
They therefore run in separate environments. The Colab worker explicitly uses
Python 3.12, Torch/Torchaudio 2.9.1 with CUDA 12.8, BF16 and SDPA. Model revisions
are pinned in `colab/qwen-models.lock.json`. Strict engine selection prevents
silent Kokoro fallback. Setup and usage are in `packages/tts/README.md`.

## Presenter synchronization

Primary implementation evidence:

- [ComfyUI audio VAE encoding](https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_audio.py):
  encoding returns samples; it does not add a zero noise mask.
- [ComfyUI AV latent concatenation](https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_lt.py):
  an absent audio mask becomes an all-ones mask when concatenated with masked
  video. The sampler can then regenerate the supposedly fixed audio.
- [LTX-2.5 custom-audio discussion](https://huggingface.co/Lightricks/LTX-2.5/discussions/44):
  corroborating community evidence for frozen audio latents and Euler sampling.
  This is practitioner guidance, not a controlled model-quality benchmark.
- [SyncNet](https://github.com/joonson/syncnet_python), pinned evaluator source
  `907c0b579c2e2d83f0eae1b2ac9e720cde4e5623`:
  learned audio-visual offset/confidence measurement, using 25 fps / 16 kHz.

Three concrete issues were found in Comfyrizz:

1. The audio-to-video graph described the audio as frozen but did not install
   its zero noise mask. Both stages now use the original encoded, masked audio.
2. Generic media playback slowed short presenter clips to fill a scene. Presenter
   playback now explicitly uses speed 1 and never loops speech.
3. The overlay lived on the global composition clock. Each presenter now has a
   scene-local Sequence. A rendered red/green/blue clip regression checks both
   native playback speed and a later scene's local time.

Generate presenter clips **after** the final narration timeline exists. Cut the
exact final voice track at that scene's timeline origin, pad to the 8n+1 frame
duration, keep one fixed sample rate and fps, and avoid time-stretching the output.
Use a sharp unobstructed frontal portrait, a locked camera and restrained motion.
Mix only the original narrator, never a generated duplicate voice.

`scripts/tts/check_lipsync.py` measures offset/confidence for locked single-face
clips. It requires separately installed SyncNet code/weights and does not ship
those weights in project bundles. Its median Haar crop is a diagnostic shortcut
for this controlled shot. Low confidence is not proof of a correct offset; a
passing metric also does not establish natural articulation. Pair the metric
with playback review and an old-versus-corrected comparison.

## Visual treatment and budget

The DeepSeek v4.1 Flash draft is expanded into a 12-scene, roughly 500-word
explainer: six LTX shots, readable editorial typography, count-up statistics,
animated step/hub diagrams, code typing, a mix of fades and directional pushes,
and labeled presenter bookends. All diagram labels remain editable package copy.

Use 1024×576 two-stage LTX outputs, whose half-resolution lattice is valid.
The previous 1920×1080 upscale request floored to 1920×1024; that geometry bug
should not be hidden behind incorrect metadata. Final composition remains 1080p.

Long-form preflight also exposed a planner cap that truncated measured speech
in stat/title scenes. Measured narration now raises the layout's cap; unmeasured
preferred pacing still obeys the existing limits. Editable ZIPs retain the
duration sidecar, per-scene takes and the saved Qwen reference. The static server
supports byte ranges so a browser can seek through the longer MP4.

The existing authorization is 20 Colab units total, including 1.07 spent on the
previous Comfyrizz explainer. Every attempt records before/after usage and a
verified stop. Qwen synthesis used a 4-unit ceiling with a 24-minute watchdog;
the alignment-only rerun used a 2-unit ceiling and 11-minute watchdog. Graphics
were launched after validation and fake rendering, with a 5-unit ceiling and
30-minute watchdog. The final CPU render follows GPU teardown.
The first two Qwen environment attempts stopped during setup and reported no
balance change; account-level cumulative spend remains the final authority.

This document records research and implementation decisions. The linked status
report distinguishes completed measurements from pending graphics and playback
checks; passing pipeline tests alone does not establish perceptual lip-sync.
