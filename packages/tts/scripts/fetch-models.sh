#!/usr/bin/env bash
# Fetch the pinned Kokoro CPU weights. They are NOT committed (338 MB).
# Override the cache with KOKORO_MODEL_DIR=/path.
set -euo pipefail

dir="${KOKORO_MODEL_DIR:-$HOME/.cache/comfyrizz/kokoro}"
base="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
mkdir -p "$dir"

fetch() {
  local name="$1" want="$2"
  if [[ -f "$dir/$name" ]] && [[ "$(sha256sum "$dir/$name" | cut -d' ' -f1)" == "$want" ]]; then
    echo "ok   $name"
    return
  fi
  echo "get  $name"
  curl -fL --retry 3 -o "$dir/$name.tmp" "$base/$name"
  local got
  got="$(sha256sum "$dir/$name.tmp" | cut -d' ' -f1)"
  if [[ "$got" != "$want" ]]; then
    rm -f "$dir/$name.tmp"
    echo "sha256 mismatch for $name: $got" >&2
    exit 1
  fi
  mv "$dir/$name.tmp" "$dir/$name"
}

fetch kokoro-v1.0.onnx 7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5
fetch voices-v1.0.bin bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d
echo "models in $dir"
