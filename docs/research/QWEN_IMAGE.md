# Comfyrizz research: Qwen-Image 2.1 as a second image model

Written Oct 18, 2026 (Toronto time). This is read-only research: nothing was committed, no Google Colab session was started and no board task was created. Tags: **[verified]** means I read it at the official source (model card, licence text, Comfy docs, or the ComfyUI source at our pinned commit). **[secondary]** means a third-party article or benchmark. **[unverified]** means an inference or claim I could not check. Repo context comes from `README.md`, `docs/SPEC.md`, `colab/models.lock.json`, `workflows/svg-guided/README.md`, `packages/agent/src/tools.ts`, `packages/jobs/src/plan.mjs` and `research/RESEARCH_CAPABILITY_WINS.md`.

G4 baseline used for every cost here: RTX PRO 6000 Blackwell Server Edition, **96 GB VRAM**, 176 GB RAM, **8.90 units/h** (≈ 0.148 units per GPU-minute), cold start ≈ 4.4 min ≈ 0.65 units, peak VRAM 54.8 GB with Klein BF16 and LTX-2.5 int8 both resident (SPEC §6.4 and §6.6, GPU tests 1–5) [verified, repo].

---

## 0. TL;DR

- **"Qwen Image 2.1" exists under exactly that name**: **Qwen-Image-2.1**, released **Sep 20, 2026** by Alibaba's Qwen team (Tongyi Lab). It is a 7B single-stream DiT with a Qwen3-VL-8B encoder that does generation and editing in **one checkpoint**: up to 10 reference images (16 slots in the ComfyUI node), native 2K output, and **native RGBA transparency**. **Qwen-Image-2.1-Turbo** (8 steps, CFG 1) followed on **Oct 9, 2026**. There is no separate "Qwen-Image-Edit-2.1"; editing is built into 2.1. [verified]
- **Licence: Qwen Research License, non-commercial only** ("research or evaluation purposes only"; a commercial licence must be requested by email). The weights are open and **not gated**. This is the first Qwen-Image release that is not Apache-2.0. The older **Qwen-Image / -2512 / -Edit-2509 / -Edit-2511 / -Layered** stay **Apache-2.0** (20B, about twice the download). [verified]
- **ComfyUI: native core support**, present in our pinned ComfyUI `ce1e922`: `TextEncodeQwenImage21`, `QwenImage21Cache`, and the Qwen 2.1 Fun ControlNet in `ModelPatchLoader` + "Apply Fun ControlNet". There are 5 official templates (t2i, edit, background removal, Turbo t2i, Turbo edit). Comfy-Org also publishes **int8 ConvRot** repacks, the same quant family our LTX files use. [verified]
- **It does the things Klein can't**: a real alpha channel, an official **ControlNet-Union** (canny/depth/lineart/scribble/MLSD/HED/pose/grey plus inpaint; Klein has none, and this is SVG-guided approach #3, which is blocked today), and edits that leave unedited pixels alone [secondary]. Long, dense and multilingual in-image text is also stronger [vendor + secondary].
- **Minimal extra download ≈ 17.3 GB** (int8 DiT 7.26, int8 TE 9.35, VAE 0.68), **+3.78 GB** for the ControlNet. That is ≈ 45–60 s more at our measured download speeds, ≈ **+0.15 units per session**. VRAM fits next to Klein and LTX on 96 GB [unverified, about 75 GB estimated].
- **Recommendation: targeted use only, gated on a small A/B test. No general adoption before the Oct 26 freeze.** The queue is full (14 in-flight tasks across Pi and Hermes), and the licence is stricter than Klein's. Comfyrizz's core rule ("labels, numbers and captions are drawn by code") already removes Qwen's headline advantage, text-heavy slides. Do the **CPU prep for an A/B now (≈ 0.75 agent-day)**. Fold the GPU run into the next approved session (≈ **+1.7 units**) or run it standalone (≈ **3 units**, cap 4). Adopt **only RGBA cutouts**, plus the **SVG ControlNet** path if it wins, and only if a Hermes slot frees up. Everything else waits until after Oct 30.

---

## 1. What the model is

### 1.1 Release timeline (official sources)

