# `pnpm doctor` - Comfyrizz setup preflight

`pnpm doctor` is a read-only preflight for judges and contributors who just cloned
the repo. It reports every prerequisite in one screen with an exact fix command, so
you get from clone to demo without guessing. The doctor script itself never installs,
fixes or writes anything, can run fully offline with `--offline`, and never prints
secret values.

Implementation: `scripts/doctor/doctor.mjs` (plus one module per check group under
`scripts/doctor/`). Spec: `docs/specs/DOCTOR.md`. Tests: `scripts/doctor/*.test.mjs`,
run from the repo root:

```bash
node --test scripts/doctor/checks.test.mjs  # one module's tests
node --test scripts/doctor/*.test.mjs       # all doctor tests
```

## Running it

The root `package.json` registers the script `"doctor": "node scripts/doctor/doctor.mjs"`,
so the portable invocation is:

```bash
pnpm run doctor            # full check run
pnpm run doctor --offline  # skip the two network checks (server, own ComfyUI)
node scripts/doctor/doctor.mjs  # same thing without pnpm
```

> Note: on pnpm 12 (verified with pnpm 12.6.0) the bare `pnpm doctor` invokes
> **pnpm's own** built-in `doctor` diagnostic, not this repo's script. Use
> `pnpm run doctor` or the `node` command; both always run the repo script, and
> `pnpm run` forwards every flag after the script name to it. (On a clone where
> dependencies are not yet installed, `pnpm run` may install workspace dependencies
> first - that is pnpm's behavior; the doctor script itself installs nothing.)

Options (from `--help`):

```text
Usage: node scripts/doctor/doctor.mjs [options]

Read-only setup preflight for Comfyrizz. Reports ok|warn|fail|skip.

Options:
  --json            print the machine-readable report
  --only <ids>     run only these check ids (comma-separated, repeatable)
  --offline         skip the local server and own-ComfyUI network checks
  -h, --help        show this help
```

Examples:

```bash
pnpm run doctor --offline --only node,pnpm   # a subset, comma-separated
pnpm run doctor --offline --only uv --only ffmpeg  # repeatable too
pnpm run doctor --json --offline             # machine-readable report
```

## Sample output

Real capture of `node scripts/doctor/doctor.mjs --offline` on a fresh Linux clone
(no `node_modules`, no `.venv`, no built `dist/`), taken Oct 20, 2026. Tool versions
will differ on your machine; the statuses and layout will not:

```text
[ok]   Node.js                 node 24.21.0 (requires >= 20.0.0)
[ok]   pnpm                    pnpm 12.6.0
[ok]   uv (optional)           uv 0.12.19
[ok]   Python 3.12             python3 3.12.3
[warn] ffmpeg (optional)       ffmpeg not found
                               fix: install ffmpeg (https://ffmpeg.org/download.html)
[fail] node_modules present    node_modules missing
                               fix: pnpm install --frozen-lockfile
[fail] pnpm-lock.yaml present  pnpm-lock.yaml missing
                               fix: pnpm install --frozen-lockfile
[warn] .venv present           .venv missing
                               fix: uv venv .venv -p 3.12
[warn] dist built: vector      packages/vector/dist missing
                               fix: npm --prefix packages/vector run build
[warn] dist built: planner     packages/planner/dist missing
                               fix: npm --prefix packages/planner run build
[warn] dist built: llm         packages/llm/dist missing
                               fix: npm --prefix packages/llm run build
[warn] dist built: agent       packages/agent/dist missing
                               fix: npm --prefix packages/agent run build
[warn] dist built: sources     packages/sources/dist missing
                               fix: npm --prefix packages/sources run build
[warn] dist built: tts         packages/tts/dist missing
                               fix: npm --prefix packages/tts run build
[skip] Local server            skipped by --offline (network check)
[skip] Own ComfyUI (BYO)       skipped by --offline (network check)
[warn] Agent LLM provider      no LLM provider key found (unset: OPENCODE_API_KEY, OPENCODE_GO_API_KEY, OPENROUTER_API_KEY, COMFYRIZZ_CUSTOM_API_KEY) - the agent falls back to the scripted/CPU path
                               fix: set one of the provider API key env vars (see docs/specs/DOCTOR.md)

Summary: 4 ok, 9 warn, 2 fail, 2 skip
```

The same run with `--json` (verbatim, one line):

```json
{"version":1,"results":[{"id":"node","title":"Node.js","status":"ok","detail":"node 24.21.0 (requires >= 20.0.0)","fix":""},{"id":"pnpm","title":"pnpm","status":"ok","detail":"pnpm 12.6.0","fix":""},{"id":"uv","title":"uv (optional)","status":"ok","detail":"uv 0.12.19","fix":""},{"id":"python","title":"Python 3.12","status":"ok","detail":"python3 3.12.3","fix":""},{"id":"ffmpeg","title":"ffmpeg (optional)","status":"warn","detail":"ffmpeg not found","fix":"install ffmpeg (https://ffmpeg.org/download.html)"},{"id":"repo-node-modules","title":"node_modules present","status":"fail","detail":"node_modules missing","fix":"pnpm install --frozen-lockfile"},{"id":"repo-pnpm-lock","title":"pnpm-lock.yaml present","status":"fail","detail":"pnpm-lock.yaml missing","fix":"pnpm install --frozen-lockfile"},{"id":"repo-venv","title":".venv present","status":"warn","detail":".venv missing","fix":"uv venv .venv -p 3.12"},{"id":"repo-dist-vector","title":"dist built: vector","status":"warn","detail":"packages/vector/dist missing","fix":"npm --prefix packages/vector run build"},{"id":"repo-dist-planner","title":"dist built: planner","status":"warn","detail":"packages/planner/dist missing","fix":"npm --prefix packages/planner run build"},{"id":"repo-dist-llm","title":"dist built: llm","status":"warn","detail":"packages/llm/dist missing","fix":"npm --prefix packages/llm run build"},{"id":"repo-dist-agent","title":"dist built: agent","status":"warn","detail":"packages/agent/dist missing","fix":"npm --prefix packages/agent run build"},{"id":"repo-dist-sources","title":"dist built: sources","status":"warn","detail":"packages/sources/dist missing","fix":"npm --prefix packages/sources run build"},{"id":"repo-dist-tts","title":"dist built: tts","status":"warn","detail":"packages/tts/dist missing","fix":"npm --prefix packages/tts run build"},{"id":"server","title":"Local server","status":"skip","detail":"skipped by --offline (network check)","fix":""},{"id":"comfy","title":"Own ComfyUI (BYO)","status":"skip","detail":"skipped by --offline (network check)","fix":""},{"id":"llm","title":"Agent LLM provider","status":"warn","detail":"no LLM provider key found (unset: OPENCODE_API_KEY, OPENCODE_GO_API_KEY, OPENROUTER_API_KEY, COMFYRIZZ_CUSTOM_API_KEY) - the agent falls back to the scripted/CPU path","fix":"set one of the provider API key env vars (see docs/specs/DOCTOR.md)"}],"summary":{"ok":4,"warn":9,"fail":2,"skip":2,"exitCode":1}}
```

Layout rules (from `scripts/doctor/report.mjs`): one `[status] Title  detail` line per
check, a `fix: ...` line under it for `warn`/`fail` results that carry a fix, then a
blank line and `Summary: N ok, N warn, N fail, N skip`. Output is ASCII unless stdout
is a TTY, in which case statuses are colorized (colors are disabled when `NO_COLOR`
is set). Every printed line passes through `redact()` first.

## What each check does

Checks run in this order (ids are what `--only` accepts):

| id | Title | What it does |
|---|---|---|
| `node` | Node.js | `node --version`; compares against the root `package.json` `engines.node` (currently `>= 20`). Missing or older: **fail**. |
| `pnpm` | pnpm | `pnpm --version`. Missing: **fail**. |
| `uv` | uv (optional) | `uv --version`. Missing: **warn** (optional toolchain for the Python side). |
| `python` | Python 3.12 | `python3 --version`; requires `>= 3.12`. Missing or older: **fail**. |
| `ffmpeg` | ffmpeg (optional) | `ffmpeg -version`. Missing: **warn** (needed for CPU export). |
| `repo-node-modules` | node_modules present | `node_modules/` at the repo root. Missing: **fail**. |
| `repo-pnpm-lock` | pnpm-lock.yaml present | `pnpm-lock.yaml` at the repo root. Missing: **fail**. |
| `repo-venv` | .venv present | `.venv/` at the repo root. Missing: **warn**. |
| `repo-dist-vector`, `repo-dist-planner`, `repo-dist-llm`, `repo-dist-agent`, `repo-dist-sources`, `repo-dist-tts` | dist built: &lt;pkg&gt; | `packages/<pkg>/dist/` for each package that `apps/server` pretest builds. Missing: **warn** naming the package. |
| `server` | Local server | `GET http://127.0.0.1:<port>/api/health` on `COMFYRIZZ_PORT` (default `4319`). `200` -> **ok**; connection refused -> **skip** with the start hint; any other error or status -> **warn**. The request carries no auth header or token. |
| `comfy` | Own ComfyUI (BYO) | Reads `COMFYRIZZ_COMFYUI_URL`, then `COMFYUI_URL`. Unset -> **skip** (optional). If set, one `GET <url>/system_stats` with a 3s timeout: **ok** with the device name and VRAM when present; timeout, non-OK response or no device name -> **warn**. `user:pass@` credentials in the URL are stripped from every output line. |
| `llm` | Agent LLM provider | Reports which provider key env vars are **set/unset** - `OPENCODE_API_KEY` / `OPENCODE_GO_API_KEY` (OpenCode Go), `OPENROUTER_API_KEY` (OpenRouter), `COMFYRIZZ_CUSTOM_API_KEY` (Custom OpenAI-compatible). None set -> **warn** noting the agent falls back to the scripted/CPU path; any set -> **ok** naming the provider and which names are set. |

Timeouts: every check gets a 5000ms budget (a slow check becomes **fail**
`timed out after 5000ms`); tool probes use a 4s exec timeout; the ComfyUI probe uses
3s.

## What the statuses mean

- **ok** - the prerequisite is present and working. No fix line.
- **warn** - something optional is missing or degraded (uv, ffmpeg, `.venv`, package
  `dist/`, an unreachable own-ComfyUI, no LLM provider key). A fix line follows when
  the check provides one. Warnings never change the exit code.
- **fail** - a required piece is missing or broken (node/pnpm/python too old or
  absent, `node_modules` or `pnpm-lock.yaml` missing, or the check itself threw or
  timed out). A fix line follows when the check provides one. The exit code becomes 1.
- **skip** - the check did not apply: `--offline` skips `server` and `comfy`; the
  server check also skips when nothing is listening on the port; the ComfyUI check
  skips when no URL is configured.

Exit codes: `0` when no check failed (warns and skips are fine), `1` when at least
one check failed, `2` on a CLI usage error (unknown flag, or `--only` without a value).

## Fix hints

Each warn/fail line can carry a one-line, copy-pasteable fix (from
`scripts/doctor/fix-hints.mjs` and the repo checks themselves):

| Situation | Fix printed |
|---|---|
| Node missing or too old | `install Node.js >= 20 (https://nodejs.org)` |
| pnpm missing | `install pnpm (https://pnpm.io/installation)` |
| uv missing | `install uv (https://docs.astral.sh/uv/getting-started/installation/)` |
| python3 missing or older than 3.12 | `uv python install 3.12` |
| ffmpeg missing | `install ffmpeg (https://ffmpeg.org/download.html)` |
| `node_modules` or `pnpm-lock.yaml` missing | `pnpm install --frozen-lockfile` |
| `.venv` missing | `uv venv .venv -p 3.12` |
| a package `dist/` missing | `npm --prefix packages/<pkg> run build` |
| local server not running | `pnpm --filter @comfyrizz/server start` |
| own ComfyUI unreachable | `check that <url> is running and reachable` (URL is credential-stripped) |
| no LLM provider key | `set one of the provider API key env vars (see docs/specs/DOCTOR.md)` |

Hints that name a `pnpm <script>` or `pnpm --filter <pkg> <script>` are tested
(`scripts/doctor/fix-hints.test.mjs`) to resolve to a script that actually exists in
the corresponding `package.json`.

## Secrets and privacy

- Every line doctor writes passes through `redact()`: values of any env var whose
  name matches `KEY|TOKEN|SECRET|PASSWORD` (values of length >= 6) are replaced with
  `[redacted]`, plus generic patterns for `sk-...`, `hf_...`, `ghp_...` and
  `Bearer ...` tokens.
- The LLM check reports env var **names** as `set`/`unset` only - never a key, never
  part of a key.
- The server health request sends no authorization header and no token.
- Credentials embedded in a ComfyUI URL (`user:pass@...`) are stripped before any
  output line is built and before the probe request is made.
- Doctor is read-only: it never installs packages, never mutates your repo or config,
  and writes nothing to disk.

## What it deliberately does not check

- **Google Colab** - no check inspects, contacts or reports on Google Colab runtimes or
  anything under `colab/`. Doctor is a local preflight only.
- **Paid providers and live LLM probes** - it never calls an LLM provider. Whether a
  key is configured is inferred solely from env var names being set or unset; no
  request is made, no billing surface is touched.
- **GPUs it cannot see** - there is no local GPU scan (no `nvidia-smi`, no device
  probing). GPU name and VRAM appear only when you point doctor at **your own
  ComfyUI** via `COMFYRIZZ_COMFYUI_URL`/`COMFYUI_URL` and its `/system_stats`
  answers.
- **Everything else the pipeline needs beyond the listed checks** - doctor does not
  run builds, tests or the pipeline, does not verify the Python virtualenv's
  installed packages (only the `python3` version, `uv` presence and `.venv`
  existence), and does not exercise the web app or renderer.

## README snippet

Suggested one-liner for the README (not applied - README is owned elsewhere). Best
placed directly under the `### Requirements` heading in the Quickstart section:

```markdown
After cloning, run `pnpm run doctor` to preflight your setup - see [docs/DOCTOR.md](docs/DOCTOR.md).
```
