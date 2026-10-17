"""Comfyrizz Google Colab batch runner (draft; never executed on Google Colab yet).

`colab exec -s comfyrizz-<pkg> -f run_jobs.py --timeout 3600`. Unpacks `jobs.zip` uploaded by
the backend and runs the *same* `pipeline-py` runner that runs locally (SPEC.md 6.4: "the same
runner is used locally and on Google Colab"), against the VM's comfy-api-proxy on loopback.
Progress is the runner's own JSON-lines output, which the backend parses out of the exec log.
"""

from __future__ import annotations

import subprocess
import sys
import zipfile
from pathlib import Path

REMOTE_ROOT = Path("/content/comfyrizz")
BUNDLE = REMOTE_ROOT / "jobs.zip"
PROXY_URL = "http://127.0.0.1:8189"


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
    command = [
        sys.executable,
        "-m",
        "comfyrizz_pipeline.runner",
        "--jobs",
        str(jobs_file),
        "--out",
        str(REMOTE_ROOT / "out"),
        "--progress-log",
        str(REMOTE_ROOT / "out" / "progress.jsonl"),
        "--base-url",
        PROXY_URL,
    ]
    if batch:
        # the backend admits and collects one batch at a time (reserve formula, SPEC 6.6)
        command += ["--batch", batch]
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


if __name__ == "__main__":
    sys.exit(main())
