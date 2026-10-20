# Natural, engaging narration: research and listening experiments

Research date: October 19, 2026. Scope: the local Kokoro ONNX and Qwen3-TTS 1.7B models used by Comfyrizz, plus Qwen's CustomVoice variant.

## The useful controls

**Treat narration as a performance: write for speech, choose an appropriate voice, give it coherent context, and audition the result.** Model settings alone cannot repair a script that reads like a specification. More emotion or slower speech is not inherently more natural.

| Model | Supported performance controls | Practical starting point |
| --- | --- | --- |
| Qwen VoiceDesign → Base clone | VoiceDesign instruction; reference audio + exact transcript; output text/punctuation; clone input mode | Design and audition a reference in the intended delivery, then reuse the approved reference across scenes. |
| Qwen CustomVoice 1.7B | Built-in speaker plus natural-language `instruct` on each generation | Keep the speaker stable; give a short, specific direction about audience, tone and the sentence's emotional arc. |
| Kokoro ONNX | Voice/style vector, text/phonemes, language, chunking and `speed` | Bundle short sentences into coherent thought groups; audition voices and small speed adjustments. |

### 1. Write something a person would say

- Give each thought a clear point. Use concrete verbs, conversational transitions and intentional contrasts.
- Prefer ordinary punctuation over a forest of ellipses, capitals and exclamation marks. Punctuation is a cue, not an exact pause timer.
- Expand or provide pronunciation mappings for ambiguous abbreviations, product names, numbers and URLs. Preserve the display/caption wording separately where appropriate.
- Do not put unverified tags such as `[excited]`, SSML or stage directions in spoken text. These APIs do not establish a general SSML contract; the model can speak the tags.
- Leave room for contrast: a curious question, an explanation, and a quiet conclusion should not all have the same intensity.

These are editorial recommendations. The listening experiment isolates punctuation while preserving every word; it does not measure a complete script rewrite.

### 2. Qwen Base: the reference carries the performance

The official API distinguishes **Base voice cloning**, **VoiceDesign**, and **CustomVoice**. Base's `generate_voice_clone` does not expose the delivery `instruct` argument used by the other two. Comfyrizz's adapter already documents this: its `instruct` parameter is not passed to Base. A UI control suggesting arbitrary per-scene emotion for Base would therefore overpromise.

The official workflow is VoiceDesign → a short reference → `create_voice_clone_prompt` → repeated Base generation. The technical report states that reference text–speech in-context learning preserves prosody better than speaker-embedding-only cloning. Use the matching reference transcript and `x_vector_only_mode=False` for that path.[1][2][3]

Practical reference direction:

> An adult female narrator with a warm low-mid register and clear neutral American English. Curious, friendly and conversational, as if sharing a discovery with one person. Varied intonation, relaxed breath pauses and gentle emphasis on what changed and why it matters. Clean close-microphone studio sound.

Audition the generated reference itself before cloning it. Check intelligibility, unwanted breathiness, room coloration, delivery and voice identity. A new VoiceDesign reference can change **timbre as well as expression**, even with similar identity wording; it is not a controlled same-speaker emotion switch. Save the approved WAV, transcript, model revision and settings for repeatability.

`non_streaming_mode=True` conditions the Base model on complete input text rather than its default simulated-streaming text path.[3] It is a worthwhile offline-narration comparison, not an established universal quality upgrade. Both paths in this experiment return complete audio files.

### 3. Qwen CustomVoice: direct a stable preset speaker

CustomVoice 1.7B supports a preset speaker and an independent delivery instruction.[1][3] Specific, compatible directions are more actionable than a list of adjectives:

> Warm, curious, conversational American English. Ask the opening question with genuine interest; build a little excitement on “suddenly,” then land the final sentence calmly. Speak as if talking to one person.

The experiment uses **Ryan** for three different passages, each with and without direction. Both takes are retained. CustomVoice was an experimental additional model in this study; the subsequent [production integration](VOICE_GENERATION.md) now exposes it alongside VoiceDesign + Base.

