# GPU test session 1: FLUX 3 Klein + LTX-2.5 on Google Colab G4

Session `comfyrizz-gpu1`, Sat Oct 17 2026, 00:35–00:44 EDT (Toronto, UTC-4). Cap 10 units (watchdog at 62 min, `comfyrizz-gpu1` only); stopped by hand after about 8.5 minutes.

## Summary

| Item | Result |
|---|---|
| Units | 386.64 → 385.70 = **0.94 units** used (29.06 of the 30-unit test budget left) |
| GPU | NVIDIA RTX PRO 6000 Blackwell Server Edition, 97,887 MiB, driver 580.82.07; 176 GiB RAM; torch 2.11.0+cu130; ComfyUI 0.41.0 |
| Model download | **60.0 GB** total; Klein 20.31 GB in 52.6 s (386 MB/s), LTX 39.71 GB in 110.8 s (359 MB/s). Run one after the other, so 163 s; not measured in parallel |
| FLUX 3 Klein 1024² | cold **7.9 s** (loading everything), warm **2.5 s**; 1344×768 warm 2.5 s; peak 20.8 GB |
| LTX-2.5 97 frames, two-stage | cold **22.7 s**, warm **11.4 s**; 121 frames 12.1 s; 1280×704×121 21.4 s; i2v 11.5 s; peak 54.8 GB cold, 37–42 GB warm |
| Both models together | **Yes, no swapping.** ComfyUI dynamic VRAM keeps about 56.6 GB of weights resident; highest nvidia-smi reading all session was 54.8 GB |
| SVG-guided (E2) | img2img at 0.45/0.60/0.75 and reference edit all keep the layout and the three labels exactly; reference edit gives the most polished result |
| Clean-up | token file deleted from the VM (checked), runtime stopped, `colab sessions` shows none, watchdog cancelled, no SSH used and no SSH key created |

## 1. Files, sizes and download

Hugging Face token: uploaded with `colab upload` as `/content/.hf/token` (directory 0700, file 0600). Read by the download script without printing; deleted right after each download. The local temp copy on the box was removed straight after upload. Never passed through `--env`.

Note: the first setup run fetched nothing for LTX (`hf download` returned 0 with no files, because LTX files sit in subfolders). The token was uploaded a second time for an LTX-only script; it was deleted again afterwards. The repo copy of `g1_setup.py` is fixed.

