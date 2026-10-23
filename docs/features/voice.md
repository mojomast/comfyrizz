# Voice

Voice choice lives in `apps/server/src/characters/voice.mjs` and the catalogue in
`packages/tts/voices.mjs`. Engines: `kokoro`, `qwen3-tts` or `none`.

- **Native voice when the model supports it.** A video model that declares the
  `supportsNativeVoice` capability (for example the MiniMax-based speaking path) speaks with one of
  its own declared built-in voices. The capability is read from the model profile, never guessed
  from the model name.
- **Otherwise Kokoro.** Every other model speaks through a Kokoro voice. Kokoro runs locally on CPU,
  and auditions are free (`kokoro-synth.mjs`, `audition.mjs`).
- **Native test shot.** A paid test shot (`productions/native-test.mjs`) is refused on a model
  without a native voice, because Kokoro can be auditioned for free. Transcript (ASR) mismatches
  are findings; the take stays unreviewed until you give a verdict.
- **No voice cloning.** Voices come from the built-in catalogues only; cloning a person's voice is
  never accepted.

Per-scene speakers resolve that character's voice and fall back to the narrator, then the package
voice, with a reported warning. Narration tuning: [VOICE_GENERATION.md](../VOICE_GENERATION.md),
[TTS_NATURALNESS.md](../TTS_NATURALNESS.md).
