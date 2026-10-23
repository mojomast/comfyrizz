# Google Colab inference automation

Comfyrizz drives your own Google Colab account through the official `google-colab-cli`. Code:
`packages/backends/` (lifecycle, budget, watchdog), `colab/` (scripts run on the VM),
`apps/server/src/colab-*.mjs`.

1. Pick **Google Colab** as the backend; the status card shows whether the CLI is installed and
   signed in, and **Test connection** checks it.
2. FLUX 3 Klein and LTX-2.5 are gated on Hugging Face: accept the licences and point
   `COMFYRIZZ_HF_TOKEN_FILE` at a `0600` token file.
3. Approve the spend card (or a production plan card). Comfyrizz allocates the accelerator,
   bootstraps pinned models, runs the jobs, collects results and stops the VM. It reports the VM
   stopped only after the CLI confirms it.

**Pricing and safety.** Rates are per accelerator (G4 8.90, L4 4.8, CPU 0.08 units/h; H100 and
A100 are refused until a rate is configured). Admission, watchdog deadlines and the balance check
include a six-minute collect-and-stop reserve. A balance that cannot be read refuses the run.
Cancel during allocation aborts it and stops any session already created.

**Spend cap.** In a production, the per-production cap is set by you and can be off; see
[production agent](production-agent.md#budget-reservations-and-the-google-colab-spend-cap).

**Progress.** The editor polls `/api/colab/progress` for setup, download, sampler, node, render and
encode gauges. The final render can also run on the held VM (`renderLocation: 'colab'`).

No test starts a real runtime: suites use a fake `colab` CLI and a fake Comfy server, and
`node scripts/gpu4/g4_dryrun.mjs` runs a whole job against loopback fakes. Bring your own GPU with
**My ComfyUI URL** instead. Measurements: [COLAB_EFFICIENCY_RESULTS.md](../COLAB_EFFICIENCY_RESULTS.md).
