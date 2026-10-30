# Klein sampling policy and official int8 eligibility

Research date: **2026-10-30**. Repository baseline: `804d7c2` on
`feat/comfy-model-quality`; comparison ref: `origin/main` at
`61c5d5d78f51b1eaf4dfa3442a97fcefb52fa1b2` (local ref, not refreshed).

## Decisions

1. **Keep distilled Klein's 16-step production default, including iteration level
   `draft` and repair retries.** Claim 7's automatic 8-step policy is not supported
   by the official defaults or this application's iteration semantics. An explicit
   author-supplied `gen.inputs.steps` already survives planning and changes job/cache
   identity. A separate, explicitly non-final preview mode could be researched later.
2. **Defer an executable official-int8 profile.** Claim 8 is directionally correct:
   replacing the transformer and local text encoder saves **9,286,689,837 bytes**
   (9.287 decimal GB / 8.649 GiB) against the current Klein downloads. Official
   Comfy templates use these weights. However, gated metadata masks their weight
   SHA-256/LFS identifiers, no runtime/quality verification was performed, and a
   profile needs coordinated workflow, bootstrap, cache and receipt changes.

The initial steps/weights work adds research only; the later reference-admission
fix is recorded in the addendum below. No weight downloads, dependency installation,
GPU/API generation, credentials, production runtime/provenance ledger writes, or
commits were used. Tests use isolated synthetic fixtures.
The local Qwen text encoder remains necessary; an API caption writer cannot replace it.

## Official evidence and source quotes

All sources below were read on **2026-10-30**.

