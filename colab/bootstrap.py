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
import hashlib
import concurrent.futures
import json
import os
import subprocess
import shlex
import threading
import sys
import time
import traceback
from pathlib import Path


#: How often `_run` tells the host it is alive (GPU test 5, G5-2).
#:
#: `ColabCli.run` kills a child that has printed nothing for 60 s (its `silenceMs` default), and
#: bootstrap is silent by nature: `pip -q` prints nothing, and `hf download` used to be a
#: `subprocess.run(capture_output=True)`, so the LTX download - 117 s of the 237 s the step takes -
#: tripped it. The CLI was SIGTERMed 130 s in and the session was thrown away with the work in it.
HEARTBEAT_SECONDS = 20

#: How often a model download reports its progress. Well under HEARTBEAT_SECONDS' own margin, because
#: a download that is quiet for a minute is indistinguishable from a hung one.
DOWNLOAD_PROGRESS_SECONDS = 15


def classify_download_stderr(stderr: str, returncode: int) -> dict:
    """Turn a failed `hf download` into a structured failure (PB01).

    The host must see the actionable network/status cause, not a later missing-file
    exception from hash verification. No network I/O here — tests pass synthetic stderr.
    """
    text = str(stderr or "")
    lower = text.lower()
    status = None
    retry_after = None
    if "429" in text or "too many requests" in lower:
        status = 429
    elif "401" in text or "unauthorized" in lower:
        status = 401
    elif "403" in text or "forbidden" in lower or "access denied" in lower:
        status = 403
    elif "404" in text or "not found" in lower:
        status = 404
    # Retry-After: N (seconds) when present
    import re as _re
    match = _re.search(r"retry[- ]after[:\s]+(\d+)", text, flags=_re.IGNORECASE)
    if match:
        retry_after = int(match.group(1))
    kind = {
        429: "rate_limited",
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
    }.get(status, "download_failed" if returncode else "ok")
    return {
        "kind": kind,
        "status": status,
        "retryAfterSeconds": retry_after,
        "returncode": returncode,
        "detail": text[-400:],
    }


def require_successful_downloads(results: dict) -> None:
    """Refuse bootstrap before hash verification when any host download failed (PB01).

    Raises SystemExit with a single-line JSON payload the host log can surface. Does not
    open weight files — incomplete downloads must not become FileNotFoundError here.
    """
    failures = []
    for name, entry in (results or {}).items():
        rc = int(entry.get("rc") or 0)
        if rc == 0:
            continue
        classified = classify_download_stderr(entry.get("error") or "", rc)
        failures.append(
            {
                "host": name,
                "repo": entry.get("repo"),
                "revision": entry.get("revision"),
                "files": entry.get("files"),
                **classified,
            }
        )
    if not failures:
        return
    payload = {
        "error": "model_download_failed",
        "message": "one or more Hugging Face model downloads failed before weight verification",
        "failures": failures,
    }
    raise SystemExit(json.dumps(payload, separators=(",", ":")))



#: The Python packages Comfyrizz adds on top of ComfyUI's own requirements (GPU test 5, G5-4).
#:
#: GPU test 5 found the VM without any of them: `pip` installed ComfyUI's requirements,
#: huggingface_hub and safetensors, and then started the proxy from a git checkout - and
#: `comfy-api-proxy` has a `src/` layout with no `__main__.py`, so `python -m comfy_api_proxy` cannot
#: import at all. `colab/requirements-vm.txt` is the same list for the wheelhouse; a test in
#: `packages/backends/test/h16-gpu5.test.mjs` fails if the two drift apart.
VM_EXTRAS = (
    "huggingface_hub[hf_xet]>=1.0",
    "safetensors",
    "comfy-api-proxy==0.1.6",
    "comfy-sdk==0.5.0",
    "jsonschema==4.25.1",
)


