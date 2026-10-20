# Spec: DOCTOR, a one-command setup preflight

Status: draft v1 (Oct 20, 2026). Branch: `feat/doctor`, off `main`.

## 1. Why this feature
Judges of Comfy's Open Source Higgsfield hackathon (deadline Oct 30, 2026, 9am PT) will clone the repo and try to run it. Comfyrizz needs Node, pnpm, Python 3.12 with uv, ffmpeg, several built packages, an optional own ComfyUI and an optional LLM provider. Today a missing piece shows up as a stack trace deep in the server or pipeline. `pnpm doctor` reports every prerequisite in one screen with an exact fix command, so a judge gets from clone to demo without guessing. It is read-only, offline-capable and never prints secrets.

## 2. Boundaries
- No changes to HyperFrames, Google Colab, renderer, GPU or composition code; another agent owns those areas. Checks and hooks never call or inspect Google Colab.
- No overlap with DEMO-WEBAPP (`apps/web/src/demo/**`, `apps/web/demo.html`) or SUBMISSION (README, CREDITS, docs/submission, CI).
- Pure `.mjs` modules with injected dependencies; tests are `node --test <file>` with no network, GPU, server or built packages.
- Secret values are never printed, stored or returned; only env var names and set/unset. No paid providers.
- Nothing is merged to main by the workers; the branch is reviewed by Kyle.

## 3. Tasks
Tiers: **simple** runs on the free model pool; **standard** runs on `deepseek-v4.1-flash`. All files live under `scripts/doctor/` except the root `package.json` script (D10) and `docs/DOCTOR.md` (D11).

| Task | Title | Tier | Files | Depends on | Acceptance |
|---|---|---|---|---|---|
| D01 checks-core | Check runner and result model | simple | `scripts/doctor/checks.mjs`, `scripts/doctor/checks.test.mjs` | - | throwing check -> fail with message; slow check -> timed out (use a fake timer or 20ms timeout); exitCode 1 only when a fail exists; order preserved |
| D02 check-tools | Toolchain checks | simple | `scripts/doctor/check-tools.mjs`, `scripts/doctor/check-tools.test.mjs` | D01 | fake exec: all present -> ok; node 18 -> fail with fix hint; ffmpeg missing -> warn; parseVersion handles 'v22.3.0', 'Python 3.12.1', 'ffmpeg version 6.1-static' |
| D03 check-repo | Repo install state checks | simple | `scripts/doctor/check-repo.mjs`, `scripts/doctor/check-repo.test.mjs` | D01 | temp-dir fixture fully installed -> all ok; missing node_modules -> fail; missing one dist -> warn naming the package; no absolute paths in detail text (use repo-relative) |
| D04 check-server | Local server checks | simple | `scripts/doctor/check-server.mjs`, `scripts/doctor/check-server.test.mjs` | D01 | refused -> skip with start hint; 200 -> ok; 500 -> warn; custom COMFYRIZZ_PORT used; no auth header sent (fake fetch records headers) |
| D05 check-comfy | Own ComfyUI (BYO) check | simple | `scripts/doctor/check-comfy.mjs`, `scripts/doctor/check-comfy.test.mjs` | D01 | unset -> skip; fake system_stats -> ok with device name; timeout -> warn; URL credentials (user:pass@) are stripped from output |
| D06 redact | Secret redaction helper | simple | `scripts/doctor/redact.mjs`, `scripts/doctor/redact.test.mjs` | - | fake secret value never survives in output; describeEnv never contains values; short/empty values left alone; pattern list covers sk-, hf_, ghp_, Bearer |
| D07 check-llm | Agent provider config check | simple | `scripts/doctor/check-llm.mjs`, `scripts/doctor/check-llm.test.mjs` | D01, D06 | output with a fake key set contains no part of the key; none set -> warn; one set -> ok naming the provider; env names match those in the repo code (cite them in a test constant) |
| D08 report | Text and JSON report | simple | `scripts/doctor/report.mjs`, `scripts/doctor/report.test.mjs` | D01 | golden text for a 4-result fixture; JSON parses and has summary.exitCode; fix lines only for warn/fail |
| D09 fix-hints | Fix hint table | simple | `scripts/doctor/fix-hints.mjs`, `scripts/doctor/fix-hints.test.mjs` | - | every pnpm hint resolves to a real package.json script; no hint mentions Google Colab |
| D10 cli | doctor CLI and root script | standard | `scripts/doctor/doctor.mjs`, `scripts/doctor/doctor.test.mjs`, `package.json` | D02, D03, D04, D05, D07, D08, D09 | `node scripts/doctor/doctor.mjs --json --offline` exits 0 or 1 and prints parseable JSON (test spawns it); --only filters; a fake secret in env never appears in stdout (spawn with env); package.json diff is the one added script line |
| D11 docs | Doctor documentation | simple | `docs/DOCTOR.md` | D10 | every command shown exists; sample output matches the real format; no claims beyond the code |

