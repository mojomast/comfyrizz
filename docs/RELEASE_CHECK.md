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
`node scripts/release-scan.mjs` scans tracked files and prints only file:line and the rule, never the value. Exit 1 = findings.

At `chore/quick-wins`: 115 findings in 1003 files.

| Rule | Count | Assessment |
|---|---|---|
| hf-token / openai-style-key / google-oauth | 5 / 2 / 1 | All in `packages/backends/test/colab-*.test.mjs`: fake fixtures for the redaction tests (they contain obvious fake patterns). No real secrets found |
| assigned-secret | 26 | Test-only `TOKEN = '…'` constants in `apps/server/test`, `apps/web/test`, `packages/*/test`, `pipeline-py/tests` |
| home-box-path | 81 | Personal path in `workflows/svg-guided/sweeps/e2.json` (20+), `docs/PLAN.md`, `docs/tasks/*.md`, `packages/backends/README.md` and `src/cli.mjs`, `scripts/gpu2|gpu6|willem` watchdogs and runners, `colab/make_jobs.py`, a few tests. **Fix before tagging:** replace with repo-relative paths or `$HOME` |
| tailnet hosts, 100.x IPs, Windows/macOS user paths, private keys | 0 | — |

Before v0.1.0: fix the home-box paths (or move the GPU-run scripts to an ops folder outside the release), then re-run the scan; for the test fixtures add `--allow 'test'` or keep them as known-fake.
