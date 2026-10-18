"""List the run's output tree as JSON lines, so the backend can fetch it one file at a time (H13).

The real `colab download` fetches a single file: it cannot pull a directory. The backend used to ask
it for `/content/comfyrizz/out`, which would have failed on a real VM (the fake CLI copied the whole
directory, so no test noticed). So collection is now two steps: this script prints what is there,

    {"path": "assets/a_still.png", "bytes": 12345}

one line per file, and the backend downloads each file by its own path.

Nothing here reads the manifest or decides anything: it is a listing, and the manifest stays the
authority on what a run produced (SPEC.md 6.4).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

OUT_ROOT = Path(os.environ.get("COMFYRIZZ_OUT", "/content/comfyrizz/out"))


def main() -> int:
    if not OUT_ROOT.is_dir():
        print(f"no output directory yet at {OUT_ROOT}", file=sys.stderr, flush=True)
        return 2
    count = 0
    for path in sorted(OUT_ROOT.rglob("*")):
        if path.is_dir() or path.is_symlink():
            continue
        relative = path.relative_to(OUT_ROOT).as_posix()
        info = path.stat()
        # G5-14: the host collects the tree after every batch, and re-downloading the files that did
        # not change is billed time (about 45 s of the GPU test 5 run). Size and mtime are what make
        # "the copy I already have is this file" checkable.
        print(json.dumps({"path": relative, "bytes": info.st_size, "mtime": round(info.st_mtime, 3)}), flush=True)
        count += 1
    print(f"{count} files under {OUT_ROOT}", file=sys.stderr, flush=True)
    return 0


def _run() -> None:
    """Print the listing, then the sentinel the backend looks for (GPU test 4, G4-6).

    The sentinel is a plain line, never a JSON object, so the backend's JSON-lines parser skips it.
    """
    try:
        main()
    except Exception:  # noqa: BLE001 - colab exec reports a kernel crash as exit 0
        import traceback

        traceback.print_exc()
        print("COMFYRIZZ_FAIL list-out", flush=True)
        return
    print("COMFYRIZZ_OK list-out", flush=True)


_run()
