# LTX quality: geometry, schedules, frames and attention

Research checked **2026-10-30**. Implementation is in the shared `feat/comfy-model-quality`
worktree, based on production `804d7c2`. Local `origin/main` is `61c5d5d`; its
`packages/jobs/src/plan.mjs` and `workflows/ltx25_i2v_2stage.api.json` are byte-identical
to production before these edits. No applicable `AGENTS.md` exists in this worktree
or its ancestor directories. This review used public documentation/source and CPU tests;
no model downloads, inference, GPU sessions or runtime/credential changes.

## 1. Geometry — confirmed template defect; ordinary plate planner already fixed

Primary evidence:

- [LTX beginner T2V guide](https://docs.ltx.io/open-source-model/usage-guides/text-to-video):
  base width/height divisible by 32; default **768×512**, 97 frames; second stage
  doubles both dimensions to **1536×1024**. These are base settings, not final settings.
- [LTX-2.5 model card, Constraints and Diffusers two-stage example](https://huggingface.co/Lightricks/LTX-2.5#constraints):
  dimensions divisible by 32; example explicitly labels **960×544 as stage 1**,
  with stage 2 taking its dimensions from the upsampled latent.
- [ComfyUI `EmptyLTXVLatentVideo`](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_lt.py):
  creates spatial latent dimensions with `height // 32, width // 32` and temporal
  length `((length - 1) // 8) + 1`. Thus 272 floors to 256 pixels before x2.
- [Lightricks two-stage guide](https://docs.ltx.io/open-source-model/usage-guides/two-stage-generation):
  its width/height are also stage-1 dimensions; stage 2 is 2×.

Our API parameter maps instead accept **final** dimensions and multiply them by 0.5.
Therefore final dimensions must be divisible by **64**, with exact 2× scaling between
stages. Final 960×544 → base 480×272 is invalid and can decode as 960×512. Calling
960×544 universally invalid is incorrect: it is a valid **base**, yielding 1920×1088.

Changes:

- I2V, T2V and derived A2V template defaults now use **512×288 → 1024×576**, exact
  16:9, matching the existing plate-planner default. I2V image scale matches the base.
- Existing nearest-64 plate normalization remains: final request 960×544 resolves
  to 960×576, base 480×288. This is **5:3, not 16:9**. Exact 16:9 at this budget
  should explicitly request 1024×576; portrait can use 576×1024 and square 768×768.
- Fixed optional upscale planning: the old plan passed a 1920×1080 delivery crop
  to the graph, creating invalid base 960×540. It now plans the uncropped generated
  raster, e.g. **960×576 → 1920×1152** for that separate pass. `dims`, parameters,
  stage-1 dimensions and the cache key agree. Crop metadata still records 36/36
  for delivery framing; it is not an executable graph crop. Composition fits/crops
  the media downstream according to authored placement.
- JS and Python job validators reject off-lattice stage-1 dimensions even when
  the two recorded dimensions otherwise satisfy the half-size relationship.
- Corrected stale README/map explanations and regenerated A2V, workflow hashes
  and the cross-language jobs fixture.

Tradeoffs: these are correctness fixes, not measured quality improvements. The chosen
base remains smaller than the beginner guide's 768×512 default to preserve the existing
planned output budget. Increasing the base could improve detail but increases compute.
The optional upscale job reuses the generation graph and start image; it does not consume
the earlier plate's retained latent. This work does not turn it into a true latent-reuse
upscale. The shared I2V preprocessing still feeds the base-sized image into both conditioning
stages; preserving an independent full-resolution stage-2 image is a separate quality A/B.

## 2. Refinement sigmas — two official variants, no automatic switch

All three repository graphs keep their current refinement schedule.

| Exact pipeline/source | Stage 1 | Stage 2 |
| --- | --- | --- |
| Repository I2V/T2V, distilled Comfy int8-convrot, CFG 1, `euler_ancestral` | `1, .99375, .9875, .98125, .975, .909375, .725, .421875, 0` | **`.85, .7250, .4219, 0`** |
| [Official built-in `video_ltx2_5_t2v`, pinned Comfy-Org revision](https://github.com/Comfy-Org/workflow_templates/blob/abb9cf6477b59c52dbe234c67f82318dadd872b2/templates/video_ltx2_5_t2v.json) | Same, ManualSigmas node 404 | **`.85, .7250, .4219, 0`**, ManualSigmas node 395 |
| [Lightricks advanced Two Stage Distilled, pinned revision](https://github.com/Lightricks/ComfyUI-LTXVideo/blob/220e1d45aa0469f518e982102fca4dca92a61862/example_workflows/2.5/LTX-2.5_T2V_I2V_Two_Stage_Distilled.json) | Same, node 4984 | **`.909375, .725, .421875, 0`**, node 4985 |
| [Native Python distilled constants, pinned revision](https://github.com/Lightricks/LTX-2/blob/e98f6d927d83c92ef2be6aec76c8440b19306e39/packages/ltx-pipelines/src/ltx_pipelines/utils/constants.py) | `DISTILLED_SIGMA_VALUES`, same | `STAGE_2_DISTILLED_SIGMA_VALUES`, **`.909375, .725, .421875, 0`** |

The built-in template also loads the **same Comfy int8-convrot distilled transformer**
as this repository; the advanced example loads bf16. Both are distilled routes, not
the full/dev + distilled-LoRA route. The advanced graph's actual stage-2 sampler node
4976 is `euler_ancestral`; its outer subgraph widget displays `euler`, so the actual
node and links should be checked rather than inferring from that label alone.
The repository's A2V derivative freezes supplied audio and uses `euler`, a further
pipeline difference. The Python constants separately contain a tiled-data-parallel
schedule `[.625, .4, 0]`; that is not the schedule for these ordinary two-stage graphs.

**Verdict:** `.909375` is a verified official candidate, but the claim that `.85`
is simply an incorrect unofficial value is false. Compare matched seed, prompt,
image, frames, resolution, checkpoint and sampler, changing only refinement sigmas.
Review identity, motion adherence, temporal stability, fine detail and artifacts.
The .4219 versus .421875 rounding also differs. No clip A/B was authorized or run,
so neither quality superiority nor equivalence is established.

## 6. Frames and prompt guidance

The [model card](https://huggingface.co/Lightricks/LTX-2.5#constraints) explicitly
requires `num_frames % 8 == 1`: 1, 9, 17, …, 97, 121, etc. The ordinary plate planner
already resolves to nearest 8n+1 (100→97; 101→105); the agent's source-shot helper
rounds upward so it covers the editorial slot. Both policies produce valid model
inputs; frame-lattice validity alone does not guarantee a requested minimum duration.

The legacy A2V presenter path previously copied narration frames without normalization.
It now rounds **up** to 8n+1 (100→105), records dimensions/frames and validates them.
Its narration replacement warnings now use the structured `PLAN_*` warning contract.
Audio preparation still owns waveform timing/padding; rounding video frames does not
prove lip-sync quality or validate the supplied WAV. The graph retains the encoded,
frozen conditioning audio. Ordinary plate nearest-rounding behavior is preserved.

FPS now reaches conditioning, empty audio and output video consistently in I2V/T2V
and the optional upscale map. Previously empty audio stayed at 24 and the upscale
container could stay at 24 despite a different requested fps.

**Findings for the prompt-owning agent (no prompt-file edits in this work):**
[Official prompting guide](https://docs.ltx.io/open-source-model/usage-guides/prompting-guide)
recommends a focused scene, present-tense observable actions, specific camera language,
consistent lighting and explicit audio. A simple shot works as one flowing paragraph,
roughly 4–8 sentences. I2V should emphasize motion/action/audio because the image supplies
appearance; prefer one continuous take unless deliberately cutting away. “One camera
move + one main action + sound plan” is a useful application constraint, **not a universal
model restriction**: the current guide explicitly supports 2–4-shot prompts with named
cuts and audio continuity. This repository's LTX outputs omit audio at CreateVideo, so
a sound description must not be represented as native sound delivery; finishing-sound
intent remains necessary. Critical titles/labels belong in post, per the guide.

## 9. SageAttention — recommendation only

- [Official SageAttention README](https://github.com/thu-ml/SageAttention/blob/main/README.md)
  documents architecture/CUDA-specific kernels and FP16/BF16 inputs, quantized attention,
  and warns that globally replacing SDPA does not work for every model. It recommends
  modifying the target attention implementation and replacing DiT attention for video.
  It also recommends SageAttention2 over 3 for precision-sensitive applications.
- [Official example coverage](https://github.com/thu-ml/SageAttention/blob/main/example/README.md)
  lists **LTX-Video 0.9.7-dev**, not this exact LTX-2.5 Comfy int8-convrot pipeline.
- [Current LTX repository optimization guidance](https://github.com/Lightricks/LTX-2/blob/e98f6d927d83c92ef2be6aec76c8440b19306e39/README.md#-optimization-tips)
  describes FlashAttention 4 on datacenter Blackwell, FlashAttention 3 on Hopper,
  and automatic PyTorch SDPA on other CUDA GPUs. This is not evidence of an LTX-2.5
  SageAttention quality win.

Recommendation: treat SageAttention as an optional **performance experiment** after
geometry/prompt fixes. Establish GPU, CUDA/PyTorch and attention-mask compatibility;
measure end-to-end cold/warm time, memory and matched-clip quality. Kernel TOPS or old
LTX benchmarks do not prove a quality improvement or production speedup here. No
installation, launch flag, monkeypatch or runtime change was made.

## CPU verification

- Node focused planner/upscale tests: **52 passed**.
- Node motion-defaults/variant tests: **14 passed**.
- Python workflow injection, cross-language jobs contract and schema tests: **149 passed**.
  The all-workflow fixture helper now explicitly roots all fixture assets, so current
  reachability pruning cannot silently omit T2V/A2V and other contract graphs.
- Regression coverage includes standalone defaults, landscape/portrait/square geometry,
  unsafe half-size dimensions, upscale pre-crop dimensions, A2V frame rounding and
  synchronized graph fps. No visual-quality claim is inferred from CPU tests.

## Receipt compatibility addendum — 2026-10-30

Changing default graph bytes changes their SHA-256. Parent review identified that
the contribution gate previously compared even **already completed trusted receipts**
to today's graph bytes, which would invalidate genuine delivered LTX assets after this
upgrade. A private read-only eligibility helper now preserves the following exact
production `804d7c2` identities (verified with `git show` and SHA-256 of the graph bytes):

| Generator | Workflow under `workflows/` | Pre-quality SHA-256 |
| --- | --- | --- |
| `ltx25` | `ltx25_i2v_2stage.api.json` | `97e205ad993996ac937a9a65ef7040973260bdc939041a23c3109184dc48c5e3` |
| `ltx25` | `ltx25_t2v_2stage.api.json` | `4975aa404c21e04a470db76327eef2548397ffe893c67475f70e42c9d66c8847` |
| `ltx25-a2v` | `ltx25_a2v_2stage.api.json` | `81b7701ecbe172df0e73ca19a3cbc9e236b84842c6ddf5aa928527c0c9e20f70` |

Each pinned graph's node 1 is `UNETLoader` loading
`ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` with default weight
dtype. A historical receipt must match its generator/path/hash tuple exactly and be a
completed supported-backend receipt with run/job/attempt identities, jobs/capture/output
hashes, positive byte count and measured dimensions. If it includes `checkpoint` or
`family`, those fields must match the pinned LTX identity. `model` remains an alias,
not loader evidence. Receipts come only from the existing server-owned provenance
stores; an imported package or uploaded sidecar cannot supply this evidence. Final
verification still requires ready, visible media whose bytes match the trusted receipt.

**Migration boundary:** the historical table is consulted only when reading existing
completed contribution evidence. New receipt minting, pending-plan eligibility,
current-workflow validation and downloaded-run recovery still require the current
graph hash and loader checks. An old pending job whose workflow no longer matches
**must still fail**; no automatic rehashing or mutation of user packages/receipts is
performed. Server-owned copying may retain existing evidence. Existing H3/Klein and
delivered-render receipt contracts are preserved.

Regression checks: current LTX minting succeeds for all three graphs; old trusted
receipts remain readable and copyable; wrong hashes, paths, generators, checkpoint
claims, completion fields, uploaded receipts and changed output bytes fail. Historical
hashes cannot mint generation receipts or authorize pending plans; recovery explicitly
rejects an old pinned workflow even with internally consistent run/plan hashes.
Focused contribution and embedded-recovery suites passed **32 tests** (including the
concurrently added Klein reference regression).
