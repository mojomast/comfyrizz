# GPU test 2: Comfyrizz model-stack showcase (Google Colab G4)

Date: Sat Oct 17 2026. Times are Toronto (EDT, UTC-4).

## Summary

| Item | Value |
|---|---|
| Session | `comfyrizz-gpu2`, Google Colab G4 (RTX PRO 6000 Blackwell, 97,887 MiB) |
| Runtime | 08:23:41 to 08:47:45 EDT (about 24 min), then stopped |
| Units | 385.70 before, 382.28 after: **3.42 used** (session cap 12; 30-unit test budget now has about 25.6 left) |
| Jobs | 134 ComfyUI jobs (107 PNG, 28 MP4 including two retries), all ok |
| Setup | 215 s total: pip 192 s, parallel downloads 60.02 GB in about 168 s, text-encoder merge 20.7 s, ComfyUI ready in 14 s |
| Cleanup | HF token was uploaded as a 0600 file, deleted by setup (`token file removed: True`, later `ls /content/.hf` empty), never printed or passed with `--env`. Runtime stopped; `colab sessions` reports no active sessions (re-checked 09:05 EDT). The session watchdog has exited. No SSH was used. |
| Box-side work | Contact sheets, crossfade loops, narrated explainer, reel and E1 edge metrics, all on CPU after the stop |

## Deliverables (`test/gpu2/`)

- `reel_gpu2.mp4`: 87 s highlight reel, 1920x1080 at 30 fps. Sections: Klein styles (Ken Burns), SVG-guided restyles, LTX i2v, the 10 s single shot, seamless loops, an explainer excerpt with audio.
- `explainer_solar_showcase.mp4`: 43.7 s narrated explainer, "How solar power works". Built with Pi's renderer, Kokoro `af_heart` voice, captions, and 8 GPU-generated LTX/Klein assets. The source is `examples/showcase-gpu2/` and `scripts/gpu2/explainer/`.
- `contact/`: `klein_styles.jpg`, `svg_{solar_flow,bar_chart,timeline,mind_map}.jpg`, `e2_{background,hero,texture}.jpg`, `ltx_i2v.jpg`, `ltx_t2v_loops_e2.jpg`.
- `loops/loop_{ribbons,particles,gradient,bokeh,grid}_seamless.mp4`: 3.5 s each, 0.5 s crossfade seam.
- `e1_edge_iou.md`: edge-IoU table for the SVG sweep.
- `raw/`: every output plus `results.json` (per-job timings), ComfyUI and proxy logs, and the Hermes runner outputs.

Best contact sheets: `klein_styles.jpg`, `svg_solar_flow.jpg`, `svg_timeline.jpg`, `ltx_i2v.jpg`, `e2_hero.jpg`.

## Timings (warm unless noted)

| Workload | Time | Peak VRAM |
|---|---|---|
| Klein 1344x768 or 1024², 16 steps | 8.1 s cold, then about 2.5 s | about 20.8 GB |
| Klein 1920x1088 | 5.35 s | |
| Klein img2img (SVG raster) | 2.0 to 2.6 s | |
| Klein reference edit (ReferenceMultiLatent) | 5.1 to 5.3 s | |
| LTX-2.5 two-stage 1024x576, 97 frames | 23.6 s cold, then 12.5 to 16 s | 54.9 GB cold, then about 42 GB |
| LTX-2.5 241 frames (10 s) | 31.9 s | 58.4 GB |
| LTX-2.5 i2v 1024x576 | 13 to 16 s (28 s for the first run after Klein) | |
| LTX-2.5 1536x832 | 24.2 s | |

Both models stay resident under ComfyUI 0.41's dynamic VRAM, so switching between Klein and LTX costs little. Most of the 24 minutes went to setup and download, not generation (134 jobs = 13.5 min wall, 12.7 min ComfyUI execution, from `results.json`). At about 8.9 units/h (0.1 unit is about 40 s), a warm G4 makes about 16 Klein stills or about 3 LTX 4 s clips per 0.1 unit.

## What worked

