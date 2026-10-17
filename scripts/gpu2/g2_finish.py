#!/usr/bin/env python3
"""End-of-session collection for a Google Colab GPU run (scripts/gpu2/g2_finish.py).

This is the step that was meant to run at the end of GPU test 2 and did not: it was invoked with a
wrong `-f` path, so the CLI never loaded it and the session ended without collecting its logs
(docs/GPU_TEST_2.md, "Other notes": "never ran because of a wrong -f path. That did not matter: the
token was already gone and the VM was destroyed on stop"). The old version also hid every failure
behind `2>/dev/null`, which is why a miss was silent. Both are fixed here:

* the paths are arguments with `/content` defaults, so nothing depends on the caller's idea of where
  the file is - `python /content/g2_finish.py` and
  `colab exec -s <session> -f /content/comfyrizz/scripts/gpu2/g2_finish.py` both work, and
  `scripts/gpu2/g2_finish.sh` resolves the path for you;
* every step is checked and reported: the token directory must be gone (a token left on the VM is a
  failure, not a note), the collected directory must exist, missing logs are named rather than
  swallowed, and the tarball is verified after it is written.

No secrets are read or printed here: it only reports whether the token file still exists.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import tarfile
from pathlib import Path

#: What a session leaves behind that is worth collecting, and whether its absence fails the run.
ARTIFACTS = (
    ("comfy.log", False),
    ("comfyui.log", False),
    ("proxy.log", False),
    ("setup_times.json", False),
    ("results.json", True),
)
TOKEN_DIR = ".hf"
TARBALL = "out.tgz"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="g2_finish", description="collect a Google Colab run's outputs and logs")
    parser.add_argument("--content", default="/content", help="the VM's content root (default /content)")
    parser.add_argument("--out", default=None, help="the directory to collect and tar (default <content>/out)")
    parser.add_argument("--runner-out", default=None, help="also copy this directory in as out/hermes_runner")
    parser.add_argument("--tarball", default=None, help="where the tar goes (default <content>/out.tgz)")
    parser.add_argument("--dry-run", action="store_true", help="report what would be collected, change nothing")
    args = parser.parse_args(argv)

    content = Path(args.content)
    out = Path(args.out) if args.out else content / "out"
    runner_out = Path(args.runner_out) if args.runner_out else content / "comfyrizz" / "out"
    tarball = Path(args.tarball) if args.tarball else content / TARBALL
    problems: list[str] = []
    copied: list[str] = []
    missing: list[str] = []

    # 1. the token must be gone: a live token file on a stopped VM is a failure, not a footnote
    token_dir = content / TOKEN_DIR
    token_file = token_dir / "token"
    if token_file.exists():
        problems.append(f"the Hugging Face token file is still on disk at {token_file} - delete it before collecting")
    print(
        f"token dir present: {token_dir.exists()} | HF_TOKEN in env: {'HF_TOKEN' in os.environ} | "
        f"hf cache token: {(Path.home() / '.cache/huggingface/token').exists()}",
        flush=True,
    )

    # 2. the collected directory has to exist, or there is nothing to hand back
    if not out.is_dir():
        problems.append(f"no output directory at {out}: the run collected nothing (wrong --out?)")
    elif args.dry_run:
        print(f"DRY would tar {out} -> {tarball}", flush=True)
    else:
        for name, required in ARTIFACTS:
            source = content / name
            if source.is_file():
                shutil.copy2(source, out / name)
                copied.append(name)
            elif required:
                missing.append(name)
                problems.append(f"{name} is missing from {content}: the run left no {name} to collect")
            else:
                missing.append(f"{name} (optional)")
        if runner_out.is_dir():
            shutil.copytree(runner_out, out / "hermes_runner", dirs_exist_ok=True)
            copied.append("hermes_runner/")

    if not args.dry_run and out.is_dir():
        with tarfile.open(tarball, "w:gz") as archive:
            archive.add(out, arcname="out")
        if not tarball.is_file() or tarball.stat().st_size == 0:
            problems.append(f"the tarball at {tarball} is missing or empty")
        else:
            print(f"tarball: {tarball} {tarball.stat().st_size} bytes sha256 {sha256_file(tarball)[:16]}", flush=True)

    print(f"copied: {', '.join(copied) if copied else 'nothing'}", flush=True)
    if missing:
        print(f"not present: {', '.join(missing)}", flush=True)
    for problem in problems:
        print(f"PROBLEM {problem}", flush=True)
    # a dry run is a report, not a contract: only a real run fails on problems
    return 0 if (args.dry_run or not problems) else 1


if __name__ == "__main__":
    sys.exit(main())