Do not use temperature as an “emotion” slider. It controls sampling, and changing it can affect stability and wording. This experiment retains the installed model's generation defaults and archives them. No claim is made that a particular temperature/top-p setting has been optimized for naturalness.

### 4. Kokoro: context before speed tricks

The official voice guidance says most voices do best around **100–200 model tokens**, can be weak below **10–20**, and may rush above **400**; its suggested mitigation for very short utterances is bundling them.[4] These are model tokens, not a word-count target.

Comfyrizz currently synthesizes Kokoro sentences independently and inserts 150 ms gaps. That is easy to time, but a sequence of very short sentences gives the model little context. The controlled experiment compares that path with one coherent paragraph using identical words, voice and speed. All listening variants omit production's scene-end padding and inter-scene silence.

- Start with a coherent thought group, rather than splitting every sentence regardless of length. Keep long groups below the model's limit and inspect actual tokenization when implementing adaptive chunking.
- Audition moderate duration-control changes; the example compares **0.98 → 0.93**. A slower take may feel warmer or simply drag. Avoid declaring a universal best speed.
- Match the language/phonemizer to the voice. The current test uses American English.
- Voice choice is a major variable. The official grades describe estimated training-data quality/quantity, not guaranteed listener preference.[4]
- Kokoro ONNX accepts a style vector as well as a preset name.[5] The experiment blends **70% `am_michael` + 30% `am_fenrir`**. This is a casting comparison and can change identity; it does not add an instruction-following capability.

### 5. Evaluate fairly

- Compare matched text at matched loudness, with no background music masking artifacts.
- Include multiple stochastic takes. A paired seed is useful bookkeeping, but different prompts consume randomness differently; it does not make the performances identical apart from one acoustic attribute.
- Listen for appropriate emphasis, natural pauses, sentence joins, stable identity and distracting artifacts—not merely pitch variation.
- Verify words with ASR and inspect any mismatch. A low word error rate is **not a naturalness score**.
- Measure final narration and rerun alignment after selection. Expressive pacing changes scene duration; forcing the take into an old timeline can undo the benefit.

## Controlled experiment

Plan: `scripts/bench/tts_expression_plan.json`; model pins: `scripts/bench/tts_expression_models.lock.json`.

| Comparison | Held constant | Candidate change |
| --- | --- | --- |
| CustomVoice × three passages × two seeds | Ryan, words, mode, paired seed | Short performance instruction |
| Base punctuation × two seeds | Reference, words, mode, paired seed | Punctuation/thought boundaries |
| Base text context × two seeds | Reference, text, paired seed | `non_streaming_mode=True` |
| Base reference × two seeds | Output text, clone mode, paired output seed | Newly designed conversational reference; timbre may change |
| Kokoro chunking | Michael, words, speed 0.98 | One paragraph instead of sentence calls + gaps |
| Kokoro pace | Michael, paragraph, words | Speed 0.93 instead of 0.98 |
| Kokoro casting | Words, paragraph, speed 0.98 | Michael/Fenrir blend |

The reference comparison uses the archived synthetic Hermes reference as its baseline, with the same reference transcript for the newly designed clips. New references use seeds 42 and 73; output takes use 123 and 456. The existing reference is independently archived with its original metadata. This design is transparent about reference/seed variation and does not establish causal superiority of the new reference direction alone.

The publication script uses **constant gain only**, selecting one common integrated-loudness target with at least 1.5 dB true-peak headroom. It preserves duration and does not compress, EQ, denoise or time-stretch. Raw files, normalized files, exact settings and before/after pair tracks are retained. Each pair is before → 0.8 seconds silence → candidate after.

## Results and listening links

