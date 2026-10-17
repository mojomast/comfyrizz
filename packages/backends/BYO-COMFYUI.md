# BYO ComfyUI: running Comfyrizz on your own GPU (spec 6.5)

The `byo-comfyui` backend drives a ComfyUI that is **yours**: your machine, your electricity, your
models. Comfyrizz does not meter it and does not call it free — `describe()` reports
`costVisibility: "external-unknown"` for exactly that reason. If you want our GPU instead, that is the
Google Colab backend and it needs an approved spend (spec 6.7).

Everything below runs on this machine only. Nothing here starts a Google Colab runtime.

## Quick start

```bash
# 1. look at the plan first: --dry-run runs nothing
scripts/setup-local-comfy.sh --dry-run

# 2. do it (ComfyUI at the ref the GPU test 2 stack used, the two model repos, the links, the runner's deps)
hf auth login                                   # the HF repos are gated; the token goes to the hf CLI
scripts/setup-local-comfy.sh --comfyui-ref v0.41.3

# 3. start ComfyUI, then the v2 proxy the runner talks to
cd ~/comfyrizz-comfyui && .venv/bin/python main.py --listen 127.0.0.1 --port 8188
.venv/bin/comfy-api-proxy --comfyui http://127.0.0.1:8188 --port 8189

# 4. health first: nodes, model files, and optionally a real smoke job
cd /path/to/comfyrizz/pipeline-py
../.venv/bin/python -m comfyrizz_pipeline.health \
  --v2-url http://127.0.0.1:8189 --comfyui-url http://127.0.0.1:8188 \
  --require-node KSampler --require-node UNETLoader \
  --require-model-file flux-3-image-klein-bf16.safetensors --json

# 5. plan and run a package
node packages/jobs/bin/plan-jobs.mjs examples/launch-demo/package.json --out out/jobs.json
.venv/bin/python -m comfyrizz_pipeline.runner --jobs out/jobs.json --out out \
  --base-url http://127.0.0.1:8189
```

`--base-url` is a **deployment root**: the SDK appends `/api/v2` itself. For a plain ComfyUI with no
proxy, `http://127.0.0.1:8188` is the root.

The script is idempotent enough to re-run: it re-checks-out the ref instead of cloning again, and the
model cache (`~/comfyrizz-models` by default) is the source the ComfyUI `models/` tree links into, so
a second ComfyUI can be pointed at the same downloads.

### What the script does and does not do

| | |
|---|---|
| does | `git clone --depth 1 --branch <ref>` ComfyUI; a venv for it; its requirements **minus torch**; `hf download` the Klein and LTX repos; merge the two Klein text-encoder shards into `qwen3vl_4b_bf16.safetensors`; symlink all nine models in under the names the graphs ask for; install `comfy-api-proxy` + `comfy-sdk` + `jsonschema`; write `SETUP-INFO.txt` |
| does not | install torch (the wheel depends on your CUDA/driver, and the command is printed for you); start ComfyUI or the proxy; download anything on `--dry-run`; touch Google Colab; print, copy or pass an HF token |
| flags | `--dir`, `--models-dir`, `--comfyui-ref`, `--port`, `--skip-models`, `--skip-runner-deps`, `--dry-run`, `--help` |

Which ComfyUI: GPU test 2 ran the **0.41** stack (docs/GPU_TEST_2.md). The `v0.41.3` tag was committed
2026-10-17T04:26:50Z, hours before that run started (08:23 EDT = 12:23 UTC the same day), so
`--comfyui-ref v0.41.3` is the closest documented match to what the 134 jobs ran on — and the resolved
commit lands in `SETUP-INFO.txt` either way.

**No custom nodes are needed.** Every `class_type` in `workflows/*.api.json` — including
`ReferenceMultiLatent`, `EmptyFlux2LatentImage` and the `LTXV*` family — ships with ComfyUI itself:
that is what the GPU test 2 VM ran (a plain clone, no `custom_nodes/` installs) and all 134 jobs
succeeded. If a future graph needs a node pack, that is a dependency to add here, not something to
discover on the server.

## What must exist, by exact filename

The graphs name files, not repos, so a differently named download is a run that fails late on the
server. The script fetches and links exactly these:

