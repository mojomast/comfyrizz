# pipeline-py

Owner: **Hermes** (WS-B). Python side of Comfyrizz: the `comfy-sdk` runner that executes
`jobs.json` against `COMFY_BASE_URL` (B2) and the package/jobs validators (B1).

| Module | What it is |
|---|---|
| `comfyrizz_pipeline/schema.py` | `comfyrizz.package/v1` + `comfyrizz.jobs/v1` validation (`jsonschema` + the shared `SEM_*` rules). Mirrors `packages/schema/src/semantic.mjs`. |
| `comfyrizz_pipeline/validate.py` | CLI: `python -m comfyrizz_pipeline.validate <file> [--json]`. |
| `comfyrizz_pipeline/atomic.py` | tmp-file + `os.replace` writes; canonical JSON + hashing (same canonical form as the TS planner). |
| `comfyrizz_pipeline/attempts.py` | Attempt records (`attempts/<attempt_id>.json`), states, open-attempt lookup. |
| `comfyrizz_pipeline/manifest.py` | `out/manifest.json` build/write/read and the "manifest decides success" verdict. |
| `comfyrizz_pipeline/progress.py` | JSON-lines progress, `{"v":1,"attempt":…,"job":…,"seq":…,"event":…}`. |
| `comfyrizz_pipeline/client.py` | The one place that talks to Comfy: submit classification, params injection, downloads. |
| `comfyrizz_pipeline/runner.py` | `jobs.json` → Comfy → manifest; `--reconcile` mode; CLI. |
| `comfyrizz_pipeline/launch.py` | run the runner in a child process from a notebook/kernel (`run_jobs`) and the idempotent metadata shim. |
| `comfyrizz_pipeline/health.py` | v2 / ComfyUI / node+model / optional smoke-job checks. |

## Setup and run

```bash
python3 -m venv .venv                 # from the repository root; .venv/ is gitignored
.venv/bin/pip install -r pipeline-py/requirements-dev.txt   # jsonschema, pytest, comfy-sdk
cd pipeline-py && ../.venv/bin/python -m pytest
```

The schema files are read from `packages/schema/` (override the package schema with
`COMFYRIZZ_SCHEMA`). Validation needs no network.

From a fresh clone, the same three commands work in place: the venv is created at the repository
root and `pipeline-py/requirements-dev.txt` is the only dependency list. `scripts/clean-clone-b-side.sh`
runs it that way against a fresh `git clone` of HEAD (jsonschema, pytest and comfy-sdk from PyPI, so
that step needs the network; everything it then tests runs on loopback against the fakes).

## Running jobs (local ComfyUI, an API proxy, or a Google Colab VM)

```bash
# 1. plan the jobs (TypeScript)
node packages/jobs/bin/plan-jobs.mjs examples/launch-demo/package.json --out out/jobs.json
# 2. run them (this process is the same one the Google Colab backend starts on the VM)
python -m comfyrizz_pipeline.runner --jobs out/jobs.json --out out \
       --base-url http://127.0.0.1:8189 --progress-log out/progress.jsonl
# 3. after a lost exec / killed run: poll the known job ids instead of rerunning
python -m comfyrizz_pipeline.runner --jobs out/jobs.json --out out --reconcile
# 4. health
python -m comfyrizz_pipeline.health --v2-url http://127.0.0.1:8189 \
       --comfyui-url http://127.0.0.1:8188 --require-node KSampler --json
```

Exit codes: `0` the manifest says every job succeeded (or was cached), `1` incomplete or
unknown, `2` the jobs file itself was rejected.

`--base-url` is a **deployment root** (`http://127.0.0.1:8189` for `comfy-api-proxy`,
`http://127.0.0.1:8188` for a plain ComfyUI if the proxy is skipped); the SDK appends
`/api/v2` itself.

## The rules the runner enforces (SPEC.md 6.4)

1. **An attempt record is written before the submit call** (`state: "submitting"`), and the
   `job_id` is written the instant the API returns it — before any progress line. A lost
   reply therefore still leaves evidence, and a recorded `job_id` is always polled, never
   resubmitted.
2. **`submission_unknown` is never resubmitted automatically.** It means "the request may
   have reached the server". A later run finds the open attempt and polls it (if a job id
   exists) or surfaces the job for the user to decide (if not). The UI text is the reason
   string in the manifest: *"ambiguous submit; not resubmitted automatically"*.
3. **The manifest decides success.** It is rewritten atomically after every job, so a kill
   leaves a truthful partial manifest; a missing manifest, or one whose `jobsHash` does not
   match the `jobs.json`, is not success — it is a reconcile.
