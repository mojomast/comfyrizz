"""Comfyrizz Google Colab batch runner (draft; never executed on Google Colab yet).

`colab exec -s comfyrizz-<pkg> -f run_jobs.py --timeout 3600`. Unpacks `jobs.zip` uploaded by
the backend and runs the *same* `pipeline-py` runner that runs locally (SPEC.md 6.4: "the same
runner is used locally and on Google Colab"), against the VM's comfy-api-proxy on loopback.
Progress is the runner's own JSON-lines output, which the backend parses out of the exec log.
"""

from __future__ import annotations

import os
import subprocess
import sys
import traceback
import zipfile
from pathlib import Path

REMOTE_ROOT = Path("/content/comfyrizz")
BUNDLE = REMOTE_ROOT / "jobs.zip"
#: The runner talks to the v2 proxy (SPEC.md 5.1) but ComfyUI's own upload route is *not*
#: forwarded by it (GPU test 3: five jobs failed with `upload_unsupported`). So the two ports
#: are named separately here, exactly as `bootstrap.py` starts them, and ComfyUI's origin is
#: declared to the runner — the VM's uploads must not depend on a flag somebody remembers.
PROXY_URL = "http://127.0.0.1:8189"
COMFY_PORT = int(os.environ.get("COMFYRIZZ_COMFY_PORT") or 8188)
COMFYUI_URL = f"http://127.0.0.1:{COMFY_PORT}"


def runner_command(jobs_file: Path, out_dir: Path, batch: str = "") -> list[str]:
    """The argv the VM's runner is started with (one place, so a test can read it).

    `--base-url` is the v2 proxy (jobs, results, assets) and `--comfyui-url` is ComfyUI itself
    (input files): the proxy does not forward `/upload/image`, which is what failed 5 of 10 jobs
    on the GPU test 3 run before somebody added the flag by hand.
    """
    command = [
        sys.executable,
        "-m",
        "comfyrizz_pipeline.runner",
        "--jobs",
        str(jobs_file),
        "--out",
        str(out_dir),
        "--progress-log",
        str(Path(out_dir) / "progress.jsonl"),
        "--base-url",
        PROXY_URL,
        "--comfyui-url",
        COMFYUI_URL,
    ]
    if batch:
        # the backend admits and collects one batch at a time (reserve formula, SPEC 6.6)
        command += ["--batch", batch]
    return command


def main() -> int:
    if not BUNDLE.is_file():
        print(f"no bundle at {BUNDLE}: the backend must upload jobs.zip first", file=sys.stderr, flush=True)
        return 2
    workdir = REMOTE_ROOT / "work"
    workdir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(BUNDLE) as archive:
        archive.extractall(workdir)

    jobs_file = next(workdir.rglob("jobs.json"), None)
    if jobs_file is None:
        print("jobs.json is not in the bundle", file=sys.stderr, flush=True)
        return 2

    selector = REMOTE_ROOT / "batch.txt"
    batch = selector.read_text(encoding="utf-8").strip() if selector.is_file() else ""
    command = runner_command(jobs_file, REMOTE_ROOT / "out", batch)
    if batch:
        print(f"$ batch selector: {batch}", flush=True)
    print(f"$ {' '.join(command)}", flush=True)
    process = subprocess.Popen(command, cwd=str(workdir), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert process.stdout is not None
    for line in process.stdout:
        print(line.rstrip(), flush=True)
    process.wait()
    print(f"runner exit {process.returncode}", flush=True)
    # The exit code is not the verdict: the backend downloads out/manifest.json and lets it decide.
    return 0


def _run() -> None:
    """Run main() and print the sentinel the backend looks for (GPU test 4, G4-6).

    `colab exec` runs this file as a kernel cell: a crash prints a traceback and the CLI still exits
    0, so the backend needs this positive line - and for the runner the manifest stays the verdict.
    """
    try:
        _ = main()
    except Exception:  # noqa: BLE001 - the traceback is the evidence
        traceback.print_exc()
        print("COMFYRIZZ_FAIL run", flush=True)
        return
    print("COMFYRIZZ_OK run", flush=True)


_run()

