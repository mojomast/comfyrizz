# Google Colab VM scripts (GPU test session 1)

Run on a G4 session with `colab exec -f`. Results: `/workspace/comfy-hackathon/test/GPU_TEST_1.md` (box).

- `g1_setup.py`: clone ComfyUI, install requirements, download FLUX 3 Klein (BF16, original BFL repo) and LTX-2.5 (Comfy int8) in parallel, merge the Klein Qwen3-VL text encoder shards, link files into `ComfyUI/models`. Reads the HF token from `/content/.hf/token` (0600, uploaded with `colab upload`), never prints it, deletes it after download.
- `g1_dl_ltx.py`: LTX-only download (used in gpu1 after the first LTX attempt fetched nothing).
- `g1_run.py`: submits API workflows to ComfyUI `/prompt`, records wall time, ComfyUI exec time and peak `nvidia-smi` VRAM; assembles LTX PNG frames to mp4 with ffmpeg.
- `make_jobs.py`: job lists with the agent-style expanded prompts (uses `../workflows/build_gpu1.py`).
