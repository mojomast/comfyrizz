#!/usr/bin/env bash
# Comfyrizz B7 (spec 6.5): set up a ComfyUI that the BYO backend can drive, on this machine.
#
#   scripts/setup-local-comfy.sh --dry-run          # print every step, run nothing (safe default check)
#   scripts/setup-local-comfy.sh                    # clone ComfyUI, fetch the models, link them in
#   scripts/setup-local-comfy.sh --help
#
# What it mirrors: scripts/gpu2/g2_setup.py, the script that prepared the Google Colab VM for GPU test
# 2 (134 jobs, all ok) with one plain ComfyUI clone, no custom nodes, and the two model repos below.
# The filenames it links in are not decoration: `workflows/*.api.json` names
# `flux-3-image-klein-bf16.safetensors`, `flux2-vae.safetensors`, `qwen3vl_4b_bf16.safetensors`,
# `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`,
# `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`, `ltx-2.5-video-vae-bf16.safetensors`,
# `ltx-2.5-audio-vae-bf16.safetensors` and `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors`
# verbatim, so a differently named file is a run that fails on the server.
#
# Rules this script keeps: no secrets on a command line (an HF token comes from `hf auth login` or an
# environment variable; a token file is chmod 600 and removed), no Google Colab calls of any kind (this
# is the local path), and nothing is downloaded or installed before you ask for it - `--dry-run` prints
# the plan and exits.
set -euo pipefail

SELF="scripts/setup-local-comfy.sh"
COMFY_DIR="${COMFYRIZZ_COMFY_DIR:-$HOME/comfyrizz-comfyui}"
MODEL_CACHE="${COMFYRIZZ_MODEL_CACHE:-$HOME/comfyrizz-models}"
COMFY_REF="${COMFYRIZZ_COMFY_REF:-master}"
COMFY_REPO="${COMFYRIZZ_COMFY_REPO:-https://github.com/comfyanonymous/ComfyUI.git}"
PORT="${COMFYRIZZ_COMFY_PORT:-8188}"
PROXY_PORT="${COMFYRIZZ_PROXY_PORT:-8189}"
PYTHON="${PYTHON:-python3}"
DRY_RUN=0
SKIP_MODELS=0
SKIP_TORCH_NOTE=0
INSTALL_RUNNER_DEPS=1

#: The model repos and files GPU test 2 used, as `name|repo|files...`.
KLEIN_REPO="black-forest-labs/flux-3-image-klein"
KLEIN_FILES="model.safetensors ae.safetensors text_encoder/model-00001-of-00002.safetensors text_encoder/model-00002-of-00002.safetensors"
LTX_REPO="Lightricks/LTX-2.5"
LTX_FILES="diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors vae/ltx-2.5-video-vae-bf16.safetensors vae/ltx-2.5-audio-vae-bf16.safetensors latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"

