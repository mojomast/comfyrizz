"""Add the runner and the schemas to a jobs bundle (GPU test 5, G5-5).

`createBundle` zips jobs.json, the workflows and the work directory, and the VM then runs
`python -m comfyrizz_pipeline.runner` from the unpacked bundle. Nothing used to put that package there,
so the runner step could not even import - and `comfyrizz_pipeline/schema.py` validates jobs.json
against `packages/schema/*-v1.schema.json`, which has to be on the VM for the same reason.

This is a host-side script (like `colab/wheelhouse.py`), not an exec'd one: it runs on the machine
that builds the bundle, so it may take arguments and read the repo directly.
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

#: The package the VM imports: everything under `pipeline-py/comfyrizz_pipeline`.
RUNNER_PACKAGE = Path("pipeline-py") / "comfyrizz_pipeline"

#: Where the schemas live in the repo, and where `schema.py` looks for them on the VM.
SCHEMA_DIR = Path("packages") / "schema"


def additions(repo: Path) -> list[tuple[Path, str]]:
    """The (local file, name inside the zip) pairs this script adds."""
    pairs: list[tuple[Path, str]] = []
    runner = repo / RUNNER_PACKAGE
    if not runner.is_dir():
        raise SystemExit(f"{runner} is not a directory: is --repo the Comfyrizz checkout?")
    for path in sorted(runner.glob("*.py")):
        pairs.append((path, f"comfyrizz_pipeline/{path.name}"))
    schemas = sorted((repo / SCHEMA_DIR).glob("*-v1.schema.json"))
    if not schemas:
        raise SystemExit(f"no *-v1.schema.json under {repo / SCHEMA_DIR}")
    for path in schemas:
        pairs.append((path, f"packages/schema/{path.name}"))
    return pairs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="colab.zip_bundle", description="add the runner and the schemas to a jobs bundle")
    parser.add_argument("--bundle", required=True, help="the jobs.zip createBundle just built")
    parser.add_argument("--repo", required=True, help="the Comfyrizz checkout to take them from")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(str.split(argv) if isinstance(argv, str) else argv)

    bundle = Path(args.bundle)
    repo = Path(args.repo).resolve()
    if not bundle.is_file():
        raise SystemExit(f"{bundle} is not there: build the bundle first")

    pairs = additions(repo)
    with zipfile.ZipFile(bundle, "a", zipfile.ZIP_DEFLATED) as archive:
        for source, name in pairs:
            archive.write(source, name)

    names = {name for _, name in pairs}
    with zipfile.ZipFile(bundle) as archive:
        present = set(archive.namelist())
    missing = sorted(name for name in names if name not in present)
    if missing:
        raise SystemExit(f"the bundle is still missing {missing}")
    if not args.quiet:
        modules = sum(1 for name in names if name.startswith("comfyrizz_pipeline/"))
        print(f"bundle {bundle}: added {modules} runner modules and {len(names) - modules} schemas")
    return 0


if __name__ == "__main__":
    sys.exit(main())