- **[Full listening lab](https://mail.tailec998.ts.net:8451/tts-expression/index.html)**: nine comparisons, alternate Qwen takes, shuffled A/B labels and local preference export.
- **[Kokoro quick player](https://mail.tailec998.ts.net:8451/kokoro-expression/index.html)**: four CPU samples plus the sentence/paragraph pair.
- **[Download all examples and settings](https://mail.tailec998.ts.net:8451/tts-expression/examples.zip)**: raw and normalized WAVs, 15 before/after tracks, model revisions, transcripts and measurements; 40,009,142 bytes.

The bounded L4 trial completed in **877.179 seconds** including allocation, setup, generation, ASR, transfer and shutdown. All **27/27 source clips** passed the automated intelligibility gate with **zero measured WER**. This establishes transcript agreement with Qwen ASR, not a perceptual naturalness ranking.

Measured examples:

| Test | Before | Candidate | Interpretation |
| --- | --- | --- | --- |
| Kokoro sentence → paragraph | 11.267 s | 11.179 s | Nearly identical total duration; the comparison isolates phrasing/context and joins. |
| Kokoro speed 0.98 → 0.93 | 11.179 s | 11.605 s | About 3.8% longer; the model's duration response need not exactly equal the speed ratio. |
| Kokoro Michael → blend | 11.179 s | 10.901 s | Casting changes can affect timing even with the same speed. |
| Qwen thoughtful story, seed 123 | 11.440 s | 15.520 s | The direction changed delivery duration substantially. |
| Qwen thoughtful story, seed 456 | 10.960 s | 15.040 s | The longer thoughtful delivery also occurred in the second take. |
| Qwen Base full-text mode, seed 123 | 12.640 s | 12.080 s | Full-text input did not automatically slow the delivery. |
| Qwen Base full-text mode, seed 456 | 13.200 s | 11.840 s | Same direction of duration change in the second take; quality remains a listening choice. |

All normalized clips target **−24.2 LUFS**, selected to retain the most demanding clip's peak headroom without compression. Maximum measured loudness error is **0.02 LU** and highest true peak is **−1.53 dBTP**. Duration/sample-format checks passed. Headless Chromium decoded all 27 clips, played the first A→B sequence, and verified stop, alternate takes, blind/reveal, preference storage/export and mobile layout with no page errors. This is functional playback verification; no human listening preference or audible naturalness winner is claimed.

The final account balance was **359.35 units**, down **0.38** from the campaign start. The initial shutdown receipt showed 359.47 before the later billing update; accounting uses the later balance. Cumulative authorized spending is **10.22/20 units**, leaving **9.78**. Runtime shutdown was verified, with zero active assignments, zero hourly usage and no server sessions.

Evidence: `/home/mojo/comfyrizz-gpu-tests/tts-expression-20261019/`, including exact `input.zip`, `qwen-run-01/output.zip`, shutdown receipt, publication measurements and browser verification. Published files are in ignored `apps/web/dist/{tts-expression,kokoro-expression}/`; rebuilding the web app clears these static directories, so retain the archive when redeploying.

## Integration recommendations

1. Offer a short voice audition using representative narration before producing the full video.
2. Store an approved reference and its transcript as a revision-bound asset, with model/settings provenance.
3. Label controls by engine capability: reference direction for VoiceDesign/Base; line delivery for CustomVoice; voice/context/speed for Kokoro.
4. If coherent Kokoro chunks are adopted, align their words back to sentences rather than treating model calls as sentence timing boundaries.
5. Reuse the existing measured timing, quality checks, cancellation and progress contracts; record the selected take in the production revision.
6. Keep batch sizes appropriate to clip length and memory. Previous efficiency work measured throughput, not a perceptual naturalness advantage from batching.

## Primary sources

1. [Qwen3-TTS official repository: model distinctions, CustomVoice, VoiceDesign then Clone](https://github.com/QwenLM/Qwen3-TTS), accessed October 19, 2026.
2. [Qwen3-TTS technical report, §3.3](https://arxiv.org/html/2601.15621v1): speaker embedding versus text–speech in-context learning and controllability.
3. [Official inference API implementation](https://github.com/QwenLM/Qwen3-TTS/blob/main/qwen_tts/inference/qwen3_tts_model.py): supported method signatures, full-text mode and reference options. Runtime signatures/defaults are also archived by the experiment.
4. [Kokoro official voice guidance](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md): short/long utterance limitations, token ranges and voice-quality qualifications.
5. [Kokoro ONNX](https://github.com/thewh1teagle/kokoro-onnx): local runtime. The experiment uses installed version 0.4.9 and records model-file SHA-256 hashes.
