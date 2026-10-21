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

**GPU: Graphite Processing Unit** is a roughly 480-word, 30-shot, 240-second workshop
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

### Main generation completed

All 30 initial production shots succeeded and their downloaded hashes matched
their receipts. They total 246.375 seconds of source footage (before editing),
with 2,021.63 seconds of summed generation/VM-save time, a median 66.08 seconds
per shot, and 8.21 seconds of computation per source-video second.

For comparison, the preceding film's 39 successful LTX-2.5 motion clips at
1024×576 took a median 22.00 seconds for roughly ten-second clips, or 2.24 seconds
per source-video second, on the same G4 GPU class. H3's current run therefore uses
about 3.67× the time per video second, at 1.75× the pixel count and with reference-
conditioned spoken performances. This is a production-workload comparison, not
an equal-resolution controlled benchmark. It excludes startup, transfers and
rejected/repair takes. The published 11.9× claim compares against base MiniMax-H3.

Full-film sample and speech review identified unwanted suffix speech in s03,
s14 and s24. s03 was trimmed cleanly; the two short questions were regenerated
with longer relevant lines. The s27 lighthouse line was also revised to make
the visible omission of the underwater requirement an explicit joke rather than
a contradiction. All three replacement takes matched their scripts in ASR.
Source captures, old takes, and raw ASR remain outside Git.

### Final delivery

The completed short contains 30 shots and a 481-word screenplay, with native
FastH3 dialogue and sound. The final edit is exactly **5,760 frames / 240 seconds**
at 24 fps, delivered as 1920×1080 H.264 with stereo AAC and 63 caption cues.
The source generation resolution was 1344×768; the export is upscaled.
SRT, WebVTT and an embedded subtitle track accompany the film.

- Master: `gpu-artists-1080p.mp4`, 149,449,168 bytes;
  SHA-256 `5e7e1aacc38a345052b63c67919fb93e6b1c04907062011a6dab6737c07b36c3`.
- Compact copy: `gpu-artists-small.mp4`, 62,535,495 bytes;
  SHA-256 `13ca211c36e794b7e40c9adc1681b14ca06d10b5f4a79417f8db072891430517`.
- Both exports passed full FFmpeg decode checks. Master integrated loudness is
  −17.9 LUFS, loudness range 4.2 LU, and true peak −1.9 dBFS.
- The private player and both files returned HTTP 200; a compact-copy byte-range
  request returned HTTP 206 with the requested 1,024 bytes. Browser captions are
  served through WebVTT.
- Review used full-film temporal samples, targeted repair samples, final-export
  samples and CPU ASR. Full real-time audiovisual review was not performed.
  Remaining visible limitations include occasional background workers, manager
  wardrobe variation, and pseudo-lettering in workshop notes.

`gpu-artists-apply.mjs <production-directory>` creates a validated
`package.ready.json` with selected workflow graphs, output hashes and the final
5,760-frame editorial timing. Replaced takes and original ASR reports are retained
alongside the local production evidence.

The G4 session was explicitly stopped after all media was recovered. Colab
reported no sessions, zero active assignments and 0.00 credits/hour. The observed
balance fell from 341.56 to 333.21: **8.35 credits** for this experiment and
**13.33 / 25 credits** across the combined project, leaving 11.67. The balance
remained 333.21 on the final check. Final assembly and compression ran locally.

### Main integration — October 21, 2026

Merged main through `06339ce`, including the reference-assets UI/server flow and
quality-pipeline tooling. The merge required no conflict resolution. Full-suite
checks identified two missing FastH3 registrations: the agent workflow hash
manifest and the Python cross-workflow fixture. Both now include the native
FastH3 graph, including injection of its audio reference into the plate workflow.

The production frontend builds successfully, typechecks, and mounts the
References panel in headless Chromium without page errors. The reference suites
pass (126 server tests and 16 frontend tests), as do the quality-tool/release-scan
tests (229 tests) and Python suite (370 passed, one skipped).

Deployment uses the existing private app service and saved runtime. The previous
runtime, frontend and untracked local files are backed up outside Git. The built
frontend is overlaid onto the live dist directory to retain published media;
deployment verification compares all 274 existing published files by SHA-256.

Deployment completed at `275e366`. All 1,251 workspace JavaScript tests passed
(backend tests were run serially to avoid watchdog timing contention); the
additional reference/quality suites above also passed. The private app's health,
catalogue, pipeline, run and reference-library endpoints returned HTTP 200.
Headless Chromium displayed the new References panel without page errors or
mobile horizontal overflow. All 274 published files retained their hashes, all
18 published pages responded, and all three separate film players responded.
The two older standalone player processes were absent at verification time and
were restarted under user-service supervision. Runtime credentials and existing
untracked work were retained; the formerly untracked local lockfile was archived
before switching the deployment checkout to the tested revision.
