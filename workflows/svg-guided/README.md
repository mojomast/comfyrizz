# SVG-guided generation — CPU prep (WS-E, E1)

Owner: **Hermes**. An agent-written SVG carries the scene's composition; this directory holds the
sample scenes, the drafts the CPU prep produces, and the research note for the GPU sweep that Kyle
approves separately (E2). **No GPU, no Google Colab, no network** is used by anything in here.

```bash
cd pipeline-py
../.venv/bin/python tools/svgguide_prep.py            # writes samples/out + sweeps/e2.json
../.venv/bin/python -m pytest tests/test_svgguide.py  # 16 cases, under 1 s, CPU only
```

| Path | What it is |
|---|---|
| `samples/{hero,background,texture}.svg` | three hand-written scenes, one per layout role |
| `samples/*.regions.json` | the v0 contract: palette (far→near), declared regions, text-safe regions, template and sweep parameters |
| `samples/out/` | generated: raster PNG, `canny`/`lineart`/`depth` maps, one mask per region, filled workflow + params files per approach, and `manifest.json` (gitignored; regenerate with the command above) |
| `sweeps/e2.json` | the E2 sweep plan: seeds, denoise grid, reference budgets, scenes, rubric, and a unit estimate |

## The four guidance approaches (PLAN.md E1)

| # | Approach | Status |
|---|---|---|
| 1 | raster as img2img init latent, denoise swept 0.35 → 0.85 | **drafted** on `workflows/flux3_klein_img2img.api.json` |
| 2 | raster as Klein reference image 0, boxes in the prompt | **drafted** on `workflows/flux3_klein_ref_edit.api.json` |
| 3 | ControlNet-style (canny / depth / lineart) | **not drafted**: no Klein-compatible control weights were established. `CONTROLNET_STATUS` says so instead of borrowing another model's ControlNet |
| 4 | LTX-2.5 i2v from the SVG-guided still | **drafted** on `workflows/ltx25_i2v_2stage.api.json` |

The drafts start from the **real** GPU-test-1 graphs and their B4 params maps, and inject the
guide's parameters with the runner's own `inject_params` — a draft that the runner could not
execute cannot be produced.

## v0 contracts (what the maps rely on)

1. **Depth** is read from the declared palette order: the sample scenes paint one flat fill per
   layer, and the palette in `<scene>.regions.json` is far→near. Reading depth out of an arbitrary
   SVG's z-order is **[unverified]** for inputs this package did not author.
2. **Region masks** match a flat, opaque declared colour (tolerance 10/765). A gradient core has no
   single colour, so `background.regions.json` declares only its opaque accent — that is why the
   note lives in the file.
3. **Edge maps** quantise luminance to 12 levels before the gradient/ hysteresis stage: an SVG
   raster is flat fills, so quantising turns a soft ramp into the boundary the composition actually
   has. OpenCV's real Canny is used instead when cv2 happens to be installed; the numpy path is the
   tested one.
4. **No image library**: rasters come from `@resvg/resvg-js` through `svgguide/_resvg.mjs` (read-only
   use of Pi's `packages/vector` dependency), and maps are written as PNGs by a ~20-line zlib writer.
5. **Geometry (GPU test 2, issue 6)**: a raster is snapped onto the 16-pixel lattice before it goes
   anywhere. `snap_size` prefers a size whose aspect is exactly the SVG's — a 16:9 scene asked for at
   width 960 becomes 1024x576, which is also the size the GPU test 2 findings recommend — and falls
   back to rounding the height to the nearest step, with `fit_box` stretching the painting to the box
   (a letterboxed guide would have a transparent band the model reads as "nothing here"). For a 16:9
   lattice size the width has to be a multiple of 256, so 480→512x288 and 960→1024x576 are exact
   twins while 320, 640 and 1920 take the fallback.
6. **A guided plate runs at its output aspect**: `svgguide.sweeps.APPROACH_GEOMETRY` carries the
   geometry each approach runs at (stills 1280x720, i2v 1024x576) into both the workflow drafts and
   `sweeps/e2.json`, so an i2v first frame is never centre-cropped down from another shape — the
   failure the GPU test 2 mascot showed. `packages/jobs` refuses a package whose i2v source is a
   different aspect than its plate for the same reason.

## Research note (E1)

* **[verified, model card — SPEC.md §6.4]** FLUX 3 Image Klein takes up to 10 reference images and
  bounding boxes belong in the prompt; it is a distilled checkpoint at 16 steps, CFG 1, and the
  model card says not to use it without a prompt upsampler. The captions here are template-rendered
  and carry the palette and the text-safe regions so the image stays quiet where copy will sit.
* **[verified, GPU test 1]** the graphs the drafts start from exist in `workflows/`, were built for
  the Oct 17 session, and stop at the same node families (`EmptyFlux2LatentImage`, `KSampler`,
  `ReferenceMultiLatent`; `EmptyLTXVLatentVideo`, `LTXVEmptyLatentAudio`, `LTXVLatentUpsampler`).
* **[unverified]** that the reference/edit path (`ReferenceMultiLatent`) ran to a good image on the
  VM: GPU test 1's results are summarised in `/workspace/comfy-hackathon/test/GPU_TEST_1.md` (box,
  outside this repo) and I have not read a per-workflow verdict there. E2 should treat approach 2 as
  unproven until it produces one.