| Date | Release | Licence | Source |
|---|---|---|---|
| Aug 2025 | Qwen-Image (20B MMDiT, Qwen2.5-VL encoder; best known for Chinese text) | Apache-2.0 | https://huggingface.co/Qwen/Qwen-Image [verified, HF API created 2025-08-02] |
| Sep 22, 2025 | Qwen-Image-Edit-2509 | Apache-2.0 | https://huggingface.co/Qwen/Qwen-Image-Edit-2509 [verified] |
| Dec 17, 2025 | Qwen-Image-Edit-2511, Qwen-Image-Layered (RGBA layer decomposition) | Apache-2.0 | HF API [verified] |
| Dec 30–31, 2025 | Qwen-Image-2512 | Apache-2.0 | https://huggingface.co/Qwen/Qwen-Image-2512 [verified] |
| Feb 10, 2026 | Qwen-Image-2.0 (7B, unified gen + edit, 1K-token prompts, multilingual typography). **API only, no open weights** | n/a | https://github.com/QwenLM/Qwen-Image news; tech report https://arxiv.org/abs/2605.10730 [verified that the news entry and report exist; "no weights" verified: the HF repo `Qwen/Qwen-Image-2.0` does not exist] |
| **Sep 20, 2026** | **Qwen-Image-2.1** (open weights), plus PE-T2I / PE-I2I prompt enhancers (Qwen3.5-9B fine-tunes) | **Qwen Research License** | https://huggingface.co/Qwen/Qwen-Image-2.1 , https://github.com/QwenLM/Qwen-Image-2.1 [verified] |
| Sep 20, 2026 | Day-0 ComfyUI native support; Comfy-Org repack | same | https://blog.comfy.org/p/qwen-image-21-in-comfyui-open-weight , https://huggingface.co/Comfy-Org/Qwen-Image-2.1 [verified] |
| Sep 23, 2026 | Qwen-Image-2.1-Fun-Controlnet-Union (Alibaba PAI) | Qwen Research | https://huggingface.co/alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union [verified] |
| **Oct 9, 2026** | **Qwen-Image-2.1-Turbo** (8-step distilled); Pro/Turbo hosted APIs on Alibaba Cloud | Qwen Research | https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo [verified] |
| Oct 13, 2026 | lightx2v Qwen-Image-2.1-Lightning (4-step DMD LoRA, unofficial) | no licence field on the card [unverified] | https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning [verified, exists] |