Details:

- **D01** Result model {id,title,status:'ok'|'warn'|'fail'|'skip',detail,fix}. runChecks(checks,ctx,{timeoutMs=5000}) runs async check functions in order, converts throws into status fail with the error message, and timeouts into fail 'timed out after Nms'; summarize(results) -> {ok,warn,fail,skip,exitCode} (exitCode 1 iff any fail). makeResult() validates status.
- **D02** Checks for node (>= the root package.json engines.node), pnpm, uv, python3 >= 3.12 (pipeline-py) and ffmpeg (CPU export) using an injected exec(cmd,args)->{code,stdout}. Missing optional tools (uv, ffmpeg) are warn, missing node/pnpm or too-old node are fail. Version parsing in an exported parseVersion().
- **D03** Checks against an injected root dir: node_modules present, pnpm-lock.yaml present, .venv present (warn if not), and built dist/ present for the packages apps/server's pretest builds (read apps/server/package.json; list them in a constant). Missing dist -> warn with the build command.
- **D04** Port from env COMFYRIZZ_PORT or 4319 (see apps/server/src/index.mjs). With injected fetch: GET http://127.0.0.1:<port>/api/health -> ok 'server running' / skip 'not running (start with pnpm --filter @comfyrizz/server start)' on connection refused; non-200 -> warn. Never sends a token.
- **D05** Read packages/backends/src/byo-backend.mjs (do not edit) to find how a user-owned ComfyUI URL is configured. If unset -> skip 'no own ComfyUI configured (optional)'. If set, injected fetch GET <url>/system_stats with 3s timeout: ok with the GPU/device name and VRAM if present, else warn. Must not mention or check Google Colab.
- **D06** redact(text, env) replaces any value of env vars whose name matches /KEY|TOKEN|SECRET|PASSWORD/i (len >= 6) with '[redacted]', plus generic patterns (sk-..., hf_..., ghp_..., Bearer ...). describeEnv(env, names) -> [{name, state:'set'|'unset'}] only.
- **D07** Read apps/server/src/provider-settings.mjs and packages/llm/src presets (do not edit) for provider ids and the env var NAMES they read. Report which providers are configured (set/unset only, via describeEnv), warn when none is set ('the agent falls back to the scripted/CPU path' if that is true in the code, else just 'no provider configured'). Optional live probe is OFF by default and not implemented here.
- **D08** renderText(results, {color:false}) -> aligned lines '[ok] Title  detail' plus 'fix: ...' lines for warn/fail and a summary line; renderJson(results) -> stable JSON {version:1, results, summary}. ASCII only when color is false.
- **D09** FIX_HINTS: map of check id -> exact command or doc pointer (pnpm i --frozen-lockfile, uv venv .venv -p 3.12, the per-package build commands, server start). Test that every 'pnpm <script>' / 'pnpm --filter X <script>' hint names a script that exists in the corresponding package.json in the repo.
- **D10** scripts/doctor/doctor.mjs: assembles all checks with real deps (child_process exec with timeout, global fetch, process.env passed through redact), flags --json, --only <ids>, --offline (skip D04/D05 network checks), exit code from summarize. Add root package.json script "doctor": "node scripts/doctor/doctor.mjs" and change nothing else in package.json. Every printed line goes through redact().
- **D11** What pnpm doctor checks, sample output (from a real --offline run, secrets-free), what each status means, the fix hints, and what it deliberately does not check (Google Colab, paid providers, GPUs it cannot see). Add a one-line pointer suggestion for the README in a 'README snippet' section (do not edit README.md).


## 4. Done when
`pnpm doctor --offline` runs on a clean clone, every check has a test, the release scan is clean for the new files, and docs/DOCTOR.md matches the real output.
