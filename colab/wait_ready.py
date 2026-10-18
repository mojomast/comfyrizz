"""Wait for a bootstrap that lost its CLI to finish on its own (GPU test 5, G5-3).

`colab exec` runs a file as a kernel cell, and killing the CLI does not kill the cell: the VM keeps
downloading models, starting ComfyUI and starting the proxy after the host has given up on the exec.
GPU test 5 run 2 lost the bootstrap to the 60 s silence timeout exactly that way, and the session was
torn down with 130 s of downloads still running in it.

So a lost bootstrap is not a verdict - it is an unanswered question, and `out/ready.json` is the
answer bootstrap.py writes when it has one. This script waits for it.

Prints `READY {json}` once the file parses and the sentinel last, like every script the backend execs.
Never takes arguments: the kernel's argv is not ours (G5-1).
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path

#: Where bootstrap.py records its verdict.
READY = Path("/content/comfyrizz/out/ready.json")

#: How long to keep waiting. GPU test 5's bootstrap took 237 s end to end, of which the last step is
#: the ComfyUI and proxy start; the default leaves room for a slow model download on top of that.
WAIT_SECONDS = int(os.environ.get("COMFYRIZZ_READY_WAIT_SECONDS", "600"))

#: How often to look, and to say so: the host's silence timeout counts the *step's* silence, and this
#: step can legitimately sit here for minutes.
POLL_SECONDS = 15


def main() -> int:
    started = time.time()
    deadline = started + WAIT_SECONDS
    while True:
        try:
            ready = json.loads(READY.read_text())
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            ready = None
        if isinstance(ready, dict):
            print(f"READY {json.dumps(ready)}", flush=True)
            if ready.get("ok") is True:
                return 0
            print(f"ready.json says the box is not ready: {json.dumps(ready)}", file=sys.stderr, flush=True)
            return 1
        if time.time() >= deadline:
            print(f"no ready.json after {WAIT_SECONDS}s", file=sys.stderr, flush=True)
            return 1
        print(f"WAITING ready.json {time.time() - started:.0f}s", flush=True)
        time.sleep(POLL_SECONDS)


def _run() -> None:
    """Run main() and print the sentinel the backend looks for (GPU test 4, G4-6).

    A crash in the kernel cell does not set the CLI's exit code, so the host reads this line: OK only
    when ready.json is there *and* ok, FAIL for everything else.
    """
    try:
        code = main()
    except (Exception, SystemExit):  # noqa: BLE001 - SystemExit is how a refusal shows up too
        traceback.print_exc()
        print("COMFYRIZZ_FAIL wait-ready", flush=True)
        return
    if code != 0:
        print("COMFYRIZZ_FAIL wait-ready (ready.json did not report a ready box)", flush=True)
        return
    print("COMFYRIZZ_OK wait-ready", flush=True)


_run()
