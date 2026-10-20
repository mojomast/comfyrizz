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
| `src/orbit-colab-plan.mjs` | `<orbit checkout>/server/colab-plan.mjs`, **verbatim** with the MIT relicence header. `parseUsage`, `parseSessions`, `parseStatus`, `parseLs`, `parseNvidiaSmi`, `catalogFromHelp`, `redactSecrets`, `stripAnsi`, `blockedLocalPath`, `sessionName`, `remotePath`, `safeBasename`, `timeoutSeconds`, `colabEnvironment`. |
| `src/job-worker.mjs` | `<orbit checkout>/server/colab-job-worker.mjs` (the detached worker + job-log pattern), header added; the interactive stdin socket is now optional. |
| `src/watchdog.mjs` | Orbit's detached-worker pattern, reduced to a stop-only timer for one session name. Armed for 45 minutes at allocation; **disarmed by `teardown()` once the stop is verified** (a sleeping process that outlives the run it belongs to is a leak, not a safety feature). A `stop_unconfirmed` keeps it armed, because that is exactly when it is the last thing that ends the spend. |

Nothing in `<orbit checkout>` is modified, and Orbit's own `redactSecrets` is *extended*
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

## `runPackage`: one path from a package to an applied package

```js
import { runPackage, withRunPackage, TEARDOWN_MODES } from "@comfyrizz/backends";

const result = await backend.runPackage(pkg, {
  workDir, outDir, onEvent, signal, budget, approved, apply, dryRun, teardownMode,
});
```

`withRunPackage(backend)` attaches it inside both factories, so `backend.runPackage(pkg, opts)` is the
only call the rest of the product needs: `apps/server`'s run controller (C9) and the web run panel call
this and nothing else. `runPackage(backend, pkg, opts)` itself calls only the `Backend` typedef, so it
never branches on the provider.

The phases run in this order, each reported through `onEvent` as `{ event: "run_phase", phase }`:
`planned` (the job graph, written to `jobsFile`) → `up` (`ensureUp`) → `ran` (the manifest and its
counts) → `applied` (the manifest lands back on the package) → `teardown`. A throw takes the same route
as a failure: the box is torn down first, then the error is rethrown with the record attached.

| opt | what it does |
|---|---|
| `workDir`, `outDir` (default `<workDir>/out`) | where `jobs.json` is written and where the run's outputs land. Keep `outDir` inside `workDir` (the default): a job's file input resolves under the output dir, so a detached output dir fails every dependent job with `input_file_missing` |
| `budget`, `approved` | passed to `ensureUp` unchanged — **the spend gate belongs to the backend, never to this function** |
| `dryRun` | plan and estimate, start nothing. This is what the run panel shows before anyone approves a session |
| `apply` (default true) | write the manifest back onto the package (`packages/jobs`' `applyManifestToPackage`) |
| `teardownMode` | `done` (stop, reason `done`) · `idle` (stop, reason `idle`, box kept warm) · `never` (leave it entirely alone: `result.teardown === null`) |
| `onEvent` | the runner's own JSON lines, plus the `run_phase` events above |
| `assets`, `includeReady`, `signal` | optional: pre-resolved asset files, jobs whose assets are already ready, an abort signal that also tears the box down |

It returns `{ backend: { id, appliedId, label, costVisibility }, workDir, outDir, jobsFile, jobsDoc,
estimate, up, health, manifest, counts, ok, package, applied, candidates, untouched, teardown, dryRun }`.
`ok` means the manifest is complete and nothing failed or was skipped — the manifest decides success,
never an exit code. `backend.appliedId` is the compliance tag the applied assets carry
(`colab:<hardware>` / `byo-comfyui`); the backend supplies it through `appliedBackendId({ up })`.

**Both backends, one contract.** Google Colab (`createColabBackend`) allocates a VM, bootstraps it and
requires a *verified* stop before calling teardown done. BYO (`createByoBackend`) starts
`comfy-api-proxy` against the user's own ComfyUI and reports `costVisibility: "external-unknown"`. They
differ in how the box comes up and goes away, and in exactly one number: the Google Colab estimate
answers real minutes and units from the H7 measured figures, while BYO answers `gpuMinutes: null` and
says so, because that hardware is not ours to meter.

**The spend gate.** `ensureUp` is the only thing that allocates, and it refuses on its own rules
(`budget.mjs`: `spent + committed + next_upper + collect_and_stop_reserve ≤ budget`, a warning at 80%, a
wall-clock cap). `runPackage` passes `budget` and `approved` through and never allocates by itself, so a
`dryRun` cannot start a session, and a refused allocation never runs a job.

**Fakes.** Every path above is exercised against `test/bin/fake-colab.mjs` (argvs logged, sessions
created / stopped / lost on demand) and `pipeline-py/tests/fake_comfy_server.py` on loopback: the H8
orchestration contract in `test/h8-runpackage.test.mjs`, and a full BYO run with the real Python runner
in `test/b5-integration.test.mjs`. No test allocates a session or reaches the network. The GPU test 4
harness (`scripts/gpu4/g4_dryrun.mjs`, prepared and dry-run only) drives this same path against the same
fakes, and the estimate it prints is the one the run panel would show.

## Final render on the same Google Colab VM

`src/colab-render-plan.mjs` plans an opt-in Remotion render (`renderLocation: "colab"`, default `local`) for a session that is already up. It does not allocate a VM. The job JSON lists cache paths, the bundle stamp, and which project files to upload versus link from `/content/comfyrizz/out`. `renderCommandArgv` is only `colab exec -f`; `--env` and credential-shaped values are refused. `decideRenderFallback` falls back to a local render only after the VM state is `stopped`. An unconfirmed shutdown aborts the fallback. `setCollectPolicy("manifest")` on the backend keeps generated media on the VM during generation; `"full"` is the fallback collect.

`colab/render_dirs.py` and `colab/render_remote.py` are the cells the app uploads. Tests import the planner and the Python helpers. They do not call the `colab` binary or start a session.

## Tests: fakes only, zero Google Colab calls

* `test/bin/fake-colab.mjs` — a fake `colab` executable, installed as a `sh` shim and executed
  for real. It logs every argv as JSON-lines, keeps its state in a JSON file, and can drop an
  exec's response, keep a session listed after `stop`, or materialise files for a script.
* `test/bin/v2-stub.mjs` — a local stand-in for `comfy-api-proxy` + ComfyUI.
* 60 cases: parsers against real CLI output, argv builders, secret refusal, redaction, the budget
  formula, the whole lifecycle (happy path, lost exec → reconcile, stop_unconfirmed, budget
  refusal, wall clock, orphans, not_owned, spend labelling, BYO proxy/health/run/cancel), the
  `runPackage` orchestration contract, and one end-to-end BYO run with the real Python runner.

Run time is ~10 s; no network beyond loopback; no VM is ever allocated.

## Server-side scripts

`colab/bootstrap.py`, `colab/health.py`, `colab/run_jobs.py`, `colab/reconcile.py` are **drafts**,
written from the Oct 16 GPU-test scripts and Kyle's `g1_setup.py`. None has been executed on
Google Colab yet — see `colab/README-comfyrizz.md`. Kyle approves every GPU run separately.
