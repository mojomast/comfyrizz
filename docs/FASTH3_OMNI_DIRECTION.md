# FastH3 Omni: directing native audiovisual scenes

Research checked **2026-10-21** against the release model card, official MiniMax
reference-prompt guide, ComfyUI source and the Omni workflow template. These
instructions apply to **FastH3 Omni / OmniRef**, not older FastH3 fl2va or base H3.

## What the sources establish

| Concern | Project rule | Evidence |
| --- | --- | --- |
| Sampling | Keep 8-step Euler/simple, guidance 1, video/audio shifts 12/3; VSA 10%, start 0/end 1, protected conditioning rows. | Omni release card and pinned Omni template [1–3]. |
| References | Map image → Picture 1, reference → Picture 2, audio → Audio 1 in this graph. Assign explicit identity/composition/voice roles. | Official reference guide and pinned node implementation [4–5]. |
| Frames | Round to `17n+5` at 24 fps. 124 frames is **5.1667 actual seconds**, despite its “5 seconds” label. Use actual frames/fps for editing. | Pinned `temporal_shape()` [5]. |
| Geometry | Native 1344×768 is the established production setting; dimensions are multiples of 32. A reference is not a fixed first frame. | Node implementation separates `minimax_refs` from `minimax_keyframes` [5]. |
| Prompt | Six ordered fields; stable subject/reference labels and speaker IDs; dialogue inside `<d>[Language]…</d>`. | Official full-reference guide [4]. |
| Audio intent | `reference` means new generated speech using timbre/delivery/content cues. `fully_copy` means reuse the complete audio signal as the complete soundtrack. | Guide's audio-retention table [4]. |
| Sound | Ambient/SFX in `overall_soundscape`, score in `non_diegetic_music`; use `N/A` for absent score. Dialogue appears only in the shot description. | Official guide [4]. |
| Precision/backend | Verify the exact checkpoint/hardware combination; changing precision can change results. | Release card [1]. |

### Conflicting guidance resolved or left open

- The general FastH3 page describes the older **8-Step-V2 fl2va** model: shift 10,
  res_multistep, and no distilled ref2va. It does **not** describe Omni. Do not
  import those settings or base-H3's 20–25-step advice into the Omni graph.
- The current general Comfy guide warns against Comfy Kitchen attention with
  INT8 ConvRot. The **Omni-specific published template uses that exact pair**.
  We retain the pinned, previously executed recipe. Whether another backend or
  BF16 improves this production is unresolved; compare a fixed-seed sample before
  changing it. This research does not establish that attention caused the errors.
- `ref_image_size=max` retains more reference pixels (never upscales the source)
  and can be much slower. Keep `match` until a controlled identity-fidelity test
  justifies the extra cost. More reference tokens are not automatically better.
- `MiniMaxH3AddGuide` exists in our pinned ComfyUI, but compatibility/quality with
  this distilled Omni checkpoint has not been production-tested. It is an
  experiment, not an already-available fixed-frame guarantee in our workflow.
- MiniMax suggests 350–500 words for a reference-generation detailed description.
  The shared helper is a compact single-shot baseline, not a claim that shorter
  prompts are superior. Add meaningful composition/action/lighting/contact detail
  in its fields; compare against a richer official-format prompt without padding
  with unrelated objects or a second action sequence.

## Shared authoring contract

`packages/jobs/src/fasth3-direction.mjs` formats the prompt. `planJobs()` invokes
it when an asset's schema-validated `gen.direction` exists. Direction stays outside
scalar Comfy node inputs. The generated prompt is part of the cache key.
The existing two-image/one-audio graph supports one shot and one voice through
this helper. Complex conversations span multiple such shots.

```json
{
  "subject": "one brown bear in blue armor, with a red monocle over the left eye",
  "composition": "Medium close-up. The bear's left shoulder presses against the yellow beam; both gloves support its underside. Amber light falls from the right.",
  "characterCount": 1,
  "action": "The beam shifts slightly. The bear braces, looks toward the mechanic offscreen, speaks, then holds the weight steady.",
  "camera": "Locked camera; the beam and shoulder contact remain visible.",
  "soundscape": "Low engine hum, a brief metal creak as the beam shifts, then steady room tone.",
  "slotSeconds": 4,
  "reactionSeconds": 0.5,
  "dialogue": {
    "text": "Roof heavy. Bear expensive.",
    "conditioningText": "Roof heavy. Bear expensive.",
    "language": "English",
    "voice": "the armored bear",
    "delivery": "strained bass-baritone, dry humor masking fear; preserve the written broken English",
    "offscreen": false
  }
}
```

