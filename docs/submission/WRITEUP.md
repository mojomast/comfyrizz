# Comfyrizz: open-source AI motion graphics from a chat brief

## What it is, and who it is for

Comfyrizz turns a short brief into a 30–90 second narrated motion-graphics video: a storyboard,
exact typography, real charts, generated stills, moving plates and captions, exported as an MP4. It
is for founders, developers and educators without a motion-design team or a GPU.

It is a pnpm monorepo under the MIT licence (Node 22, Python). Its contract is
`comfyrizz.package/v1`: scenes, copy, datasets, assets, licences and generation provenance in one
JSON file. The bundled CPU example, `examples/launch-demo`, opens and exports with no key, GPU or network.

## How it is built

It separates generative pixels from exact information.

- **Comfy SDK workflows.** `pipeline-py` reads an ordered, hashed `jobs.json` and submits API-format
  ComfyUI workflows through the Comfy SDK. `workflows/` covers FLUX 3 Klein text-to-image and
  reference edits, LTX-2.5 text-to-video and image-to-video, and an LTX ×2 upscale pass. The same
  runner reaches Google Colab or a user's ComfyUI via `comfy-api-proxy`.
- **FLUX 3 Klein stills.** The agent expands prompts for illustrations, textures and hero images;
  the submitted graph, seed and prompt stay with the asset.
- **LTX-2.5 plates.** LTX supplies moving backgrounds and hero shots, sized to the model's lattice
  and retimed to 30 fps.
- **Remotion for exact text and charts.** `apps/renderer` is deterministic: frame = f(timeline,
  local assets, frame number). Headlines, statistics, SVG charts, lists and captions are drawn by
  code, so chart values never come from an image model. Eight layouts and frame-driven motion recipes are supported.
- **A model-agnostic chat agent.** `packages/agent` runs a bounded, zod-validated tool loop. An
  asset router prefers CPU-checked SVG for icons, diagrams and patterns, FLUX for raster art, and
  Openverse or uploads only as fallbacks. `packages/llm` supports OpenRouter, OpenCode Go
  (conditional) and any OpenAI-compatible endpoint, so open-weights models can be used.
- **Two backends, one pipeline.** The Google Colab adapter allocates a G4, bootstraps pinned
  models, runs batches, collects results and verifies the stop; a spend card and reserve formula
  gate every job. The BYO adapter points the same jobs at the user's own ComfyUI.
- **Rights and portability.** Each asset records its source, licence and approval. `CREDITS.md` and
  a rights-filtered `package.zip` ship only assets that may be redistributed, with reasons.

## Why it is innovative

ComfyUI is usually the whole product. Here it is a plate and still generator inside a deterministic
motion-graphics engine. That gives generated imagery without letting a diffusion model invent
numbers or headline spelling. Editing copy, palette or chart data recompiles the
timeline and previews instantly.

Second, a licence-aware agent makes asset choice, provenance and export rights part of the project
format. The third is execution honesty. Attempt records are written before submission, an
atomic result manifest is the only proof of success, lost submissions are reconciled rather than
resubmitted, and a Google Colab runtime is reported stopped only after `colab sessions` confirms it.

## Categories and bonuses

| Target | Priority | Reason |
| --- | --- | --- |
| **Open Weights Only** | Primary main prize | FLUX 3 Klein, LTX-2.5 and Kokoro are open weights; both backends run the repo's workflows with no partner nodes. The LLM is user-selected, and a local OpenAI-compatible model keeps the stack open. A hosted open-weights LLM is [unverified]. |
| **Best Overall** | Automatic | Demo and output quality. |
| **Most Innovative** | Secondary | Generative plates in a deterministic compositor, licence tracking and a verified Colab teardown. |
| **Most Viral** | Not targeted | A productivity tool. |
| **VFX Workflow Built with LTX** | Primary bonus | LTX-2.5 makes the moving plates. Motion graphics may not count as VFX [unverified]. |
| **Built with FLUX** | Fallback bonus | FLUX 3 Klein makes stills and reference edits. Klein's "FLUX 3" eligibility is [unverified]. |

## What works today

- **CPU path:** install, build, serve, edit, preview and export MP4 plus captions,
  credits and a project archive. `examples/launch-demo` has 1,100 frames (36.7 s) and a clean-clone
  end-to-end script.
- **Narration:** Kokoro on CPU, measured sentence cues and SRT/VTT export (`examples/hook-20s`,
  `examples/narrated-demo`).
- **Authoring:** the package schema and validators, timeline compiler, SVG sanitise and render-check
  pipeline, agent tools and provider probe.
- **GPU:** the FLUX and LTX workflows, Comfy SDK runner, attempt records and manifest handling, the
  Google Colab lifecycle and BYO ComfyUI. Real G4 media runs are documented; a combined paid
  nine-stage Colab run is outstanding.

## Post-hackathon (SCOPE FREEZE)

`docs/PLAN.md` freezes the submission to the demo path. These are post-hackathon:

- Music bed and SFX in the mix.
- Motion transitions (blur, push, zoom, iris); the vocabulary and motion lint stay.
- Qwen3-TTS voices; Kokoro is the only submission voice.
- SVG-guided generation defaults from `workflows/svg-guided/`, which stays experimental and off by
  default.
- A Comfy Cloud backend; Google Colab and your own ComfyUI remain.

## How to run it

```bash
pnpm install --frozen-lockfile
pnpm -r --if-present run build
cd apps/server && npm start          # open the printed 127.0.0.1 URL
```

Or render the example directly and run the checks:

```bash
pnpm --filter @comfyrizz/renderer render:example
pnpm test:all
```

CPU needs no key. For GPU work, choose Google Colab or BYO ComfyUI; the README covers the
Hugging Face token and `google-colab-cli`.