| Model | Repo / file | Size | Goes to `ComfyUI/models/` as |
|---|---|---|---|
| FLUX 3 Klein transformer (BF16) | `black-forest-labs/flux-3-image-klein` `model.safetensors` | 11.10 GB | `diffusion_models/flux-3-image-klein-bf16.safetensors` |
| Klein text encoder Qwen3-VL-4B (BF16) | same repo, `text_encoder/model-0000{1,2}-of-00002.safetensors` | 8.88 GB | merged into `text_encoders/qwen3vl_4b_bf16.safetensors` (713 tensors, 25.8 s) |
| Klein VAE (flux2 VAE) | same repo, `ae.safetensors` | 0.34 GB | `vae/flux2-vae.safetensors` |
| LTX-2.5 22B distilled (int8) | `Lightricks/LTX-2.5` `diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` | 21.50 GB | same path |
| LTX text encoder Gemma 4 12B + proj (int8) | `text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` | 15.37 GB | same path |
| LTX video VAE | `vae/ltx-2.5-video-vae-bf16.safetensors` | 1.47 GB | same path |
| LTX audio VAE (required by the AV latent even when muted) | `vae/ltx-2.5-audio-vae-bf16.safetensors` | 0.36 GB | same path |
| LTX ×2 latent upscaler | `latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | 1.00 GB | same path |

Why these quantizations: LTX uses the int8 files picked by the official ComfyUI template (BF16 would be 42 + 26 GB). For Klein, the ComfyUI-repackaged repo `black-forest-labs/flux-3-image-klein-comfy` returns 403 for this token (licence not accepted on that repo), so the original BF16 files were used. ComfyUI loads them as they are: it detects the transformer as `flux3` and remaps the HF text-encoder keys. If Kyle accepts the licence on the `-comfy` repo, the int8 single files would cut Klein to about 11 GB and remove the 26 s shard merge.

Measured setup steps: `colab new` 3 s; upload 8 small files about 10 s; ComfyUI clone 1.5 s; requirements 17.7 s; downloads 163 s (one after the other); text-encoder merge 25.8 s; ComfyUI start until `/system_stats` responds 14 s; first Klein job 7.9 s; first LTX job 22.7 s.
**Cold start, sum of measured steps: ≈ 4.4 min ≈ 0.65 units** at 8.9 units/h, to the first image and first video, with all 60 GB of both models. Real time in this session from `colab new` to the first image was 5.5 min, because the LTX download had to be redone. Running the two downloads in parallel and using the int8 Klein files would probably bring this to about 3 min (estimate).

## 2. FLUX 3 Klein (BF16, distilled: 16 steps, cfg 1, euler/simple)

Workflow: `UNETLoader → CLIPLoader(type flux3) → CLIPTextEncode / ConditioningZeroOut → EmptyFlux2LatentImage → KSampler → VAEDecode → SaveImage` (`workflows/flux3_klein_t2i.api.json`). Prompts were written as full agent-style captions (subject, layout, palette with hex codes, lighting, negative space, "no text"), see `colab/make_jobs.py`.

| Job | Size | Wall | ComfyUI exec | Peak VRAM (nvidia-smi) |
|---|---|---|---|---|
| explainer illustration, cold (loads TE + transformer + VAE) | 1024² | 8.2 s | 7.85 s | 18.5 GB |
| icon, warm | 1024² | 3.0 s | 2.56 s | 20.8 GB |
| background, warm | 1344×768 | 3.0 s | 2.54 s | 20.8 GB |
| after LTX had run (first, re-stages Klein) | 1024² | 5.5 s | 5.46 s | 48.3 GB* |
| after LTX had run (second) | 1024² | 2.5 s | 2.47 s | 33.7 GB* |

*Whole-GPU total with the LTX weights still resident.
Quality: all three match the brief. The explainer has clean flat vectors with headline space at the top, the icon is a crisp glass app tile, and the background has calm negative space on the left. No stray text in any of them. Contact sheet: `test/gpu1/contact_klein.jpg`.
Loads came from the RAM page cache, since the files had just been downloaded. That is our real cold path; a load from cold disk was not measured.

## 3. LTX-2.5 distilled (int8), official two-stage pipeline, muted

Workflow, matching the template: stage 1 at half resolution with 8 sigmas → `LTXVLatentUpsampler` ×2 → stage 2 with 3 sigmas. `LTXVDualCFGGuider` cfg 1/1, euler_ancestral, `VAEDecodeTiled`, frames saved as PNG, mp4 made with ffmpeg at 24 fps. The audio latent stays in sampling as the model needs it; audio is not decoded (`ltx25_t2v_2stage.api.json`, `ltx25_i2v_2stage.api.json`).

| Job | Output | Frames | Wall | Exec | Peak VRAM |
|---|---|---|---|---|---|
| t2v background plate, cold (loads Gemma TE, transformer, upscaler, VAEs) | 960×512 | 97 (4 s) | 23.1 s | 22.7 s | 54.8 GB |
| i2v from the FLUX background (strength 0.7 / 1.0) | 960×512 | 97 | 11.9 s | 11.5 s | 42.1 GB |
| t2v, warm | 960×512 | 97 | 11.8 s | 11.4 s | 37.0 GB |
| t2v, warm | 960×512 | 121 (5 s) | 12.5 s | 12.1 s | 37.0 GB |
| t2v, warm (template size) | 1280×704 | 121 | 21.8 s | 21.4 s | 37.0 GB |

Finding: **asking for 960×544 gave 960×512.** In two-stage mode, the stage-1 latent is half size and rounded down to a multiple of 32 px, so the final size is a multiple of 64 (1280×720 became 1280×704 the same way). Use 64-multiples for two-stage, for example 1024×576 (16:9) or 960×512, or run single-stage for 960×544. The builder now warns about this.
Loop: t2v is not seamless by itself; the first and last frames differ. A 0.5 s ffmpeg crossfade of the tail into the head makes a clean 3.5 s loop (`ltx_t2v_960x512_loop.mp4`). That is cheap post-processing on the box. Motion is calm silk-like ribbons; i2v keeps the FLUX frame faithfully and animates it gently. Frame strips: `test/gpu1/contact_ltx_frames.jpg`.

## 4. Both models on one 96 GB GPU

They fit, and no swapping was needed. ComfyUI 0.41 uses dynamic VRAM loading (comfy-aimdo): it reported staging Flux3 10.6 GB, Qwen3-VL TE 8.5 GB, LTXAV 20.5 GB, Gemma TE 14.6 GB, upscaler 0.9 GB and video VAE 1.4 GB, about 56.6 GB in total, and logged no unloads. Alternating Klein → LTX → Klein → LTX → Klein: after the first switch, both stayed at warm speed (Klein 2.5 s, LTX 11.4 s). The only cost was a one-off 3 s re-stage the first time Klein ran after LTX. The highest whole-GPU reading of the session was 54.8 GB, during the first LTX load. No `--highvram` or other flags were used.

## 5. SVG-guided probe (E2)

Input: `gpu1/inputs/diagram.svg` (three labelled boxes "Brief → Storyboard → Video", arrows, dark navy, periwinkle), rasterized on the box with cairosvg to 1344×768 (`inputs/diagram.png`).

| Mode | Time (warm) | Result |
|---|---|---|
| img2img, denoise 0.45 | 2.6 s | Layout, labels and arrows unchanged; adds a slight gradient and a softer background. Very faithful, small style lift |
| img2img, denoise 0.60 | 2.4 s | Same layout and exact labels; cards get gradient fills and the background gets texture. Best img2img balance |
| img2img, denoise 0.75 | 2.4 s | Layout and labels still exact; arrows redrawn as thin line arrows and cards get borders. More restyling, still on-structure |
| Reference edit (`ReferenceMultiLatent`, image as reference, empty latent from the reference) | 5.3 s | Exact layout and labels with a clearly more polished glass-card style and a grid background. Best-looking result |

Conclusion: for diagram slides, Klein holds SVG geometry and short labels well up to denoise 0.75. This is promising for E2 "SVG skeleton → styled render": use img2img 0.6 for safe styling, or the reference edit for more polish. Text was kept because it was already in the raster. Not tested: denser diagrams, longer labels, and denoise above 0.75. In the reference edit, API inputs are named `resolution: "resize"`, `resolution.megapixels: 1.0`, `images.image0: [node, 0]` (this worked). Contact sheet `gpu1/contact_svg.jpg`. Top row: input, 0.45, 0.60. Bottom row: 0.75, reference edit.

## 6. What this means for the spec

- Model downloads: measured 60.0 GB for the minimum Klein + LTX set, at about 360–390 MB/s per repo from Hugging Face (xet), so about 2.7 min if done one after the other.
- Cold start: about 4.4 min, about 0.65 units, to the first image and video. Warm cost is tiny: about 2.5 s per 1024² image and about 11–12 s per 4–5 s 960×512 clip. A 10-scene video with 10 images and 5 clips is roughly 1.5 min of GPU time warm, about 0.2 units.
- Risk 2 (model size above 63 GB) is resolved for this set: weights resident ≈ 56.6 GB, peak 54.8 GB measured.
- The whole session, including all tests, cost 0.94 units.

## 7. Best outputs (box: `/workspace/comfy-hackathon/test/gpu1/`)

- `klein_explainer_00001_.png`, `klein_icon_00001_.png`, `klein_bg_00001_.png` (1344×768)
- `ltx_t2v_960x544_97f.mp4` (actually 960×512), `ltx_t2v_960x512_loop.mp4` (crossfaded loop), `ltx_i2v_960x544_97f.mp4` (from the FLUX background), `ltx_t2v_1280x720_121f.mp4` (1280×704)
- `svg_ref_00001_.png` (best SVG-guided), `svg_i2i_d60_00001_.png`
- Raw data: `results.json` (all timings and VRAM), `setup_times.json`, `comfy.log`, `object_info.json`, logs `*.log`, scripts in `gpu1/scripts/`

## 8. Follow-ups

- Run the Klein and LTX downloads in parallel properly (the first-run bug left them sequential), and measure the total.
- Optional: Kyle accepts the licence on `black-forest-labs/flux-3-image-klein-comfy` to get int8 single files (about 9 GB smaller, no merge).
- Use 64-multiple sizes for two-stage LTX (1024×576 recommended), or single-stage for 960×544.
- Not tested: a cold-disk load (page cache was warm), audio decode, TextGenerate prompt upsampling, the comfy-api-proxy and SDK path with these models.
