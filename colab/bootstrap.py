"""Comfyrizz Google Colab bootstrap (draft; never executed on Google Colab yet).

Run with `colab exec -s comfyrizz-<pkg> -f bootstrap.py --timeout 900` after the backend has
uploaded the Hugging Face token as a 0600 file (SPEC.md 6.7.2 step 4). Steps:

1. clone the pinned ComfyUI and install its requirements (torch is preinstalled on the G4 image;
   measured in GPU test 1: clone 1.0 s, requirements 24.8 s);
2. read the token from /content/.hf/token (0600), never from `--env`, never printed;
3. download the pinned model files in parallel with `hf download` (519 MB/s measured), printing
   progress so the CLI's quiet-period timeout does not fire;
4. merge the sharded Qwen3-VL text encoder, symlink the model files into ComfyUI/models;
5. start ComfyUI on 127.0.0.1:8188 and comfy-api-proxy on 127.0.0.1:8189 with
   `Popen(start_new_session=True)` (background processes survive between execs — verified);
6. write /content/comfyrizz/out/ready.json with versions, node types and free VRAM.

Adapted from Kyle's `colab/g1_setup.py` (GPU test 1) and the Oct 16 test scripts s2–s4. Model
files and revisions are pinned in `colab/models.lock.json` when the M3 spike records them.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/content")
COMFY = ROOT / "ComfyUI"
OUT = Path("/content/comfyrizz/out")
TOKEN = Path("/content/.hf/token")
PROXY_PORT = 8189
COMFY_PORT = 8188
PROXY_PY = ROOT / "comfy-api-proxy"

#: Pinned by the M3 spike; the versions below are the ones GPU test 1 used.
COMFYUI_REF = os.environ.get("COMFYRIZZ_COMFYUI_REF", "master")
MODELS = {
    "klein": (
        "black-forest-labs/flux-3-image-klein",
        ["model.safetensors", "ae.safetensors", "text_encoder/model-00001-of-00002.safetensors", "text_encoder/model-00002-of-00002.safetensors"],
    ),
    "ltx": (
        "Lightricks/LTX-2.5",
        [
            "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
            "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
            "vae/ltx-2.5-video-vae-bf16.safetensors",
            "vae/ltx-2.5-audio-vae-bf16.safetensors",
            "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
        ],
    ),
}


def run(command: str, tag: str = "") -> int:
    print(f"$ {tag or command[:120]}", flush=True)
    started = time.time()
    process = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert process.stdout is not None
    for number, line in enumerate(process.stdout, start=1):
        if number % 40 == 0 or "rror" in line:
            print("  ", line.rstrip()[:200], flush=True)
    process.wait()
    print(f"-> {tag} exit {process.returncode} in {time.time() - started:.1f}s", flush=True)
    return process.returncode


def read_token() -> str:
    """Read the uploaded 0600 file once. The value is never printed and never an argument."""
    if not TOKEN.is_file():
        raise SystemExit("no /content/.hf/token: upload it before bootstrapping (never via --env)")
    os.chmod(TOKEN.parent, 0o700)
    os.chmod(TOKEN, 0o600)
    value = TOKEN.read_text().strip()
    if not value:
        raise SystemExit("the uploaded token file is empty")
    return value


def download_models(token: str) -> dict:
    env = dict(os.environ)
    env["HF_TOKEN"] = token
    env["HF_XET_HIGH_PERFORMANCE"] = "1"
    env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    results = {}
    for name, (repo, files) in MODELS.items():
        started = time.time()
        process = subprocess.run(["hf", "download", repo, *files, "--local-dir", f"/content/hf/{name}"], capture_output=True, text=True, env=env)
        results[name] = {"rc": process.returncode, "seconds": round(time.time() - started, 1), "error": process.stderr[-400:] if process.returncode else ""}
        print(f"DOWNLOAD {name} {json.dumps(results[name])}", flush=True)
    return results


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    if run(f"cd {ROOT} && rm -rf ComfyUI && git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI.git && cd ComfyUI && git checkout -q {COMFYUI_REF} && git log -1 --format='%h %cd'", "clone") != 0:
        raise SystemExit("cloning ComfyUI failed")
    if run(f"cd {COMFY} && grep -viE '^(torch|torchvision|torchaudio)([<>=~ ]|$)' requirements.txt > /tmp/req.txt && pip install -q -r /tmp/req.txt 'huggingface_hub[hf_xet]>=1.0' safetensors", "requirements") != 0:
        raise SystemExit("installing ComfyUI requirements failed")
    if subprocess.run(f"cd {ROOT} && git clone -q --depth 1 https://github.com/Comfy-Org/comfy-api-proxy.git", shell=True).returncode != 0:
        raise SystemExit("cloning comfy-api-proxy failed")

    token = read_token()
    download = download_models(token)
    # the token is used and then removed; it is never exported to ComfyUI or to a node
    TOKEN.unlink(missing_ok=True)
    print("token file removed:", not TOKEN.exists(), flush=True)

    # merge the sharded Klein text encoder (GPU test 1: two shards -> one file)
    from safetensors.torch import load_file, save_file  # noqa: PLC0415 - only present on the VM

    merged = {}
    for shard in sorted(Path("/content/hf/klein/text_encoder").glob("model-*.safetensors")):
        merged.update(load_file(shard))
    target = COMFY / "models/text_encoders/qwen3vl_4b_bf16.safetensors"
    target.parent.mkdir(parents=True, exist_ok=True)
    save_file(merged, target)
    tensors = len(merged)
    del merged
    print(f"merged text encoder: {tensors} tensors -> {target}", flush=True)
    for shard in Path("/content/hf/klein/text_encoder").glob("model-*.safetensors"):
        shard.unlink()

    links = {
        "/content/hf/klein/model.safetensors": "diffusion_models/flux-3-image-klein-bf16.safetensors",
        "/content/hf/klein/ae.safetensors": "vae/flux2-vae.safetensors",
        "/content/hf/ltx/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors": "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
        "/content/hf/ltx/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors": "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
        "/content/hf/ltx/vae/ltx-2.5-video-vae-bf16.safetensors": "vae/ltx-2.5-video-vae-bf16.safetensors",
        "/content/hf/ltx/vae/ltx-2.5-audio-vae-bf16.safetensors": "vae/ltx-2.5-audio-vae-bf16.safetensors",
        "/content/hf/ltx/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors": "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
    }
    for source, relative in links.items():
        destination = COMFY / "models" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_symlink() or destination.exists():
            destination.unlink()
        os.symlink(source, destination)

    # background processes persist between execs (verified Oct 16), so start both detached
    comfy_log = open("/content/comfyui.log", "w")  # noqa: SIM115 - intentionally kept open for the process
    subprocess.Popen(
        [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", str(COMFY_PORT)],
        cwd=str(COMFY),
        stdout=comfy_log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    proxy_log = open("/content/proxy.log", "w")  # noqa: SIM115
    subprocess.Popen(
        [sys.executable, "-m", "comfy_api_proxy", "--comfyui", f"http://127.0.0.1:{COMFY_PORT}", "--port", str(PROXY_PORT)],
        cwd=str(PROXY_PY),
        stdout=proxy_log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    ready = {"ok": False, "comfyui": None, "proxy": None, "downloads": download, "at": time.time()}
    import urllib.request  # noqa: PLC0415

    for _ in range(60):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{COMFY_PORT}/system_stats", timeout=2) as response:  # noqa: S310 - loopback
                stats = json.load(response)
            ready["comfyui"] = stats.get("system", {}).get("comfyui_version")
            break
        except Exception:  # noqa: BLE001 - retry until ready
            time.sleep(2)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PROXY_PORT}/api/v2/jobs?limit=1", timeout=3) as response:  # noqa: S310 - loopback
            ready["proxy"] = response.status
    except Exception as error:  # noqa: BLE001
        ready["proxy_error"] = str(error)
    ready["ok"] = bool(ready["comfyui"]) and ready["proxy"] == 200
    (OUT / "ready.json").write_text(json.dumps(ready, indent=2))
    print("READY", json.dumps(ready), flush=True)
    return 0 if ready["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
