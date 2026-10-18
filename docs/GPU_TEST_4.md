# GPU test 4 — plan (prepared, NOT run)

The harness for one Google Colab session that re-verifies the GPU test 3 fixes **and** the one-API
run path (`runPackage`). Everything here has been exercised end to end against the fake `colab` CLI
and the fake Comfy v2 — no session was started, and none should be without the owner approving it.

    node scripts/gpu4/g4_dryrun.mjs          # the whole dry run (loopback fakes), exit 0 = all checks
    node scripts/gpu4/g4_estimate.mjs        # the spend estimate only; never calls the CLI

## What a real run would do

1. `preflight()` — `colab version`, `usage`, `sessions`; refuse if a session we own is already live.
2. `ensureUp()` — one session, named after the package; the budget in units is checked before it is
   created.
3. `bootstrap()` — upload the job bundle, install ComfyUI, fetch the locked models; the HF token is
   copied to the VM, used, and unlinked.
4. `health()` — `/system_stats` plus the required nodes.
5. `run()` — the job set below, one batch at a time, resumable.
6. `teardown('done')` — stop, verified against `sessions`; the watchdog stops it if the app dies.

## Spend estimate (from the H7 measured minutes, `MEASURED_JOB_MINUTES`)

| | |
|---|---|
| jobs | 6 (3 still, 2 plate, 1 upscale) |
| GPU minutes | 1.95 |
| bootstrap overhead | 4.0 min (measured 218.5 s) |
| **units** | **0.88** of a 20-unit budget (19.12 left) |
| slowest single job | 0.5 min |
| wall clock | ~5.95 min |

`gpuMinutes` is `null` on the BYO backend by design — that is the user's own hardware, not ours to
meter.

## The checks the dry run makes (26, exit 0 = all pass)

Job facts — every one is about the *files* and the manifest, which is why a fake ComfyUI is enough:

- **N1** `text` is a job control (`allowText` on the job), never a graph param.
- **N3** both two-stage LTX graphs end in `SaveVideo`, and a plate's manifest entry has exactly one
  output of kind `video`.
- **N4** the manifest measures the file it got (PNG IHDR), and the package's `media` is that size.
- **N5** the label-refusal note survives an all-cached re-run ("earlier run against this deployment").
- **N6** `job_id`/`attempt_id` are strings, and the applied package still validates (no null ids).
- **N9** a plate is on the 64 lattice, its stage 1 on the 32 lattice, and its first frame follows it.

Run facts (H8): the phase order `planned -> up -> ran -> applied -> teardown`, `ok` with 6/6
succeeded, teardown `stopped`, and the Colab estimate above.

Lifecycle facts (against the fake CLI): preflight ready with a parsed balance, `ensureUp` created a
session named `comfyrizz-*`, bootstrap/health/run/teardown in order, `version,usage,sessions` first
and `new,upload,exec,download,stop` all present, and **the token value never appears in any argv**.

## Running it for real (owner only)

A real run needs the owner's approval, a Google Colab account with units, and the model lock in
place; the same script is the record. `scripts/gpu4/g4_dryrun.mjs` deliberately installs the fake CLI,
so a real run means running the app's own path (`backend.runPackage` with the real Colab backend),
not this harness.
