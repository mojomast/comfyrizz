#!/usr/bin/env bash
# H11 (M8): B-side clean-clone check.
#
# The back side of the product - the package format, the planner and the two backends - from a
# stranger's clone, with no API key and no Google Colab runtime anywhere in the loop:
#
#   clone HEAD -> pnpm install -> build -> packages/schema, packages/jobs and packages/backends
#   suites -> a fresh venv with pipeline-py's dev requirements -> pytest
#
# Every backend test drives the fake `colab` CLI and the fake Comfy v2 over loopback, so the suites are
# run with the credential-shaped environment variables explicitly unset: if a suite ever needed a key
# or a real session, it would fail here instead of on someone's account.
#
# Set KEEP=1 to keep the clone, B_SIDE_REPO to clone from somewhere else, and SKIP_PY=1 to stop after
# the Node suites.
set -euo pipefail

REPO="${B_SIDE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STARTED_AT=$SECONDS
WORK="$(mktemp -d "${TMPDIR:-/tmp}/comfyrizz-clean-clone-b.XXXXXX")"
CLONE="$WORK/clone"

log() { printf '\n== %s ==\n' "$*"; }

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "${KEEP:-0}" == "1" ]]; then
    echo "kept $WORK (KEEP=1)"
  else
    rm -rf "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

# no key, no token, no account: the same run a stranger gets after `git clone`
unset COMFYRIZZ_COLAB_TOKEN COMFYRIZZ_HF_TOKEN HF_TOKEN HUGGING_FACE_HUB_TOKEN || true

log "environment"
echo "node $(node --version) · pnpm $(pnpm --version) · python $(python3 --version | sed 's/^Python //')"
if command -v colab > /dev/null 2>&1; then
  echo "a real colab CLI is on PATH ($(command -v colab)); nothing below calls it"
else
  echo "no colab CLI on PATH - the suites bring their own fake"
fi

log "clone $REPO (HEAD)"
git clone --quiet --no-local "$REPO" "$CLONE"
echo "cloned $(git -C "$CLONE" rev-parse --short HEAD) with --no-local: no objects shared with the source tree"

log "install (pnpm, as the READMEs describe)"
( cd "$CLONE" && pnpm install --no-frozen-lockfile --reporter=append-only 2>&1 | tail -3 )

log "build the workspace packages"
( cd "$CLONE" && pnpm -r --if-present run build > "$WORK/build.log" 2>&1 ) || { tail -30 "$WORK/build.log"; exit 1; }

for pkg in schema jobs backends; do
  log "packages/$pkg suite"
  ( cd "$CLONE/packages/$pkg" && npm test > "$WORK/$pkg.log" 2>&1 ) || { tail -30 "$WORK/$pkg.log"; exit 1; }
  printf '%s: %s\n' "$pkg" "$(grep -E '^# (tests|pass|fail)' "$WORK/$pkg.log" | tr -d '\n' | sed 's/^# //')"
done

if [[ "${SKIP_PY:-0}" == "1" ]]; then
  log "PASS: fresh clone -> install -> schema, jobs and backends suites (python skipped: SKIP_PY=1)"
  echo "elapsed $((SECONDS - STARTED_AT))s"
  exit 0
fi

log "pipeline-py suite in a fresh venv"
(
  cd "$CLONE/pipeline-py"
  python3 -m venv "$WORK/venv"
  "$WORK/venv/bin/pip" install -q --disable-pip-version-check -r requirements-dev.txt
  "$WORK/venv/bin/python" -m pytest -q
) 2>&1 | tail -3

log "PASS: fresh clone -> install -> schema, jobs, backends and pipeline-py suites"
echo "elapsed $((SECONDS - STARTED_AT))s"
