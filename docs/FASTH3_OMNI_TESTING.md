# FastH3 Omni testing branch

This experimental integration uses native ComfyUI reference-to-video/audio nodes.
The graph retains both generated streams in its MP4. It is separate from the
production LTX bootstrap and has not been made the default generator.

## Pinned recipe

- ComfyUI: `d52a7a5ef60b36062f7c3c69bd774f4c98b56eb0`.
- Upstream workflow: [FastH3 OmniRef template](https://github.com/Comfy-Org/workflow_templates/blob/d0e41fe5423f93db5b5872cf273d7b1af8aa68bc/templates/video_fasth3_ominiref_r2v.json).
- Model manifest: `colab/fasth3-models.lock.json`, with sizes and SHA-256 hashes.
- Template-compatible INT8 diffusion, NVFP4 reference encoder, INT8 video VAE,
  FP32 audio VAE. Approximately 41.32 GB of weights; Blackwell pilot profile.
- Eight-step Euler/simple, no CFG multiplier, VSA 10%, video/audio shifts 12/3.
- 24 fps, 32-pixel spatial lattice, frame counts rounded **up** to `17n+5`.
- `image`, `reference`, `audio` mean `<Picture 1>`, `<Picture 2>`, `<Audio 1>`.
  All three inputs are required by the included graph. The model supports more
  references, but this first integration deliberately implements this bounded set.

The announcement's 11.9× speedup is not a measured speedup on our single G4.

## Project integration

`gen.generator: "fasth3-omni"` now plans a normal video plate with file uploads,
source provenance and reference-sensitive caching. It does not inherit LTX's
framing lock, strength, 8n+1 frame count, half-size stage or image-aspect coercion.
The included graph is `workflows/fasth3_omni_ref2va.api.json`; its sibling params
file works with the existing Python parameter injector.

Applied assets record `media.audio: "present"`. The ordinary renderer still needs
its plate audio bus configured at an appropriate level; it is not automatically
a dialogue-led editor. Model terms are recorded separately and H3 output is not
automatically marked unrestricted CC0. No model weights or reference media are
committed to the repository.

## Four-minute production

**GPU: Graphite Processing Unit** is a 467-word, 30-shot, 240-second workshop
mockumentary: impossible lighthouse commission → dubious optimization → lunch
outage → chairs and credit → the client's raccoon revision. It uses four fixed
character/voice references from the prior production. The script lets the absurd
premise speak for itself, without explanatory satire cards.

Prepare outside the checkout:

```bash
python scripts/demos/gpu-artists.py "$PREVIOUS_PRODUCTION" "$NEW_PRODUCTION"
node scripts/demos/gpu-artists-package.mjs "$NEW_PRODUCTION"
```

This writes `film.json`, `screenplay.md`, cropped character references, normalized
voice references and the API workflow.
The second command writes validated `package.json` and `jobs.json` documents for
the normal project planner, with the generated audio bus enabled. The production
finisher uses unobstructed full-frame footage rather than the package's editor
headlines. The previous production is expected to
contain `repair/packages/comfy_mockumentary20261020/assets/a_still6.png` and the
measured `audio/voice-manifest.json` with its line takes. References are our own
previously generated clay characters and synthetic voices.

The GPU experiment uses `colab/fasth3_bootstrap.py` to download/verify only H3
weights, start pinned ComfyUI, and check native node availability. Upload the
prepared film directory beside `ComfyUI`, then run:

```bash
python colab/fasth3_run.py /content/fasth3/film --shots s04
```

The runner records every submitted graph and prompt ID before polling. It refuses
to blindly repeat interrupted attempts. Successful shots include hashes, timing,
and ffprobe metadata. It preserves generated audio rather than replacing it with
the voice reference. A host-side owner must enforce the credit budget and stop
the billed runtime, including after failures.

Review the pilot's actual speech, identity, hands and lip motion before expanding
to all shots. Source clips run slightly longer than their editorial slots; trim
only after checking the spoken line has finished. Native generated speech can
change words and pacing: the script is not an automatically verified transcript.

## Verification

```bash
node --test packages/jobs/test/fasth3.test.mjs packages/jobs/test/plan.test.mjs
python -m py_compile colab/fasth3_bootstrap.py colab/fasth3_run.py scripts/demos/gpu-artists.py
```

The integration tests cover H3 frame/geometry rules, portrait reference handling,
changed-reference invalidation, audio retention, model metadata, and native graph
AV connectivity.

## Live pilot results — 20 October 2026

Confirmed on one Colab G4: RTX PRO 6000 Blackwell Server Edition, about 96 GB
VRAM, Torch 2.11.0+cu130 / CUDA 13. Native ComfyUI accepted the graph and saved
MP4s with synchronized audio. All four model hashes were verified.

| Pilot | Size | Generation/collection into local VM output | Result |
|---|---|---:|---|
| Engineer v1 | 832×480 | 33.68 s | Exact script transcription, but duplicated foreground/background character; rejected. |
| Engineer v2 | 1344×768 | 51.13 s | Correct words and better staging; background worker from the portrait crop remained. |
| Reporter v3 | 1344×768 | 66.10 s | Exact script transcription; stable foreground identity in temporal samples. |
| Painter v3 | 1344×768 | 78.09 s | Correct scripted line followed by unwanted additional speech after about 6.5 s. Trim required. |
| Engineer v3 | 1344×768 | 54.08 s | Exact script transcription; stable foreground identity in temporal samples. |

These are individual shot times, not end-to-end campaign benchmarks. The first
bootstrap encountered a missing `torchsde`: a dependency filter had mistakenly
excluded every package starting with `torch`. The corrected filter excludes only
the Torch/torchvision/torchaudio distributions themselves.

The v3 reference set uses tight face portraits and a person-free workshop crop.
This removed the conspicuous tiny-duplicate effect. The model can still introduce
background workers despite the prompt requesting one person; review actual output.

`scripts/demos/gpu-artists-finish.py review` produces five-frame temporal sheets,
ASR word timings, script comparison, and exact-prefix extra-speech detection.
The finisher cuts before unwanted suffix speech, protects the intended last word,
and reallocates reaction holds to keep the entire short at 5,760 frames / 240 s.
It refuses an edit that cannot fit the available clean footage. Captions use
observed words rather than assuming the generation prompt was followed.

The raw pilot player is `scripts/demos/fasth3-player.mjs`, bound to localhost;
the user's private proxy configuration remains outside Git. No public deployment
is performed. ASR and temporal samples do not substitute for a listening review.

**At the integration checkpoint:** the 30-shot production is running; the final
four-minute export is not yet delivered. Subsequent results belong below.
