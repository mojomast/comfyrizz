"""Paid-runtime worker: pinned Qwen narration followed by alignment/ASR QA.

Invoked by scripts/tts/qwen_colab.mjs after its dry run and bounded allocation.
Only the source package, optional-voice code and public model pins are uploaded.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile


def run(argv, **kwargs):
    print("Running:", " ".join(map(str, argv)), flush=True)
    process = subprocess.Popen(list(map(str, argv)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, **kwargs)
    for line in process.stdout:
        print(line, end="", flush=True)
    if process.wait():
        raise subprocess.CalledProcessError(process.returncode, argv)


def main():
    root = Path("/content/comfyrizz-qwen")
    root.mkdir(exist_ok=True)
    with zipfile.ZipFile("/content/comfyrizz-qwen-input.zip") as archive:
        archive.extractall(root)
    lock = json.loads((root / "models.lock.json").read_text())
    run(["apt-get", "update", "-qq"])
    run(["apt-get", "install", "-y", "-qq", "sox", "ffmpeg", "python3-venv"])
    for name, package in [("tts", lock["ttsPackage"]), ("asr", lock["asrPackage"])]:
        env = root / ("venv-" + name)
        run([sys.executable, "-m", "venv", "--system-site-packages", env])
        run([env / "bin/python", "-m", "pip", "install", "--disable-pip-version-check", package])
    tts_python, asr_python = [root / ("venv-" + name) / "bin/python" for name in ("tts", "asr")]
    download = """
import json
from concurrent.futures import ThreadPoolExecutor
from huggingface_hub import snapshot_download
from pathlib import Path
root=Path('/content/comfyrizz-qwen')
models=json.loads((root/'models.lock.json').read_text())['models']
def download(item):
    repo,revision=item
    snapshot_download(repo, revision=revision, local_dir=root/'models'/repo.split('/')[-1], max_workers=4)
with ThreadPoolExecutor(max_workers=2) as pool:
    list(pool.map(download, models.items()))
"""
    run([tts_python, "-c", download])
    environment = {**os.environ, "COMFYRIZZ_QWEN_DEVICE": "cuda:0", "COMFYRIZZ_QWEN_MODELS": str(root / "models"), "PYTHONUNBUFFERED": "1"}
    pkg = root / "package.json"
    out = root / "audio"
    run([tts_python, root / "py/synth.py", "--package", pkg, "--out", out, "--padding", "0.5"], env=environment)
    qa_error = None
    try:
        run([asr_python, root / "py/qa_qwen.py", "--package", pkg, "--out", out], env=environment)
    except subprocess.CalledProcessError as exc:
        qa_error = str(exc)
        (out / "qa-error.json").write_text(json.dumps({"error": qa_error}))
    report = json.loads((out / "durations.json").read_text())
    if report.get("engine") != "qwen3-tts" or report.get("engineFallback"):
        raise RuntimeError("Expected actual Qwen output, never a fallback")
    shutil.copy(root / "models.lock.json", out / "models.lock.json")
    for name, python in [("tts", tts_python), ("asr", asr_python)]:
        with (out / (name + "-environment.txt")).open("w") as f:
            subprocess.run([str(python), "-m", "pip", "freeze"], stdout=f, check=True)
    shutil.make_archive("/content/comfyrizz-qwen-output", "zip", root, "audio")
    if qa_error:
        raise RuntimeError("Narration saved, but alignment/ASR failed: " + qa_error)
    print("COMFYRIZZ_OK qwen-narrate", flush=True)


if __name__ == "__main__":
    main()
