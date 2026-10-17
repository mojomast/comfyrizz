"""Comfyrizz Google Colab bootstrap (draft; never executed on Google Colab yet).

Run with `colab exec -s comfyrizz-<pkg> -f bootstrap.py --timeout 900` after the backend has
uploaded the Hugging Face token as a 0600 file (SPEC.md 6.7.2 step 4). Add
`--wheelhouse /content/wheelhouse` when the pre-built wheels are on the VM (colab/wheelhouse.py);
`--offline` then refuses PyPI entirely. Steps:

1. clone the pinned ComfyUI and install its requirements (torch is preinstalled on the G4 image;
   measured in GPU test 1: clone 1.0 s, requirements 24.8 s — GPU test 2's 192 s is the number the
   wheelhouse exists to cut, and this step now records its own seconds into ready.json);
2. read the token from /content/.hf/token (0600), never from `--env`, never printed;
3. download the pinned model files in parallel with `hf download` (519 MB/s measured), printing
   progress so the CLI's quiet-period timeout does not fire;
4. merge the sharded Qwen3-VL text encoder, symlink the model files into ComfyUI/models;
5. start ComfyUI on 127.0.0.1:8188 and comfy-api-proxy on 127.0.0.1:8189 with
   `Popen(start_new_session=True)` (background processes survive between execs — verified);
6. write /content/comfyrizz/out/ready.json with versions, node types and free VRAM.

Adapted from Kyle's `colab/g1_setup.py` (GPU test 1) and the Oct 16 test scripts s2–s4. The model
files and revisions are pinned in `colab/models.lock.json` (H7, GPU test 3): this script reads that
file - it has no list of its own - and passes `hf download --revision`, so a session downloads the
same bytes the timings were measured on. The backend uploads the lock next to the token.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # so `import wheelhouse` works from /content/colab

from wheelhouse import install_command  # noqa: E402 - a sibling module, imported after the path fix

ROOT = Path("/content")
COMFY = ROOT / "ComfyUI"
OUT = Path("/content/comfyrizz/out")
TOKEN = Path("/content/.hf/token")
PROXY_PORT = 8189
COMFY_PORT = 8188
PROXY_PY = ROOT / "comfy-api-proxy"
#: Where the pinned model list is uploaded to (the backend sends `colab/models.lock.json`).
LOCK_PATH = Path("/content/comfyrizz/models.lock.json")

#: Pinned by the M3 spike; the versions below are the ones GPU test 1 used.
COMFYUI_REF = os.environ.get("COMFYRIZZ_COMFYUI_REF", "master")


def load_lock(path: Path) -> dict:
    """Read the model pin (`colab/models.lock.json`).

    One source of truth: this file says which repos and files to download, which revision, and
    where each one has to land in `ComfyUI/models`. There is deliberately no second list in this
    script - a second list is a second thing to drift, and a drifted model file fails on the GPU
    after the session has been billed.
    """
    path = Path(path)
    if not path.is_file():
        raise SystemExit(
            f"no model lock at {path}: upload colab/models.lock.json there before bootstrapping "
            "(the backend does it for you; see packages/backends/src/colab-backend.mjs)"
        )
    lock = json.loads(path.read_text(encoding="utf-8"))
    if lock.get("v") != 1:
        raise SystemExit(f"{path} is not a comfyrizz.models.lock/v1 document (v={lock.get('v')!r})")
    for field in ("hosts", "files"):
        if not lock.get(field):
            raise SystemExit(f"{path} has no {field!r}: nothing to download")
    hosts = lock["hosts"]
    for entry in lock["files"]:
        if entry.get("host") not in hosts:
            raise SystemExit(f"{path}: {entry.get('path')!r} names host {entry.get('host')!r}, which is not declared")
        if not entry.get("path"):
            raise SystemExit(f"{path}: a file entry has no path")
    for merge in lock.get("merge", []):
        if merge.get("host") not in hosts:
            raise SystemExit(f"{path}: merge {merge.get('id')!r} names an undeclared host")
    return lock


def model_plan(lock: dict) -> dict[str, tuple[str, list[str]]]:
    """`{host: (repo, [file, ...])}` - what `hf download` is asked for, per host."""
    plan: dict[str, list[str]] = {name: [] for name in lock["hosts"]}
    for entry in lock["files"]:
        plan[entry["host"]].append(entry["path"])
    return {name: (lock["hosts"][name]["repo"], files) for name, files in plan.items() if files}


def link_plan(lock: dict) -> dict[str, str]:
    """`{local file: path under ComfyUI/models}` - what has to be importable by a graph.

    Merge outputs are not in here: `main` writes those into `ComfyUI/models` itself, so a link
    would point a file at itself.
    """
    links: dict[str, str] = {}
    for entry in lock["files"]:
        if entry.get("target"):
            links[f"{lock['hosts'][entry['host']]['localDir']}/{entry['path']}"] = entry["target"]
    return links


def merge_plan(lock: dict) -> list[dict]:
    """The shard merges (a gated repo that ships its text encoder in pieces)."""
    return list(lock.get("merge", []))


def run(command: str, tag: str = "") -> int:
    print(f"$ {tag or command[:120]}", flush=True)
    started = time.time()
    process = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert process.stdout is not None
    for number, line in enumerate(process.stdout, start=1):
        if number % 40 == 0 or "rror" in line:
            print("  ", line.rstrip()[:200], flush=True)
    process.wait()
    print(f"-> {tag} exit {process.returncode} in {time.time() - started:.1f}s", flush=True)
    return process.returncode


def read_token() -> str:
    """Read the uploaded 0600 file once. The value is never printed and never an argument."""
    if not TOKEN.is_file():
        raise SystemExit("no /content/.hf/token: upload it before bootstrapping (never via --env)")
    os.chmod(TOKEN.parent, 0o700)
    os.chmod(TOKEN, 0o600)
    value = TOKEN.read_text().strip()
    if not value:
        raise SystemExit("the uploaded token file is empty")
    return value


def download_models(token: str, plan: dict[str, tuple[str, list[str]]], lock: dict) -> dict:
    env = dict(os.environ)
    env["HF_TOKEN"] = token
    env["HF_XET_HIGH_PERFORMANCE"] = "1"
    env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    results = {}
    for name, (repo, files) in plan.items():
        host = lock["hosts"][name]
        started = time.time()
        revision = host.get("revision")
        command = ["hf", "download", repo, *files, "--local-dir", host["localDir"]]
        if revision:
            # the pin: `hf download --revision` also writes the resolved revision into the local
            # cache, so a re-run cannot quietly pick up a newer file under the same name
            command += ["--revision", revision]
        process = subprocess.run(command, capture_output=True, text=True, env=env)
        results[name] = {
            "repo": repo,
            "revision": revision,
            "files": len(files),
            "rc": process.returncode,
            "seconds": round(time.time() - started, 1),
            "error": process.stderr[-400:] if process.returncode else "",
        }
        print(f"DOWNLOAD {name} {json.dumps(results[name])}", flush=True)
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="colab.bootstrap", description="prepare a Google Colab VM for Comfyrizz")
    parser.add_argument(
        "--wheelhouse",
        default=os.environ.get("COMFYRIZZ_WHEELHOUSE") or None,
        help="directory of pre-downloaded wheels (colab/wheelhouse.py); installed with --find-links",
    )
    parser.add_argument("--offline", action="store_true", help="install with --no-index: the wheelhouse must be complete")
    parser.add_argument(
        "--lock",
        default=os.environ.get("COMFYRIZZ_MODELS_LOCK") or str(LOCK_PATH),
        help="the model pin (colab/models.lock.json): repos, revisions, files and their ComfyUI targets",
    )
    args = parser.parse_args(argv)
    wheelhouse = Path(args.wheelhouse) if args.wheelhouse else None
    lock = load_lock(Path(args.lock))
    plan = model_plan(lock)
    links = link_plan(lock)
    merges = merge_plan(lock)
    print(f"LOCK {args.lock}: {sum(len(files) for _, files in plan.values())} files from {len(plan)} repos", flush=True)

    OUT.mkdir(parents=True, exist_ok=True)
    if run(f"cd {ROOT} && rm -rf ComfyUI && git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI.git && cd ComfyUI && git checkout -q {COMFYUI_REF} && git log -1 --format='%h %cd'", "clone") != 0:
        raise SystemExit("cloning ComfyUI failed")

    # The install step GPU test 2 spent 192 s on. With a wheelhouse, pip reads the wheels from that
    # directory first; `--offline` refuses the index altogether. Whatever happens, the seconds are
    # recorded, so "a cache halves setup" becomes a measurement instead of a hope.
    requirements = Path("/tmp/req.txt")
    if run(f"cd {COMFY} && grep -viE '^(torch|torchvision|torchaudio)([<>=~ ]|$)' requirements.txt > {requirements} && grep -q . {requirements}", "requirements-list") != 0:
        raise SystemExit("writing the requirements list failed")
    install = {
        "requirements": str(requirements),
        "wheelhouse": str(wheelhouse) if wheelhouse else None,
        "offline": bool(args.offline),
        "command": install_command(requirements, wheelhouse, offline=args.offline),
    }
    if wheelhouse and not (wheelhouse / "manifest.json").is_file():
        raise SystemExit(f"{wheelhouse} has no manifest.json: build it with colab/wheelhouse.py, or drop --wheelhouse")
    started = time.time()
    if run(f"cd {COMFY} && {install['command']} 'huggingface_hub[hf_xet]>=1.0' safetensors", "requirements") != 0:
        raise SystemExit("installing ComfyUI requirements failed")
    install["seconds"] = round(time.time() - started, 1)
    print(f"INSTALL {json.dumps(install)}", flush=True)
    if subprocess.run(f"cd {ROOT} && git clone -q --depth 1 https://github.com/Comfy-Org/comfy-api-proxy.git", shell=True).returncode != 0:
        raise SystemExit("cloning comfy-api-proxy failed")

    token = read_token()
    download = download_models(token, plan, lock)
    # the token is used and then removed; it is never exported to ComfyUI or to a node
    TOKEN.unlink(missing_ok=True)
    print("token file removed:", not TOKEN.exists(), flush=True)

    # merge the sharded text encoders the lock declares (GPU test 1: two shards -> one file)
    from safetensors.torch import load_file, save_file  # noqa: PLC0415 - only present on the VM

    for merge in merges:
        host = lock["hosts"][merge["host"]]
        shards = sorted(Path(host["localDir"]).glob(f"{Path(merge['shards'][0]).parent}/*.safetensors"))
        expected = {name.rsplit("/", 1)[-1] for name in merge["shards"]}
        if {shard.name for shard in shards} != expected:
            raise SystemExit(f"{merge['id']}: expected shards {sorted(expected)}, found {[shard.name for shard in shards]}")
        merged = {}
        for shard in shards:
            merged.update(load_file(shard))
        target = COMFY / "models" / merge["target"]
        target.parent.mkdir(parents=True, exist_ok=True)
        save_file(merged, target)
        print(f"merged {merge['id']}: {len(merged)} tensors -> {target}", flush=True)
        del merged
        for shard in shards:
            shard.unlink()

    for source, relative in links.items():
        destination = COMFY / "models" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_symlink() or destination.exists():
            destination.unlink()
        os.symlink(source, destination)

    # background processes persist between execs (verified Oct 16), so start both detached
    comfy_log = open("/content/comfyui.log", "w")  # noqa: SIM115 - intentionally kept open for the process
    subprocess.Popen(
        [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", str(COMFY_PORT)],
        cwd=str(COMFY),
        stdout=comfy_log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    proxy_log = open("/content/proxy.log", "w")  # noqa: SIM115
    subprocess.Popen(
        [sys.executable, "-m", "comfy_api_proxy", "--comfyui", f"http://127.0.0.1:{COMFY_PORT}", "--port", str(PROXY_PORT)],
        cwd=str(PROXY_PY),
        stdout=proxy_log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    ready = {
        "ok": False,
        "comfyui": None,
        "proxy": None,
        "downloads": download,
        "install": install,
        "lock": {
            "path": str(args.lock),
            "revisions": {name: host.get("revision") for name, host in lock["hosts"].items()},
            "files": sum(len(files) for _, files in plan.values()),
        },
        "at": time.time(),
    }
    import urllib.request  # noqa: PLC0415

    for _ in range(60):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{COMFY_PORT}/system_stats", timeout=2) as response:  # noqa: S310 - loopback
                stats = json.load(response)
            ready["comfyui"] = stats.get("system", {}).get("comfyui_version")
            break
        except Exception:  # noqa: BLE001 - retry until ready
            time.sleep(2)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PROXY_PORT}/api/v2/jobs?limit=1", timeout=3) as response:  # noqa: S310 - loopback
            ready["proxy"] = response.status
    except Exception as error:  # noqa: BLE001
        ready["proxy_error"] = str(error)
    ready["ok"] = bool(ready["comfyui"]) and ready["proxy"] == 200
    (OUT / "ready.json").write_text(json.dumps(ready, indent=2))
    print("READY", json.dumps(ready), flush=True)
    return 0 if ready["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