The audio asset's `media.durationSeconds` must contain its measured WAV duration,
including padding. The planner rejects mismatched conditioning text, missing
duration, overfull speech + reaction time, impossible source coverage, and
speed/trim changes that pre-empt review. Every background scene use is checked;
the shortest use limits the speech budget. If no scene references the asset,
`slotSeconds` is required. The helper does not transcribe the WAV: declared text
must come from its synthesis manifest or a verified transcript, not a guess.

Legacy prompts are preserved with an explicit unreviewed-direction warning.
Duplicate image slots also produce a warning. This keeps old plans readable and
does not silently rewrite already generated prompts or approve their content.

For an unoccupied console, use `characterCount: 0` and an offscreen voice. The
prompt then describes the console as the visible subject and the voice as an
independent `(S1)`; it does not request a person to embody the voice.

## Workflow from script to approved take

1. **Write the dramatic scene.** Establish each character's want and tactic,
   the change produced by the exchange, and physical action that proves it.
2. **Plan coverage.** Each source clip is a manageable action/voice performance,
   not an isolated dramatic scene. Record geography, eyelines, prop state and
   the listener's reaction across adjacent clips.
3. **Inspect reference composition.** Confirm count, anatomy, costume, key prop,
   contact points and visible before/after states. A duplicated bear, empty hand
   or generic engine panorama must be corrected before motion generation.
   Reusing a wrong still only makes the wrong thing more consistent.
4. **Prepare clean exact-line conditioning.** Preserve registered voice, language
   and natural speed. Keep other dialogue and background music out. Measure the
   WAV plus planned reaction time against the editorial slot, not source length.
5. **Compile full-reference direction.** Assign each reference a specific role.
   Express the desired positive scene rather than accumulating negative concepts.
   Under BasicGuider, a negative prompt does not supply a separate CFG branch.
6. **Validate representative samples before a full batch.** Select an offscreen
   console, a physical-contact action, a longer emotional line and the threatening
   rival. Keep seed/settings fixed when comparing prompts; change one factor.
7. **Review at natural speed.** Verify exact speech, voice/delivery, lip sync,
   anatomy, identity, contact, action ordering and the edited cut. Listen for
   reference leakage, repeated lines and unwanted score. Review connected turns,
   not just independent clips. ASR/decoding are evidence, not creative approval.
8. **Edit from measured native performances.** Preserve entire intended words
   and reaction beats. Mark extra speech for trimming/regeneration; extending
   every slot blindly retains contamination. Retain original takes and owner edits.
9. **Resume selectively.** Reuse accepted work, regenerate only affected/missing
   shots, re-estimate the remaining-credit ceiling, and keep the run stopped when
   the user has requested a pause.

Steps 3, 6 and 7 require actual review. Prompt fields are not automated visual or
acting validation. Exact-line conditioning addresses an observed production
failure; it is a **project mitigation awaiting FastH3 A/B validation**, not an
official guarantee of verbatim speech. Finished dialogue remains FastH3 audio.

The first bounded [direction validation](NRCU_DIRECTION_VALIDATION.md) rejected
two replacement references for missing beam contact and an extra glove. A console
reference also began in the wrong diagram state. Prompt compliance must be checked
in the pixels. If a flawed reference is used for a narrower diagnostic (such as
offscreen speech), record that limitation and do not promote the result as an
approved action or production take.

## Sources

1. [FastH3 Omni Comfy model card](https://huggingface.co/FastVideo/FastH3-Omni-Comfy)
2. [FastH3 Omni BF16 release / inputs and outputs](https://huggingface.co/FastVideo/FastVideo-FastH3-Omni-8-Step-V1)
3. [Omni template at 1524172f454aff9c87b7e5ebc143af95542bf8f0](https://github.com/Comfy-Org/workflow_templates/blob/1524172f454aff9c87b7e5ebc143af95542bf8f0/templates/video_fasth3_ominiref_r2v.json)
4. [MiniMax official full-reference prompt guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)
5. [Pinned ComfyUI H3 nodes](https://github.com/Comfy-Org/ComfyUI/blob/d52a7a5ef60b36062f7c3c69bd774f4c98b56eb0/comfy_extras/nodes_minimax_h3.py)
6. [Comfy H3 prompt guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide)
7. [Comfy native workflow details](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native)
8. [General H3 settings / attention caveat](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)
9. [Older FastH3 fl2va guide — distinct checkpoint](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-fastvideo)