def install_command(requirements: Path, wheelhouse: Path | None, *, offline: bool = False) -> str:
    """The `pip install` command this script runs (inlined from `colab/wheelhouse.py`).

    `colab exec -f` runs a file's source as an IPython kernel cell: `__file__` does not exist there and
    a sibling module is not on the VM unless it was uploaded and imported from an explicit path, so
    every script the backend execs has to be self-contained (GPU test 4, G4-5). The host-side
    `wheelhouse.py` keeps the same function for building the cache; this copy is the VM's.
    """
    base = f"pip install -q -r {requirements}"
    if wheelhouse is None:
        return base
    command = f"{base} --find-links {wheelhouse}"
    return f"{command} --no-index" if offline else command


ROOT = Path("/content")
COMFY = ROOT / "ComfyUI"
OUT = Path("/content/comfyrizz/out")
TOKEN = Path("/content/.hf/token")
PROXY_PORT = 8189
COMFY_PORT = 8188
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


def _heartbeat(stop: "threading.Event", started: float) -> None:
    """Say the bootstrap is alive every HEARTBEAT_SECONDS (G5-2).

    Runs as a daemon thread for the whole step: any single step inside can be quiet for minutes (a
    model download, a pip resolve, the ComfyUI start), and the host's silence timeout counts the
    *step's* silence, not its progress.
    """
    while not stop.wait(HEARTBEAT_SECONDS):
        print(f"HEARTBEAT bootstrap {time.time() - started:.0f}s", flush=True)


