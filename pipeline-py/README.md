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
| `comfyrizz_pipeline/health.py` | v2 / ComfyUI / node+model / optional smoke-job checks. |

## Setup and run

```bash
python3 -m venv .venv                 # from the repository root; .venv/ is gitignored
.venv/bin/pip install -r pipeline-py/requirements-dev.txt   # jsonschema, pytest, comfy-sdk
cd pipeline-py && ../.venv/bin/python -m pytest
```

The schema files are read from `packages/schema/` (override the package schema with
`COMFYRIZZ_SCHEMA`). Validation needs no network.

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

The runner uploads each file to `<deployment root>/upload/image` (override with `--upload-url` or
`COMFY_UPLOAD_URL`; **[unverified against a real `comfy-api-proxy`: the GPU test runs used the SDK
path]**, so pointing this at ComfyUI itself is the fallback), then injects the returned name into
the mapped node input. A few properties worth keeping:

- the upload is content-addressed (`<stem>_<sha8><suffix>`) and cached in
  `out/cache/uploads.json` **keyed by (deployment root, sha256)**: a retry or a re-run that resubmits
  a job does not upload the same bytes twice, and a *different* server (a fresh Google Colab VM with
  an empty input directory) always gets them again;
- a missing input file or an upload that fails is a clean refusal with no attempt record
  (`input_file_missing`, `upload_unsupported`, `upload_failed`, `upload_disabled`) — nothing was
  submitted, so nothing is ambiguous;
- the attempt record gained an `inputs_uploaded` event naming the files, and the attempt's
  `inputs_hash` covers the uploaded content, so two runs that differ only in the bytes behind an
  asset id are not the same attempt.

