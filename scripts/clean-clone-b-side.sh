#!/usr/bin/env bash
# H11 (M8): B-side clean-clone check.
#
# The back side of the product - the package format, the planner and the two backends - from a
# stranger's clone, with no API key and no Google Colab runtime anywhere in the loop:
#
#   clone HEAD -> pnpm install -> build -> a venv at the clone root (.venv, as the READMEs describe)
#   -> packages/schema, packages/jobs and packages/backends suites -> pipeline-py pytest
#
# The venv goes in *first* on purpose: the backends tests drive the real Python runner through
# `<repo>/.venv/bin/python`, and the schema conformance test compares the TypeScript and Python
# validators through it, so without it a fresh clone quietly skips the cases that matter most. The
# script fails if any suite skips anything. Every backend test drives the fake `colab` CLI and the fake
# Comfy v2 over loopback, and the credential-shaped environment variables are unset here: if a suite
# ever needed a key or a real session, it would fail on this clone instead of on an account.
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

if [[ "${SKIP_PY:-0}" != "1" ]]; then
  log "the clone's python: $CLONE/.venv (the backends and conformance tests look for it exactly there)"
  python3 -m venv "$CLONE/.venv"
  "$CLONE/.venv/bin/pip" install -q --disable-pip-version-check -r "$CLONE/pipeline-py/requirements-dev.txt"
  "$CLONE/.venv/bin/python" -c 'import jsonschema, numpy, pytest, comfy_sdk; print("installed: jsonschema, numpy, pytest, comfy_sdk")'
fi

SUMMARY=()
# a suite that skips is a suite that did not run: a fresh clone has to be able to run every case
require_no_skips() { # name logfile
  local name="$1" log="$2" skipped
  skipped="$(grep -E '^# skipped [0-9]+' "$log" | awk '{print $3}' | tail -1)"
  skipped="${skipped:-0}"
  SUMMARY+=("$name: $(grep -E '^# (tests|pass|fail)' "$log" | tr -d '\n' | sed 's/^# //')")
  if [[ "$skipped" != "0" ]]; then
    echo "$name skipped $skipped case(s) on a fresh clone:"
    grep -E '^not ok|# SKIP' "$log" | head -10
    exit 1
  fi
}

for pkg in schema jobs backends; do
  log "packages/$pkg suite"
  ( cd "$CLONE/packages/$pkg" && npm test > "$WORK/$pkg.log" 2>&1 ) || { tail -40 "$WORK/$pkg.log"; exit 1; }
  require_no_skips "$pkg" "$WORK/$pkg.log"
done

if [[ "${SKIP_PY:-0}" == "1" ]]; then
  log "PASS: fresh clone -> install -> schema, jobs and backends suites"
  printf '%s\n' "${SUMMARY[@]}"
  echo "elapsed $((SECONDS - STARTED_AT))s"
  exit 0
fi

log "pipeline-py suite with the clone's own interpreter"
( cd "$CLONE/pipeline-py" && "$CLONE/.venv/bin/python" -m pytest -q > "$WORK/pytest.log" 2>&1 ) || { tail -40 "$WORK/pytest.log"; exit 1; }
tail -1 "$WORK/pytest.log"
if grep -qE '[0-9]+ skipped' "$WORK/pytest.log"; then
  echo "pytest skipped cases on a fresh clone"
  exit 1
fi
SUMMARY+=("pipeline-py: $(tail -1 "$WORK/pytest.log" | sed 's/ in .*//')")

log "PASS: fresh clone -> install -> schema, jobs, backends and pipeline-py suites, nothing skipped"
printf '%s\n' "${SUMMARY[@]}"
echo "elapsed $((SECONDS - STARTED_AT))s"
