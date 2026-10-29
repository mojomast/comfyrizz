# Music Video and Lip-Sync Research

Research date: 2026-10-28. This document describes the recommended architecture; it does not claim that a lip-sync backend is installed or that singing synchronization can be perfect.

## Product contract

**Music Video** uses one user-supplied song as the unchanged master track. CPU analysis and Remotion create most of the film. Selective GPU work is reserved for short, reviewed performance inserts that need lip synchronization.

Do not promise “perfect lip sync.” Singing includes sustained vowels, melisma, vibrato, non-lexical vocals, reverb, backing vocals and instrumental masking. Most lip-sync models and SyncNet evaluators were developed primarily for speech. The honest promise is **selective AI lip-sync with per-shot review and measured QA**.

If the supplied performance footage is already correctly synchronized to the song, use it directly and do not regenerate it.

## Recommended implementation

1. Require song rights and performer consent. Decode the song once to a canonical PCM WAV master. Use derived 16 kHz mono vocals only for analysis/model input, never as the final master.
2. Normalize performance footage to constant 25 fps. Prefer one visible, mostly frontal, unobstructed face and shots without source cuts.
3. Precompute beats, downbeats, section candidates, onset/RMS/spectral features, stem energy and optional lyric cues. Keep deterministic arrays in an analysis artifact; do not invoke a model per rendered frame.
4. Use Remotion for stem-reactive graphics, waveforms, spectral bars, kinetic reviewed lyrics, section palettes, ordinary footage and transitions. Keep exactly one master `<Audio>` and mute generated-shot audio.
5. Audition representative performance shots before a batch. Process bounded 3–8 second inserts with context handles, trim the handles, and return silent mezzanine clips. These are editorial/resource bounds, not claims about model limits.
6. Review phrase onsets/endings, sustained vowels, mouth closures, instrumental-only intervals, identity, teeth, face seams and generation joins. Failed shots must be retried, shortened, replaced with a cutaway or removed.

## Backend research