- **Klein style range is excellent** (`klein_styles.jpg`). These all came out clean at 1344x768 in about 2.5 s each: isometric, flat vector, clay/3D mascot, glassmorphism UI, photoreal product (battery, card), photoreal portrait, editorial, paper-cut, low-poly, synthwave, icon set, seamless textures, mesh backgrounds.
- **The SVG reference edit is the best way to style agent SVGs.** It gives a strong style while keeping layout and labels legible (see `svg_solar_flow.jpg` glass/clay ref, `svg_timeline.jpg` clay ref). Img2img at d0.45 and d0.60 is faithful but barely restyled. At d0.75 it restyles but corrupts small labels (timeline quarter labels shuffled).
- **LTX loops** with static-camera prompts are smooth. A 0.5 s crossfade makes them seamless (`loops/`).
- **LTX i2v keeps the first frame faithfully.** Character idle motion (fox, mascot) and glow pulses on diagrams look good. `i2v_svg_solar_glass` (static camera plus glow) is the model for "animate a diagram".
- **A 10 s single shot (241 frames)** holds together: a sunrise over a solar farm with no drift artefacts.
- **The explainer pipeline works end to end on CPU:** Kokoro synth 8.3 s for 7 scenes, narrate/loudnorm -16.3 LUFS, captions, package validates, Remotion render 2 min 24 s for 43.7 s at 1080p.

## What looked bad

- `st_corp_hero` drew garbled pseudo-text on screens. The v2 prompt with "no text, blank screens" fixed it. The sketch style wrote a legible stray word ("Loss"). Always add "no text, no letters" unless text is wanted.
- The battery "turntable" prompt produced a zoom, not an orbit. LTX-2.5 does not reliably orbit from an i2v still.
- A 1:1 mascot fed to 16:9 i2v was centre-cropped, cutting off the head. Generate i2v sources at the output aspect (the 16:9 rerun was fine).
- Camera push-ins on diagrams (`i2v_svg_timeline_clay`, `i2v_svg_chart_clay`) push labels out of frame. Use a static camera for anything with text.
- E2 hero img2img stays flat up to 0.65 and departs at 0.85. s42 d0.85 came back as a small letterboxed image inside the frame.
- **E1 metric caveat:** edge IoU against the SVG raster rewards low denoise. d45 scores 0.61 to 0.88, while the visually best reference edits score 0.07 to 0.74, because the edits re-render texture, shift geometry slightly and add depth. So the reference edit is *not pixel-registered* to the SVG: you cannot overlay crisp SVG text on it without misalignment. For the rubric, a label-OCR/text-legibility check would fit "keeps the labels" better than edge IoU. Full table below.

### E1 edge IoU (agent SVG raster vs output, 672x384 gradient edges, tolerance 2 px)

| SVG | style | d45 | d60 | d75 | ref |
|---|---|---|---|---|---|
| solar_flow | glass | 0.88 | 0.83 | 0.61 | 0.74 |
| solar_flow | clay | 0.88 | 0.83 | 0.65 | 0.30 |
| solar_flow | editorial | 0.88 | 0.86 | 0.52 | 0.14 |
| bar_chart | glass | 0.81 | 0.56 | 0.47 | 0.26 |
| bar_chart | clay | 0.82 | 0.58 | 0.49 | 0.14 |
| bar_chart | editorial | 0.83 | 0.67 | 0.51 | 0.07 |
| timeline | glass | 0.61 | 0.55 | 0.32 | 0.28 |
| timeline | clay | 0.61 | 0.51 | 0.37 | 0.26 |
| timeline | editorial | 0.61 | 0.57 | 0.38 | 0.08 |
| mind_map | glass | 0.68 | 0.64 | 0.57 | 0.54 |
| mind_map | clay | 0.66 | 0.65 | 0.53 | 0.22 |
| mind_map | editorial | 0.66 | 0.64 | 0.56 | 0.13 |

Script: `scripts/gpu2/e1_quick.py`, which uses `pipeline-py/eval/metrics.edge_iou`.

## Best prompt templates (full set in `scripts/gpu2/prompts.py`)

- **Klein style still:** `<subject>, <style descriptor: e.g. "soft clay 3D render, rounded shapes, pastel studio lighting">, clean composition with negative space on the left for a headline, 16:9, no text, no letters, no logos.`
- **SVG reference edit** (ReferenceMultiLatent, image0 = SVG raster): `Restyle this diagram as <glass|clay|editorial> ... Keep the exact layout, positions, colours and all labels exactly as written. Do not add or remove elements.`
- **LTX loop (t2v):** `<abstract subject>, slow continuous motion, static camera, seamless, no cuts, no text.` Then add a 0.5 s crossfade on the box.
- **LTX i2v:** `Use the provided start image as the first frame. <one gentle motion: idle breathing / glow pulse / light sweep>. Static camera. No cuts, no text.` Avoid push-ins and orbits when the frame has labels.
- **Long single shot:** 241 frames at 1024x576, with one slow, physically simple event (a sunrise, drifting clouds).

