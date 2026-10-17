# GPU test 3: the pipeline on real assets, and the model pin (Google Colab G4)

Date: Sat Oct 17 2026. Times are Toronto (EDT, UTC-4).

Kyle's own findings for this run (N1-N9, per-issue verdicts, repro steps) are at
`/workspace/comfy-hackathon/test/GPU_TEST_3.md` (read-only). This file is the run record the *spend
estimate* cites: the numbers below are the ones `packages/backends` and `pipeline-py/svgguide`
quote, and they agree with Kyle's table.

## Summary

| Item | Value |
|---|---|
| Session | `comfyrizz-gpu3`, Google Colab G4 (RTX PRO 6000 Blackwell, 97,887 MiB) |
| Runtime | 14:24 to 14:38 EDT (about 14 min), then stopped; `colab sessions` reported none afterwards |
| Units | 380.38 before, 378.48 after: **1.90 used** (account-wide; the CLI has no per-session figure). Implied 8.14 units/h against the 8.9 units/h the spend estimate assumes |
| Jobs | 34 measured ComfyUI jobs (12 Klein stills, 6 reference edits, 7 E2 img2img/ref-edit, 8 LTX plates, 1 long plate) plus the 10-job pipeline run |
| Setup | 218.5 s: clone 1.7 s, requirements + proxy + SDK 193.5 s, 60.0 GB of model downloads 193.5 s (parallel), text-encoder merge 22.2 s; ComfyUI answered `/system_stats` 14 s after launch, and the proxy was alive after a 6 s wait |
| Cleanup | HF token deleted by setup, runtime stopped, session watchdog (900 s) exited, no SSH |
| Box-side work | Contact sheets, the explainer package and its render, all on CPU after the stop |

## Deliverables (`test/gpu3/`)

- `explainer_wind_gpu3.mp4`: 36.4 s narrated explainer, 1920x1080 h264 + aac, rendered on CPU after the stop. Its package is `examples/showcase-gpu3` (the A7 example) and the built copy is in `package/`; `reel_gpu3.mp4` is the 89 s highlight reel.
- `contact/`: `klein_stills.jpg`, `svg_ref_edits.jpg`, `e2_sweep.jpg`, `ltx_showcase.jpg`, `pipeline_assets.jpg`, `pipeline_plates.jpg`, `explainer_frames.jpg`, `reel_frames.jpg`.
- `raw/`: `results.json` (per-graph wall/exec seconds and peak VRAM), `setup_times.json`, ComfyUI and proxy logs, `out/` with every render, and `pipeline/` with the runner's own logs (`run1`, `run1b_uploadurl`, `run2_same_kernel`, the label and reconcile cases).
- `logs/`: per-step logs, `usage_before.log` / `usage_after.log`, `sessions_*.log`, `stop.log`.

## Timings (ComfyUI wall clock, warm unless noted)

| Workload | n | min | median | max | Peak VRAM |
|---|---|---|---|---|---|
| Klein t2i still, 1344x768 or 1024², 16 steps | 12 | 1.5 s | 2.5 s | 3.0 s | 41.4 GB |
| Klein reference edit (`ReferenceMultiLatent`) | 6 | 5.5 s | 5.6 s | 5.6 s | 42.6 GB |
| E2 img2img (1280x720, d0.35-0.85) and ref-edit (mp 0.5/1.0/1.5) | 7 | 2.5 s | 3.0 s | 8.5 s | 42.3 GB |
| LTX-2.5 two-stage t2v, 97 frames | 3 | 13.3 s | 14.6 s | 27.1 s | 56.9 GB |
| LTX-2.5 two-stage i2v, 1024x576, 97 frames | 5 | 14.1 s | 16.1 s | 17.0 s | 42.1 GB |
| LTX-2.5 241 frames (a 10 s shot) | 1 | 33.0 s | 33.0 s | 33.0 s | 42.1 GB |

Through the runner on the VM (`pipeline/run1b_uploadurl.log`, 6 jobs): a still 6-7 s, a two-stage i2v plate 13-28 s. Those are the numbers the spend estimate uses, because Google Colab bills the runtime rather than the GPU: `packages/backends/src/colab-backend.mjs` `MEASURED_JOB_MINUTES` (still 0.15, plate 0.5, upscale 0.5, audio 0.05) and `pipeline-py/svgguide/sweeps.py` (img2img 0.05, ref_edit 0.05/0.1/0.15 per reference megapixel, ltx_i2v 0.3). Every value is the worst measurement rounded up.