usage() {
  cat <<EOF
$SELF - BYO ComfyUI for Comfyrizz (ComfyUI + pinned reference + models + comfy-api-proxy)

  --dry-run              print every command and exit (nothing is cloned, installed or downloaded)
  --dir DIR              where ComfyUI goes (default \$COMFYRIZZ_COMFY_DIR, else ~/comfyrizz-comfyui)
  --models-dir DIR       where the model repos are downloaded (default \$COMFYRIZZ_MODEL_CACHE, else ~/comfyrizz-models)
  --comfyui-ref REF      git ref to check out (default master). The GPU test 2 VM ran the 0.41 stack:
                         tag v0.41.3 was committed 2026-10-17T04:26:50Z, hours before that run started at
                         12:23 UTC, so \`--comfyui-ref v0.41.3\` reproduces it. The resolved commit is written
                         to SETUP-INFO.txt either way.
  --port PORT            ComfyUI port to print in the next steps (default $PORT; this script does not start it)
  --skip-models          skip the Hugging Face downloads and the text-encoder merge (link nothing)
  --skip-runner-deps     skip installing comfy-api-proxy / comfy-sdk / jsonschema into the ComfyUI venv
  -h, --help             this text

Environment: COMFYRIZZ_COMFY_DIR, COMFYRIZZ_MODEL_CACHE, COMFYRIZZ_COMFY_REF, COMFYRIZZ_COMFY_REPO,
COMFYRIZZ_COMFY_PORT, COMFYRIZZ_PROXY_PORT, PYTHON, HF_TOKEN (optional; never echoed), HF_HOME.

Nothing here touches Google Colab. The Hugging Face repos are gated, so run \`hf auth login\` first (or
export HF_TOKEN) - the token is read by the hf CLI, never by this script, and never printed.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --dir) COMFY_DIR="${2:?--dir needs a path}"; shift ;;
    --models-dir) MODEL_CACHE="${2:?--models-dir needs a path}"; shift ;;
    --comfyui-ref) COMFY_REF="${2:?--comfyui-ref needs a ref}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --skip-models) SKIP_MODELS=1 ;;
    --skip-runner-deps) INSTALL_RUNNER_DEPS=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "$SELF: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# run CMD... - the only way this script executes anything, so --dry-run is a complete plan by design.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY   %s\n' "$*"
    return 0
  fi
  printf '+ %s\n' "$*"
  "$@"
}

# run_shell SCRIPT - same contract for the few steps that are naturally shell one-liners.
run_shell() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY   sh -c %s\n' "$1"
    return 0
  fi
  printf '+ sh -c %s\n' "$1"
  bash -c "$1"
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    if [ "$DRY_RUN" = "1" ]; then
      say "note: '$1' is not installed (a real run would stop here)"
      return 0
    fi
    say "$SELF: '$1' is required but not on PATH" >&2
    exit 1
  fi
}

say "Comfyrizz: local ComfyUI setup (BYO backend, spec 6.5)"
say "  ComfyUI:   $COMFY_DIR  (ref $COMFY_REF)"
say "  models:    $MODEL_CACHE"
say "  python:    $PYTHON"
if [ "$DRY_RUN" = "1" ]; then say "  mode:      DRY RUN - nothing will be cloned, installed or downloaded"; fi

step "preflight"
need git
need "$PYTHON"
if [ "$SKIP_MODELS" = "0" ]; then need hf; fi
run "$PYTHON" --version
if [ "$DRY_RUN" = "0" ] && [ -n "${HF_TOKEN:-}" ]; then
  say "note: HF_TOKEN is set and will be used by the hf CLI; this script does not print or copy it"
fi

step "ComfyUI ($COMFY_REF)"
if [ -d "$COMFY_DIR/.git" ]; then
  run git -C "$COMFY_DIR" fetch --depth 1 origin "$COMFY_REF"
  run git -C "$COMFY_DIR" checkout --detach FETCH_HEAD
else
  run git clone --depth 1 --branch "$COMFY_REF" "$COMFY_REPO" "$COMFY_DIR"
fi
run_shell "git -C '$COMFY_DIR' log -1 --format='ComfyUI %h %cd'"
# No custom node packs: every class_type in workflows/*.api.json (ReferenceMultiLatent,
# EmptyFlux2LatentImage, the LTXV* family) ships with ComfyUI itself, which is what the GPU test 2 VM ran.

step "ComfyUI python environment"
if [ ! -x "$COMFY_DIR/.venv/bin/python" ]; then
  run "$PYTHON" -m venv "$COMFY_DIR/.venv"
fi
COMFY_PY="$COMFY_DIR/.venv/bin/python"
# torch is deliberately NOT installed here: the right wheel depends on your CUDA/driver. The
# requirements are installed without torch lines, and the recommended command is printed for you.
run_shell "grep -viE '^(torch|torchvision|torchaudio)([<>=~ ]|\$)' '$COMFY_DIR/requirements.txt' > '$COMFY_DIR/requirements-notorch.txt'"
run "$COMFY_PY" -m pip install --upgrade pip
run "$COMFY_PY" -m pip install -r "$COMFY_DIR/requirements-notorch.txt"
say "next (not run by this script): install a torch matching your GPU, e.g."
say "  $COMFY_PY -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124"
if [ "$INSTALL_RUNNER_DEPS" = "1" ]; then
  # the runner's own dependencies: the v2 proxy, the SDK the runner speaks, and the validator's jsonschema
  run "$COMFY_PY" -m pip install 'comfy-api-proxy' 'comfy-sdk==0.5.0' 'jsonschema==4.25.1'
fi

if [ "$SKIP_MODELS" = "0" ]; then
  step "models (about 60 GB: Klein 4 files, LTX 5 files)"
  run mkdir -p "$MODEL_CACHE/klein" "$MODEL_CACHE/ltx"
  # shellcheck disable=SC2086 - the file lists are intentional word splitting
  run hf download "$KLEIN_REPO" $KLEIN_FILES --local-dir "$MODEL_CACHE/klein"
  run hf download "$LTX_REPO" $LTX_FILES --local-dir "$MODEL_CACHE/ltx"

  step "merge the Klein text encoder (2 shards -> qwen3vl_4b_bf16.safetensors)"
  run_shell "'$COMFY_PY' - '$MODEL_CACHE' '$COMFY_DIR' <<'PY'
import glob, os, sys
from safetensors.torch import load_file, save_file
cache, comfy = sys.argv[1], sys.argv[2]
shards = sorted(glob.glob(os.path.join(cache, 'klein', 'text_encoder', 'model-*.safetensors')))
if not shards:
    sys.exit('no text-encoder shards under ' + os.path.join(cache, 'klein', 'text_encoder'))
state = {}
for path in shards:
    state.update(load_file(path))
dest = os.path.join(comfy, 'models', 'text_encoders', 'qwen3vl_4b_bf16.safetensors')
os.makedirs(os.path.dirname(dest), exist_ok=True)
save_file(state, dest)
print('merged %d shards -> %s' % (len(shards), dest))
PY"

  step "link the models where the workflow graphs expect them"
  # the names are the ones workflows/*.api.json asks for; a link, not a copy, so the cache stays the source
  run_shell "mkdir -p '$COMFY_DIR/models/diffusion_models' '$COMFY_DIR/models/text_encoders' '$COMFY_DIR/models/vae' '$COMFY_DIR/models/latent_upscale_models'"
  run_shell "ln -sfn '$MODEL_CACHE/klein/model.safetensors' '$COMFY_DIR/models/diffusion_models/flux-3-image-klein-bf16.safetensors'"
  run_shell "ln -sfn '$MODEL_CACHE/klein/ae.safetensors' '$COMFY_DIR/models/vae/flux2-vae.safetensors'"
  for file in $LTX_FILES; do
    run_shell "ln -sfn '$MODEL_CACHE/ltx/$file' '$COMFY_DIR/models/$file'"
  done
  run_shell "find -L '$COMFY_DIR/models' -name '*.safetensors' -printf '%p -> %l\n' | sort"
fi

step "record what was set up"
run_shell "printf 'ComfyUI ref: %s\\ncommit: %s\\nmodels: %s\\n' '$COMFY_REF' \"\$(git -C '$COMFY_DIR' log -1 --format=%H 2>/dev/null || echo unknown)\" '$MODEL_CACHE' >> '$COMFY_DIR/SETUP-INFO.txt'"

step "next steps"
say "1. start ComfyUI:      cd $COMFY_DIR && .venv/bin/python main.py --listen 127.0.0.1 --port $PORT"
say "2. start the v2 proxy: .venv/bin/comfy-api-proxy --comfyui http://127.0.0.1:$PORT --port $PROXY_PORT"
say "   (the runner takes a deployment root: COMFY_BASE_URL=http://127.0.0.1:$PROXY_PORT, and the SDK appends /api/v2)"
say "3. health check:       $COMFY_PY -m comfyrizz_pipeline.health --v2-url http://127.0.0.1:$PROXY_PORT --comfyui-url http://127.0.0.1:$PORT --require-node KSampler --json"
say "   (run it from the repository root, with pipeline-py on PYTHONPATH; see pipeline-py/README.md)"
say "4. plan and run:       node packages/jobs/bin/plan-jobs.mjs <package.json> --out out/jobs.json"
say "                       .venv/bin/python -m comfyrizz_pipeline.runner --jobs out/jobs.json --out out --base-url http://127.0.0.1:$PROXY_PORT"
say ""
say "BYO has no spend meter of ours: it is your hardware and your electricity (spec 6.5). See"
say "packages/backends/BYO-COMFYUI.md for the two connection modes, the health checks and the limits."
if [ "$DRY_RUN" = "1" ]; then say ""; say "dry run complete: nothing was executed"; fi
