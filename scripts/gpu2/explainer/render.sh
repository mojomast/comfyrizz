#!/bin/bash
# Render the GPU test 2 showcase explainer on CPU with Pi's renderer toolchain.
# usage: scripts/gpu2/explainer/render.sh [out.mp4] [extra remotion args, e.g. --frames=0-60]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"; EX="$REPO/examples/showcase-gpu2"
OUT="${1:-$EX/out/showcase-gpu2.mp4}"; shift || true
mkdir -p "$EX/public/assets" "$EX/public/fonts" "$EX/out"
cp "$REPO/apps/renderer/public/fonts/"* "$EX/public/fonts/"
cp "$EX/assets/"* "$EX/public/assets/"
cp "$EX/audio/narration.norm.wav" "$EX/public/"
ln -sfn ../../../apps/renderer/node_modules "$REPO/scripts/gpu2/explainer/node_modules"
cd "$REPO/apps/renderer"
npx remotion render "$REPO/scripts/gpu2/explainer/index.ts" ShowcaseGpu2 "$OUT" \
  --config="$REPO/scripts/gpu2/explainer/remotion.config.ts" --public-dir="$EX/public" \
  --browser-executable="${REMOTION_BROWSER:-/usr/bin/google-chrome}" "$@"
