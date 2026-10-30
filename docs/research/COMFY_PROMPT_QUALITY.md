# Comfy prompt quality: Klein captions, references and LTX shot direction

Research date: **2026-10-30**. Scope: prompt authoring, caption decoration, skills
and repair guidance on `feat/comfy-model-quality`, baseline `804d7c2`. Comparison:
local `origin/main` at `61c5d5d78f51b1eaf4dfa3442a97fcefb52fa1b2`.
No applicable `AGENTS.md` was found in this repository or its ancestor directories.

## Findings and decisions

| Claim | Evidence-based conclusion | Prompt-side change |
| --- | --- | --- |
| 3: 40–70 words should become 80–150, camera first | The old short, subject-first rule is unnecessarily restrictive, but **80–150 is not BFL's published t2i range**. Its current upsampler says **100–350 words**, more for complex scenes, and medium/style first, then scene/light/camera. | Use contextual richness, early medium/framing and that non-binding range; never pad or invent source facts to hit a quota. |
| 4: describe the result, not the edit | ComfyUI says this, but BFL's current upsampler distinguishes a bounded edit instruction from a new composition. These primary sources are not fully consistent. | Full result captions for new compositions; concrete end-state instructions plus preservation clauses for bounded edits. Remove the decorator's forced `Restyle this …` / `Edit the supplied reference: …` wrapper. |
| 4: use reference tokens | ComfyUI documents zero-based `<ref_image_0>`, `<ref_image_1>`. The correspondence is **connected latent order**, not arbitrary asset IDs or H3 Picture numbering. | Teach only verified connected roles. The generated LTX start-frame caption names the verified two-image pair with those tokens; larger legacy lists/custom input overrides receive no inferred token mapping. |
| 5: no Klein negatives at CFG 1 | Correct for the ordinary distilled CFG-1 sampler path; not a universal claim about all models. | Positive surface direction replaces the agent caption decorator's negative list. Preserve LTX negative conditioning and independent H3 guidance. |
| 6: fixed-shape, focused LTX shots | Useful for this application's single-shot i2v path. Official LTX also supports multi-shot prompts; one shape is not a model-wide requirement. | Early shot/camera, one observable action/end state, coherent light and material continuity, separate finishing sound, no internal cuts for this path. |

These are source-backed authoring corrections, **not evidence that prompt defects
caused a particular failed delivery**. No controlled visual comparison, model call,
paid generation, GPU run or model download was performed for this research.

## Primary sources and exact language

Sources were retrieved on the research date. URLs pointing to `main`/`master` are
mutable; the quotes below record what was read, not a claim about every historical
release.

### BFL model documentation

