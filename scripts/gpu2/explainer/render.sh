#!/bin/bash
# Render the GPU test 2 showcase explainer on CPU through apps/renderer.
# No custom composition and no node_modules symlink: this calls the shared
# render-package-lib (validate -> A2 compile -> Remotion PackageDemo -> MP4).
# usage: scripts/gpu2/explainer/render.sh [out.mp4]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${1:-$REPO/examples/showcase-gpu2/out/showcase-gpu2.mp4}"
cd "$REPO"
node apps/renderer/scripts/render-showcase.mjs "$OUT"
