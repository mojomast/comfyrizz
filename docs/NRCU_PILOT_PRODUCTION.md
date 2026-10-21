# The Lower Road — pilot production

This is the pilot for **Hermes: The Unfinished Dawn**. The production
uses native FastH3 Omni for every motion and speaking shot, with FLUX 3 Klein
used only to author still references and starting compositions.

## Live view

**Pilot player and downloads:** <https://your-host.example:8455/>

### Current delivery — 65-second rock recut

After the user requested better pacing, rock music and more action/AI banter in
future scenes, the pilot was recut from **90 to 65 seconds**. All 20 shots remain,
with **1,560 frames at 24 fps**. The opening geography/prop setup is 3.25 seconds
instead of nine; the cable failure, fork turn, descent, boarding and regulator
departure cut closer to their action. Long pauses before Turbo and Don's final
lines are removed. The spoken performances retain their natural speed and words.

The original score is replaced by an original **144 BPM instrumental rock cue**:
synthesized double-tracked distorted power-chord guitars, electric bass, kick,
snare, hats and cymbals. Speech-window ducking lowers the music by approximately
15.4 dB through dialogue, with short attack/release ramps. Picture-timed accents
and original nonvocal engine/cable Foley support the action. No third-party music
samples or additional GPU allocation were used.

| Rock recut export | Bytes | SHA-256 |
| --- | ---: | --- |
| 1080p master | 51,202,005 | `8d9bdeb4b4feb8f8cbae03df4c0ceaac11b7d9c666d137942c927275415b5fcf` |
| 720p compact | 13,041,832 | `3986bc2c4c37904bf88ab337f4727b73e482b5e6e571e5840d6684d84eddbf6b` |

Both exports are exactly 65.000 seconds, with 1,560 video frames and 11 caption
cues. They passed clean full decode and exact frame-rate/frame-count checks.
Final mixed-audio ASR recovered all scripted words in order. Master loudness is
−18.3 LUFS, true peak −1.6 dBFS, range 4.1 LU. End-of-shot frames were inspected
for all 20 editorial cuts. Normal-speed listening review remains pending.

Production root: `/home/mojo/comfyrizz-gpu-tests/nrcu-pilot-rock-v2-20261021`.
The original production/export directory remains intact. The recut reuses its
verified source takes, reference images and source review reports. The shared
player now serves the rock recut; the live dashboard also embeds this version.

The finisher now supports the film's declared frame-exact duration. The shorter
edit exposed concatenated timestamp irregularities, so final video timestamps
are rebuilt at 24 fps and both master and compact files are checked independently.
Decode diagnostics now fail verification even when FFmpeg exits zero.

Future preparation is rewritten to **4 / 4 / 4 / 5 / 6 minutes**. The season bible
contains revised action beats and cheeky AI-trope dialogue for all five chapters.
[Save the Failure](NRCU_NEXT_SCENE_ROCK_ACTION.md) is a new 60-second, 20-shot
shooting draft with a retry/memory payoff during a live shelter repair. These
future scenes are written, not generated.

### Original delivery — 90-second cut

Delivered cut: 20 shots, 2,160 video frames, exactly 90.000 video seconds at
24 fps. The 1080p master is 65,704,761 bytes; the 720p compact export is
17,665,551 bytes. Both contain native FastH3 dialogue and 11 caption cues.
AAC/container padding measures 9 ms in the master and 17 ms in the compact file.

| Export | SHA-256 |
| --- | --- |
| `hermes-the-lower-road-1080p.mp4` | `f354f9c3d2b79977cfd2fde4cbc3e3198bc1f5d8b1597ea2ad9814c2d1baa383` |
| `hermes-the-lower-road-small.mp4` | `c32575929a69193ebf7198bad6dafb849202f622b4a298f9bfb80bc4268ad7e7` |

Both exports passed full video/audio decode. The measured master is −17.8 LUFS,
−1.3 dBFS true peak, with 9.0 LU loudness range. A separate assembled-master ASR
pass recovered every intended line without the removed opening preamble.

The private player runs as `comfyrizz-nrcu-pilot-player.service` on localhost
4194, proxied through Tailscale HTTPS 8455. Headless checks verified playback
advancement, all 11 external caption cues, desktop/mobile layout, valid range
downloads (206), and invalid-range handling (416). These checks are not a
normal-speed listening review; that remains pending.

Private production dashboard:
<https://your-host.example:8451/nrcu-pilot/index.html>

The explicit `index.html` is required by the deployed app's static routing.
The dashboard refreshes status every five seconds. Images and raw takes are
published after download and SHA-256 verification. Raw takes are working
material, not a reviewed final edit. The production directory and media stay
outside Git at `/home/mojo/comfyrizz-gpu-tests/nrcu-pilot-20261021`.

## Creative and technical contract

