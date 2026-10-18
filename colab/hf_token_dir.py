"""Create the 0700 directory the Hugging Face token is uploaded into (H13).

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


def main() -> int:
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(TOKEN_DIR, 0o700)
    mode = stat.S_IMODE(TOKEN_DIR.stat().st_mode)
    print(f"hf token dir {TOKEN_DIR} mode {mode:o}", flush=True)
    if mode != 0o700:
        print("the token directory is not 0700; refusing to have the token uploaded into it", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
