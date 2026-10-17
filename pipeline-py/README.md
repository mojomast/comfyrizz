# pipeline-py

Owner: **Hermes** (WS-B). Python side of Comfyrizz: the `comfy-sdk` runner that executes
`jobs.json` against `COMFY_BASE_URL` (B2) and the package validator (B1).

- `comfyrizz_pipeline/schema.py` — `comfyrizz.package/v1` validation (JSON Schema via
  `jsonschema` + the shared `SEM_*` semantic rules). Mirrors
  `packages/schema/src/semantic.mjs`; the two are compared by conformance tests on both sides.
- `comfyrizz_pipeline/validate.py` — CLI: `python -m comfyrizz_pipeline.validate <file> [--json]`.
- `tests/` — pytest: the shared fixture corpus, semantic units, and the cross-language sweep.

## Setup and run

```bash
python3 -m venv .venv                 # from the repository root; .venv/ is gitignored
.venv/bin/pip install -r pipeline-py/requirements-dev.txt
cd pipeline-py && ../.venv/bin/python -m pytest
```

The schema file is read from `packages/schema/package-v1.schema.json` (override with
`COMFYRIZZ_SCHEMA`). No network access is needed for validation.