- Original proof: 90 seconds / 2,160 frames. Current rock recut: 65 seconds /
  1,560 frames. Both use 20 shots at 24 fps.
- Native FastH3 reference-conditioned video at 1344×768, letterboxed into a
  1920×1080 delivery canvas without stretching.
- Don's original synthetic voice speaks the user's requested broken English.
  Preserve “You watch me. This time, I first.”, “I go lower. You take core.
  People need you.” and “We no get part. But everybody here.”
- Don gives up the regulator to rescue the two workers. Following the user's
  live feedback, Molty sounds evil and openly claims the prize: a cold,
  mocking rival rather than a friendly rescue partner. The initial warm voice
  and two speaking takes are archived; `nrcu.molty.v2` replaces them.
- Kokoro reference voices condition identity; final dialogue comes from FastH3.
- Deterministic original synthesized score and ambience, without sampled music.
- Native inference receipts retain submitted graphs, references, timing and
  output hashes. Uncertain attempts require inspection before resubmission.

## Budget and runtime

Combined authorization: 25 credits; previous observed spend: 13.33 credits.
Pilot reserve: 9 credits. Starting balance: 333.21 compute units.

The first G4 request was unavailable. The successful allocation used an NVIDIA
RTX PRO 6000 Blackwell Server Edition at an observed 8.90 credits/hour. A
55-minute systemd stop timer was armed, due at 01:30:33 UTC on 2026-10-21.
Pinned FastH3 setup completed in approximately 240 seconds; reference-model
setup took approximately 83 seconds. Temporary download credentials were removed.

The allocation was explicitly terminated after the selected takes and repairs
were downloaded, and the timer was cancelled. Observed ending balance: 326.34;
pilot spend: **6.87 credits**; combined spend: **20.20 / 25 credits**, leaving
**4.80 credits**. The CLI confirmed zero assignments and a zero usage rate.

## Helpers

| Helper | Purpose |
| --- | --- |
| `scripts/demos/nrcu-pilot.py` | Author screenplay, timings, reference plans and synthetic voice registry |
| `colab/nrcu_reference_bootstrap.py` | Install pinned still-reference models into the isolated runtime |
| `colab/nrcu_reference_run.py` | Generate reference images with native ComfyUI receipts |
| `scripts/demos/nrcu-run.py` | Submit bounded batches, verify downloaded artifacts, publish live progress |
| `scripts/demos/nrcu-live.mjs` | Publish the private live production dashboard |
| `scripts/demos/nrcu-pilot-score.py` | Synthesize original 90-second score and ambience stems |
| `scripts/demos/nrcu-rock-score.py` | Fit original rock arrangement and ducking to measured speech windows |
| `scripts/demos/nrcu-pilot-finish.py` | CPU ASR, temporal contact sheets and speech-protected assembly |
| `scripts/demos/nrcu-pilot-package.mjs` | Produce schema-validated package and planned jobs |
| `scripts/demos/nrcu-pilot-player.mjs` | Hash-verified private player with captions and range downloads |

## Review evidence

Initial reference review found unwanted human drivers in the two vehicle images.
Explicit edit passes removed them; initial references and receipts are retained.
Character references identify Don, Molty, Turbo and the two workers distinctly.

The first 20-frame composition pass overused the wide world reference and
duplicated workers. A complete scene-specific composition pass replaced it;
three additional edits restored Don's red monocle. Video review then found:

- Don's opening take spoke an unwanted preamble before the correct line. The
  edit starts at frame 42, after that preamble and before the intended words.
- Several action takes produced possible speech detections. Their source audio
  is muted in the edit and replaced by the original score/ambience stems.
- Don's fork reply contained generated on-image captions. A same-aspect crop
  removes them while preserving his face and performance.
- The user requested an evil-sounding Molty. Both speaking shots were replaced
  using the `bm_george`/0.90 original reference voice and explicit cold,
  gravelly antagonist direction; both replacement transcripts match the script.
- A later Turbo shot duplicated the character, and a departure shot introduced
  another car. Explicit replacement takes remove those problems in the reviewed
  temporal samples. The replacement Turbo line also matches the script.

Every editorial override names the matching source hash and its reason in
`review-overrides.json`. Superseded media and receipts are retained outside Git.

ASR and sampled frames are inspection aids. They do not establish normal-speed
audiovisual or listening review. Individual review receipts record that distinction.
The balance was checked again after export and remained 326.34, with zero
assignments and zero usage rate. Existing app, Dipsy and mockumentary services
were also confirmed active after delivery.

Selected-take review covers all 20 final source clips and 100 temporal frames.
The production package validates with 20 scenes and a 2,160-frame target.
The live dashboard passed headless desktop/mobile checks: 28 image cards loaded,
no page JavaScript errors, and no horizontal overflow at a 390-pixel viewport.