| graph node | filename in `ComfyUI/models/` | source |
|---|---|---|
| `UNETLoader` (Klein) | `diffusion_models/flux-3-image-klein-bf16.safetensors` | `black-forest-labs/flux-3-image-klein` `model.safetensors` |
| `VAELoader` (Klein) | `vae/flux2-vae.safetensors` | same repo, `ae.safetensors` |
| `CLIPLoader` (Klein, `type: flux3`) | `text_encoders/qwen3vl_4b_bf16.safetensors` | same repo, `text_encoder/model-0000{1,2}-of-00002.safetensors`, **merged** |
| `UNETLoader` (LTX-2.5) | `diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` | `Lightricks/LTX-2.5` |
| `CLIPLoader` (LTX, `type: ltxv`) | `text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` | `Lightricks/LTX-2.5` |
| `VAELoader` | `vae/ltx-2.5-video-vae-bf16.safetensors`, `vae/ltx-2.5-audio-vae-bf16.safetensors` | `Lightricks/LTX-2.5` |
| `LatentUpscaleModelLoader` | `latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | `Lightricks/LTX-2.5` |

About 60 GB in total; GPU test 2 measured about 168 s to fetch them on a Google Colab VM link, so
budget for your own bandwidth. Licence: the FLUX and LTX weights are open-weight and their terms are
per-asset in the package (`model_license`, `redistributable`) — check them before you redistribute an
output.

## The two connection modes

1. **ComfyUI URL (default).** You have a URL the host can reach without auth (loopback, LAN, or a
   forwarded port). Comfyrizz starts `comfy-api-proxy --comfyui <url> --port <free>` on loopback and
   spawns the runner with `COMFY_BASE_URL=http://127.0.0.1:<port>`.
2. **v2 endpoint.** Your ComfyUI is behind auth or on a remote box: you run
   `comfy-api-proxy --token …` next to it and Comfyrizz connects to that v2 endpoint with the bearer.

Three claims about the proxy are still **[unverified]** (spec §9, item 9) — they were taken from a
review, not from us reading its source. They are cheap to settle once the proxy is installed, and the
commands are here so nobody has to trust the sentence:

```bash
# (a) does --token protect calls *into* the proxy only, and never authenticate to the upstream ComfyUI?
python -c "import comfy_api_proxy, inspect, sys; print(inspect.getsourcefile(comfy_api_proxy))"
#     read `cli.py`: the token check and the upstream client construction
# (b) how does comfy-sdk pass a bearer to a self-hosted proxy (v2-endpoint mode)?
python -c "import comfy_sdk, inspect; from comfy_sdk import Comfy; print(inspect.signature(Comfy.__init__))"
# (c) does the proxy work against a non-loopback ComfyUI URL?
#     point it at a ComfyUI on another host and run the health command above against it
```

Until (b) is settled, treat v2-endpoint mode as unproven and use mode 1; until (c) is settled, this
document promises nothing about a non-loopback upstream.

## Health checks, and what they do not prove

`python -m comfyrizz_pipeline.health` checks, in this order: the v2 endpoint answers, ComfyUI itself
answers (`/system_stats`), the node types you require exist (`/object_info`), the model files you
require exist, and — with `--smoke <workflow.api.json>` — a small job actually runs. `--json` prints
the whole report and the exit code is 0 only when every check passed.

A 256 px smoke job proves the wiring, not the workload: it says nothing about whether your VRAM fits a
241-frame LTX plate. GPU test 2 measured Klein at about 20.8 GB peak and a 241-frame LTX plate at
58.4 GB (docs/GPU_TEST_2.md), which is the number to compare against your card.

## Limits (what we deliberately do not promise)

- **No auth to your ComfyUI**: no upstream basic auth, no cookies, no path prefixes, no remote model
  installation. The proxy's optional bearer is about calls *into* the proxy (see (a) above).
- **Teardown is honest about ownership**: we stop only the proxy we started. Pointed at a ComfyUI you
  are already running, `teardown` reports `not_owned` rather than claiming to have stopped anything.
- **Cancel is scoped**: we cancel only job ids this backend submitted, never a global interrupt that
  would kill your own work.
- **No spend meter**: BYO has no units, no balance and no Google Colab accounting. The cost is yours.
- **The runner's own rules still apply** (pipeline-py/README.md): attempt records before every submit,
  `submission_unknown` never resubmitted, the manifest decides success, `--adopt`/`--clear` to resolve
  an ambiguous attempt by hand.
