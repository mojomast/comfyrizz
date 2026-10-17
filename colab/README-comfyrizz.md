# Google Colab VM scripts (Comfyrizz server side)

Owner: **Hermes** (WS-B, B3). These are the scripts the Google Colab backend uploads and runs
with `colab exec -f`. **None of them has been executed on Google Colab yet**: the drafts below
are written from the Oct 16 GPU-test session (`docs/SPEC.md` §6.7.2, `/workspace/comfy-hackathon/test/s2–s7*.py`)
and from Kyle's `g1_setup.py` (which *was* run, in GPU test 1 on Oct 17). Kyle approves every GPU
run separately (docs/tasks/RULES.md rule 1), so they ship untested, marked here.

| File | What it does | Status |
|---|---|---|
| `bootstrap.py` | clone ComfyUI, install requirements, download the pinned models with the HF token from a 0600 file, start ComfyUI + `comfy-api-proxy` detached, write `out/ready.json` | draft, adapted from `g1_setup.py` + `s2`–`s4` |
| `wheelhouse.py` | **host side**: download the pinned wheels (`requirements-vm.txt`) for the VM's platform, hash them into `manifest.json`, and `--check` a cache later; `install_command()` is what `bootstrap.py` installs with | new (H-fix5); CPU only, tested with a fake pip |
| `requirements-vm.txt` | the pinned install list: ComfyUI's `requirements.txt` at the cloned ref (torch excluded - the G4 image has it), plus `huggingface_hub[hf_xet]`, `comfy-api-proxy`, `comfy-sdk`, `jsonschema` | new (H-fix5) |
| `health.py` | proxy reachable, `nvidia-smi` free VRAM, node types present, one small smoke job; writes `out/health.json` | draft, adapted from `s6`/`s7` |
| `run_jobs.py` | unpack `jobs.zip`, run `pipeline-py` against loopback, stream JSON-lines progress | draft; the runner itself is tested (B2) |
| `reconcile.py` | `pipeline-py --reconcile` on the VM after a lost exec, so the host never resubmits | draft |
| `g1_*.py`, `make_jobs.py` | Kyle's GPU-test-1 scripts (already run once); left untouched | measured |

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