[FLUX 3 Image Klein](https://docs.bfl.ml/flux_3/flux3_image_klein):

> “Klein is trained on full scene captions.”

> “If you skip it, write full scene captions yourself: framing, subject, background and lighting.”

The page says the reference CLI runs the upsampler by default and warns that the
Diffusers pipeline does not call it. Its distilled/base table specifies CFG 1/3.5
respectively. The manual-caption exception matters: adding a few deterministic
suffixes is not equivalent to running the vision-language upsampler.

[Official upsampler model card](https://huggingface.co/black-forest-labs/flux-3-image-klein-pup/blob/main/README.md):

> “Any other LLM can do the job with the system prompts in `system_prompts.json`.”

> “For an edit it looks at the references and writes the instruction around what is in them: what changes, what stays, by appearance.”

The card supports another LLM as a caption writer; it does not validate the quality
of this application's planner. Reference-aware expansion requires actual images
or grounded descriptions. An asset ID alone is not visual observation. The model
card also notes that small reference details can be described wrongly after resize.
Prompt expansion is distinct from the local diffusion text encoder; these changes
do not replace or remove that encoder.

### BFL upsampler's actual instructions

[Official `system_prompts.json`](https://huggingface.co/black-forest-labs/flux-3-image-klein-pup/raw/main/system_prompts.json), `t2i`:

> “Lead with medium and style, then scene, lighting and camera, then the subjects with concrete colors, materials and state.”

> “Typical length is 100 to 350 words, more for complex scenes.”

> “transcribe every wording verbatim inside double quotes in its original language and script, keep the line breaks of multi-line text”

Its `i2i` instruction:

> “When one reference stays and gets bounded changes, write an imperative editing instruction on it”

> “When the references are drawn into a newly composed frame (combining subjects, a new scene, a garment, object or style donor), write a generation request”

> “Describe the change, not the whole scene, and close an editing instruction with one compact clause naming what stays unchanged”

> “Typical length is 50 to 150 words.”

Both ordinary `t2i` and `i2i` upsampler instructions forbid angle-bracket tokens;
ordinary `i2i` names images by ordinal. The separate `i2i_bbox` instruction uses
`ref_image_0`, `ref_image_1`, etc., and angle-bracket citations. Therefore, do not
describe tokenized local Comfy prompts as verbatim adoption of the ordinary BFL
upsampler format. These changes adapt its scene/detail/fidelity principles to the
existing local workflow; they do not implement bbox annotation or a new upsampler.

BFL permits filling unspecified creative details and even authoring missing text.
This application deliberately applies stricter source fidelity: approved exact
copy/dialogue, identity, supplied facts and ordered labels win. It does not add
people, biographies, props, brands, evidence, story events or lettering merely to
lengthen a caption. Early camera/framing is a composition aid, not a demonstrated
universal optimum or permission to invent lens blur.

### ComfyUI guidance and the editing discrepancy

[Official Klein tutorial](https://docs.comfy.org/tutorials/flux/flux-3-klein):

> “Write the result, not the change.”

> “The image editing templates expect a full caption of the finished image with the edit folded in”

The same page's example is `In <ref_image_0>, change the dress color <obj_1> to red`.
This and BFL's task-specific instructions rule out treating “never use an edit
instruction” as settled official guidance. Concrete end state, grounded referents
and preserved features are compatible across the sources. A new scene should not
be constrained by an automatic “keep exact layout / do not add or remove elements”
suffix when the requested edit changes layout or content.

For references the tutorial explicitly says:

> “The first reference is `<ref_image_0>` in the prompt, the next is `<ref_image_1>`, and so on”

It says references go into both positive and negative conditionings. This means
latent/image wiring, not that a user must repeat tokens in a negative text field.

## Verified reference correspondence in this repository

[ComfyUI `ReferenceMultiLatent`](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_edit_model.py)
sorts image keys by `int(name.removeprefix("image"))`, skips missing images, VAE
encodes the connected images and appends the resulting `reference_latents` list
to positive and optional negative conditioning. It does not look up package IDs
from words in a prompt. Prior conditioning with already-appended references could
also affect order; the local graphs start with ordinary text conditioning.

Local graph/planner inspection:

| Path | Verified mapping |
| --- | --- |
| `workflows/flux3_klein_ref_edit.api.json` | `LoadImage(10)` → `ReferenceMultiLatent(12).images.image0` → `<ref_image_0>` only. |
| `workflows/flux3_klein_ref2_edit.api.json` | node 10 → `images.image0` → `<ref_image_0>`; node 11 → `images.image1` → `<ref_image_1>`. |
| `packages/agent/src/tools.ts`, `mergeRefs` | Explicit refs first, then deduplicated implicit cast refs. Model-family cap is not a promise that every graph wires that many references. |
| `packages/jobs/src/plan.mjs` | Exactly two references select the two-reference graph; public `reference_2` becomes upload parameter `_reference_2`. The `_2` is the **second file**, whose token is **`<ref_image_1>`**. |

At the inspected baseline, three-plus-reference legacy lists upload and record
additional files but do not select a graph connecting every reference. Prompt
wording cannot repair this. Do not teach `<ref_image_2>` etc. as available just
because `reference_3` appears in provenance. The integration follow-up now rejects
unsupported third/higher sources, alias conflicts and implicit cast overflow at
tool planning, JS job validation, Python preflight and receipt boundaries. It also
removes unconnected upload declarations from the single-reference map. Supported
one/two-image ordering is retained; arbitrary N-reference graphs remain deferred.
See the [reference-integrity addendum](COMFY_KLEIN_RUNTIME.md) for implementation
and tests, including an actual two-input submission to the local fake runner.

For the generated LTX start frame, the tool requests `[composition, identity]`;
the verified two-file case is therefore composition `<ref_image_0>`, identity
`<ref_image_1>`. H3's `image` identity is **Picture 1** and `reference` composition
is **Picture 2**: blindly carrying those labels into Klein reverses conventions.
The prompt compiler now checks both role values, known workflow and absence of
extra reference inputs before emitting the tokenized pair. It does not attach
tokens automatically to arbitrary direct image captions.

## Negative guidance scope

The Comfy tutorial says distilled Klein runs with CFG 1 and raising CFG does not
help. [ComfyUI sampling code](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/samplers.py)
uses `uncond_pred + (cond_pred - uncond_pred) * cond_scale` in the ordinary CFG
function and skips the unconditional branch at scale 1 unless the optimization
is disabled. At 1 the standard result is the conditional prediction. Custom
sampler hooks are outside this conclusion.

Thus a separate negative prompt is not an effective exclusion control for these
distilled Klein graphs. This does **not** establish that every natural-language
negation causes the unwanted object, nor that LTX/H3 lack negative conditioning.
The prior global claim in `agent.ts` was removed. The agent caption decorators now
use `plain, unmarked surfaces` for text-free imagery, preserving exact supplied
lettering when requested. This is direction, not an OCR guarantee. Job-planner
suffixes and LTX negative conditioning are separate execution policy owned by the
workflow/planner workstream.

## LTX structure and sound boundary

[Official LTX prompting guide](https://docs.ltx.io/open-source-model/usage-guides/prompting-guide):

> “Write your prompt as a **single flowing paragraph**”

> “Aim for roughly **4–8 descriptive sentences**”

> “For image-to-video from a first frame, prefer a **single continuous take** unless you intentionally describe a cut away from that opening image.”

The guide also explicitly supports LTX-2.5 multi-shot scenes and audio. The local
`ltx25_i2v_2stage` route is picture-only with an external finishing-sound contract;
do not turn that implementation boundary into a model-wide inability to generate
audio. Here camera/framing precedes subject/composition and action in the compiled
paragraph. The agent supplies one achievable action/end state, one camera move,
consistent light and a separate concrete sound plan. No new timing, geometry,
frame enforcement, sampling, dialogue routing or H3 prompt format is introduced.

## Authoritative prompt sources and drift control

- **Builder:** `packages/agent/src/agent.ts`, with the shared policy in
  `packages/agent/src/prompts/model-quality.ts`. Existing H3 section formatting,
  exact dialogue, source-copy and reference-identity requirements remain separate.
- **Model-facing schemas and execution:** `packages/agent/src/tools.ts` consumes
  the same Klein/LTX guidance constants. `generateImageSchema.intent` already
  accepts rich captions without a short word/character cap. `caption.ts` decorates
  authored intent deterministically; it neither observes references nor adds a
  semantic model call. The LTX start-frame and video prompt assembly also live in
  `tools.ts`. `expandVideoCaption` is a separate existing helper, not this film path.
- **Focused repair:** both repair systems in `apps/server/src/agent-runner.mjs`
  import the shared policy via the agent package export instead of copying it.
  Their existing only-fix-reported-issues and preserve-ready-assets rules apply.
- **Conversation:** `packages/agent/src/skills/storyboard-direction/SKILL.md`
  contains a compact planning-level summary. The registry in `skills/index.ts`
  loads the canonical Markdown body at runtime (source or published-source
  fallback), strips `## Sources`, and is not a second embedded copy. Storyboard
  skill version is `1.4.2`; catalog version is `1.5.2`. The 512-character visual
  summary is not the model-caption length limit. Conversation instructions do not
  expose builder generation tools.
- **Hermes film entry point:** `plugins/comfyrizz/skills/comfyrizz-film/SKILL.md`
  gives planning/continuity guidance through the actual MCP tool set. The MCP
  server's short embedded instructions in `packages/comfyrizz-mcp/src/server.mjs`
  govern plan/assembly/export/retake, not a duplicate model-caption policy. Internal
  `assets.generate_*` calls are not introduced into this plugin skill.
- **Related boundaries:** `prompts/motion.ts`, `video-types.ts`, `presenter.ts`,
  `production-tools.ts`, `production-planner.ts`, and other bundled skills govern
  routing, presets, presenter and production control, not a second Klein length
  policy. Historical GPU-test/research docs and demo scripts retain their evidence
  and example status; they are not loaded as current prompt rules.

Compared with `origin/main`, the baseline builder/caption/skill policy was the
same; existing unrelated branch changes in `tools.ts` and server repair/timing
code were retained. The new shared policy prevents divergent builder, tool-schema
and repair instructions. Planning-only skills intentionally summarize it at their
own capability boundary rather than reproducing a long builder prompt.

## Verification and remaining uncertainty

CPU checks cover exact multilingual source text and line breaks through the schema
and caption planner; intact result and bounded-edit prose; absence of automatic
negative lists/token guesses; shared builder/tool guidance; actual two-image graph
links and role ordering; third-reference caveats; LTX picture/sound separation;
and existing H3/native-dialogue behavior. Skill tests verify loaded canonical bodies,
versions and compact budgets; the server conversation contract checks the current
skill in model requests.

Verification completed in the shared workspace:

```sh
packages/agent/node_modules/.bin/tsc -p packages/agent/tsconfig.json
node --test packages/agent/dist/test/*.test.js
node --test apps/server/test/animation-tool-contract.test.mjs
node --check apps/server/src/agent-runner.mjs
git diff --check
```

Results: agent build passed, **589/589 agent tests** passed, **3/3 server contract
tests** passed, syntax and whitespace checks passed. The initial `pnpm` launcher
failed because its cached executable was missing; after the parent supplied
dependencies, the package-local compiler and Node test runner completed the checks.
Agent output: `/tmp/opencode/comfy-prompt-quality-agent-tests.log` (local evidence,
not a committed artifact).

No evidence yet establishes that 100–350 words always outperforms a shorter clear
caption, that manual captions match BFL's fine-tuned upsampler, or that the positive
surface guard reliably prevents lettering. Actual caption quality still depends
on the planner and visual access; short direct callers remain accepted rather than
being padded with invented detail. References constrain but do not guarantee
identity, geometry, spelling or continuity. A future visual comparison should hold
model/seed/reference inputs constant and score the requested content and exact copy,
not infer success from prompt length or a completed export alone.