| Project | Role | Practical assessment | Terms/cautions |
|---|---|---|---|
| [FastH3 Omni](https://huggingface.co/FastVideo/FastH3-Omni-Comfy) | New image-based audio-conditioned performance | Recommended Comfyrizz default for selected 5–6 second singing auditions: the existing Ref2VA graph accepts arbitrary song audio and MiniMax demonstrates singing. It generates native synchronized AV rather than preserving an existing filmed performance. | `fully_copy` is prompt guidance, not a hard audio lock. Output audio is synthesized through the audio VAE; arbitrary full-mix lip-sync quality still requires A/B review. |
| [MuseTalk 1.5](https://github.com/TMElyralab/MuseTalk) | Existing video/image + audio retargeting | Recommended dedicated retargeting candidate: latent-space mouth inpainting, 25 fps, 256 face region; official examples include relatively modest GPUs. Identity and jitter still require review. | README permits commercial code/model use; third-party components and test data have separate terms. No singing guarantee. |
| [LatentSync 1.5/1.6](https://github.com/bytedance/LatentSync) | Existing video + audio retargeting | Quality challenger for close-ups. v1.6 uses 512 face resolution; official minimum is about 18 GB VRAM versus 8 GB for v1.5. | Code is Apache-2.0; the [1.6 checkpoint](https://huggingface.co/ByteDance/LatentSync-1.6) has separate OpenRAIL++ terms. Speech benchmarks do not prove singing quality. |
| [Wav2Lip](https://github.com/Rudrabha/Wav2Lip) | Existing video/image + audio | Lightweight historical baseline, but old 96px mouth quality and speech-oriented behavior. | Open models/outputs are personal/research/non-commercial only; not the commercial local default. |
| [InfiniteTalk](https://github.com/MeiGen-AI/InfiniteTalk) | Full video/audio performance generation | Premium full-body challenger; much heavier than mouth-only retargeting and subject to identity/color drift. | Review base models and dependencies in addition to declared model terms. |
| [LongCat Video Avatar 1.5](https://github.com/meituan-longcat/LongCat-Video) | Portrait/image + audio | Strong portrait-only candidate with explicit singing evaluation; generates a new performance and is much heavier than retargeting. | MIT code/weights according to official materials; self-reported quality is not an independent guarantee. |
| [EchoMimic](https://github.com/antgroup/echomimic) | Portrait/image + audio | V1 includes singing demos; V3 is the more practical current portrait candidate. Separate portrait audition required. | Review version-specific model/dependency terms. |
| [Hallo2](https://github.com/fudan-generative-vision/hallo2) | Long portrait animation | Not the low-spend default; clear-vocal/frontal-portrait constraints and heavy official hardware. | Optional CodeFormer restoration is non-commercial by default. |
| [HunyuanVideo-Avatar](https://github.com/Tencent-Hunyuan/HunyuanVideo-Avatar) | Dynamic portrait/body synthesis | Excessive for selective low-cost inserts. | Custom regional/community terms and high VRAM requirements. |
| [SadTalker](https://github.com/OpenTalker/SadTalker) | Talking portrait baseline | Dated choice for expressive singing hero shots. | Audit bundled dependencies and models. |
| [Sonic](https://github.com/jixiaozhong/Sonic) | Portrait animation | Not a default: official setup is heavy and weights are non-commercial. | CC BY-NC-SA 4.0. |

### FastH3 path verified in Comfyrizz

The existing `workflows/fasth3_omni_ref2va.api.json` accepts a ready WAV through `LoadAudio` into `MiniMaxH3ReferenceToVideo`; the job planner and Python runner already stage and inject that file. A music-video adapter can therefore plan FastH3 without a new graph or generator enum. The full-reference prompt must explicitly use `audio reuse` and `<Audio 1>: fully_copy`; the existing dialogue-only `reference` direction is not appropriate for a song.

`fully_copy` belongs to prompt `retention_analysis`, not to an unmapped node input. In the current graph, target audio is sampled and decoded through `VAEDecodeAudio`; there is no source-WAV passthrough to the output mux. Consequently, the generated plate stays muted in the final edit and the unchanged uploaded song remains the master. FastH3's documented local frame grid is `17n+5`; a bounded six-second audition uses 141 frames (5.875 seconds) rather than rounding up to 158 frames (6.583 seconds).

Primary references: [MiniMax H3 launch and singing demo](https://www.minimax.io/blog/minimax-h3), [official retention guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md), [model card](https://huggingface.co/MiniMaxAI/MiniMax-H3), and [native ComfyUI node implementation](https://github.com/Comfy-Org/ComfyUI/blob/d52a7a5ef60b36062f7c3c69bd774f4c98b56eb0/comfy_extras/nodes_minimax_h3.py).

A pinned, asynchronous Python service is preferable to a model invoked by Remotion or an unpinned hosted notebook for dedicated retargeting backends. Keep MuseTalk and LatentSync in separate pinned environments. A job should identify backend/model/container versions, exact source and song hashes, source/timeline in/out frames, fps, handles, parameters and idempotency key. Output manifests must include frame count, resolution, audio-stream status, QA diagnostics and `needs_human_review` until approved.

## Audio analysis

- [All-In-One](https://github.com/mir-aidj/all-in-one): tempo, beats, downbeats and functional section candidates on CPU/GPU. Treat labels as editorial suggestions. Use one canonical decode because decoder differences can introduce offsets.
- [librosa](https://librosa.org/doc/latest/beat.html): CPU onset strength, tempo/beats, RMS, chroma, spectral features and segmentation. Half/double-tempo errors require review.
- [Demucs](https://github.com/facebookresearch/demucs): vocals/drums/bass/other stems for analysis and optional lip-sync input. Separation artifacts can damage consonants and reverb; never replace the master with separated stems.
- [WhisperX](https://github.com/m-bain/whisperX): candidate transcript and word timings. It is speech ASR, not singing ground truth. Prefer user-confirmed lyrics and line boundaries.
- [Remotion audio visualization](https://www.remotion.dev/docs/audio-visualization): supported audio-driven visualization APIs, including windowed data for long tracks and timeline-aligned `<Audio>`.

Lyrics are useful for editorial cues and human review, but the principal lip-sync backends consume audio directly. Do not synthesize mouth motion independently from ASR phonemes instead of the real waveform.

### Karaoke presentation contract

Music Video offers **Off**, **Caption** (bottom-safe line lyrics) and **Reel** (large lower-middle/center overlay). Standard LRC supplies line-by-line timing; enhanced LRC supplies explicit word-by-word timing. Plain lyrics are never automatically presented as synchronized. Store canonical cues in original-song seconds and evaluate them against `audio.music.trim.startSeconds + frame / fps` so paste, Player, full export and incremental export share one clock.

Lyrics are a separate editable song-lyric track, not narration captions. They do not enable TTS, narration ducking or measured narration sidecars. Standard lines must not acquire interpolated word timings. Enhanced lines may contain untimed gaps/segments without inventing cues for them. Both presentations preserve exact text and Unicode, wrap safely, respect reduced motion and require review after trimming or lyric edits.

## Low-spend audition

Use representative four-second cases: fast verse, sustained wide-mouth note, accompaniment/reverb/harmony, modest head movement, mouth occlusion and difficult low-resolution/lighting. Include an instrumental negative case.

Compare MuseTalk and LatentSync on identical inputs at final fps/resolution. Log cold start, runtime, retries, parameters and **cost per accepted second**. If neither handles a required shot, change the editorial treatment instead of repeatedly spending on it. Portrait-only input needs a separate portrait-model audition; do not compare image synthesis directly with video preservation.

## Acceptance gates

### Timeline

- Constant 25 fps and expected frame count.
- Master song and picture share the intended origin.
- Final duration differs from the master by no more than one frame.
- No unexplained dropped/duplicated frames, global mux offset or progressive drift.
- Compare the model artifact with the same shot after Remotion to isolate compositor shifts.

### Diagnostics

[SyncNet](https://github.com/joonson/syncnet_python) can provide offset/confidence diagnostics, not proof of singing correctness. Calibrate sign with deliberate shifted copies and compare against genuine known-good footage from the same song/performer. Initial project candidates at 25 fps are median voiced-window offset at most one frame and p90 at most two frames, with no sustained directional drift. These are project gates, not universal standards. If tracking or negative controls fail, mark the metric unavailable/unreliable rather than passed.

### Human review

Every hero performance shot requires normal-speed review with sound against the actual master and supplied lyrics. Check onset/ending, sustained-vowel shapes, appropriate closures, instrumental silence, identity, mouth/teeth/seams and joins. Record approve/retry/cutaway decisions. Finish with one uninterrupted full-video watch. Never ship a failed shot under a “perfect” claim.

## Rights and licensing

Model licenses do not grant song, lyric, footage, publicity or performer-consent rights. Review dependencies independently: for example, InsightFace-provided pretrained models and CodeFormer have non-commercial restrictions by default. Store rights assertions and immutable provenance with source assets. Uploading or analyzing a song must not itself authorize generation or paid work.
