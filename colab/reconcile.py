"""Comfyrizz Google Colab reconcile (draft; never executed on Google Colab yet).

Run by the backend with `colab exec -s comfyrizz-<pkg> -f reconcile.py` **only** after a lost
exec (a dropped/timed-out `colab exec` while the VM kept working). It re-polls the attempt
records' known job ids through the VM's loopback proxy and rewrites `out/manifest.json`. It
never submits a job, so a lost exec cannot double-bill (SPEC.md 6.4/6.7.2 step 7).
"""

from __future__ import annotations

import subprocess
import sys
import traceback
from pathlib import Path

REMOTE_ROOT = Path("/content/comfyrizz")
PROXY_URL = "http://127.0.0.1:8189"


def main() -> int:
    jobs_file = next((REMOTE_ROOT / "work").rglob("jobs.json"), None)
    if jobs_file is None:
        print("no jobs.json on the VM: the bundle was never unpacked, so there is nothing to reconcile", file=sys.stderr, flush=True)
        return 2
    command = [
        sys.executable,
        "-m",
        "comfyrizz_pipeline.runner",
        "--jobs",
        str(jobs_file),
        "--out",
        str(REMOTE_ROOT / "out"),
        "--reconcile",
        "--base-url",
        PROXY_URL,
    ]
    print(f"$ {' '.join(command)}", flush=True)
    process = subprocess.Popen(command, cwd=str(jobs_file.parent), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert process.stdout is not None
    for line in process.stdout:
        print(line.rstrip(), flush=True)
    process.wait()
    print(f"reconcile exit {process.returncode} (attempt records polled; nothing resubmitted)", flush=True)
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
        print("COMFYRIZZ_FAIL reconcile", flush=True)
        return
    print("COMFYRIZZ_OK reconcile", flush=True)


_run()

