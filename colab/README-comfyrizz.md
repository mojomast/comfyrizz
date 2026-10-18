# Google Colab VM scripts (Comfyrizz server side)

Owner: **Hermes** (WS-B, B3). These are the scripts the Google Colab backend uploads and runs
with `colab exec -f`. GPU test 5 (Oct 18, 2026, `/workspace/comfy-hackathon/test/GPU_TEST_5.md`)
executed them on a real G4 against the real backend, end to end, **with a probe patch**: `runPackage`
returned `ok=true`, 5 assets applied as `colab:G4`, teardown verified. HEAD as committed still fails
at bootstrap, so the fixes below are required before the scripts run unpatched; every run in that
test used a detached worktree and nothing was committed or pushed.

| File | What it does | Status |
|---|---|---|
| `hf_token_dir.py` | **runs before the token upload**: creates `/content/.hf` as 0700, because `colab upload` does not create parent directories and the CLI has no `mkdir` (H13) | new (H13); ran in GPU test 5; the fake CLI refuses an upload into a missing directory, like the real one |
| `list_out.py` | prints the run's `out/` tree as JSON lines, so the backend can fetch it one file at a time - `colab download` takes single files, never a directory (H13) | new (H13); ran in GPU test 5 (needs G5-6, the local parent mkdir); the fake CLI refuses a directory download, like the real one |
| `bootstrap.py` | clone ComfyUI, install requirements, download the pinned models with the HF token from a 0600 file (`/content/.hf/token`, the path `hf_token_dir.py` prepared), start ComfyUI + `comfy-api-proxy` detached, write `out/ready.json` | ran on Google Colab in GPU test 5 (237 s) with the G5-1/G5-2/G5-4/G5-5 probe patch; HEAD needs those fixes; adapted from `g1_setup.py` + `s2`–`s4` |
| `wheelhouse.py` | **host side**: download the pinned wheels (`requirements-vm.txt`) for the VM's platform, hash them into `manifest.json`, and `--check` a cache later; `install_command()` is what `bootstrap.py` installs with | new (H-fix5); CPU only, tested with a fake pip |
| `requirements-vm.txt` | the pinned install list: ComfyUI's `requirements.txt` at the cloned ref (torch excluded - the G4 image has it), plus `huggingface_hub[hf_xet]`, `comfy-api-proxy`, `comfy-sdk`, `jsonschema` | new (H-fix5) |
| `health.py` | proxy reachable, `nvidia-smi` free VRAM, node types present, one small smoke job; writes `out/health.json` | ran in GPU test 5 (proxy 200, 988 node types, RTX PRO 6000 Blackwell, 94.4 GB free); the smoke job still needs G5-12; adapted from `s6`/`s7` |
| `run_jobs.py` | unpack `jobs.zip`, run `pipeline-py` against loopback, stream JSON-lines progress | ran in GPU test 5 (both batches, 5 jobs) with the G5-5/G5-8 probe patch; the runner itself is tested (B2) |
| `reconcile.py` | `pipeline-py --reconcile` on the VM after a lost exec, so the host never resubmits | draft |
| `g1_*.py`, `make_jobs.py` | Kyle's GPU-test-1 scripts (already run once); left untouched | measured |

GPU test 5 also exercised the backend (not these scripts) and found G5-1..G5-14 in
`test/GPU_TEST_5.md`; the backend-side ones are Hermes's (`packages/backends/src/colab-backend.mjs`).

### Cutting the 192 s install (H-fix5)

GPU test 2's setup was 215 s and 192 s of it was `pip install`. The wheel cache is the answer:

```bash
# on a fast link (this box, not the VM)
python colab/wheelhouse.py --out /path/that/survives/restart/wheelhouse
python colab/wheelhouse.py --out /path/.../wheelhouse --check      # verify before a session
# on the VM
python bootstrap.py --wheelhouse /content/wheelhouse               # --find-links, index still allowed
python bootstrap.py --wheelhouse /content/wheelhouse --offline     # --no-index: cache only
```

`bootstrap.py` writes the install's own seconds into `ready.json` (`"install": {...}`), so the
"halves setup" claim gets replaced by a measurement on the next approved session. Nothing here starts
a session or touches the network on the VM beyond what the install needs.

Not here on purpose: anything that starts a session, uploads a token, or stops a VM. The
lifecycle is the backend's job (`packages/backends/src/colab-backend.mjs`), so the scripts stay
pure and re-runnable.