* **[unverified — none found]** no ControlNet or control-LoRA weights for FLUX 3 Image Klein were
  established while writing this; the M3 spike (with hub access) should re-check and record links
  here. Nothing was substituted for them.
* **[unverified]** LTX-2.5 first/last-frame conditioning (`ltx25_i2v_loop`, SPEC.md §6.4's stretch
  goal) is not covered by any draft here; a matching last frame does not guarantee a seamless loop.
* **[unverified]** how the guide image reaches the VM: the drafts pass a repository-relative path,
  which is what the runner does today. SDK asset upload for reference images is M3 work (SPEC.md
  §6.4).

## What E2 has to measure

`sweeps/e2.json` is data, not a run: 48 jobs (3 scenes × 2 seeds × 8 settings) at a placeholder
0.5–1.5 GPU minutes per job, **≈ 6.1 units estimate** including the measured 5-minute cold start
and the 6-minute collect-and-stop reserve — the same reserve formula as SPEC.md §6.6. It needs
Kyle's explicit approval of the session and the budget before anything runs, and the metadata says
so. Output: a CSV of `edge_iou` / `chamfer_px` / `mask_iou` / `palette ΔE` per job plus a contact
sheet per scene, a CLIP score where a checkpoint is available (optional, CPU-slow, off by default),
and a human 1–5 sheet that picks the defaults per layout role.

**Label legibility is scored too, because edge IoU scored the wrong thing.** On GPU test 2 edge IoU
against the SVG raster rewarded a low-denoise near-copy (0.61–0.88) and punished the reference edits
that looked best (0.07–0.74): an edit re-renders the texture and shifts geometry, so it is *not*
pixel-registered and crisp SVG text cannot be overlaid on it. Two CPU checks, in `pipeline-py/eval/`:

| check | what it answers | needs |
|---|---|---|
| `metrics.label_structure_retention(ref, out, label_mask)` | did the label's strokes and contrast survive in that region? | numpy only |
| `legibility.check_labels(labels, image=…)` | do the SVG's label **strings** still read in the output? | an OCR engine (injected or installed) |

`label_structure_retention` runs everywhere and is a *proxy* — it cannot tell a moved label from a
kept one. `legibility` compares the SVG's known strings against OCR text with a similarity ratio per
label, reporting near misses; this box has **no OCR engine** (`tesseract` binary, pytesseract and
easyocr are all absent), so `read_labels` returns `available: false` with the install note instead of
guessing, and the interface takes an injected engine (`check_labels(labels, image=..., engine=fn)`)
so a transcription or a future OCR install drops straight in:
`python -m eval.legibility --labels "Solar Panel" "Inverter" --observed "<text read from the frame>"`.
A future sweep session should install `tesseract-ocr` on the VM and record the OCR rows next to the
IoU rows, so "keeps the labels" is answered with a reading rather than an edge overlap.

Every axis is checked against the approach's params map before the plan is written
(`svgguide.workflows.SWEEP_AXES` + `check_sweep_axes`, used by `build_sweep_spec`): an axis whose
parameter reaches no node input is a no-op that still costs GPU units, which is exactly what the
first E2 plan shipped — a `reference_weight` axis for `ReferenceMultiLatent`, a node with no weight
input, so every reference-edit job in that batch was one render under three names (`w0_0`). The
reference-edit axis is now `reference_megapixels`, the reference **budget** the node really takes
(`resolution.megapixels`).