The official blog (https://qwen.ai/blog?id=qwen-image-2.1) rendered empty for my fetch (JS page). Anything attributed to "the blog" below comes from the GitHub README or secondary coverage [unverified].

### 1.2 Architecture and claims [verified, model card and GitHub README]
- 7B "visual generation component", 32 single-stream DiT layers, mixed-granularity (block-causal) attention, and **prefix KV-cache reuse**: the prompt and references are encoded once and reused across steps, so multi-reference edits are cheap per step.
- **Text encoder: Qwen3-VL-8B.** This is larger than the DiT, and different from Klein's Qwen3-VL-4B, so the two can't share it.
- **RGBA VAE** (64-channel latent, 16× compression [secondary, ai.rs]). Generates transparent images from text, edits transparent layers, extracts subjects.
- Up to **10 reference images** (the ComfyUI node exposes `image_1`…`image_16`; the templates wire 10). Local edits via circles, painted marks, or masks; identity preservation for people and products.
- Native **2048×2048**; presets up to **2752×1536 (16:9)**. Comfy docs warn that going well above 2K (e.g. 4K) loses prompt adherence.
- Base: published pipeline 40–50 steps; the ComfyUI template uses **25 steps, CFG 1, euler/simple**. Turbo: **8 steps, CFG 1, fixed ManualSigmas**.

### 1.3 Licence [verified, full text read: https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE]
- §2a: rights "FOR NON-COMMERCIAL PURPOSES ONLY"; §1i: "Non-Commercial" = "for research or evaluation purposes only". §2b: commercial use needs a separate licence (model-business@notice.qwencloud.com, no published price).
- Redistribution is allowed with the licence copy and a NOTICE line. §4b: if outputs train or improve a distributed model, show "Built with Qwen". §4c: don't name a product "Qwen…". Governing law: PRC, Hangzhou courts.
- The licence says nothing separately about outputs. Producing a client's or company's explainer video with the model is plausibly "commercial use of the Materials" [interpretation, not legal advice].
- **Compared with Klein**: the FLUX Kommunity License allows commercial *outputs* for users under US$5M revenue. Qwen 2.1 allows none, so Qwen is stricter for Comfyrizz users who make paid work.
- **Open Weights Only prize**: the rule says "No partner nodes or closed-source APIs, open-weights models only" (https://comfy.org/open-source-higgsfield/ [verified]). Qwen 2.1's weights are public and ungated with native core nodes, so it most likely counts [unverified; ask in Comfy Discord if it ships in the demo]. **There is no Qwen/Alibaba bonus**; the bonuses are LTX, FLUX 3 and MiniMax H3 [verified]. Adding Qwen doesn't touch the LTX bonus story. Using it for headline stills would weaken a FLUX fallback claim ("FLUX 3 must be the core model").
- Turbo, PE models and Fun ControlNet: all `qwen-research` [verified, HF cardData]. Lightning LoRA and the texture-fix VAE: licence not stated [unverified].

### 1.4 Files, sizes, variants [verified, HF API with blob sizes, Oct 18]

**Comfy-Org/Qwen-Image-2.1** (rev `a8342359…`, ungated). This is the repo to pin.

| ComfyUI folder | File | Size |
|---|---|---|
| diffusion_models | `qwen_image_2.1_int8_convrot.safetensors` (template default) | 7.26 GB |
| diffusion_models | `qwen_image_2.1_bf16.safetensors` | 14.23 GB |
| diffusion_models | `qwen_image_2.1_turbo_int8_convrot.safetensors` | 7.26 GB |
| diffusion_models | `qwen_image_2.1_turbo_bf16.safetensors` | 14.23 GB |
| text_encoders | `qwen3vl_8b_int8_convrot.safetensors` (template default) | 9.35 GB |
| text_encoders | `qwen3vl_8b_bf16.safetensors` / `qwen3vl_8b_w4a8.safetensors` | 17.53 / 6.31 GB |
| text_encoders | `qwen3.5_9b_qwen_image_2.1_pe_{t2i,i2i}.int8_convrot` / `_w4a8` (optional prompt enhancers) | 9.47 / 6.72 GB each |
| vae | `qwen_image_2.1_vae_bf16.safetensors` | 0.68 GB |
| model_patches | `qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors` / `_bf16` | 3.78 / 7.55 GB |
| loras | `qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors` (Turbo as a LoRA on base) | 0.91 GB |

Community quants [verified that they exist; quality and licence unverified]: `unsloth/Qwen-Image-2.1-GGUF`, `unsloth/Qwen-Image-2.1-Turbo-GGUF`, `unsloth/Qwen-Image-2.1-FP8`, `BennyDaBall/Qwen-Image-2.1-NVFP4`, `toxicdog/Qwen-Image-2.1-INT4ConvRot-ComfyUI`, `leejet/Qwen-Image-2.1-GGUF`. Several high-download "uncensored" fine-tunes exist; **don't pin those**. On a 96 GB G4 we don't need GGUF; the official int8 ConvRot is the right choice, since LTX already runs int8 ConvRot on this card [verified, GPU tests 3–5].

**Apache-2.0 predecessors** (Comfy-Org repacks) [verified]: `qwen_image_2512_fp8_e4m3fn` 20.43 GB, `qwen_image_edit_2511_fp8mixed` 20.53 GB / `int8_convrot` 20.50 GB, `qwen_image_layered_fp8mixed` 20.53 GB, TE `qwen_2.5_vl_7b_fp8_scaled` 9.38 GB. A commercially clean "Qwen-for-Comfyrizz" set (2512 + Edit-2511 + TE + VAE) is ≈ 50 GB, ~3× the 2.1 int8 set.

### 1.5 ComfyUI support [verified]
- **Core nodes at our pin `ce1e922` (Oct 17)**: `comfy_extras/nodes_qwen.py` has `TextEncodeQwenImage21` and `QwenImage21Cache`, and `comfy/ldm/qwen_image21/model.py` exists. `comfy_extras/nodes_model_patch.py` detects the Qwen 2.1 Fun ControlNet in `ModelPatchLoader` and applies it via `ZImageFunControlnet` ("Apply Fun ControlNet", search alias "qwen image 2.1 controlnet"; supports control image + inpaint mask + strength). **No custom nodes needed.**
- **Templates** (https://github.com/Comfy-Org/workflow_templates/tree/main/templates): `image_qwen_image_2_1_t2i.json`, `image_qwen_image_2_1_image_edit.json`, `image_qwen_image_2_1_background_removal.json`, `image_qwen_image_2_1_turbo_t2i.json`, `image_qwen_image_2_1_turbo_image_edit.json`. **There is no official 2.1 ControlNet template** (only 2512 has one); the node path exists, so we'd build our own graph.
- Template graph (t2i): `UNETLoader(qwen_image_2.1_int8_convrot)` → `QwenImage21Cache(auto, default)` → `KSampler(25, cfg 1, euler, simple)`; `CLIPLoader(qwen3vl_8b_int8_convrot, type qwen_image)` → `TextEncodeQwenImage21`; `VAELoader(qwen_image_2.1_vae_bf16)`; `EmptyLatentImage`; `VAEDecode`. The PE branch (`TextGenerate` + `ComfySwitchNode`) is off by default. The templates use **subgraphs, `ResolutionSelector`, `ComfySwitchNode`, `SaveImageAdvanced`**, so our API-format graphs must be flattened the way `workflows/build_gpu1.py` did for Klein.
- Docs: https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1 . Gotchas from the docs:
  - CFG 1 means negative prompts do nothing; CFG 2 follows dense text and numbers better but over-sharpens.
  - The stock VAE leaves a **checkerboard texture** in detailed photo output; an unofficial `madebyollin/texture-fix-vae-for-qwen-image-2.1` exists.
  - **RGBA output breaks 3-channel nodes**: insert `SplitImageWithAlpha`.
  - Edit canvas size comes from `image_1` unless `custom_size` is set (a 12 MP reference costs ~20× a 1 MP one).

### 1.6 VRAM and speed
- **G4 (RTX PRO 6000 Blackwell Server, 96 GB): no published Qwen-2.1 measurement found** [unverified]. Estimates below scale from RTX 5090 numbers; the G4 is the same GB202 class with more memory.
- RTX 5090, ComfyUI, 1024², 40 steps, warm: **bf16 15.6 s, int8 ConvRot 7.6 s, NVFP4 6.7 s**; whole-card memory with int8 ≈ 18 GB [secondary, https://smeltcore.com/recipes/qwen-image-2-1-on-rtx-5090-what-stays-resident-in-32-gb-int8-vs-bf16-and-third-party-timings/]. ComfyUI bf16, 1024², 20 steps: 8.4 s, 19.7 GB peak [secondary, https://stableyogi.com/blog/rtx-5090-qwen-image-2-1-power-limit-benchmark]. LightX2V FP8 DiT, 40 steps, 1024²: t2i 5.9 s, edit 7.1 s [secondary, ai.rs]. RTX PRO 6000 Max-Q NVFP4, 40 steps: 7.7 s [secondary, smeltcore citing ModelsLab].
- 2048² (native): ≈ 3.4–3.5 s/it in a ComfyUI PR (batch 5, int8 DiT) [secondary], so ≈ 85 s per 25-step 2K image at batch 1 [unverified estimate]. **We render at 1280×720 / 1024×576**, so 2K isn't needed.
- **Estimate for Comfyrizz on G4** [unverified]: int8, 1280×720, 25 steps ≈ 5–7 s; Turbo 8 steps ≈ 2–3 s; single-reference edit ≈ 6–9 s. Compare Klein at 2.5–6 s [verified, our runs]. Resident memory with the int8 set ≈ 17 GB + activations, so Klein + LTX + Qwen ≈ 75 GB, under 96 GB. It has to be measured, and ComfyUI may offload anyway (176 GB RAM).
- One Japanese comparison: with 10 references, the first image is faster on FLUX 3 Klein (675 s vs 1,038 s on their consumer card), but repeated prompts are faster on 2.1 thanks to the KV cache [secondary, https://geekoyaji.com/tech/flux3-klein-vs-qwen-image-21/].

### 1.7 Strengths vs FLUX 3 Klein

| Capability | Qwen-Image-2.1 | FLUX 3 Klein (as used) | Evidence |
|---|---|---|---|
| In-image text (short English) | Strong | Passes short English, but our tool schema says "Klein draws garbled pseudo-text" and defaults `text: false` | Klein: `packages/agent/src/tools.ts` L116 [verified repo]; Qwen: vendor showcase + secondary comparisons |
| Long/dense text, infographics, slides, UI mockups | Headline feature ("dense small text and complex layouts hold up") | No evidence for long or multilingual typography | Comfy docs [verified as claim]; groundy.com / influencerstudio [secondary] |
| Multilingual text | Chinese + English shown officially (Lightning card prompt renders "通义千问"); "multilingual typography" is a Qwen-Image-**2.0** tech-report claim. French/Spanish quality on **2.1** not shown anywhere I found | Unknown | [unverified for fr/es]; must be in the A/B |
| Instruction editing | Same checkpoint; edits leave unasked regions alone; mask/paint-mark targeting | Edits "subtly redraw the whole image" | [secondary, geekoyaji]; Comfy docs (mask/paint marks) [verified] |
| Multi-image reference | 10 (16 slots), addressed by index in the prompt; identity preservation | 10, plus **bounding boxes in the prompt** (Qwen has no box input) | both model cards [verified] |
| RGBA / transparency | **Native** (alpha in the VAE), bg-removal template | None; our `cutout` flag is "[unverified node]" (SPEC §6.2) | [verified] |
| ControlNet / canny / depth for sketch-to-render | **Official Fun ControlNet-Union**, 8 conditions + inpaint, core node | **None established** (SVG-guided approach 3 "not drafted") | [verified] |
| Native resolution | 2K | up to 4K advertised | cards [verified] |
| Speed at our sizes | ≈ 5–7 s (int8, 25 steps), ≈ 2–3 s Turbo | 2.5–6 s | estimate vs measured |
| Licence | Non-commercial only | Commercial outputs < US$5M revenue | [verified] |
| Gating | None | `gated: auto` (users must accept) | [verified] |

### 1.8 Weaknesses and risks
1. **Licence**: research or evaluation only. It must be opt-in and flagged in provenance and exports.
2. **Bigger encoder**: Qwen3-VL-8B (9.35 GB int8) on top of Klein's 4B, so two VLM encoders in VRAM.
3. **Vendor-only benchmarks** (Qwen-Image-Bench); no independent quality evaluation vs Klein [secondary, ai.rs].
4. VAE checkerboard on photo detail; RGBA output breaks 3-channel nodes; CFG 1 ignores negatives; quality below ~1 MP is untested (trained at 2K) [unverified].
5. No bounding-box layout input (Klein has one).
6. It's one more model family to pin, test and document 8 days before freeze.
7. Comfyrizz already draws text with code, so the top Qwen feature mostly isn't needed (§2).

### 1.9 LoRA ecosystem [verified, HF API counts Oct 18]
- `base_model:adapter:Qwen/Qwen-Image-2.1`: **136 adapters** (134 tagged `lora`), 76 fine-tunes, 140 quantized derivatives, in four weeks. For comparison, Qwen-Image (Aug 2025): 506 adapters; Qwen-Image-2512: 200. Speed LoRAs: the official Turbo LoRA (Comfy-Org), lightx2v Lightning 4-step, Viggle turbo. Training is supported via VideoX-Fun / DiffSynth [unverified for 2.1 specifics]. LoRAs trained on 2.1 inherit the research licence.
- **LoRAs don't port across versions**: 2.1 (7B single-stream) is a different architecture from Qwen-Image/2512 (20B) [verified, architecture differs].

---

## 2. Concrete uses in Comfyrizz

Ground rule (README, SPEC): **labels, numbers and captions are drawn by code (Remotion/SVG), never by the image model**. That keeps copy exact, editable and translatable, and the fit-check is a fail state. So "Qwen renders slides" is **not** a replacement for the vector path. Its text value is **diegetic** text: text that lives in the scene, like signs, packaging, whiteboards and screens.

Common plumbing for any adoption (counted once, in "Q-core" below):
- `packages/schema/package-v1.schema.json`: add `qwen-image-21` (and maybe `qwen-image-21-turbo`) to `gen.generator`, plus `model_license: { id: "Qwen-Research", commercial: false }`. `semantic.mjs` already treats NC licences as non-redistributable for *assets*; the export needs a **"non-commercial model used"** badge in `compliance`.
- `packages/jobs/src/plan.mjs`: `GENERATOR_KIND["qwen-image-21"] = "still"`; cache key already includes generator, model and workflow sha.
- `colab/models.lock.json`: a new `qwen` host (`Comfy-Org/Qwen-Image-2.1`, rev `a8342359c61979b06a8dafb1a47991fe1f30e994`, ungated) with three files. `bootstrap.py` currently downloads **every** host, so add an `optional`/profile flag so Qwen files download only when the package's jobs need them (otherwise every session pays +17 GB).
- New workflows, flattened API format plus `.params.json` like the Klein ones: `workflows/qwen21_t2i.api.json`, `qwen21_edit.api.json` (refs `image_1..n`), `qwen21_cutout.api.json` (RGBA, `SplitImageWithAlpha` → PNG with alpha), optional `qwen21_turbo_*`, `qwen21_controlnet.api.json`.
- `packages/agent/src/tools.ts`: a `generator` choice on `assets.generate` and routing rules (§2.9). Skip the Qwen PE models; our agent LLM already expands captions (SPEC §6.4).
- `colab/health.py`: node types `TextEncodeQwenImage21`, `QwenImage21Cache`, `ModelPatchLoader`, `ZImageFunControlnet`.
- **Q-core effort ≈ 1.5 agent-days** (Hermes: schema/jobs/lock/bootstrap/workflows; Pi: 0.25 for the agent tool).

Extra download/setup per session (only when used): 17.3 GB ≈ 45–60 s at 310–390 MB/s (parallel with other hosts it may hide partly behind LTX's 39.7 GB) ≈ **+0.1–0.15 units**. Plus 3.78 GB ControlNet ≈ +10 s. First-load ≈ 10–20 s [unverified].

| # | Use | Value | Pipeline mapping (beyond Q-core) | Effort (agent-days) | Before freeze? |
|---|---|---|---|---|---|
| 2.1 | **RGBA cutouts** (mascots, product shots, icons-as-illustrations, CAST1 character on transparent bg) layered in Remotion; also feeds 2.5D parallax later | **High.** It's the only real alpha path we'd have (SPEC's `cutout` is "[unverified node]", and it's last in the cut order). Makes layered motion graphics look designed | `qwen21_cutout.api.json`; route `cutout: true` → Qwen; renderer already composites PNGs (verify alpha handling) | +0.5 | **Yes, if the A/B passes and Hermes has a slot** |
| 2.2 | **SVG-guided structure via Fun ControlNet-Union** (canny/lineart/depth from `svgguide_prep.py` maps, which already exist on CPU) | **High.** Unblocks approach #3. ControlNet + inpaint keeps geometry pixel-registered, which fixes GPU test 2's problem (Klein ref edits shift geometry, so crisp SVG labels can't be overlaid). Also a strong demo/"Most Innovative" story | `qwen21_controlnet.api.json` (`ModelPatchLoader` → `ZImageFunControlnet` with `strength`); add `controlnet_strength` axis to `sweeps/e2.json` + `SWEEP_AXES`; route `sketchToRender` → Qwen when the guide is canny/lineart | +1.0 (incl. sweep extension) | **Only in the A/B**; adopt after it if a slot is free, else after Oct 30 |
| 2.3 | **Diegetic text in stills** (sign, chalkboard, product label, phone screen in a hero still) | Medium. Today `text: false` blocks this outright | Route `text: true` → Qwen; caption expansion quotes the exact strings | +0.25 | Rides on Q-core |
| 2.4 | **Localized diegetic text** (translate the sign in a still for the fr version; pairs with dubbing) | Medium. Only matters once language variants have in-image text; the 2.1 quality for French is **unverified** | Edit workflow: "replace the text 'X' with 'Y', keep everything else"; per-language asset variant in the planner | +0.5 | No (dubbed-presenter / more-languages work is parked until after Oct 30) |
| 2.5 | **Instruction edits on stills** (user says "make the jacket blue"/"remove the cup" in chat) | Medium-high UX value, and it preserves unedited regions better than Klein [secondary] | New agent tool `assets.edit(asset_id, instruction, mask?)` → `qwen21_edit`; asset revision chain | +1.0 | No (new tool surface; Pi busy) |
| 2.6 | **Thumbnails / social cards (X1)** | Low-medium. X1's 1200×630 card and thumb are hero frame + **vector headline**, which is better kept as code. Qwen could make a text-baked "poster" variant | Optional `qwen21_t2i` poster job in the X1 pack | +0.25 | No; keep X1 vector-first |
| 2.7 | **Recurring character (CAST1)** | Low marginal. Klein already does 10 refs and is in use; Qwen's identity claim is untested here | Allow `cast.ref_asset` to route to Qwen edit when the cast sheet is Qwen-made | +0.25 | No; keep CAST1 on Klein |
| 2.8 | **Presenter portraits (H17 / P-pres / C-pres)** | Low. Klein portrait → LTX a2v is the plan; changing the generator mid-H17 adds risk. A **transparent-bg presenter** (2.1 RGBA) could later enable cut-out PiP | — | — | No |
| 2.9 | **Text-heavy slides / infographics / title cards** | Low for Comfyrizz. It conflicts with the "copy is code" rule and the fit-check; a baked-text slide can't be edited or translated. Possible "illustrated infographic background" with **no** real copy | — | — | No |

### 2.10 Agent routing rules (draft for `tools.ts` / system prompt)
1. Default generator = `flux3-klein` (keeps the FLUX story, commercial outputs < US$5M, already measured).
2. Pick `qwen-image-21` only when **Qwen mode is enabled for the project** (licence opt-in) **and** one of these holds:
   - `cutout: true`, i.e. an alpha PNG is needed;
   - `text: true` with diegetic strings (quote them; ≤ ~12 words; never body copy, numbers, chart labels or captions; those stay vector);
   - an SVG-guided render that must stay **pixel-registered** to the SVG (labels overlaid afterwards), via ControlNet;
   - a local instruction edit of an existing still where untouched regions must not move.
3. Never use Qwen for presenter portraits or cast sheets until the A/B says otherwise; never mix generators within one cast's ref chain.
4. If the project is marked commercial, or the licence opt-in is off: route to Klein (and, for `cutout`, fall back to the existing "[unverified] cutout" path or a solid-background still).
5. Record `gen.generator`, the `model` file, `model_license.id = "Qwen-Research"` and `commercial: false`; the export compliance badge then lists "non-commercial model used".

---

## 3. Queue and freeze assessment

- Freeze: **Mon Oct 26 (evening)**, 8 days away; deadline **Oct 30, 9:00 am PT = 12:00 pm Toronto time (UTC-4)**.
- In flight: H17 presenter, M1/M2 sound, MS3, P-fix5, P-pres, C-pres, K1, X1, LP2, CAST1, R3, W1, MS5, U2. That's 14 tasks across Pi and Hermes, already more than the "now" set in RESEARCH_CAPABILITY_WINS.
- Q-core + cutout + ControlNet ≈ **3.0 agent-days**, mostly Hermes (schema/jobs/lock/workflows), the same lane that owns CAST1, M1/M2 and the SVG-guided work. Doing all of it before freeze would push out at least one of CAST1/X1/LP2.
- Prize effect: neutral for the LTX bonus; neutral-to-slightly-positive for Open Weights Only (more open models, real ControlNet) if Comfy counts research-licensed weights as open weights [unverified]; slightly negative for a FLUX fallback claim if Qwen takes the hero stills.
- **Verdict: targeted use only, gated on an A/B. General second-model adoption waits until after Oct 30.**

## 4. Recommendation and minimal first step

**Recommendation: targeted use only.**
1. **Now (CPU only, ≈ 0.75 agent-day, Hermes or whoever frees first):** build the A/B kit and touch nothing else in the product.
   - A `colab/models.qwen.lock.json` (or `optional: true` host) with the 3 int8 files + the int8 ControlNet. Pin rev `a8342359…`.
   - Flattened `workflows/qwen21_{t2i,edit,cutout,controlnet}.api.json` + params maps built from the official templates at our pin `ce1e922`.
   - A `workflows/qwen-ab/plan.json` with prompts.
2. **GPU A/B (worthwhile, small):** fold it into the next Kyle-approved session (Kyle's approval of up to **30 units runs until 2:48 PM Oct 19 Toronto time (UTC-4)**; nothing was run here).
   - **Matrix (≈ 70 jobs):**
     - 10 shared prompts × Klein vs Qwen-int8 vs Qwen-Turbo × 2 seeds at 1280×720: 2 diegetic-text-en, 2 diegetic-text-fr, 2 hero illustrations, 2 product/mascot, 2 portraits.
     - 6 instruction edits (Klein ref-edit vs Qwen edit).
     - 4 RGBA cutouts.
     - 3 SVG scenes (`samples/{hero,background,texture}`) × canny/lineart × strength {0.6, 0.85} via ControlNet vs the existing Klein img2img/ref-edit best settings.
   - **Record:** per-job seconds, peak VRAM with all three families resident, download seconds; legibility via the existing `pipeline-py/eval/legibility.py` (install `tesseract-ocr` on the VM, as the svg-guided README already recommends) and `label_structure_retention`/edge IoU for the ControlNet rows; plus a human 1–5 sheet.
   - **Cost:** folded into another session ≈ 17 GB download (~1 min) + ~8–10 GPU-min of jobs ≈ **+1.5–1.7 units**. Standalone: 4.4 min cold start + 1 min Qwen download + ~10 min jobs + 6 min collect-and-stop reserve ≈ 21 min ≈ **3.1 units** (set budget 4).
3. **Adopt before freeze only if** the A/B shows (a) usable alpha cutouts and/or (b) ControlNet beating Klein on layout fidelity with labels intact, **and** a Hermes slot is free. Then do Q-core + cutout (≈ 2.0 days), + ControlNet (+1.0).
4. **After Oct 30:** instruction-edit tool, localized diegetic text, Qwen poster variants, per-project Qwen mode in the UI. Re-evaluate the **Apache-2.0** Qwen-Image-2512 / Edit-2511 / Layered set as the commercially clean option (≈ 50 GB) vs requesting a 2.1 commercial licence.

## 5. Proposed board tasks (NOT created)

| ID | Title | One-line spec | Owner | Effort |
|---|---|---|---|---|
| QW0 | Qwen-Image 2.1 A/B kit (CPU) | Optional lock profile (Comfy-Org/Qwen-Image-2.1 @ a8342359, int8 DiT/TE + VAE + int8 Fun ControlNet), flattened API workflows t2i/edit/cutout/controlnet from official templates at ComfyUI ce1e922, A/B plan + scoring sheet; no product wiring | Hermes | 0.75 |
| QW0-GPU | Run Qwen vs Klein A/B on G4 | Fold into next approved session; ≈ +1.7 units (standalone ≈ 3.1, budget 4); record speed, VRAM with 3 families resident, OCR legibility, IoU, human scores → `docs/GPU_TEST_6.md` | Hermes (needs Kyle's spend approval) | 0.25 |
| QW1 | Qwen generator plumbing (Q-core) | `gen.generator: qwen-image-21`, `GENERATOR_KIND`, `model_license` Qwen-Research non-commercial + export badge, optional-host download in `bootstrap.py`, `health.py` node checks, tests | Hermes (+Pi 0.25 for tool arg) | 1.5 |
| QW2 | RGBA cutouts via Qwen | `cutout: true` → `qwen21_cutout`; alpha-safe PNG path to Remotion; agent routing rule; one example package layer | Hermes + Pi | 0.5 |
| QW3 | SVG-guided ControlNet (approach #3) | `qwen21_controlnet` workflow, `controlnet_strength` sweep axis in `e2.json`/`SWEEP_AXES`, route pixel-registered sketch-to-render to Qwen | Hermes | 1.0 |
| QW4 (after) | Instruction edits + localized diegetic text | `assets.edit(asset_id, instruction, mask?)` tool, per-language edited variants | Pi | 1.5 |

## 6. Decisions for Kyle
1. **Licence**: is a **non-commercial-only** model acceptable as an opt-in in an MIT tool whose users may do paid work? (Suggested: yes, opt-in per project, off by default, flagged in exports.) Or should the commercial path be the Apache-2.0 Qwen-Image-2512/Edit-2511 after the hackathon?
2. **A/B spend**: fold the Qwen A/B into the next approved session (≈ +1.7 units) or run it standalone (≈ 3.1 units, budget 4)? Either fits the 30-unit approval if it runs before 2:48 PM Oct 19 Toronto time (UTC-4); otherwise it needs a new approval.
3. **Queue**: may QW0 (0.75 day) jump ahead of a queued Hermes task, and which task slips if QW1–QW3 are adopted before freeze?
4. **Prize framing**: ask Comfy Discord whether research-licensed open weights count for Open Weights Only (likely yes), only if Qwen will appear in the demo.

## 7. Sources (accessed Oct 18, 2026)
- Qwen-Image-2.1 model card (Sep 20, 2026): https://huggingface.co/Qwen/Qwen-Image-2.1 ; licence: https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE
- GitHub: https://github.com/QwenLM/Qwen-Image-2.1 (news: 2.1 Sep 20; Turbo + APIs Oct 9) ; earlier line: https://github.com/QwenLM/Qwen-Image
- Turbo card (Oct 9, 2026): https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo
- Comfy-Org repack (sizes via HF API): https://huggingface.co/Comfy-Org/Qwen-Image-2.1
- Comfy blog (Sep 20, 2026): https://blog.comfy.org/p/qwen-image-21-in-comfyui-open-weight ; Comfy docs: https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1 ; landing: https://comfy.org/qwen-image-2.1/
- Templates: https://github.com/Comfy-Org/workflow_templates/tree/main/templates (`image_qwen_image_2_1_*`)
- ComfyUI source at pin: https://github.com/comfyanonymous/ComfyUI/blob/ce1e922/comfy_extras/nodes_qwen.py , .../comfy_extras/nodes_model_patch.py
- Fun ControlNet-Union (Sep 23, 2026): https://huggingface.co/alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union
- Lightning LoRA (Oct 13, 2026): https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning
- Qwen-Image-2.0 tech report: https://arxiv.org/abs/2605.10730
- Hackathon rules: https://comfy.org/open-source-higgsfield/
- Secondary: ai.rs licence/VRAM (Sep 20, 2026) https://ai.rs/ai-for-business/qwen-image-2-1-open-weights-licence-vram ; smeltcore RTX 5090 timings https://smeltcore.com/recipes/qwen-image-2-1-on-rtx-5090-what-stays-resident-in-32-gb-int8-vs-bf16-and-third-party-timings/ ; stableyogi 5090 bf16 https://stableyogi.com/blog/rtx-5090-qwen-image-2-1-power-limit-benchmark ; mesmer.tools FP4 https://mesmer.tools/benchmarks/qwen-image-2-1 ; Klein vs 2.1 (ja) https://geekoyaji.com/tech/flux3-klein-vs-qwen-image-21/ ; Kingy Klein test (Oct 15, 2026) https://kingy.ai/blog/flux-3-image-klein-tested-benchmarks-costs/
