#!/bin/bash
# Render Willem's birthday video on CPU with Pi's renderer toolchain (private media, outputs stay off git).
# usage: scripts/willem/explainer/render.sh [out.mp4] [extra remotion args]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"; EX="$REPO/examples/willem-birthday"
OUT="${1:-/workspace/willem-birthday/willem_3e_anniversaire.mp4}"; shift || true
mkdir -p "$EX/public/assets" "$EX/public/fonts"
cp "$REPO/apps/renderer/public/fonts/"* "$EX/public/fonts/"
cp "$EX/assets/"* "$EX/public/assets/"
cp "$EX/audio/narration.norm.wav" "$EX/public/"
[ -f "$EX/audio/music.wav" ] && cp "$EX/audio/music.wav" "$EX/public/"
ln -sfn ../../../apps/renderer/node_modules "$REPO/scripts/willem/explainer/node_modules"
cd "$REPO/apps/renderer"
npx remotion render "$REPO/scripts/willem/explainer/index.ts" WillemBirthday "$OUT" \
  --config="$REPO/scripts/willem/explainer/remotion.config.ts" --public-dir="$EX/public" \
  --browser-executable="${REMOTION_BROWSER:-/usr/bin/google-chrome}" "$@"