## Issues for Hermes (pipeline-py / runner)

1. **SDK and proxy disagree on `metadata`.** The proxy rejects SDK submissions: "'metadata' must be a string (opaque label)". Sending a JSON string instead makes the SDK fail: "invalid_workflow: dictionary update sequence element #0 has length 1; 2 is required" (the SDK wants a dict). Only `metadata=None` works. Pick one contract.
2. **No image upload plumbing for i2v/img2img.** `a_plate1.plate` failed with "Prompt outputs failed validation" because LoadImage received the asset id rather than an uploaded filename. The runner needs to upload the dependency output (`/upload/image`) and inject the returned name.
3. **LTX params map puts `width`/`height` on node 8,** the stage-1 latent. A planned 960x544 runs stage 1 at full size and outputs 2x (1920x1088). Map the final size to stage 1 at half size, or add a separate key.
4. **i2v ImageScale (node 31) dimensions are unmapped,** so the start image keeps the default size whatever the plan says.
5. **`e2.json` `reference_weight` has no target node.** ReferenceMultiLatent has no weight input, so this sweep axis is a no-op (outputs are named `w0_0`).
6. **E2 sample rasters are 960x540,** which is not a multiple of 16. Klein pads or crops them; use 960x544 or 1024x576.
7. **The `validate` CLI treats a jobs.json as a package** and reports schema errors. It needs a mode for job files.
8. **Reconcile behaves correctly:** after the crashed run 2, `a_cutout.still` came back `submission_unknown`, because the attempt was left "submitting" with no job id. That is right, but it is worth documenting how a user clears it. `a_plate1_still.still` went end to end through SDK and proxy (960x544 PNG).
9. The runner and SDK monkeypatches persist in the Google Colab kernel; a second in-kernel run hit RecursionError. Run them in a subprocess (see `scripts/gpu2/hermes_shim.py`).

## Issues for Pi (renderer / tts)

1. **The renderer does not draw raster or video assets.** `background.asset` and video/image foreground items are ignored; `Background` falls back to `colors[0]`. The showcase works around this in its own composition (`scripts/gpu2/explainer/Showcase.tsx`): a media layer under `SceneView`, a palette copy with `colors[0]='transparent'`, a scrim, and framed video panels. Something like this belongs in the renderer.
2. **The list layout uses `colors[0]` for bullet text,** so a transparent or dark base colour breaks bullets.
3. There is no lower-third or kicker overlay for full-bleed diagram scenes. The showcase uses its own and a `media.json` sidecar (`scrim`, `skipLayout`, `lowerThird`). Consider adding these to the schema.
4. `packages/tts/fetch-models.sh` is not executable (run it with `bash`).
5. `narrate.mjs` adds `a_narration` but no scene references it, so the validator always warns `WARN_ASSET_UNUSED`.
6. A composition outside `apps/renderer` cannot resolve `remotion` imports. Remotion bundles the config with esbuild, so a `resolve.modules` override in a config outside the app is never applied. The workaround is a gitignored `node_modules` symlink, made by `scripts/gpu2/explainer/render.sh`.

## Other notes

- Parallel downloads gave no speedup (Klein 121 s, LTX 168 s, against about 168 s sequential), so the link is the bottleneck. The 192 s pip install is the bigger target: pre-built wheels or a cached venv would roughly halve setup.
- `scripts/gpu2/g2_finish.py` never ran because of a wrong `-f` path. That did not matter: the token was already gone and the VM was destroyed on stop.
- The box was restored from a snapshot mid-task, so files disappeared for about 4 minutes. A large glob `ls` hung for 840 s.

## Reproduce (CPU, no GPU)

```
python3 scripts/gpu2/make_showcase.py   # package from test/gpu2/raw (copies media into examples/showcase-gpu2/assets)
.venv/bin/python packages/tts/py/synth.py --package examples/showcase-gpu2/package.json --out examples/showcase-gpu2/audio --padding 0.5
node packages/tts/scripts/narrate.mjs --example examples/showcase-gpu2
scripts/gpu2/explainer/render.sh        # -> examples/showcase-gpu2/out/showcase-gpu2.mp4
python3 scripts/gpu2/reel.py            # -> test/gpu2/reel_gpu2.mp4
```
