# @comfyrizz/jobs — package → `jobs.json`

Owner: **Hermes** (WS-B). `comfyrizz.package/v1` in, an ordered hashed job graph out, for
`pipeline-py` to execute (SPEC.md 6.4).

```bash
node bin/plan-jobs.mjs ../../examples/launch-demo/package.json --out jobs.json
node bin/plan-jobs.mjs <package.json> --out jobs.json --check   # fail if stale
node --test test/*.test.mjs        # or: npm test
```

From a fresh clone (Node 20 or 22, pnpm): `pnpm install --no-frozen-lockfile` at the repository
root, then `cd packages/jobs && npm test`. No key, no network and no Google Colab runtime is
needed — `scripts/clean-clone-b-side.sh` does exactly this from a fresh `git clone` of HEAD.

## What it plans

Driven by the package's **assets**, not by guesses about scenes: every asset whose
`origin` is `generated`, whose `status` still needs work, and whose `gen.generator` is a
model generator gets a job. `llm-svg` never does: procedural vector work is CPU sanitize +
render-check (PLAN.md A5), reported in `skipped[]` with the reason.

| generator | kind | workflow | output |
|---|---|---|---|
| `flux3-klein` | `still` | `gen.workflow` | `assets/<id>.png` |
| `ltx25` | `plate` (+ `upscale` when `gen.inputs.upscale` is set) | `gen.workflow` | plate: `assets/<id>.mp4` (the asset's own file); upscale: `assets/<id>@2x.mp4`, applied as `assets.<id>.variants.upscaled` (H12) |
| `kokoro` | `audio` | `gen.workflow` | `assets/<id>.wav` |

The plan is executed through `packages/backends`: `backend.runPackage(pkg, opts)` plans, brings the box
up, runs the batches, applies the manifest back onto the package and tears the box down — its README
documents the signature, both backends (Google Colab and BYO) and the spend gate. The apply step is
`src/apply.mjs` here, so that is where a manifest becomes a package edit.

## The rules baked in

- **Batch order** is always `stills → plates → upscales → audio`: every FLUX still in the
  package is submitted before any LTX plate, so one GPU session does the stills first
  (SPEC.md 6.4, one job at a time). Within a batch, jobs are ordered by scene, then asset id.
- **LTX geometry**: two-stage plate/upscale output width and height resolve to multiples of **64**
  (`960×544` becomes `960×576`), so the half-resolution base is divisible by **32**.
  The default is exact 16:9: `512×288 → 1024×576`. Frame counts resolve to **8n+1**
  (100 → 97, 101 → 105; nearest, ties round up). Stills use multiples of **16**: Klein's VAE
  factor is 8 but its patch size is 2, so a still on the 8 lattice is padded or cropped by the
  model — GPU test 2 shipped 960×540 sample rasters and the verdict in `docs/GPU_TEST_2.md` was
  "use 960×544 or 1024×576".
- **Upscale geometry**: `x2+crop` doubles the plate and records delivery-crop metadata
  (`960×576 → 1920×1152`, crop 36/36 for a 1920×1080 composition). The generated file's
  `dims` and graph parameters remain `1920×1152`; delivery framing is downstream of generation.
  Sending the cropped height 1080 to the graph would create an invalid 540-pixel base height.
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
- **Prompt defaults** (`src/defaults.mjs`, from `docs/GPU_TEST_2.md` "What looked bad"): every
  still/plate prompt the planner writes is the package's prompt **plus** the guards the GPU run
  proved are needed, and each job records them in `promptGuards` so nothing is a VM-side edit:
  - `no text, no letters, no words, no logos, no watermarks` — unless the asset opts in
    (`gen.inputs.text: true`) or its prompt already refuses text. On that run a hero still drew
    garbled pseudo-text and a "sketch" run wrote a legible stray word ("Loss").
  - `static camera, gentle motion, no cuts` on an i2v plate, `slow continuous motion, static
    camera, seamless, no cuts` on a t2v plate — unless the prompt directs the camera itself
    (LTX-2.5 turns an orbit into a zoom; a push-in pushes labels out of frame).
  - `warnings[]` (not refusals) for the two measured weak spots, with codes
    `PLAN_ORBIT_UNRELIABLE`, `PLAN_PUSH_IN_LABELS`, and `PLAN_CAMERA_ON_TEXT_FRAME` when the
    plate's first frame carries labels *and* the prompt moves the camera.
- **i2v sources at the plate's aspect**: a plate whose first-frame still has a different aspect is
  refused (a 1:1 source fed to 16:9 was centre-cropped and cut the subject's head off), unless the
  caller passes `{ allowAspectMismatch: true }`, which is then recorded as a warning.

## Jobs are submitted through a params map

`workflows/<name>.api.json` is the API-format graph; the sibling
`workflows/<name>.api.params.json` maps a job parameter to `[node_id, field]`:

```json
{ "v": 1, "generator": "ltx25",
  "map": { "width": ["5", "width"], "frames": ["5", "length"], "image": ["1", "image"] } }
```
