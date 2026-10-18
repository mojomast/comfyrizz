#!/usr/bin/env bash
# C12 (M8): front-side clean-clone e2e.
#
# A stranger's path from `git clone` to a finished video, with no API key and no
# Google Colab runtime anywhere in the loop:
#
#   clone HEAD -> pnpm install -> build -> start apps/server with the scripted
#   (stub) agent -> one chat brief -> POST /api/render -> POST /api/export ->
#   assert the five export files exist and ffprobe frames == compiled timeline.
#
# Everything happens under one mktemp dir; the trap stops the server and removes
# the dir, so a run leaves no orphaned process or temp files. Set KEEP=1 to keep
# the workspace for inspection, and CLEAN_CLONE_PORT / CLEAN_CLONE_REPO to
# override the port and source repo.
set -euo pipefail

REPO="${CLEAN_CLONE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
STARTED_AT=$SECONDS
WORK="$(mktemp -d "${TMPDIR:-/tmp}/comfyrizz-clean-clone.XXXXXX")"
CLONE="$WORK/clone"
RUNTIME="$WORK/runtime"
TOKEN="clean-clone-$(date +%s)-0123456789abcdef"
PORT="${CLEAN_CLONE_PORT:-$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')}"
SERVER_PID=""

log() { printf '\n== %s ==\n' "$*"; }

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 10); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "${KEEP:-0}" == "1" ]]; then
    echo "kept $WORK (KEEP=1)"
  else
    rm -rf "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

api() { # api METHOD PATH [JSON]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "http://127.0.0.1:$PORT$path" \
      -H "x-comfyrizz-token: $TOKEN" -H "origin: http://127.0.0.1:$PORT" \
      -H 'content-type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "http://127.0.0.1:$PORT$path" \
      -H "x-comfyrizz-token: $TOKEN" -H "origin: http://127.0.0.1:$PORT"
  fi
}

json() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(eval(process.argv[1]))' "$1"; }

log "clone $REPO (HEAD)"
git clone --quiet --no-local "$REPO" "$CLONE"
echo "cloned $(git -C "$CLONE" rev-parse --short HEAD)"

log "install (pnpm, as the README describes for the workspace)"
( cd "$CLONE" && pnpm install --no-frozen-lockfile --reporter=append-only 2>&1 | tail -4 )

log "build workspace packages + web"
( cd "$CLONE" && pnpm -r --if-present run build > "$WORK/build.log" 2>&1 ) || { tail -30 "$WORK/build.log"; exit 1; }

log "start apps/server (scripted agent, no key, port $PORT)"
mkdir -p "$RUNTIME"
COMFYRIZZ_RUNTIME="$RUNTIME" COMFYRIZZ_PORT="$PORT" COMFYRIZZ_TOKEN="$TOKEN" \
  node "$CLONE/apps/server/src/index.mjs" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "server exited early:"; tail -30 "$WORK/server.log"; exit 1; }
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/health" > /dev/null || { echo "server never became healthy:"; tail -30 "$WORK/server.log"; exit 1; }

log "send one brief (stub provider, no API key)"
BRIEF="A 20-second explainer about why the sky is blue."
AGENT="$(api POST /api/agent "$(node -e 'process.stdout.write(JSON.stringify({brief:process.argv[1]}))' "$BRIEF")")"
PKG_ID="$(printf '%s' "$AGENT" | json 'd.package.id')"
REVISION="$(printf '%s' "$AGENT" | json 'String(d.revision)')"
FRAMES="$(printf '%s' "$AGENT" | json 'String(d.timeline.durationInFrames)')"
SCENES="$(printf '%s' "$AGENT" | json 'String(d.timeline.scenes.length)')"
echo "package $PKG_ID rev $REVISION · $SCENES scenes · $FRAMES frames"

log "render the MP4"
api POST /api/render "{\"packageId\":\"$PKG_ID\",\"baseRevision\":$REVISION}" > "$WORK/video.mp4"
GOT="$(ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of default=nokey=1:noprint_wrappers=1 "$WORK/video.mp4")"
[[ "$GOT" == "$FRAMES" ]] || { echo "frame mismatch: ffprobe $GOT != timeline $FRAMES"; exit 1; }
echo "ffprobe frames $GOT == timeline $FRAMES"

log "export the bundle"
api POST /api/export "{\"packageId\":\"$PKG_ID\",\"baseRevision\":$REVISION}" > "$WORK/export.json"
EXPORT_DIR="$RUNTIME/out/export/$PKG_ID"
MISSING=0
for file in video.mp4 captions.srt captions.vtt CREDITS.md package.zip; do
  # captions.srt is legitimately empty when a package has no narration (C10), so check existence.
  if [[ -f "$EXPORT_DIR/$file" ]]; then
    echo "  ok  $file ($(stat -c%s "$EXPORT_DIR/$file") bytes)"
  else
    echo "  MISSING $file"; MISSING=1
  fi
done
[[ "$MISSING" == "0" ]] || { echo "export bundle incomplete"; exit 1; }

log "PASS: clone -> brief -> $GOT-frame MP4 -> 5-file export bundle, server stopped"
echo "elapsed $((SECONDS - STARTED_AT))s"
