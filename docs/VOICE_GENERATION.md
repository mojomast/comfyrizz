# Voice options in production generation

The storyboard now has a **Voice & narration** panel. Choose a preset or customize a voice, enter narration on the scene cards, then use **Check generation plan → Generate video**. Metered plans retain the existing budget-bound approval step. The panel runs `POST /api/pipeline`, displays its nine stages, and offers the resulting video and editable files. A page reload reconnects to the last run in that browser session.

## Available choices

- **Kokoro:** 29 selectable English/French voices (US female/male, British female/male, French female). Speed 0.5–2.0; sentence or connected-paragraph context; two-voice blending within a language/accent. The API supports two to four positive weighted styles, normalized at synthesis.
- **Qwen designed voice:** editable identity/performance description, additional reference direction, optional reference transcript, and full-text conditioning. VoiceDesign creates one reference; Base clones it across scenes.
- **Qwen CustomVoice:** Ryan, Aiden, Vivian, Serena, Uncle_Fu, Dylan, Eric, Ono_Anna and Sohee. Default delivery instruction plus per-scene overrides. Preset voices have different native accents/languages; audition the chosen voice in the requested language.

Ten quick presets include the four tested Michael sentence/context/pace/blend configurations, Heart, Bella, Ryan curious/thoughtful, Aiden, and the conversational designed female narrator. The preset definitions are shared in `packages/tts/voices.mjs`.

Kokoro is local CPU inference. Qwen can use managed Colab or configured local TTS/ASR environments. The UI selects strict Qwen execution, so a missing runtime does not silently substitute another voice. Numeric speed is a Kokoro control; Qwen requires `speed: 1` and uses natural-language delivery for pacing.

The **Generate narrated video** action synthesizes the chosen voice and remeasures the timeline. Existing Render/Export actions reuse existing audio. Generated runs remain isolated revision-bound cuts; use their downloads rather than treating their asset paths as edits to the original project.

## Saved package examples

Tested Kokoro blend:

```json
{
  "enabled": true,
  "engine": "kokoro",
  "voice": "am_michael",
  "language": "en-us",
  "speed": 0.98,
  "chunking": "paragraph",
  "blend": [
    {"voice": "am_michael", "weight": 0.7},
    {"voice": "am_fenrir", "weight": 0.3}
  ]
}
```

Directed Qwen preset:

```json
{
  "enabled": true,
  "engine": "qwen3-tts",
  "qwen_mode": "custom",
  "voice": "Ryan",
  "language": "en-us",
  "speed": 1,
  "strict": true,
  "non_streaming": true,
  "delivery": "Warm, curious and conversational. Speak as if talking to one person."
}
```

For CustomVoice, `scene.narration_style` overrides `voice.delivery`. For design mode, `persona` and `delivery` shape the reference; Base does not receive per-scene instructions. `reference_text` is the text **to synthesize into a new synthetic reference**, not an uploaded audio reference. Provide reference text in the target language when using a non-English designed voice. Existing `ref_asset` does not implement automatic reference-file reuse.

Paragraph Kokoro synthesis preserves the measured whole-take duration and rebuilds sentence/word caption chunks using the established syllable fallback. Its sentence boundaries are estimates, not forced alignment. Raw settings are recorded in `durations.json` and serialized in narration asset provenance.

## API and frontend handoff

- `GET /api/voice-options` (authenticated): versioned presets, Kokoro voice IDs/languages, Qwen speakers, and supported controls. This is the supported catalogue, not a promise that Qwen is installed locally.
- Save the selected object as `package.voice` through the existing revision-checked package PATCH.
- Save narration and optional CustomVoice direction as `scene.narration` / `scene.narration_style`.
- Plan/start through the [pipeline API](PIPELINE_OBSERVABILITY.md). The plan binds voice settings, narration, package revision and compute ceilings.
- Generated asset provenance uses the actual Qwen model (`CustomVoice` or `Base`), not a hardcoded Base attribution.
- The Colab worker downloads only the selected TTS family plus the ASR/aligner models, with pinned revisions. QA-only jobs still skip all TTS models.

The small `apps/web/src/voice-settings.ts` panel is an integration for the current shell. The other frontend agents can use the same catalogue and package fields in the redesigned editor. Existing agent/provider settings and conversational project merging remain in place.

## Verification

The schema accepts all ten presets and rejects unknown CustomVoice speakers, Qwen numeric-speed changes and Qwen blend requests before allocation. Python adapter tests verify weighted styles, model/API selection, reference direction/transcript, full-text forwarding and per-scene delivery overrides. The local browser test exercises settings persistence, stale-plan rejection, real CPU blended paragraph generation, caption timing, video verification/export, Qwen planning and desktop/mobile controls.

See [the listening research](TTS_NATURALNESS.md) for the real Qwen/Kokoro samples and their quality checks. Production CustomVoice uses the same official model/API as those experiments; the new adapter routing is covered by contract tests.

Deployment verification (October 19, 2026): the live Tailscale app exposes the panel and authenticated catalogue. The real CPU browser run `pipe_8dceba49e545480ebc49840d06737e2a` completed all required stages with a 70/30 Michael/Fenrir paragraph voice at speed 0.93. Evidence, screenshots, generated outputs and the Qwen production dry-run bundle are archived in `~/comfyrizz-gpu-tests/voice-options-20261019/`. The update used no additional GPU credits. Existing example/listening players remained accessible after the frontend build.