Setup: 218.5 s measured here against 215 s on GPU test 2, so `BOOTSTRAP_OVERHEAD_MINUTES` is 4 (was a 5-minute placeholder). The cached-wheelhouse path (`colab/wheelhouse.py`) is not on this critical path yet: this run installed from PyPI and spent 193.5 s on it.

## The upload blocker (fixed as H-fix6)

The root cause of five failed jobs: the runner uploaded inputs to `<deployment root>/upload/image`, the root is `comfy-api-proxy` on 8189, and the proxy serves `/api/v2` **without forwarding ComfyUI's native upload route**. Run `run1` shows it exactly:

    [('a_chart_i2i.still', 'failed', 'upload_unsupported'), ('a_city_still.still', 'succeeded', None),
     ('a_flow_ref.still', 'failed', 'upload_unsupported'), ..., ('a_city.plate', 'failed', 'upload_unsupported')]

`run1b_uploadurl` re-ran the same plan with `--upload-url http://127.0.0.1:8188/upload/image` and every job succeeded (4 cached, 6 done), which is what identified the proxy as the culprit. The code fix is in `pipeline-py/comfyrizz_pipeline/client.py`: uploads resolve their endpoint (explicit, remembered, declared `--comfyui-url`, the root, then ComfyUI behind the declared 8189→8188 pairing), a 404/405 walks to the next candidate, and the endpoint that took the bytes is recorded in the progress log, the manifest and the cache. `colab/run_jobs.py` and the BYO backend now declare ComfyUI's origin outright, so a run cannot need the flag somebody remembered here.

## The model pin

`colab/models.lock.json` pins both repos by revision — klein `337337621b8526e120f2275d250242f4a6bedd75`, LTX-2.5 `49b093a39c19169a8a81721dcc541e07e945232f` — with every file, its size and the `ComfyUI/models` path it lands on. The revisions were resolved from the Hugging Face API after the run and **every file size matches the bytes this run downloaded** (60,019,207,384 bytes = 60.0 GB, `logs/setup.log`), so the pin describes the files the timings above were measured on. `colab/bootstrap.py` now reads the lock (`--lock`, uploaded to `/content/comfyrizz/models.lock.json` by the backend) and passes `--revision` to `hf download`; the inline file list is gone, so there is one thing to keep true.

Two honest gaps, recorded in the lock's `authoringNotes`: gated repos mask LFS sha256 through the API (sizes are the cross-check that needs no token), and this run cloned ComfyUI `master` (`ce1e922`) rather than passing `--comfyui-ref`. The ref belongs in the lock when the next run pins it.

## What worked

- **The reference edit is still the best way to style agent SVGs** (see `svg_ref_edits.jpg`): 5.5 s per edit, layout intact, labels legible.
- **The E2 sweep answered its question**: img2img at d0.5/d0.65 restyles without corrupting labels, and the reference budget drives cost and fidelity in step (0.5 MP 2.5 s, 1.0 MP 5.6 s, 1.5 MP 8.5 s).
- **LTX two-stage i2v is stable at 1024x576 / 97 frames** and predictable (14-17 s), which is what the plate estimate is built on.
- **The runner ran the pipeline package three times in the session**: `run1` (37 s, 4 jobs done, 5 refused on the upload above), `run1b` with the upload URL (81 s, 6 done + 4 re-used), and `run2` in the same kernel (10/10 served from cache), so the attempt records and the cache behave on a real VM.

## What looked bad / needs care

- The proxy's missing upload route cost five jobs and a 37 s run whose outputs were unusable, and it forced the 81 s retry: a deployment root is not an origin, which is the whole of H-fix6.
- `t2v_ink` took 27.1 s while the other two t2v jobs took 13.3 and 14.6 s: the first LTX job after Klein pays the model load (peak VRAM 56.9 GB). A cold-load allowance belongs in the estimate before it is called precise.
- The session's 1.90 units carry one setup: the retry reused the downloaded models, so a working upload path would have saved the 37 s and one plan pass, not the 218 s of setup.