- [BFL Klein documentation](https://docs.bfl.ml/flux_3/flux3_image_klein):
  “**Distilled** is step-distilled for fast inference. **Base** is the undistilled
  model for fine-tuning, LoRA training, and research.” Its table specifies distilled
  **16 steps / CFG 1** and Base **50 steps / CFG 3.5**.
- [BFL Comfy model card](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy):
  “Sample with the defaults of the checkpoint: 16 steps and no guidance for the
  distilled checkpoint, 50 steps and CFG 3.5 for the base checkpoint.” Also:
  “Files with `-base-` in the name are the base checkpoint; the others are the
  distilled checkpoint.” This is FLUX **3** Klein, not an earlier Klein variant
  whose distillation schedule might differ.
- The same card states: “The int8 files run on 8 GB GPUs such as the RTX 3070, and
  on GPUs without FP8 support (RTX 30 series and older). NVFP4 needs a Blackwell
  GPU.” This is upstream compatibility guidance, not a measured Colab memory or
  speed guarantee for our entire application.
- The same card states: “Do not use the model without a prompt upsampler,” and
  allows “any LLM you prefer with a system prompt that expands the request into
  one full scene caption.” The BFL docs qualify manual use: “If you skip it, write
  full scene captions yourself: framing, subject, background and lighting.” Caption
  expansion and diffusion text encoding are distinct operations.
- [Official Comfy distilled t2i template](https://github.com/Comfy-Org/workflow_templates/blob/abb9cf6477b59c52dbe234c67f82318dadd872b2/templates/image_flux3_klein_distilled_t2i.json):
  “this template ships the quantised distilled checkpoint to keep the footprint
  small. With more than 24 GB of VRAM, use the bf16 weights instead”.
  Its top-level subgraph widget values select **16**, `euler`, `simple`, the
  official int8 transformer and int8 Qwen encoder. CFG is 1 in the nested sampler.
- [Official Comfy distilled edit template](https://github.com/Comfy-Org/workflow_templates/blob/abb9cf6477b59c52dbe234c67f82318dadd872b2/templates/image_flux3_klein_distilled_image_edit.json)
  uses the same int8 loader names and a 16-step / CFG 1 / Euler / simple sampler.
- [Official Comfy Base t2i template](https://github.com/Comfy-Org/workflow_templates/blob/abb9cf6477b59c52dbe234c67f82318dadd872b2/templates/image_flux3_klein_t2i.json)
  selects Base int8, **50** steps and **3.5** CFG through its top-level subgraph.
  **Inspection pitfall:** the nested t2i KSampler retains stale widget defaults
  (15 steps, CFG 1, `er_sde`), but linked subgraph inputs override the exposed
  fields. Reading only nested `widgets_values` would report the wrong settings.

The Comfy template tree was resolved to
`abb9cf6477b59c52dbe234c67f82318dadd872b2`. BFL's own `workflows/README.md` returned
HTTP 401 without authentication, so the runnable-template evidence above comes
from the official Comfy organization rather than claiming to have read the gated
BFL workflow bodies.

## Claim 7: what the existing code actually does

### Model and step path

- `colab/models.lock.json` downloads `black-forest-labs/flux-3-image-klein`
  `model.safetensors` at `337337621b8526e120f2275d250242f4a6bedd75`, then exposes it
  as `diffusion_models/flux-3-image-klein-bf16.safetensors`. This is distilled, not
  `flux-3-image-klein-base`.
- `workflows/build_gpu1.py` and the four `workflows/flux3_klein_*.api.json` graphs
  default to 16 steps, CFG 1, Euler and simple scheduling. Their parameter maps
  expose `steps` to node 7; img2img additionally exposes its denoise setting.
- `packages/agent/src/tools.ts`, `generateImageSchema` / `planImage`, has no
  iteration-level or public `steps` field. Default image inputs include caption,
  dimensions, seed and optional references/text/cutout controls, but omit steps.
  An injected `planImage` implementation can supply `planned.inputs`, including
  explicit steps. Directly authored package inputs can also supply steps.
- `packages/jobs/src/plan.mjs` copies `gen.inputs` to `params`; it does not replace
  Klein steps or choose them from iteration level. The runner's mapped-parameter
  path (`pipeline-py/comfyrizz_pipeline/runner.py`, with the graph materialization
  helper in `capture.py`) overlays provided values on the pinned graph. Thus the
  normal path executes 16, while explicitly provided steps remain effective.
- `cacheKeyFor` includes `params`, `workflowSha256`, `model` and `modelRevision`.
  The canonical jobs document hash also changes when steps change. Omitted steps
  are represented by the pinned graph hash rather than a resolved scalar in
  `job.params`; adding a default scalar now would change existing identities.

### Iteration is not a sampling-quality tier

`apps/server/src/productions/iteration.mjs` explicitly defines iteration as the
user's **creative-iteration budget**: candidates, rounds, auditions, picking and
review depth. Its closed stage schema contains `takes`, `rounds`, `auditions`,
`pick` and voice `linesPerVoice`, not diffusion steps. `draft` selects one take,
one round and zero keyframe auditions. `packages/agent/src/production-planner.ts`
enforces those take limits; it does not propagate a sampler-quality level into
`planImage` or jobs. There is no implicit promise to regenerate the selected
draft-level image at 16 steps before final delivery.

The existing final contribution gate verifies supported visible generation, not
a minimum denoising-step count. It must not be mistaken for an automatic quality
promotion mechanism. Automatically reducing draft/repair jobs to 8 can therefore
put an 8-step image directly into a final film or its downstream video conditioning.

**Recommendation:** retain 16 for ordinary production and repair. Treat 8 as an
unvalidated, explicitly selected preview experiment, not an official draft default
or a guaranteed 2x end-to-end speedup. A future preview feature needs a separate
purpose/quality contract, explicit-step precedence, resolved steps before hashing,
and a defined final promotion/regeneration path that also invalidates dependent
video jobs. Preserve explicit author overrides rather than silently coercing them.
Compare fixed captions/seeds at 8 and 16 on representative text, reference edits,
identity and final-film stills before selecting any automatic policy.

### Comparison with `origin/main`

At the stated baseline, Klein graphs/maps, `colab/models.lock.json`, bootstrap,
iteration contract and agent workflow manifest have no committed changes relative
to `origin/main`. The only `plan.mjs` delta is ready-dependency regeneration scope;
the `defaults.mjs` delta recognizes additional camera wording. Neither changes
Klein steps. Image-tool changes include caption/aspect/reference handling, still
without an iteration-to-steps policy. The contribution/receipt implementation is
new on this branch relative to `origin/main` and must be preserved. No applicable
`AGENTS.md` was found in this repository or its ancestor directories.

## Claim 8: exact official file inventory

Repository: `black-forest-labs/flux-3-image-klein-comfy`.
[Model metadata](https://huggingface.co/api/models/black-forest-labs/flux-3-image-klein-comfy)
resolved `main` to **`feef60b0aaf63a4773ace96636ebbcf43b881312`**, last modified
`2026-10-17T07:10:12.000Z`, `gated: auto`.
The following values were checked against the
[revision-pinned tree API](https://huggingface.co/api/models/black-forest-labs/flux-3-image-klein-comfy/tree/feef60b0aaf63a4773ace96636ebbcf43b881312?recursive=true&expand=false).

**Every safetensors file's `lfs.oid` and `xetHash` was masked as 64 asterisks.**
The 40-hex values below are Git tree-entry blob OIDs (for weights, LFS pointer
blobs), **not weight SHA-256 values**. Do not insert them into `sha256` fields.

| Exact repository path | Bytes | Git blob OID |
| --- | ---: | --- |
| `diffusion_models/flux3-image-klein-bf16.safetensors` | 11,097,404,512 | `36d986aa9c4e54eb26e1b5d80455cc6546da9ce3` |
| `diffusion_models/flux3-image-klein-int8-convrot.safetensors` | 5,827,874,779 | `fd455429b3e87418302c0717e3ba68fe3aca525d` |
| `diffusion_models/flux3-image-klein-nvfp4.safetensors` | 5,277,685,632 | `9381f7b0a49093bcd9105e8b093b2a1f90ab56c9` |
| `diffusion_models/flux3-image-klein-base-bf16.safetensors` | 11,076,957,072 | `d14d35da5f5cc4f47127a504cc5dfcb53a8a774d` |
| `diffusion_models/flux3-image-klein-base-int8-convrot.safetensors` | 5,807,427,339 | `450f47e2f4811aaa396fe646ba76741f1c2f31b8` |
| `diffusion_models/flux3-image-klein-base-nvfp4.safetensors` | 5,257,238,192 | `ee7856f7681f68ae4d318f4c5eeb7201819134bd` |
| `text_encoders/qwen3vl_4b_bf16.safetensors` | 8,875,719,408 | `431ac79fc03e5336825508b7d0fb9e378147d76b` |
| `text_encoders/qwen3vl_4b_int8_convrot.safetensors` | 4,858,559,240 | `f3e18bede7712a8a068eeef83327c2aeaf380580` |
| `text_encoders/qwen3.5_9b_flux3_prompt_upsampler_bf16.safetensors` | 18,819,722,392 | `fd01bc79ba8088da5a2e7a2a36d2511b698f3264` |
| `text_encoders/qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors` | 9,748,113,996 | `99410a6ad9e2c999faf11d8fbe994f20cbfcba45` |
| `text_encoders/qwen3.5_9b_flux3_prompt_upsampler_w4a8.safetensors` | 6,724,090,780 | `8ce417fe16d94f58acea680c13bbcffa58e09b4b` |
| `vae/flux2-vae.safetensors` | 336,211,292 | `78f8fcf4adb004763e3335b937a9d7a6dfa9f5b5` |

### License identity

The model card identifies **FLUX Kommunity License v1.0** for the model: “non-commercial
use, plus commercial output generation by Qualifying Users with less than US$5M
in gross annualized revenue, including affiliates, subject to the license terms.”
It separately identifies **Apache-2.0** for Qwen3-VL-4B-Instruct and the prompt
upsampler. Quantizing the model does not turn its license into Apache-2.0 or CC0.
The VAE is distributed in this repository under its model terms; a separate
per-file VAE license was not independently recovered.

The tree reports `LICENSE.md`: **19,593 bytes**, Git blob
`044cf48568c278150d132a7479ea237a79766ea7`; `NOTICE.md`: **330 bytes**, Git blob
`ee97a99bbf8ad09b197cf3cb6a079084876b0376`; `workflows/LICENSE.upstream`:
**1,074 bytes**, Git blob `ec6ae8a4821329f417a3e74e6dd108f499d08290`.
The [revision-pinned license body](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/raw/feef60b0aaf63a4773ace96636ebbcf43b881312/LICENSE.md)
returned HTTP 401. These are metadata identities, not a locally computed license
SHA-256 or a claim that the full gated license text was fetched. Preserve the
existing separation of `model_license` from generated-output `license`.

### Download accounting

Current Klein lock downloads:

```text
transformer             11,097,404,512
Qwen encoder shard 1     4,967,229,296
Qwen encoder shard 2     3,908,490,048
VAE                       336,211,292
total                  20,309,335,148
```

Official distilled int8 transformer + int8 Qwen encoder + same VAE totals
**11,022,645,311 bytes**, saving **9,286,689,837 bytes**, about **45.73%** of current
Klein downloads. With the current non-Klein lock entries unchanged, total lock
downloads would go from **60,019,207,384** to **50,732,517,547 bytes**.
This is byte arithmetic, not a measured setup-time or GPU-memory improvement.
It would also remove the sharded-Qwen merge (historically measured at 22.2 seconds).

The current merged BF16 encoder is recorded as 8,875,719,384 bytes; the official
repacked BF16 encoder is 8,875,719,408 bytes. Equal model architecture or nearly
equal file length is not evidence of byte identity.

The savings above exclude a local prompt upsampler, because the current model lock
does not contain one. Adding the official **int8 upsampler** makes the proposed
total **20,770,759,307 bytes**, **461,424,159 bytes larger** than today's Klein
download. Adding the Comfy templates' **w4a8 upsampler** instead totals
**17,746,736,091 bytes**, saving **2,562,599,057 bytes**. These alternatives require
their own runtime/caption-quality work; a blanket “10 GB saved” claim is misleading
if the upsampler is added simultaneously.

## Loader compatibility and implementation boundaries

Official templates wire `UNETLoader` with
`flux3-image-klein-int8-convrot.safetensors` / `weight_dtype=default`, `CLIPLoader`
with `qwen3vl_4b_int8_convrot.safetensors` / `type=flux3` / `device=default`, and
`VAELoader` with `flux2-vae.safetensors`. No hosted text-embedding API is involved.

The repository's Colab Comfy pin `ce1e922` resolves to
`ce1e922d8623bb507180e32a0c01a7d0e29edef7`. Source inspection confirms:

- [supported_models.py](https://github.com/Comfy-Org/ComfyUI/blob/ce1e922d8623bb507180e32a0c01a7d0e29edef7/comfy/supported_models.py)
  recognizes `Flux3` and a `qwen3vl_4b` text-encoder target.
- [sd.py](https://github.com/Comfy-Org/ComfyUI/blob/ce1e922d8623bb507180e32a0c01a7d0e29edef7/comfy/sd.py)
  maps `CLIPType.FLUX3` + `TEModel.QWEN3VL_4B` into `flux3_te`.
- [quant_ops.py](https://github.com/Comfy-Org/ComfyUI/blob/ce1e922d8623bb507180e32a0c01a7d0e29edef7/comfy/quant_ops.py)
  registers `int8_tensorwise` / `TensorWiseINT8Layout`;
  [ops.py](https://github.com/Comfy-Org/ComfyUI/blob/ce1e922d8623bb507180e32a0c01a7d0e29edef7/comfy/ops.py)
  loads INT8 scales and `convrot` / `convrot_groupsize` metadata.

This establishes source-level plausibility and official graph support, not a
successful load of these exact gated files on the pinned Colab stack. The model
lock records `comfy-kitchen` 0.2.38, but installed runtime compatibility, memory,
latency and output quality were not exercised here.

### What a future opt-in profile must coordinate

1. Pin the official repository revision and authenticated weight SHA-256/LFS IDs,
   exact sizes, model/encoder/VAE identities and license snapshot. Gate selection
   through an explicit server-owned profile, keeping BF16 as the default.
2. `colab/bootstrap.py` already pins download revisions and checks `sha256` **when
   present**. Current Klein entries omit hashes. Its current verification loop
   does **not** enforce each declared `bytes` value. Add profile-specific size and
   hash verification before advertising verified weight bytes. The current lock's
   sizes and measured timing are historical metadata, not a runtime size check.
3. Give the int8 profile explicit loader names. The current BF16 alias is
   **`flux-3-image-klein-bf16.safetensors`**, whereas official Comfy names begin
   **`flux3-image-…`**. Never hide int8 under the BF16 filename: that would conceal
   the change from workflow hashes and current receipt matching.
4. Add versioned/profile-specific graphs and regenerate
   `packages/agent/src/workflow-manifest.ts` via `scripts/workflow-manifest.mjs`.
   Bind profile/revision to `gen.model` / `gen.model_revision` and/or an explicit
   supported contract so cache/job fingerprints cannot cross profiles. Include
   t2i, img2img, one/two-reference selection, smoke graph and capability routing.
   Existing reference routing currently names the BF16 workflows directly.
5. Extend `packages/jobs/src/model-contribution.mjs` narrowly. Today `eligibleJob`
   allowlists four Klein workflow paths, verifies the exact committed graph hash
   and requires the BF16 UNET filename. Collection compares graph topology and
   **all loader string inputs**, including the local text encoder, before issuing
   receipts. A graph-only filename switch fails the existing allowlist; a filename
   alias conceals weight identity. Keep original graph paths/hashes available so
   existing BF16 receipts remain eligible. Recovery currently supports only the
   existing Klein t2i path (plus its separately supported video path), so it also
   needs explicit profile coverage.
6. Preserve the evidence boundary: the current receipt certifies submitted graph
   identity and output bytes under a trusted backend; it is **not independent
   cryptographic attestation of the model file behind a loader filename**. Do not
   broaden “officially verified” to mean any user-supplied file with a matching
   name. Bind installation verification to the selected profile if stronger weight
   provenance is required. This product gate also explicitly does not guarantee
   external ecosystem/hackathon bonus eligibility.
7. Integrate profile selection with `packages/backends/src/fasth3-profile.mjs` and
   `createColabBackend`'s lock selection; a constructor `modelsLock` override alone
   does not update workflow identity, smoke requirements or eligibility. Measure
   load/generation and compare representative BF16/int8 outputs before calling
   the profile supported. There was no such runtime validation in this research.

## Verification performed

- `node --test apps/server/test/productions/iteration-policy.test.mjs`:
  **27 passed, 0 failed** (pure policy tests).
- Read-only, in-memory Node assertions using `planJobs` and the existing
  `packages/jobs/test/fixtures/package-pending.json`: omitted Klein steps stay
  omitted in job params; committed t2i default is 16; explicit 8 and 16 survive;
  both cache keys and jobs-document hashes differ; draft keyframes are one take,
  one round, zero auditions. **Passed.** No fixture or ledger was written.
- Revision-pinned public metadata enumeration, byte arithmetic and official
  template/subgraph inspection were performed without fetching any weights.
- No inference quality claim was tested. Automatic 8-step production policy and
  executable int8 profile remain deferred for the reasons above.

## Addendum: confirmed multi-reference admission defect and bounded fix

Date: **2026-10-30**, following the separate
[prompt-quality investigation](COMFY_PROMPT_QUALITY.md#verified-reference-correspondence-in-this-repository).

### Confirmed defect

The original planner accepted up to ten numbered references, but selected the
two-reference graph **only when the count was exactly two**. Three references used
the single-reference graph. That graph's parameter map declared extra `_reference_N`
uploads without mapping them to nodes. The Python parameter injector ignores
unmapped underscore-prefixed parameters, so recording/uploading the third file
did not connect it to conditioning. With three sources even the second source
could become unconnected. Implicit cast references could trigger this path when
the image tool combined a two-image composition/identity pair with a third cast
image. The former ten-item cap also silently discarded further cast references.

The working path is precisely:

```text
reference (or image) -> LoadImage 10 -> ReferenceMultiLatent 12 images.image0
_reference_2         -> LoadImage 11 -> ReferenceMultiLatent 12 images.image1
ReferenceMultiLatent outputs 0/1 -> KSampler positive/negative conditioning
```

The second line exists only in `flux3_klein_ref2_edit.api.json`. The corresponding
prompt tokens are `<ref_image_0>` and `<ref_image_1>`, respectively. Model-family
support for ten images does not enlarge the connected capacity of these graphs.

### Implemented behavior

- The supported local bound is **two**, including implicit cast sources. The image
  tool's executable and model-facing schemas agree on this count. Merging a third
  distinct cast/reference source throws rather than truncating the list.
- `planJobs` rejects higher numbered slots (including internal underscore forms),
  unsupported `gen.inputs.images` lists/scalars, conflicting aliases and missing
  first slots. It validates again against the selected workflow's actual supported
  reference slots after cast expansion and normalization. The error is
  `PLAN_KLEIN_REFERENCE_UNSUPPORTED`; no jobs document is returned for admission.
- `checkJobsDoc` and Python `validate_jobs` enforce the same resolved-job boundary
  for callers that bypass package planning. Extra `fileInputs`, a second upload
  on a single-reference graph, repeated/alias upload slots and custom parameter-map
  overrides cannot bypass it. Python reports `JOBS_KLEIN_REFERENCE_UNSUPPORTED`
  before runner submission. Unknown/custom reference graphs are not certified.
- The single-reference map now declares only its actually mapped `image` and
  `reference` aliases. The two-reference map and all Klein graph bytes are unchanged.
  Valid one/two-reference paths retain their graph hashes, ordering and existing
  parameter normalization. The formerly broken `image` + second-reference alias
  path now preserves `image` as the first source and canonicalizes the pair without
  competing assignments to node 10.
- New receipts and recovery admission reject unsupported Klein job reference
  claims. Completed-receipt checking also examines recorded conditioning params
  and file inputs, so an old receipt explicitly claiming an unconnected third
  source cannot qualify through reuse. Genuine one/two-reference graph eligibility
  remains covered. No production ledger was rewritten.

This is an admission fix, not an N-reference workflow generator. Generalizing
`ReferenceMultiLatent` beyond two is deferred until deterministic graph/parameter
mapping, fingerprinting, recovery and runtime behavior can all be verified.
No Klein sampling steps, weight profile, model name or quality default changed.

### Follow-up verification

- Agent TypeScript build passed. Full built agent suite: **590 passed**.
- Focused planner/reference/receipt suite initially passed **62 tests**; subsequent
  full jobs testing exposed a reachability test fixture incorrectly declaring a
  reference on a t2i graph, now corrected to use the reference-edit graph.
- New tests cover public/internal third slots, high/sparse slot indices, explicit
  `images` overrides, aliases, implicit cast overflow, direct jobs bypasses, loader
  links and zero-based ordering, cache/hash separation on source reorder, tool
  override rejection, and receipt minting/reuse refusal.
- Python jobs-contract tests passed **11 tests**. A broader schema/workflow/capture
  run passed **158**, with two fake-runner capture tests blocked by missing
  `comfy_sdk` in the selected Python environment (no dependency installation done).
- Full jobs run initially passed **169/171**: the fixture issue above and an
  independently stale LTX upscale cache-key expectation in `motion-ref.test.mjs`.
  The latter belongs to the parallel LTX integration; no LTX expectation was edited
  by this reference-capacity fix.
- Final focused rerun (planner, new reference cases, reachability, contribution
  receipts and embedded recovery): **89 passed, 0 failed**. Python jobs-contract,
  schema and workflow-contract rerun: **157 passed**. Syntax checks and
  `git diff --check` passed. Recovery includes an internally consistent jobs hash
  carrying an unconnected reference and proves no evidence/receipt is written.

Local test logs: `/tmp/opencode/klein-reference-agent-tests.log` and
`/tmp/opencode/klein-reference-jobs-tests.log`, with the final focused rerun in
`/tmp/opencode/klein-reference-focused-tests.log` (not committed artifacts).
