"""Build (and check) the wheel cache the Google Colab bootstrap installs from (H-fix5).

GPU test 2's setup was 215 s, and 192 s of it was `pip install` (docs/GPU_TEST_2.md, "Other notes":
"pre-built wheels or a cached venv would roughly halve setup"). This is the "pre-built wheels" half:
run it **on a machine with a fast link** (this box, or the user's), keep the result in the runtime
directory that survives a Google Colab restart (Drive), and the VM then installs the pinned list with
`--no-index --find-links` instead of hitting PyPI.

    # on the fast link
    python colab/wheelhouse.py --out /path/to/wheelhouse
    # the VM, before bootstrap.py:
    python colab/bootstrap.py --wheelhouse /content/wheelhouse

Nothing here calls Google Colab, and nothing here installs anything: it downloads wheels for the VM's
platform, hashes them into `manifest.json`, and can re-check that cache later. No secrets, no token.

The speedup is an **estimate** until a real session measures it (the M3 spike); the bootstrap records
per-phase seconds into `ready.json` so the claim gets replaced with a number.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

#: Where the pinned VM package list lives, relative to this file's repository.
DEFAULT_REQUIREMENTS = Path(__file__).resolve().parent / "requirements-vm.txt"
MANIFEST_NAME = "manifest.json"
MANIFEST_VERSION = 1

#: The VM's platform, so the wheels downloaded here are the ones it can install.
DEFAULT_PLATFORM = "manylinux2014_x86_64"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def requirement_names(requirements: Path) -> list[dict[str, str]]:
    """The requirement lines that are real pins, as [{name, spec, line}] (comments/blanks dropped)."""
    entries = []
    for raw in Path(requirements).read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)", line)
        if not match:
            continue
        entries.append({"name": match.group(1).lower(), "spec": line, "line": line})
    return entries


def normalise(name: str) -> str:
    return re.sub(r"[-_.]+", "_", name).lower()


def wheel_package(filename: str) -> str | None:
    """The package a wheel filename belongs to (`foo_bar-1.2-py3-none-any.whl` -> `foo_bar`)."""
    if not filename.endswith(".whl"):
        return None
    parts = filename[:-4].split("-")
    return normalise(parts[0]) if parts and parts[0] else None


def download_command(
    requirements: Path,
    out: Path,
    *,
    python: str | None = None,
    platform: str | None = DEFAULT_PLATFORM,
    python_version: str | None = None,
    only_binary: bool = True,
) -> list[str]:
    """The `pip download` argv. Kept separate so a caller can print it without running it."""
    command = [python or sys.executable, "-m", "pip", "download", "--dest", str(out), "-r", str(requirements)]
    if only_binary:
        command.append("--only-binary=:all:")
    if platform:
        command += ["--platform", platform, "--implementation", "cp", "--abi", "none"]
    if python_version:
        command += ["--python-version", python_version]
    return command


def build(
    requirements: Path = DEFAULT_REQUIREMENTS,
    out: Path = Path("wheelhouse"),
    *,
    python: str | None = None,
    platform: str | None = DEFAULT_PLATFORM,
    python_version: str | None = None,
    dry_run: bool = False,
) -> dict:
    """Download the wheels and write the manifest. `dry_run` prints the command and writes nothing."""
    requirements, out = Path(requirements), Path(out)
    if not requirements.is_file():
        raise SystemExit(f"no requirements file at {requirements}")
    command = download_command(requirements, out, python=python, platform=platform, python_version=python_version)
    if dry_run:
        print("DRY", " ".join(command))
        return {"dry_run": True, "command": command}
    out.mkdir(parents=True, exist_ok=True)
    print("$", " ".join(command), flush=True)
    completed = subprocess.run(command, text=True)
    if completed.returncode != 0:
        raise SystemExit(f"pip download failed with exit {completed.returncode}")
    files = sorted(path for path in out.iterdir() if path.is_file() and path.name != MANIFEST_NAME)
    manifest = {
        "v": MANIFEST_VERSION,
        "requirements": str(requirements),
        "requirements_sha256": sha256_file(requirements),
        "platform": platform,
        "python_version": python_version,
        "requirements_count": len(requirement_names(requirements)),
        "files": [{"name": path.name, "bytes": path.stat().st_size, "sha256": sha256_file(path)} for path in files],
    }
    manifest["total_bytes"] = sum(entry["bytes"] for entry in manifest["files"])
    (out / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wheelhouse: {len(manifest['files'])} wheels, {manifest['total_bytes'] / 1e6:.1f} MB -> {out / MANIFEST_NAME}", flush=True)
    return manifest


def check(wheelhouse: Path, requirements: Path = DEFAULT_REQUIREMENTS) -> dict:
    """Is this cache complete and unchanged? Reports missing/extra/corrupt files and unpinned packages."""
    wheelhouse = Path(wheelhouse)
    manifest_path = wheelhouse / MANIFEST_NAME
    if not manifest_path.is_file():
        raise SystemExit(f"no {MANIFEST_NAME} in {wheelhouse}: build it with colab/wheelhouse.py --out {wheelhouse}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    problems: list[str] = []
    present = {entry["name"] for entry in manifest.get("files", [])}
    for entry in manifest.get("files", []):
        path = wheelhouse / entry["name"]
        if not path.is_file():
            problems.append(f"missing {entry['name']}")
            continue
        actual = sha256_file(path)
        if actual != entry["sha256"]:
            problems.append(f"{entry['name']} changed since the manifest (sha256 {actual[:12]} != {entry['sha256'][:12]})")
    expected = [normalise(entry["name"]) for entry in requirement_names(Path(requirements))]
    have = {name for name in (wheel_package(filename) for filename in present) if name}
    missing = sorted(set(expected) - have)
    if missing:
        problems.append(f"no wheel for {', '.join(missing)}")
    return {
        "ok": not problems,
        "wheelhouse": str(wheelhouse),
        "wheels": len(present),
        "requirements": len(expected),
        "total_bytes": sum(entry["bytes"] for entry in manifest.get("files", [])),
        "problems": problems,
        "requirements_sha256_matches": manifest.get("requirements_sha256") == sha256_file(Path(requirements))
        if Path(requirements).is_file()
        else False,
    }


def install_command(requirements: Path, wheelhouse: Path | None, *, offline: bool = False) -> str:
    """The `pip install` command the bootstrap should run.

    With a wheelhouse, pip is pointed at it first (`--find-links`) and still allowed the index, so a
    package the cache missed is fetched rather than failing the session; `offline` adds `--no-index`,
    which is the true "cached session" mode and must be paired with a `check()` that passed.
    """
    base = f"pip install -q -r {requirements}"
    if wheelhouse is None:
        return base
    command = f"{base} --find-links {wheelhouse}"
    return f"{command} --no-index" if offline else command


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="colab.wheelhouse", description="build/check the Google Colab wheel cache")
    parser.add_argument("--out", default="wheelhouse", help="where the wheels and manifest.json go")
    parser.add_argument("--requirements", default=str(DEFAULT_REQUIREMENTS))
    parser.add_argument("--python", default=None, help="interpreter to run pip with (default: this one)")
    parser.add_argument("--platform", default=DEFAULT_PLATFORM, help="wheel platform tag (empty for the host's own)")
    parser.add_argument("--python-version", default=None, help="wheel python tag, e.g. 3.12")
    parser.add_argument("--check", action="store_true", help="only verify an existing cache")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if args.check:
        report = check(Path(args.out), Path(args.requirements))
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print(f"wheelhouse: {'ok' if report['ok'] else 'NOT ok'} ({report['wheels']} wheels, {report['total_bytes'] / 1e6:.1f} MB)")
            for problem in report["problems"]:
                print(f"  {problem}")
        return 0 if report["ok"] else 1

    manifest = build(
        Path(args.requirements),
        Path(args.out),
        python=args.python,
        platform=args.platform or None,
        python_version=args.python_version,
        dry_run=args.dry_run,
    )
    if args.json:
        print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