def download_models(token: str, plan: dict[str, tuple[str, list[str]]], lock: dict) -> dict:
    """Download every host's files, all hosts at once (GPU test 5, G5-11).

    The docstring said parallel; the loop was not. GPU test 5 measured Klein at 54 s and LTX at 117 s
    one after the other - 171 s of the 237 s bootstrap, and 54 s of that is pure waiting. The hosts are
    independent repositories and the HF client is doing network I/O, so a thread per host downloads
    both at the same time; the progress lines simply interleave.
    """
    env = dict(os.environ)
    env["HF_TOKEN"] = token
    env["HF_XET_HIGH_PERFORMANCE"] = "1"
    env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    results: dict[str, dict] = {}
    collected = threading.Lock()

    def fetch(name: str) -> None:
        repo, files = plan[name]
        host = lock["hosts"][name]
        started = time.time()
        revision = host.get("revision")
        command = ["hf", "download", repo, *files, "--local-dir", host["localDir"]]
        if revision:
            # the pin: `hf download --revision` also writes the resolved revision into the local
            # cache, so a re-run cannot quietly pick up a newer file under the same name
            command += ["--revision", revision]
        # G5-2: poll instead of a silent blocking run, so a download never looks like a hang - and so
        # the host's silence timeout (and a human reading the step log) can tell the two apart
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=env)
        stderr = ""
        while True:
            try:
                _, stderr = process.communicate(timeout=DOWNLOAD_PROGRESS_SECONDS)
                break
            except subprocess.TimeoutExpired:
                print(f"DOWNLOADING {name} {time.time() - started:.0f}s", flush=True)
        entry = {
            "repo": repo,
            "revision": revision,
            "files": len(files),
            "rc": process.returncode,
            "seconds": round(time.time() - started, 1),
            "error": stderr[-400:] if process.returncode else "",
        }
        with collected:
            results[name] = entry
        print(f"DOWNLOAD {name} {json.dumps(entry)}", flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(4, len(plan)))) as pool:
        list(pool.map(fetch, list(plan)))
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
    ref = os.environ.get('COMFYRIZZ_COMFYUI_REF') or lock.get('comfyui', {}).get('revision') or COMFYUI_REF
    quoted_ref = shlex.quote(ref)
    if run(f"cd {ROOT} && rm -rf ComfyUI && git clone -q https://github.com/comfyanonymous/ComfyUI.git && cd ComfyUI && git checkout -q {quoted_ref} && git log -1 --format='%h %cd'", "clone") != 0:
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
    extras = " ".join(f"'{package}'" for package in VM_EXTRAS)
    if run(f"cd {COMFY} && {install['command']} {extras}", "requirements") != 0:
        raise SystemExit("installing ComfyUI requirements failed")
    install["seconds"] = round(time.time() - started, 1)
    print(f"INSTALL {json.dumps(install)}", flush=True)
    token = read_token()
    download = download_models(token, plan, lock)
    require_successful_downloads(download)
    # the token is used and then removed; it is never exported to ComfyUI or to a node
    TOKEN.unlink(missing_ok=True)
    print("token file removed:", not TOKEN.exists(), flush=True)

    for entry in lock['files']:
        if not entry.get('sha256'):
            continue
        file = Path(lock['hosts'][entry['host']]['localDir']) / entry['path']
        digest = hashlib.sha256()
        with file.open('rb') as stream:
            for chunk in iter(lambda: stream.read(16 * 1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != entry['sha256']:
            raise SystemExit('Model hash mismatch: ' + entry['path'])
        print('VERIFIED', entry['path'], flush=True)

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
    # G5-4: `comfy-api-proxy` is a PyPI package with a `src/` layout and no `__main__.py`, so
    # `python -m comfy_api_proxy` (and a git checkout of it) cannot import. Its installed entry point
    # is `comfy_api_proxy.cli:main`, which is what the console script calls.
    subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import sys; from comfy_api_proxy.cli import main; sys.exit(main())",
            "--comfyui",
            f"http://127.0.0.1:{COMFY_PORT}",
            "--port",
            str(PROXY_PORT),
        ],
        cwd=str(ROOT),
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
    if ready['ok'] and lock.get('requiredNodes'):
        with urllib.request.urlopen(f'http://127.0.0.1:{COMFY_PORT}/object_info', timeout=30) as response:
            info = json.load(response)
        ready['missingNodes'] = [name for name in lock['requiredNodes'] if name not in info]
        ready['ok'] = not ready['missingNodes']
    ready['comfyuiRevision'] = ref
    (OUT / "ready.json").write_text(json.dumps(ready, indent=2))
    print("READY", json.dumps(ready), flush=True)
    return 0 if ready["ok"] else 1


#: The arguments this script runs with, always (GPU test 5, G5-1).
#:
#: `colab exec` runs this file as an IPython kernel cell with `__name__ == "__main__"`, so a
#: `if __name__ == "__main__"` block fires *and* the process argv belongs to ipykernel
#: (`-f /root/.local/share/jupyter/runtime/kernel-....json`). Anything that reads `sys.argv` - argparse
#: included - sees those flags, raises `SystemExit: 2` and aborts the cell before the first step, so
#: the host only ever sees a missing sentinel. The backend never passes flags: run with none.
NO_ARGS: list[str] = []


def _run() -> None:
    """Run main() and print the sentinel the backend looks for (GPU test 4, G4-6).

    `colab exec` runs this file as a kernel cell, so an exception inside it prints a traceback and the
    CLI still exits 0, and a `SystemExit` (how main() refuses) does not stop the cell either. The
    backend therefore requires the positive `COMFYRIZZ_OK bootstrap` line, and every other outcome has
    to say FAIL - a non-zero return included, because that is ready.json saying the box is not usable.
    """
    # G5-2: the host kills a step that is silent for 60 s, so this step is never silent
    stop = threading.Event()
    threading.Thread(target=_heartbeat, args=(stop, time.time()), daemon=True).start()
    try:
        # G5-1: never the kernel's argv
        code = main(NO_ARGS)
    except (Exception, SystemExit):  # noqa: BLE001 - SystemExit too: `raise SystemExit(msg)` refuses
        stop.set()
        traceback.print_exc()
        print("COMFYRIZZ_FAIL bootstrap", flush=True)
        return
    stop.set()
    if code != 0:
        print(f"COMFYRIZZ_FAIL bootstrap (main returned {code}: ready.json says the box is not ready)", flush=True)
        return
    print("COMFYRIZZ_OK bootstrap", flush=True)



# Unit tests set COMFYRIZZ_BOOTSTRAP_IMPORT_ONLY=1 so helpers can be imported without
# starting a Google Colab bootstrap cell. The real cell/CLI leaves the env unset.
if os.environ.get("COMFYRIZZ_BOOTSTRAP_IMPORT_ONLY") != "1":
    _run()
