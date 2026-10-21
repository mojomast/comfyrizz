# FastH3 Omni testing (experimental)

**Status: experimental.** FastH3 Omni (`gen.generator: "fasth3-omni"`) is an
optional, reference-conditioned video **and** audio generator. It is not the
default generator, it is not on the production path, and it is not covered by
the shipped pipeline's performance claims. It is registered in the workflow
manifest (`packages/agent/src/workflow-manifest.ts`) and in the package schema
(`packages/schema/package-v1.schema.json`, `packages/schema/jobs-v1.schema.json`)
so a package *can* plan it, and nothing else in the pipeline treats it as a
first-class generator.

The graph uses native ComfyUI reference-to-video nodes and keeps both generated
streams - picture and speech - in one MP4. It is separate from the production
LTX bootstrap (`colab/bootstrap.py`, `colab/models.lock.json`) and does not
touch that environment.

## Pinned recipe

- ComfyUI: `d52a7a5ef60b36062f7c3c69bd774f4c98b56eb0`.
- Upstream workflow: [FastH3 OmniRef template](https://github.com/Comfy-Org/workflow_templates/blob/d0e41fe5423f93db5b5872cf273d7b1af8aa68bc/templates/video_fasth3_ominiref_r2v.json).
- Model manifest: `colab/fasth3-models.lock.json`, with sizes and SHA-256 hashes. It is
  flagged experimental in its own `purpose` field, as is the params file of the graph.
- Template-compatible INT8 diffusion, NVFP4 reference encoder, INT8 video VAE,
  FP32 audio VAE. Approximately 41.32 GB of weights; a Blackwell pilot profile.
- Eight-step Euler/simple, no CFG multiplier, VSA 10%, video/audio shifts 12/3.
- 24 fps, 32-pixel spatial lattice, frame counts rounded **up** to `17n+5`.
- `image`, `reference`, `audio` mean `<Picture 1>`, `<Picture 2>`, `<Audio 1>`.
  All three inputs are required by the included graph. The model supports more
  references, but this first integration deliberately implements this bounded set.

No speedup is claimed here. The upstream announcement's number is not a
measurement on our hardware, and this repository records no GPU benchmark for
this generator.

## Project integration

`gen.generator: "fasth3-omni"` plans a normal video plate with file uploads,
source provenance and reference-sensitive caching. It does **not** inherit
LTX's framing lock, strength, 8n+1 frame count, half-size stage or
image-aspect coercion: for this generator the two pictures are identity and
context references, not the first frame of the shot, so a portrait reference is
not coerced to the plate's aspect and no `stage1Dims` is recorded.

The committed graph is `workflows/fasth3_omni_ref2va.api.json`; its sibling
params file (`workflows/fasth3_omni_ref2va.api.params.json`) works with the
existing Python parameter injector.

The planner's rules (`packages/jobs/src/plan.mjs`):

| Rule | Value | Why |
| --- | --- | --- |
| Dims lattice | 32 px | the graph's own spatial lattice |
| Frame count | `17n+5`, rounded up | the model's temporal lattice; never shorter than the line it speaks |
| Frame rate | 24 fps, enforced | the audio and the pictures are muxed into one file |
| Required inputs | `image`, `reference`, `audio` | the graph needs all three |
| Upscale stage | refused | the graph has no x2 pass |
| Cache key | folds the sha256 of all three inputs | a new portrait or voice take invalidates the take, even when the asset ids stay the same |

Applied assets record `media.audio: "present"`, because the produced MP4 keeps
the generated audio. The ordinary renderer still needs its plate audio bus
configured at an appropriate level; it is not automatically a dialogue-led
editor.

Model terms are recorded separately, and H3 output is **not** automatically
marked unrestricted CC0: a FastH3 asset defaults to the MiniMax-H3 community
licence (`LicenseRef-MiniMax-H3-Community`) and to `redistributable: false`,
because that licence carries territorial and commercial conditions that reach
the produced file. A reviewer can say otherwise on purpose in the package.

No model weights and no reference media are committed to the repository.

## Running it on Google Colab

The experiment runs on its own Google Colab GPU session, isolated from the
production LTX/FLUX environment.

1. Upload `colab/fasth3-models.lock.json` next to the bootstrap script in
   `/content/fasth3`.
2. `colab/fasth3_bootstrap.py` downloads and verifies only the H3 weights
   (size and SHA-256 per file), starts the pinned ComfyUI, and checks that the
   native nodes (`MiniMaxH3ReferenceToVideo`, `MiniMaxH3SigmaShift`,
   `BlockSparseAttention`, `VAEDecodeAudio`, `CreateVideo`, `SaveVideo`) exist.
   It writes `/content/fasth3/bootstrap-receipt.json`.
3. `colab/fasth3_run.py` submits prepared shots to that server and keeps the
   synchronized audio:

   ```bash
   python colab/fasth3_run.py /content/fasth3/film --shots s04
   ```

The runner records every submitted graph and prompt id **before** it polls, and
it refuses to repeat an interrupted or uncertain attempt automatically: a
receipt that already exists has to be inspected before a new take is started.
A successful shot's receipt carries the source graph, the sha256 of every
input, the wall time, the ffprobe streams and the sha256 of the produced
file. The generated audio is preserved, not replaced with the voice reference.

A host-side owner must enforce the credit budget and stop the billed runtime,
including after a failure. The scripts never stop the session themselves.

## Verification

```bash
node --test packages/jobs/test/fasth3.test.mjs packages/jobs/test/plan.test.mjs
node --test packages/schema/test/generated.test.mjs
node scripts/py.mjs -m pytest pipeline-py/tests/test_workflows_contract.py -q
python3 -m py_compile colab/fasth3_bootstrap.py colab/fasth3_run.py
```

The integration tests cover the H3 frame and geometry rules, portrait
reference handling, changed-reference invalidation, audio retention, model
metadata and licence defaults, and the native graph's AV connectivity.

## Limits

- Experimental: no GPU benchmark, no measured quality bar and no promised
  throughput. Review the real output (speech, identity, hands, lip motion)
  before using any of it in a delivered film.
- The generated speech is not a verified transcript of the prompt; the model can
  change words and pacing.
- The reference set matters: tight face portraits and a person-free context
  crop behave differently from wide shots that contain people.
- The MiniMax-H3 community licence is not MIT and not Apache: read it before
  any commercial use, and keep the recorded `model_license` and the
  `redistributable: false` default unless a reviewer has decided otherwise.
