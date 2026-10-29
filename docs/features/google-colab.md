# Google Colab inference automation

**Generate on a cloud GPU from a computer that does not have one.** Google Colab
is ComfyRizz's default managed inference path. The app deploys and operates the
inference stack on your behalf through the official `google-colab-cli`, using
your Google account and available Colab compute units.

You do not need a local CUDA setup, a local copy of the GPU model weights or a
manually maintained ComfyUI server. Your computer runs the app and browser; the
Colab GPU runs the media models. Final composition can render locally on CPU or
on the held VM with `renderLocation: 'colab'`. Self-hosting still requires the
Node/Python/FFmpeg/browser dependencies in [One prompt setup](../ONE_PROMPT.md).

## Connect once, then approve a film

1. Pick **Google Colab** as the backend; the status card shows whether the CLI is installed and
   signed in, and **Test connection** checks it.
2. Accept the required Hugging Face model licences and save a read token using
   **Set up AI & Google Colab**. Environment-based setup can use
   `COMFYRIZZ_HF_TOKEN_FILE` pointing to a private token file.
3. Connect an agent provider, choose a per-video credit ceiling, generate a
   proposal and approve **Make this film**. The saved ceiling enables the initial
   Super Easy run without per-shot spending dialogs; server authorization still
   applies to each production. Advanced production uses scoped plan-card approvals.

## What ComfyRizz deploys and runs

After approval, ComfyRizz handles the lifecycle:

1. **Allocate:** obtain a supported accelerator after readiness, balance and budget checks.
2. **Bootstrap:** install ComfyUI and its dependencies/custom nodes, download pinned
   model weights required by the route, and start the inference service.
3. **Check readiness:** verify the service before running the production jobs.
4. **Generate:** submit model-specific ComfyUI workflows through the Comfy SDK,
   including image/reference dependencies and the chosen video route.
5. **Collect:** retrieve completed media and execution evidence; verify output bytes
   before issuing trusted generation receipts and making assets available.
6. **Finish and stop:** complete any selected remote rendering, collect its output
   and shut down the owned runtime. **VM stopped** appears only after CLI confirmation.

The supported routes use FLUX 3 Image Klein for stills/reference art, LTX-2.5 for
motion plates and MiniMax H3 for character/native-audio shots. Pi coordinates the
creative agent's tools; deterministic backend services control allocation,
execution, collection, budget accounting and shutdown.

Final production delivery requires a directly visible, eligible ComfyUI output
and matching generation/render receipts. A planned job, conditioning-only image
or CPU-only preview does not satisfy the final gate. See
[the contribution contract](../PI_PIPELINE_MIGRATION.md#per-final-video-model-contribution).

## Compute units and Google AI Pro

An eligible Google AI Pro subscription can supply Colab compute units for this
workflow, lowering the barrier for creators who do not own a GPU.

**Source check: 2026-10-29.** Google's
[AI Pro benefits page](https://support.google.com/googleone/answer/14534406?hl=en)
currently lists **200 Colab compute units (CCUs)**. It limits this benefit by
country/account eligibility, to adults and Google One family plan managers, and
excludes trial memberships. The separate
[Colab Pro subscription](https://colab.research.google.com/signup) advertises
**100 compute units per month**. Check your signed-in account for its actual
allowance and renewal terms; AI Pro and Colab Pro are different subscriptions.

Compute units are a runtime allowance, not a fixed number of videos. Accelerator
type, setup/model downloads, generation time and retries affect consumption.
GPU availability also varies; see Google's
[Colab FAQ](https://research.google.com/colaboratory/faq.html#gpu-availability).
ComfyRizz prices the production against the configured rates and available balance,
including collection and shutdown time. A credit ceiling limits authorization; it
does not guarantee that a film will fit or that a particular GPU will be available.
Language-model API charges from the selected agent provider are separate.

## Budget, progress and cancellation

**Configured rates.** Rates are per accelerator (G4 8.90, L4 4.8, CPU 0.08 units/h; H100 and
A100 are refused until a rate is configured). Admission, watchdog deadlines and the balance check
include a six-minute collect-and-stop reserve. A balance that cannot be read refuses the run.
Cancel during allocation aborts it and stops any session already created.

**Spend cap.** In a production, the per-production cap is set by you and can be off; see
[production agent](production-agent.md#budget-reservations-and-the-google-colab-spend-cap).

**Progress.** The editor polls `/api/colab/progress` for setup, download, sampler, node, render and
encode gauges. The final render can also run on the held VM (`renderLocation: 'colab'`).

## Implementation and verification

Code: `packages/backends/` (lifecycle, budget, watchdog), `colab/` (scripts run on
the VM), and `apps/server/src/colab-*.mjs`.

Automated offline suites use a fake `colab` CLI and a fake Comfy server, and
`node scripts/gpu4/g4_dryrun.mjs` runs a whole job against loopback fakes. Bring your own GPU with
**My ComfyUI URL** instead. These tests establish service behavior, not successful
live media generation. Historical measurements:
[COLAB_EFFICIENCY_RESULTS.md](../COLAB_EFFICIENCY_RESULTS.md). Current acceptance
status: [deadline handoff](../submission/DEADLINE_HANDOFF.md).