4. **Outputs are collected after each job**, so a later failure never discards earlier
   work.
5. **Cache** by `(workflow sha, resolved inputs, model revision, seed, dims, frames)`: a hit
   copies the recorded file and skips the submission entirely.
6. **A failed dependency blocks its dependents** (they are recorded `skipped` with the
   dependency named) rather than running a plate without its first frame.
7. A `422 idempotency_key_reuse` is *not* replayed: the runner tries to adopt the job the
   first attempt created (job labels are best-effort — SPEC.md 5.1 notes the proxy ignores
   them) and otherwise records `submission_unknown`.

## Job labels (`metadata`) and the contract that actually holds

The idempotency key is `comfyrizz-<job>-<cacheKey[:16]>-<attempt seq>`, which is deterministic. When
a second run of the same plan re-offers a key the server has already seen, the server answers `422
idempotency_key_reuse` — deliberately, so a resubmit cannot be billed twice. Finding the job that
key created means listing jobs **by label**, which is why labels matter and why their absence is
recorded rather than guessed at.

The two ends disagreed on GPU test 2: `comfy-sdk` sends `metadata` as an object, and
`comfy-api-proxy` rejected it in its own words — *"'metadata' must be a string (opaque label)"* — while
the SDK cannot send a bare string instead. Only *no* metadata is accepted by both. So:

- the runner asks for labels by default (`job_labels="auto"`) and classifies a refusal with
  `client.classify_metadata_refusal` rather than string-matching in the caller;
- on the first refusal it emits a `metadata_unsupported` progress line, submits that one job again
  without labels (`metadata_retry` on the attempt), and stops asking for the rest of the run
  (`runner.labels_ok`); the manifest gains a `notes` entry naming the server and saying that a lost
  submit can no longer be found by label;
- `--job-labels` pins labels on (the refusal is then final: the job fails with the server's own
  words), `--no-job-labels` pins them off. Either way the manifest says what was asked for.

## Getting out of `submission_unknown` (by hand, the only way)

