"""Delete the uploaded Hugging Face token from this VM (GPU test 5, G5-13).

bootstrap.py removes the token itself once the models are down, but only if it gets that far. GPU test
5 run 1 died in its first two seconds (G5-1) and left the token sitting on the VM for the whole
session - it was still there when the harness stopped the box. The host cannot delete it (`colab` has
no rm and the token is on the VM's disk), so teardown runs this before `colab stop`.

Never prints the value: the file is unlinked, and what it says is whether it was there.
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

#: The one file this script exists for.
TOKEN = Path("/content/.hf/token")


def main() -> int:
    existed = TOKEN.exists()
    TOKEN.unlink(missing_ok=True)
    gone = not TOKEN.exists()
    print(f"token file removed: {gone} (it was there: {existed})", flush=True)
    return 0 if gone else 1


def _run() -> None:
    """Print the sentinel the backend looks for (GPU test 4, G4-6)."""
    try:
        code = main()
    except (Exception, SystemExit):  # noqa: BLE001 - a kernel cell reports a crash in its output
        traceback.print_exc()
        print("COMFYRIZZ_FAIL drop-token", flush=True)
        return
    if code != 0:
        print("COMFYRIZZ_FAIL drop-token (the token file is still there)", flush=True)
        return
    print("COMFYRIZZ_OK drop-token", flush=True)


_run()
