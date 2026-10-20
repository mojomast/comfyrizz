"""Render and verify a Comfyrizz package on the Google Colab VM.

The host uploads three files after `render_dirs.py` creates the directories:

- `/content/comfyrizz/render/bundle.zip` — renderer sources, no node_modules
- `/content/comfyrizz/render/project.zip` — package, timeline, narration, local edits
- `/content/comfyrizz/render/job.json` — paths and the bundle stamp, never a token

Generated plates stay under `/content/comfyrizz/out` and are linked into the project
when the host does not already have them. Node, ffmpeg, a headless browser and
`npm install` are cached under `/content/comfyrizz/render-cache` for this VM.

This cell does not read `--env` and does not print the process environment.
`colab exec` runs the file as a kernel cell (`__name__ == "__main__"`).
"""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import traceback
import urllib.request
import zipfile
from pathlib import Path

JOB_PATH = Path("/content/comfyrizz/render/job.json")
NODE_VERSION = "22.20.0"
HEARTBEAT_SECONDS = 20
SECRET_KEY = re.compile(r"token|secret|password|credential|api[_-]?key|^hf_", re.IGNORECASE)
KEEP_ENV = {"PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "DEBIAN_FRONTEND"}


def safe_relative(name: str) -> Path:
    """A zip or project path that cannot escape its parent."""
    path = Path(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"unsafe path {name}")
    return path


def clean_env(base: dict[str, str] | None = None, extra: dict[str, str] | None = None) -> dict[str, str]:
    """Child environment with credential-shaped keys removed. Values are not logged."""
    merged = {key: value for key, value in (base or {}).items() if key in KEEP_ENV and not SECRET_KEY.search(key)}
    for key, value in (extra or {}).items():
        if SECRET_KEY.search(key):
            continue
        merged[key] = value
    return merged


def node_command(node: Path, repo: Path, package: Path, output: Path) -> list[str]:
    return [str(node), str(repo / "apps/renderer/scripts/render-remote-entry.mjs"), str(package), str(output)]


def should_skip_install(stamp_path: Path, stamp: str, markers: list[Path]) -> bool:
    if not stamp or not stamp_path.is_file() or stamp_path.read_text(encoding="utf-8").strip() != stamp:
        return False
    return all(marker.is_file() for marker in markers)


def link_missing(project: Path, media_root: Path, relative_paths: list[str]) -> list[str]:
    linked: list[str] = []
    for name in relative_paths:
        rel = safe_relative(name)
        dest = project.joinpath(*rel.parts)
        if dest.exists():
            continue
        src = media_root.joinpath(*rel.parts)
        if not src.is_file():
            raise FileNotFoundError(f"generated media is not on the VM: {name}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.symlink_to(src)
        linked.append(name)
    return linked


def _progress(phase: str, message: str | None = None) -> None:
    payload: dict[str, object] = {"event": "progress", "phase": phase}
    if message:
        payload["message"] = message
    print(json.dumps(payload), flush=True)


def _heartbeat(stop: threading.Event, started: float) -> None:
    while not stop.wait(HEARTBEAT_SECONDS):
        print(json.dumps({"event": "progress", "phase": "heartbeat", "elapsed": round(time.time() - started)}), flush=True)


def _extract_zip(archive: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            safe_relative(info.filename)
        bundle.extractall(dest)


def _node_major(binary: Path) -> int:
    try:
        out = subprocess.check_output([str(binary), "-p", "process.versions.node"], text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        return 0
    try:
        return int(out.split(".", 1)[0])
    except ValueError:
        return 0


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + ".partial")
    _progress("node", f"downloading Node.js {NODE_VERSION}")
    with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as handle:
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            handle.write(chunk)
    partial.replace(dest)


def ensure_node(cache: Path, major: int) -> Path:
    cached = cache / "node" / "bin" / "node"
    if cached.is_file() and _node_major(cached) >= major:
        _progress("node", "reusing cached Node.js")
        return cached
    found = shutil.which("node")
    if found and _node_major(Path(found)) >= major:
        _progress("node", "reusing Node.js already on PATH")
        return Path(found)
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"aarch64", "arm64"} else "x64" if machine in {"x86_64", "amd64"} else ""
    if not arch:
        raise RuntimeError(f"no Node.js build for {machine}")
    dist = f"node-v{NODE_VERSION}-linux-{arch}"
    tarball = cache / f"{dist}.tar.xz"
    if not tarball.is_file():
        _download(f"https://nodejs.org/dist/v{NODE_VERSION}/{dist}.tar.xz", tarball)
    _progress("node", "unpacking Node.js")
    with tarfile.open(tarball) as archive:
        archive.extractall(cache)
    extracted = cache / dist
    target = cache / "node"
    if target.exists():
        shutil.rmtree(target)
    extracted.rename(target)
    binary = target / "bin" / "node"
    if _node_major(binary) < major:
        raise RuntimeError("Node.js install did not produce a usable binary")
    return binary


def ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        _progress("ffmpeg", "reusing ffmpeg already on PATH")
        return
    _progress("ffmpeg", "installing ffmpeg")
    env = clean_env(os.environ, {"DEBIAN_FRONTEND": "noninteractive"})
    subprocess.run(["apt-get", "update", "-y"], check=False, env=env)
    subprocess.run(["apt-get", "install", "-y", "ffmpeg"], check=False, env=env)
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("ffmpeg is not available on the Google Colab VM")


def _browser_candidates(cache: Path) -> list[Path]:
    names = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome-headless-shell", "chrome")
    found = [Path(path) for path in (f"/usr/bin/{name}" for name in names[:4]) if Path(path).is_file()]
    if cache.is_dir():
        for match in cache.rglob("*"):
            if match.is_file() and match.name in names and os.access(match, os.X_OK):
                found.append(match)
    return found


def ensure_browser(node: Path, repo: Path, cache: Path) -> str | None:
    cached = _browser_candidates(cache)
    if cached:
        _progress("chromium", "reusing a cached headless browser")
        return str(cached[0])
    remotion = repo / "apps/renderer/node_modules/.bin/remotion"
    if remotion.is_file():
        _progress("chromium", "ensuring Remotion's headless browser")
        env = _tool_env(node, cache, {})
        subprocess.run([str(remotion), "browser", "ensure"], cwd=repo / "apps/renderer", env=env, check=False)
    found = _browser_candidates(cache)
    if found:
        return str(found[0])
    _progress("chromium", "installing a system Chromium")
    env = clean_env(os.environ, {"DEBIAN_FRONTEND": "noninteractive"})
    subprocess.run(["apt-get", "install", "-y", "chromium-browser"], check=False, env=env)
    system = _browser_candidates(cache)
    return str(system[0]) if system else None


def _tool_env(node: Path, cache: Path, extra: dict[str, str]) -> dict[str, str]:
    path = f"{node.parent}{os.pathsep}{os.environ.get('PATH', '')}"
    base = {key: os.environ[key] for key in KEEP_ENV if key in os.environ}
    return clean_env(base, {"PATH": path, "HOME": str(cache), **extra})


def ensure_modules(node: Path, repo: Path, cache: Path, stamp: str) -> None:
    npm = node.parent / "npm"
    markers = [
        repo / "apps/renderer/node_modules/remotion/package.json",
        repo / "packages/schema/node_modules/ajv/package.json",
        repo / "packages/vector/node_modules/@resvg/resvg-js/package.json",
    ]
    stamp_path = cache / "bundle-stamp"
    if should_skip_install(stamp_path, stamp, markers):
        _progress("deps", "reusing cached renderer dependencies")
        return
    env = _tool_env(node, cache, {})
    for prefix in ("apps/renderer", "packages/schema", "packages/vector"):
        _progress("deps", f"installing {prefix}")
        completed = subprocess.run(
            [str(npm), "install", "--prefix", str(repo / prefix), "--cache", str(cache / "npm"), "--no-audit", "--no-fund"],
            cwd=repo,
            env=env,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(f"npm install failed for {prefix}")
    if stamp:
        stamp_path.write_text(stamp + "\n", encoding="utf-8")


def _stream(command: list[str], cwd: Path, env: dict[str, str]) -> int:
    process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert process.stdout is not None
    for line in process.stdout:
        print(line.rstrip(), flush=True)
    return process.wait()


def verify(out: Path, project: Path, repo: Path, voiced: bool) -> None:
    video = out / "video.mp4"
    render = json.loads((out / "render.json").read_text(encoding="utf-8"))
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-count_frames",
        "-show_entries", "stream=codec_type,width,height,nb_read_frames,sample_rate:format=duration",
        "-of", "json", str(video),
    ], text=True))
    streams = probe.get("streams") or []
    picture = next((stream for stream in streams if stream.get("codec_type") == "video"), {})
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    checks = {
        "frames": int(picture.get("nb_read_frames") or -1) == int(render["frames"]),
        "dimensions": picture.get("width") == render["width"] and picture.get("height") == render["height"],
        "duration": abs(float(probe["format"]["duration"]) - (render["frames"] / render["fps"])) < 0.1,
        "narrationStream": (not voiced) or bool(audio),
    }
    report: dict[str, object] = {"checks": checks, "probe": probe, "location": "colab", "note": "Technical checks do not replace perceptual review."}
    narration_path = out / "audio-verification.json"
    if voiced:
        measure = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", str(video), "-vn", "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True, check=False,
        )
        match = re.search(r"mean_volume:\s*(-?[\d.]+) dB", measure.stderr or "")
        checks["nonSilentAudio"] = bool(match) and float(match.group(1)) > -60
        if narration_path.exists():
            narration_path.unlink()
        checker = subprocess.run([
            sys.executable, str(repo / "scripts/tts/verify_mix.py"),
            "--video", str(video),
            "--narration", str(project / "audio/narration.norm.wav"),
            "--out", str(narration_path),
        ], check=False)
        if not narration_path.is_file():
            raise RuntimeError(f"Mix checker exited {checker.returncode} without writing a report")
        narration = json.loads(narration_path.read_text(encoding="utf-8"))
        if not isinstance(narration.get("passed"), bool):
            raise RuntimeError(f"Mix checker exited {checker.returncode} with an invalid report")
        if (checker.returncode == 0) != (narration["passed"] is True):
            raise RuntimeError(f"Mix checker exit {checker.returncode} contradicts its report")
        report["narration"] = narration
        checks["narrationEnvelope"] = narration["passed"] is True
    if any(value is False for value in checks.values()):
        (out / "verification.json").write_text(json.dumps(report), encoding="utf-8")
        raise RuntimeError("Final video verification failed")
    (out / "verification.json").write_text(json.dumps(report), encoding="utf-8")


