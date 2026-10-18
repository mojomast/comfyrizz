# @comfyrizz/backends — Google Colab lifecycle + BYO ComfyUI

Local setup for the BYO backend: [`BYO-COMFYUI.md`](BYO-COMFYUI.md) +
`scripts/setup-local-comfy.sh` (ComfyUI at the 0.41 ref, the two model repos, the links the graphs
require, the runner's deps; `--dry-run` prints the plan and runs nothing).

Owner: **Hermes** (WS-B, B3). The two backends of SPEC.md §6.5, behind one `Backend` interface
(`src/index.mjs` documents it as a JSDoc typedef; there is no build step).

```bash
node --test test/*.test.mjs        # or: npm test
```

From a fresh clone (Node 20 or 22, pnpm): `pnpm install --no-frozen-lockfile` at the repository
root, then `cd packages/backends && npm test` — 60 cases in about 10 s. A fresh `git clone` of HEAD
is what `scripts/clean-clone-b-side.sh` runs, with the credential-shaped environment variables
unset: the suites allocate nothing, reach nothing but loopback, and call the fake `colab` CLI.

## What is copied from Orbit, and why

| File | Origin |
|---|---|
| `src/orbit-colab-plan.mjs` | `/home/box/orbitdesktop/server/colab-plan.mjs`, **verbatim** with the MIT relicence header. `parseUsage`, `parseSessions`, `parseStatus`, `parseLs`, `parseNvidiaSmi`, `catalogFromHelp`, `redactSecrets`, `stripAnsi`, `blockedLocalPath`, `sessionName`, `remotePath`, `safeBasename`, `timeoutSeconds`, `colabEnvironment`. |
| `src/job-worker.mjs` | `/home/box/orbitdesktop/server/colab-job-worker.mjs` (the detached worker + job-log pattern), header added; the interactive stdin socket is now optional. |
| `src/watchdog.mjs` | Orbit's detached-worker pattern, reduced to a stop-only timer for one session name. Armed for 45 minutes at allocation; **disarmed by `teardown()` once the stop is verified** (a sleeping process that outlives the run it belongs to is a leak, not a safety feature). A `stop_unconfirmed` keeps it armed, because that is exactly when it is the last thing that ends the spend. |

Nothing in `/home/box/orbitdesktop` is modified, and Orbit's own `redactSecrets` is *extended*
rather than edited: `redactAll` in `src/colab-plan.mjs` adds the provider keys SPEC.md §6.6 asks
for (`hf_`, `sk-`, `AIza`, `ghp_`, `xoxb-`, `AKIA`). A test asserts Orbit's version does **not**
know about them, so the extension can never be mistaken for the original.

## The rules that are enforced, not documented

1. **argv arrays, never a shell**, and `assertNoSecrets` runs on every argv built here. `--env` is
   refused outright, and so is a `KEY=value` whose key looks like a credential
   (SPEC.md §5.2/§6.7.2: the CLI writes `--env` into its local history as code, and the value
   shows in the host's process list).
2. **The Hugging Face token travels as a file**: `hfTokenPlan` describes the 0700 directory + 0600
   file upload (`colab upload`), and `argvUpload` refuses to upload `token.json`,
   `~/.config/colab-cli/*`, `credentials.json`, `id_rsa` or anything service-account-shaped.
   The token is never an argument, never an environment variable, and never logged.
3. **A lost exec reconciles, it never re-runs the batch** (`reconcile()`): the backend pulls the
   VM's `out/manifest.json` and `out/attempts/`, and only if the batch is not already complete
   does it run one `reconcile.py` exec — the same `pipeline-py --reconcile` on the VM, which
   polls known job ids. The test asserts `run_jobs.py` is executed exactly once.
4. **The manifest decides success**, never the exit code: `collectOut()` downloads `out/`, and
   `verifyAgainstManifest()` re-checks every recorded output against disk.
5. **Verified teardown, else `stop_unconfirmed`**: `colab stop` accepted but `colab sessions`
   still listing the session (retried) is reported as `stop_unconfirmed` with the evidence and
   the manual command — "VM may still be running, units draining". A session we did not create is
   `not_owned`, and nothing is stopped.
6. **The reserve formula gates every admission** (`budget.mjs`,
   `spent + committed + next_upper + collect_and_stop_reserve ≤ budget`), warn at 80%, and a
   wall-clock cap that applies even when metering is stale. Spend is always labelled an estimate,
   and says "other sessions running" when the account-level assignment count is above ours.
7. **The orphan reaper offers only**: unknown `comfyrizz-*` sessions come back as
   `{session, offer, note}` and nothing is stopped automatically.
8. **BYO is not free and not ours**: `costVisibility: "external-unknown"`, `ensureUp` starts
   `comfy-api-proxy --comfyui <url> --port <free>` on loopback and health-checks it, `teardown`
   stops only the proxy we started (`not_owned` otherwise), and cancels only job ids this backend
   submitted.

## Tests: fakes only, zero Google Colab calls

* `test/bin/fake-colab.mjs` — a fake `colab` executable, installed as a `sh` shim and executed
  for real. It logs every argv as JSON-lines, keeps its state in a JSON file, and can drop an
  exec's response, keep a session listed after `stop`, or materialise files for a script.
* `test/bin/v2-stub.mjs` — a local stand-in for `comfy-api-proxy` + ComfyUI.
* 29 cases: parsers against real CLI output, argv builders, secret refusal, redaction, the budget
  formula, and the whole lifecycle (happy path, lost exec → reconcile, stop_unconfirmed, budget
  refusal, wall clock, orphans, not_owned, spend labelling, BYO proxy/health/run/cancel).

Run time is ~4 s; no network beyond loopback; no VM is ever allocated.

## Server-side scripts

`colab/bootstrap.py`, `colab/health.py`, `colab/run_jobs.py`, `colab/reconcile.py` are **drafts**,
written from the Oct 16 GPU-test scripts and Kyle's `g1_setup.py`. None has been executed on
Google Colab yet — see `colab/README-comfyrizz.md`. Kyle approves every GPU run separately.
