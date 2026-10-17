"""H-fix5 acceptance: faster Google Colab setup (cached wheels) and the g2_finish path fix.

Fakes only: nothing here calls Google Colab, downloads a wheel, or touches /content. The wheelhouse
builder is driven with a fake `pip`, and the collection script against a temporary content directory.
GPU test 2's two setup findings are the subject: 192 s of `pip install` and a collection step that
never ran because of a wrong `-f` path (docs/GPU_TEST_2.md, "Other notes").
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from conftest import REPO_ROOT

WHEELHOUSE = REPO_ROOT / "colab" / "wheelhouse.py"
REQUIREMENTS_VM = REPO_ROOT / "colab" / "requirements-vm.txt"
FINISH = REPO_ROOT / "scripts" / "gpu2" / "g2_finish.py"
FINISH_SH = REPO_ROOT / "scripts" / "gpu2" / "g2_finish.sh"


def load_wheelhouse():
    spec = importlib.util.spec_from_file_location("colab_wheelhouse", WHEELHOUSE)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def fake_pip(tmp_path: Path, *wheels: str) -> Path:
    """A `python` that answers `-m pip download --dest DIR` by writing the named wheels."""
    script = tmp_path / "fake_pip.sh"
    wheel_names = " ".join(wheels)
    script.write_text(
        "#!/usr/bin/env bash\n"
        'dest=""\n'
        'while [ $# -gt 0 ]; do if [ "$1" = "--dest" ]; then dest="$2"; fi; shift; done\n'
        '[ -n "$dest" ] || { echo "no --dest" >&2; exit 2; }\n'
        'mkdir -p "$dest"\n'
        f'for name in {wheel_names}; do echo "fake wheel" > "$dest/$name"; done\n'
        "exit 0\n"
    )
    script.chmod(0o755)
    return script


def run_script(script: Path, *args: str, cwd: Path | None = None, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True,
        text=True,
        cwd=str(cwd or REPO_ROOT),
        env=env,
    )


# --------------------------------------------------------------------------- the wheel cache
def test_the_vm_requirement_list_is_the_measurable_part_of_setup():
    lines = [line.strip() for line in REQUIREMENTS_VM.read_text(encoding="utf-8").splitlines()]
    real = [line for line in lines if line and not line.startswith("#")]
    module = load_wheelhouse()
    names = {entry["name"] for entry in module.requirement_names(REQUIREMENTS_VM)}
    assert not names & {"torch", "torchvision", "torchaudio"}, (
        "torch is preinstalled on the G4 image: fetching it here would download hundreds of MB of the wrong CUDA"
    )
    assert "torchsde" in names, "torchsde is a small pure-python dependency and does belong in the cache"
    for needed in ("huggingface_hub[hf_xet]>=1.0", "comfy-api-proxy", "comfy-sdk==0.5.0", "jsonschema==4.25.1"):
        assert needed in real, needed
    assert any("requirements.txt" in line for line in lines), "the list must say where it came from"
    assert any("v0.41.3" in line for line in lines), "and which ComfyUI ref it matches"


def test_the_install_command_prefers_the_cache_and_can_refuse_the_index():
    module = load_wheelhouse()
    requirements = Path("/tmp/req.txt")
    plain = module.install_command(requirements, None)
    assert "--find-links" not in plain and "--no-index" not in plain
    cached = module.install_command(requirements, Path("/content/wheelhouse"))
    assert "--find-links /content/wheelhouse" in cached and "--no-index" not in cached, (
        "a cache hit must still be allowed the index, so a missed package does not fail the session"
    )
    offline = module.install_command(requirements, Path("/content/wheelhouse"), offline=True)
    assert offline.endswith("--no-index"), "offline mode is the one that must not touch PyPI"


def test_a_wheelhouse_is_built_hashed_and_noticed_when_it_rots(tmp_path: Path):
    module = load_wheelhouse()
    out = tmp_path / "wheelhouse"
    requirements = tmp_path / "requirements.txt"
    requirements.write_text("foo-bar==1.0\nbaz==2.0\n", encoding="utf-8")
    fake = fake_pip(tmp_path, "foo_bar-1.0-py3-none-any.whl", "baz-2.0-py3-none-any.whl")

    manifest = module.build(requirements, out, python=str(fake), platform=None)
    assert sorted(entry["name"] for entry in manifest["files"]) == ["baz-2.0-py3-none-any.whl", "foo_bar-1.0-py3-none-any.whl"]
    assert manifest["total_bytes"] > 0 and manifest["requirements_count"] == 2
    assert json.loads((out / "manifest.json").read_text())["v"] == 1
    digest = hashlib.sha256((out / "foo_bar-1.0-py3-none-any.whl").read_bytes()).hexdigest()
    assert manifest["files"][0]["sha256"] in (digest, manifest["files"][1]["sha256"])

    assert module.check(out, requirements)["ok"] is True

    (out / "baz-2.0-py3-none-any.whl").unlink()
    report = module.check(out, requirements)
    assert report["ok"] is False and any("missing baz-2.0" in problem for problem in report["problems"])

    (out / "foo_bar-1.0-py3-none-any.whl").write_text("fake wheel, tampered")
    report = module.check(out, requirements)
    assert any("changed since the manifest" in problem for problem in report["problems"])

    # a requirement with no wheel in the cache is a gap the VM would have to hit the network for
    (tmp_path / "more.txt").write_text("foo-bar==1.0\nbaz==2.0\nqux==3.0\n", encoding="utf-8")
    report = module.check(out, tmp_path / "more.txt")
    assert any("no wheel for qux" in problem for problem in report["problems"])


def test_a_dry_run_prints_the_pip_command_and_writes_nothing(tmp_path: Path):
    module = load_wheelhouse()
    out = tmp_path / "wheelhouse"
    result = module.build(REQUIREMENTS_VM, out, dry_run=True)
    assert result["dry_run"] is True and "pip" in result["command"]
    assert "--only-binary=:all:" in result["command"], "wheels only: no sdists to build on the VM"
    assert not out.exists(), "a dry run must not create the directory"


def test_the_cli_refuses_a_wheelhouse_that_does_not_exist(tmp_path: Path):
    out = tmp_path / "nowhere"
    completed = run_script(WHEELHOUSE, "--out", str(out), "--check")
    assert completed.returncode == 1
    assert "no manifest.json" in completed.stderr and str(out) in completed.stderr

    dry = run_script(WHEELHOUSE, "--out", str(out), "--dry-run")
    assert dry.returncode == 0 and "DRY" in dry.stdout and not out.exists()


# --------------------------------------------------------------------------- the collection step
def test_a_collection_run_tars_the_outputs_and_names_what_is_missing(tmp_path: Path):
    content = tmp_path / "content"
    (content / "out").mkdir(parents=True)
    (content / "results.json").write_text('{"jobs": []}', encoding="utf-8")
    (content / "comfy.log").write_text("comfyui said things", encoding="utf-8")
    (content / "comfyrizz" / "out" / "assets").mkdir(parents=True)
    (content / "comfyrizz" / "out" / "manifest.json").write_text("{}", encoding="utf-8")

    completed = run_script(FINISH, "--content", str(content))
    assert completed.returncode == 0, completed.stderr
    assert "copied: comfy.log, results.json" in completed.stdout
    assert "proxy.log (optional)" in completed.stdout, "a missing log is reported, not swallowed"
    assert "hermes_runner/" in completed.stdout
    tarball = content / "out.tgz"
    assert tarball.is_file() and tarball.stat().st_size > 0
    with tarfile.open(tarball) as archive:
        names = archive.getnames()
    assert "out/results.json" in names and "out/hermes_runner/manifest.json" in names


def test_a_leftover_token_file_fails_the_collection_without_printing_it(tmp_path: Path):
    content = tmp_path / "content"
    (content / "out").mkdir(parents=True)
    (content / "results.json").write_text("{}", encoding="utf-8")
    (content / ".hf").mkdir(parents=True)
    secret = "hf_THIS_MUST_NOT_APPEAR"
    (content / ".hf" / "token").write_text(secret, encoding="utf-8")

    completed = run_script(FINISH, "--content", str(content))
    assert completed.returncode == 1
    assert "token file is still on disk" in completed.stdout
    assert secret not in completed.stdout and secret not in completed.stderr


def test_a_missing_output_directory_is_a_failure_not_silence(tmp_path: Path):
    content = tmp_path / "content"
    content.mkdir()
    completed = run_script(FINISH, "--content", str(content))
    assert completed.returncode == 1
    assert "no output directory" in completed.stdout, "the old version hid this behind 2>/dev/null"
    assert "copied: nothing" in completed.stdout


def test_the_launcher_resolves_its_own_path_from_any_directory(tmp_path: Path):
    content = tmp_path / "content"
    (content / "out").mkdir(parents=True)
    import os

    environment = {**os.environ, "PYTHON": sys.executable}
    completed = subprocess.run(
        ["bash", str(FINISH_SH), "--content", str(content), "--dry-run"],
        capture_output=True,
        text=True,
        cwd=str(tmp_path),  # deliberately somewhere else: the wrong-path failure mode
        env=environment,
    )
    assert completed.returncode == 0, completed.stderr
    assert "DRY would tar" in completed.stdout
    assert os.access(FINISH_SH, os.X_OK) and os.access(FINISH, os.X_OK)
    help_text = subprocess.run(["bash", str(FINISH_SH), "--help"], capture_output=True, text=True, env=environment)
    assert help_text.returncode == 0 and "--content" in help_text.stdout
