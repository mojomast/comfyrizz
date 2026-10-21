# Release check: clean clone, tests, CPU export, scan

Run on Tue Oct 20, 2026, about 12:10–12:25 pm Toronto time, on branch `chore/quick-wins` (base `origin/main` 184bde6). CPU only; no Google Colab or GPU.

## Clean clone
```
git clone --branch chore/quick-wins <repo> /tmp/comfyrizz-cleanclone && cd /tmp/comfyrizz-cleanclone
pnpm i --frozen-lockfile                     # pnpm 10.34.6, node 22.23.3: OK
uv venv .venv -p 3.12 && uv pip install -p .venv -r pipeline-py/requirements-dev.txt -e pipeline-py
pnpm test:all
pnpm --filter @comfyrizz/renderer render:example
```

| Step | Result |
|---|---|
| `pnpm i --frozen-lockfile` | pass (lockfile committed in this branch) |
| `pnpm test:all` (first try, before the fix) | **fail**: `apps/web` tests import `packages/agent/dist`, which a clean clone hasn't built |
| Fix | root `test` runs `build:libs` (`pnpm -r --filter './packages/**' --if-present run build`) first |
| `pnpm test:all` (after the fix) | **pass**, exit 0. Node: web 82, agent 110, compositions 15, jobs 61, llm 11, planner 39, backends 125, sources 15, tts 17, vector 12, schema 140, renderer 241, server 200 (1068 passing, 0 failing). Python `pipeline-py`: 362 passed |
| CPU example export | **pass**: `examples/launch-demo/out/launch-demo.mp4`, 1920×1080 h264, 30 fps, 1100 frames, 36.7 s, 3.35 MB, rendered in 81 s |

## Release scan
`node scripts/release-scan.mjs` scans tracked files and prints only file:line and the rule, never the value. Exit 1 = non-allowlisted findings. `--json` prints `{findings, allowed}` with file:line and rule only.

The scanner has a `workspace-path` rule for absolute `/workspace/<name>` paths and reads `scripts/release-scan.allow.json`. Each allowlist entry is `{path, rules, reason}`; `path` is a glob or a prefix. Matching hits are counted separately as `allowed`, printed per rule with their reason, and never fail the run.

At base `678cbd3`: 0 home-box findings and 0 non-allowlisted findings in 1004 tracked files. The 57 allowed hits are intentional test fixtures (26 assigned-secret, 5 hf-token, 2 openai-style-key, 1 google-oauth) and historical GPU-run references (23 workspace-path) under `scripts/gpu*/`, `scripts/willem/`, `docs/`, the Colab/workflows README notes and one render regression-test comment.

`pnpm run test:scan` runs the scanner unit tests and then the scan. Test fixtures are only allowlisted for the four fake-secret rules; anything else in a test still fails.