`submission_unknown` means the submit request was sent but never answered: the job may exist and be
running, or not exist at all. The runner never resolves that guess. Look at the run
(`--reconcile` reports each attempt's state) and then choose:

```bash
# 1. the server console (or the Google Colab job list) shows a job for this attempt: adopt it and poll it
python -m comfyrizz_pipeline.runner --jobs out/jobs.json --out out --base-url http://127.0.0.1:8189 \
       --adopt a_cutout.still=job_abc123
# 2. the server shows nothing for this attempt: close it as failed, so the job can be retried
python -m comfyrizz_pipeline.runner --jobs out/jobs.json --out out --base-url http://127.0.0.1:8189 \
       --clear a_cutout.still --reason "checked the server console: no job for this attempt"
```

Neither command submits anything. `--adopt` polls the job id you name, records it on the attempt
(`adopted_by_user`) and collects its outputs as usual; `--clear` marks the attempt failed
(`cleared_by_user`, with your reason), which makes the *next* run pick the job up normally. Both
refuse a job with no unresolved attempt, and `--clear` refuses a job that is not in the plan.
With labels unavailable, a re-run of the same plan against the same server lands here by design:
the duplicate-key rejection cannot be resolved by a label search that the server does not support,
so the job is surfaced for a human instead of being resubmitted behind their back.

## Running the runner from a notebook or a long-lived kernel

Run it as a **child process**. On GPU test 2 a Google Colab driver patched `ComfyClient.submit` in
place and called the runner with `runpy` in the same kernel; the second run wrapped the wrapper and
died with `RecursionError`, after the session had been billed. `comfyrizz_pipeline.launch` is the
supported path:

```python
from comfyrizz_pipeline import launch
launch.run_jobs("out/jobs.json", "out", base_url="http://127.0.0.1:8189")  # as often as you like
```

Each call is a fresh `python -m comfyrizz_pipeline.runner`, so module state, SDK imports and any
patch die with the child. If a caller truly cannot use a child process, `launch.install_metadata_shim()`
installs the metadata patch idempotently (a second install is a no-op, not a second wrapper) and
`launch.uninstall_metadata_shim()` puts the original method back.

## Tests

`tests/fake_comfy.py` is a local fake Comfy v2 server (stdlib only, loopback, no GPU, no
network) that implements the surface `comfy-sdk` uses — including a reused
`Idempotency-Key` being *rejected* with 422, and a mode that accepts a request and then
drops the response. Every request is logged, so the tests can assert how many submissions
happened, which is how "reconcile polls instead of resubmitting" is actually verified.

`tests/fixtures/jobs.json` is the planner's committed output, re-planned by the contract
test; `tests/fixtures/workflows/*.api.json` + `*.api.params.json` are the graphs it points at.

Not wired here on purpose: the Google Colab lifecycle itself (B3, `packages/backends/` +
`colab/`).

## Input files (uploads)

A graph node that takes a file (`LoadImage` on the i2v, img2img and reference-edit graphs) needs a
name in the *server's* input directory — not an asset id and not a local path. Handing it the asset
id is exactly how `a_plate1.plate` failed on the GPU test 2 run with "Prompt outputs failed
validation", after the Google Colab session had been billed.

Two halves, one contract:

1. **The plan** (`jobs.json`) carries a `fileInputs` entry per file-valued parameter:
   `{param, from, path}` where `from: "job"` means `path` is relative to the output directory (a
   dependency's output — the still an i2v plate starts from) and `from: "package"` means it is
   relative to the `jobs.json` directory (an SVG raster shipped with the bundle).
2. **The workflow's params file** declares which parameters are files: `"files": ["image"]`. A
   file-valued parameter the map does not declare is *refused* (`upload_not_declared`) before
   anything is uploaded or submitted; without that check the graph would fail late, on the GPU.

The runner uploads each file to **ComfyUI's own `/upload/image`**, then injects the returned name
into the mapped node input. The deployment root is *not* that endpoint: with the v2 proxy in front
(`comfy-api-proxy` on 8189) the native route is not forwarded, which is what failed 5 of 10 jobs
with `upload_unsupported` on the GPU test 3 run — the run only finished because somebody added
`--upload-url http://127.0.0.1:8188/upload/image` by hand. So the endpoint is now resolved in a
declared order, and the one that took the bytes is what gets recorded (progress event
`upload_endpoint`, a manifest note when it is not the root, and the cache):

1. `--upload-url` / `COMFY_UPLOAD_URL` — an *instruction*: the only endpoint tried, never quietly
   bypassed by a fallback;
2. what this deployment last saw take an upload (the runner's own `out/cache/uploads.json`), so the
   discovery below is paid once per deployment, not once per run;
3. `--comfyui-url` / `COMFYUI_URL` — where the deployment says ComfyUI is. `colab/run_jobs.py` and
   the BYO backend (`packages/backends`) both pass it, so the standard deployments never guess;
4. the deployment root itself (correct when the root *is* ComfyUI — `scripts/setup-local-comfy.sh`
   without the proxy);
5. ComfyUI behind the declared port pairing (`COMFYRIZZ_PROXY_PORT`, default 8189 →
   `COMFYRIZZ_COMFY_PORT`, default 8188), so a forgotten flag does not fail work on a billed VM.

A `404`/`405` on one endpoint means "no ComfyUI upload route here" and the next candidate is tried;
every endpoint tried, with the code each answered, is in the failure message when none of them
works. A few properties worth keeping:

- the upload is content-addressed (`<stem>_<sha8><suffix>`) and cached in
  `out/cache/uploads.json` **keyed by (endpoint, sha256)**: a retry or a re-run that resubmits
  a job does not upload the same bytes twice, and a *different* server (a fresh Google Colab VM with
  an empty input directory) always gets them again. The same file also remembers which endpoint took
  the last upload for this deployment root;
- a missing input file or an upload that fails is a clean refusal with no attempt record
  (`input_file_missing`, `upload_unsupported`, `upload_failed`, `upload_disabled`) — nothing was
  submitted, so nothing is ambiguous;
- the attempt record gained an `inputs_uploaded` event naming the files, and the attempt's
  `inputs_hash` covers the uploaded content, so two runs that differ only in the bytes behind an
  asset id are not the same attempt.

## Two-stage LTX geometry

The LTX graph (`workflows/ltx25_*_2stage.api.json`) renders stage 1 at *half* the finished size and a
latent upsampler doubles it back, so a planned 960x544 must reach the graph's stage-1 latent (node 8)
and its i2v image scale (node 31) as 480x272. The plan states both numbers — `job.dims` is the frame
the package asked for, `job.stage1Dims` is the lattice the graph renders — and every LTX params map
derives the stage-1 value from the planned one with a `{mul: 0.5}` target, so the map cannot disagree
with the plan. A planned size sent whole to node 8 came back at 2x on the GPU test 2 run (issue 3),
and an unmapped node 31 kept the graph's own 960x544 whatever the plan said (issue 4).