def _zip_existing(dest: Path, root: Path, names: list[str], required: set[str]) -> None:
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            rel = safe_relative(name)
            path = root.joinpath(*rel.parts)
            if not path.is_file():
                if name in required:
                    raise FileNotFoundError(f"missing render output {name}")
                continue
            archive.write(path, name)


def main(argv: list[str] | None = None) -> int:
    del argv  # the kernel's argv is not this job
    job = json.loads(JOB_PATH.read_text(encoding="utf-8"))
    if job.get("secrets") not in (None, "none") or job.get("envArgs") not in (None, False):
        raise RuntimeError("refusing a render job that carries secrets or env args")
    cache = Path(job["cacheRoot"])
    repo = Path(job["repoDir"])
    project = Path(job["projectDir"])
    out = Path(job["outDir"])
    out.mkdir(parents=True, exist_ok=True)
    stamp = str(job.get("stamp") or "")
    _progress("unpack", "opening the render bundle")
    marker = cache / "unpacked-stamp"
    if not (stamp and marker.is_file() and marker.read_text(encoding="utf-8").strip() == stamp and (repo / "apps/renderer/package.json").is_file()):
        if repo.exists():
            shutil.rmtree(repo)
        _extract_zip(Path(job["bundleZip"]), repo)
        if stamp:
            marker.write_text(stamp + "\n", encoding="utf-8")
    if project.exists():
        shutil.rmtree(project)
    _extract_zip(Path(job["projectZip"]), project)
    node = ensure_node(cache, int(job.get("nodeMajor") or 20))
    ensure_ffmpeg()
    ensure_modules(node, repo, cache, stamp)
    browser = ensure_browser(node, repo, cache)
    if not browser:
        raise RuntimeError("no headless browser is available for Remotion")
    linked = link_missing(project, Path(job["mediaRoot"]), list(job.get("linkFiles") or []))
    _progress("link", f"linked {len(linked)} generated file(s) already on the VM")
    output = out / "video.mp4"
    command = node_command(node, repo, project / "package.json", output)
    if "--env" in command:
        raise RuntimeError("refusing a render command that uses --env")
    code = _stream(command, repo, _tool_env(node, cache, {"REMOTION_BROWSER": browser}))
    if code != 0:
        raise RuntimeError(f"renderer exited {code}")
    _progress("verify", "checking the mix")
    verify(out, project, repo, bool(job.get("voiced")))
    _zip_existing(Path(job["resultsZip"]), out, list(job.get("outputs") or []), {"video.mp4", "render.json", "verification.json"})
    _zip_existing(Path(job["mediaZip"]), project, list(job.get("archiveFiles") or []), set())
    _progress("packaged", "MP4 and verification are ready to download")
    return 0


def _run() -> None:
    stop = threading.Event()
    threading.Thread(target=_heartbeat, args=(stop, time.time()), daemon=True).start()
    try:
        code = main([])
    except (Exception, SystemExit):
        stop.set()
        traceback.print_exc()
        print("COMFYRIZZ_FAIL render", flush=True)
        return
    stop.set()
    if code != 0:
        print(f"COMFYRIZZ_FAIL render (main returned {code})", flush=True)
        return
    print("COMFYRIZZ_OK render", flush=True)


if __name__ == "__main__":
    _run()
