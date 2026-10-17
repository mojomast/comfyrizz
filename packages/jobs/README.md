# @comfyrizz/jobs — package → `jobs.json`

Owner: **Hermes** (WS-B). `comfyrizz.package/v1` in, an ordered hashed job graph out, for
`pipeline-py` to execute (SPEC.md 6.4).

```bash
node bin/plan-jobs.mjs ../../examples/launch-demo/package.json --out jobs.json
node bin/plan-jobs.mjs <package.json> --out jobs.json --check   # fail if stale
node --test test/*.test.mjs
```

## What it plans

Driven by the package's **assets**, not by guesses about scenes: every asset whose
`origin` is `generated`, whose `status` still needs work, and whose `gen.generator` is a
model generator gets a job. `llm-svg` never does: procedural vector work is CPU sanitize +
render-check (PLAN.md A5), reported in `skipped[]` with the reason.

| generator | kind | workflow | output |
|---|---|---|---|
| `flux3-klein` | `still` | `gen.workflow` | `assets/<id>.png` |
| `ltx25` | `plate` (+ `upscale` when `gen.inputs.upscale` is set) | `gen.workflow` | plate: `out/intermediates/<id>.plate.mp4`, upscale: `assets/<id>.mp4` |
| `kokoro` | `audio` | `gen.workflow` | `assets/<id>.wav` |

## The rules baked in

- **Batch order** is always `stills → plates → upscales → audio`: every FLUX still in the
  package is submitted before any LTX plate, so one GPU session does the stills first
  (SPEC.md 6.4, one job at a time). Within a batch, jobs are ordered by scene, then asset id.
- **LTX geometry**: plate/upscale width and height resolve to multiples of **32**
  (`960×544` stays put; `961×545` becomes `960×544`), and frame counts resolve to **8n+1**
  (100 → 97, 101 → 105; nearest, ties round up). Stills use multiples of 8 (the VAE factor).
- **Upscale geometry**: `x2+crop` doubles the plate and records the crop that brings it back
  to the package format (`960×544 → 1920×1088 → crop 4/4 → 1920×1080`).
- **Dependencies**: a plate depends on the still it uses as its first frame; an upscale
  depends on its plate. The runner refuses to run a job whose dependency failed.
- **Cutout**: `cutout: true` on the asset or in `gen.inputs` is carried into the still job
  (an alpha PNG), and is not a node input.
- **Determinism**: no timestamps, keys sorted, so the same package always produces the same
  document and the same `hash`. The hash covers the whole document with `hash: null`, and
  the Python runner recomputes it the same way (see
  `pipeline-py/tests/test_jobs_contract.py`).
- **Cache key per job**: `sha256` over `(workflow sha, generator, model, model revision,
  params, seed, dims, frames)`, so a text/colour/layout-only edit does not invalidate a
  rendered asset but a seed or prompt change does.
- **Refusals, not silent drops**: an absolute or traversing `gen.workflow`, a missing
  `workflow_sha256`, or a kokoro asset with no caption is an error naming the asset.
  A parameter with no `params.json` mapping is an error in the runner, never a dropped value.

## Jobs are submitted through a params map

`workflows/<name>.api.json` is the API-format graph; the sibling
`workflows/<name>.api.params.json` maps a job parameter to `[node_id, field]`:

```json
{ "v": 1, "generator": "ltx25",
  "map": { "width": ["5", "width"], "frames": ["5", "length"], "image": ["1", "image"] } }
```
