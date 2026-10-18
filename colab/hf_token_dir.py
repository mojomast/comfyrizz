"""Create the VM directories the backend needs before it uploads anything (H13, G4-4).

`colab upload` writes a file into a path that has to exist already and the CLI has no `mkdir`, so
this runs *before* the token upload: `/content/.hf` is created and chmodded 0700, and the token lands
at `/content/.hf/token` - the path `bootstrap.py` reads, and the one the Oct 16 GPU-test scripts
(`g1_setup.py`, `g1_dl_ltx.py`) used. Without it the upload fails on a real VM, which is a failure a
fake that quietly `mkdir -p`-ed the destination could never show.

This script never reads, writes or prints the token; bootstrap.py uploads it, reads it once and
deletes it.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

TOKEN_DIR = Path("/content/.hf")
#: Where the bundle, the model lock and the run's outputs go. The real `colab upload` fails with HTTP
#: 500 when the destination's parent does not exist (G4-4), and the runner needs `out/` to exist from
#: the first job on, so both are created here - before any upload - rather than by the scripts that
#: run later.
BUNDLE_DIR = Path("/content/comfyrizz")
OUT_DIR = BUNDLE_DIR / "out"


def main() -> int:
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(TOKEN_DIR, 0o700)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(TOKEN_DIR.stat().st_mode)
    print(f"vm dirs ready: {TOKEN_DIR} mode {mode:o}, {BUNDLE_DIR} and {OUT_DIR} present", flush=True)
    if mode != 0o700:
        print("the token directory is not 0700; refusing to have the token uploaded into it", file=sys.stderr, flush=True)
        return 1
    return 0


def _run() -> None:
    """Print the sentinel the backend looks for (GPU test 4, G4-6)."""
    try:
        code = main()
    except Exception:  # noqa: BLE001 - colab exec reports a kernel crash as exit 0
        import traceback

        traceback.print_exc()
        print("COMFYRIZZ_FAIL hf-token-dir", flush=True)
        return
    if code != 0:
        print("COMFYRIZZ_FAIL hf-token-dir", flush=True)
        return
    print("COMFYRIZZ_OK hf-token-dir", flush=True)


_run()
