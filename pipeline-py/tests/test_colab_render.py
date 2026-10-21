"""Helpers for the Google Colab render cell. No session is allocated and nothing touches /content."""

from __future__ import annotations

import importlib.util
import json
import re
from types import SimpleNamespace
from pathlib import Path

import pytest

from conftest import REPO_ROOT


def load_render():
    path = REPO_ROOT / "colab" / "render_remote.py"
    spec = importlib.util.spec_from_file_location("colab_render_remote", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_project_paths_cannot_escape():
    module = load_render()
    with pytest.raises(ValueError):
        module.safe_relative("../secret")
    with pytest.raises(ValueError):
        module.safe_relative("/etc/passwd")
    assert module.safe_relative("assets/plate.mp4") == Path("assets/plate.mp4")


def test_install_is_skipped_only_when_the_stamp_and_markers_match(tmp_path: Path):
    module = load_render()
    stamp = tmp_path / "bundle-stamp"
    marker = tmp_path / "remotion" / "package.json"
    marker.parent.mkdir()
    marker.write_text("{}", encoding="utf-8")
    assert module.should_skip_install(stamp, "abc", [marker]) is False
    stamp.write_text("abc\n", encoding="utf-8")
    assert module.should_skip_install(stamp, "abc", [marker]) is True
    assert module.should_skip_install(stamp, "changed", [marker]) is False
    missing = tmp_path / "missing"
    assert module.should_skip_install(stamp, "abc", [missing]) is False


def test_generated_media_is_linked_and_host_files_are_left_alone(tmp_path: Path):
    module = load_render()
    project = tmp_path / "project"
    media = tmp_path / "out"
    project.mkdir()
    (project / "audio").mkdir()
    (project / "audio" / "narration.norm.wav").write_bytes(b"host")
    (media / "assets").mkdir(parents=True)
    (media / "assets" / "plate.mp4").write_bytes(b"plate")
    linked = module.link_missing(project, media, ["audio/narration.norm.wav", "assets/plate.mp4"])
    assert linked == ["assets/plate.mp4"]
    assert (project / "assets" / "plate.mp4").is_symlink()
    assert (project / "assets" / "plate.mp4").read_bytes() == b"plate"
    with pytest.raises(FileNotFoundError):
        module.link_missing(project, media, ["assets/missing.mp4"])


def test_child_environment_and_render_command_drop_credentials():
    module = load_render()
    cleaned = module.clean_env(
        {"PATH": "/usr/bin", "HOME": "/content", "HF_TOKEN": "hf_secret", "API_KEY": "no"},
        {"REMOTION_BROWSER": "/usr/bin/chromium", "HF_TOKEN": "still-no"},
    )
    assert cleaned["PATH"] == "/usr/bin"
    assert cleaned["REMOTION_BROWSER"] == "/usr/bin/chromium"
    assert "HF_TOKEN" not in cleaned
    assert "API_KEY" not in cleaned
    command = module.node_command(Path("/opt/node"), Path("/repo"), Path("/repo/package.json"), Path("/out/video.mp4"))
    assert "--env" not in command
    assert all("hf_" not in part and "secret" not in part for part in command)


def test_vm_installs_and_builds_workspaces_then_reuses_complete_cache(tmp_path, monkeypatch):
    module = load_render()
    repo, cache = tmp_path / "repo", tmp_path / "cache"
    cache.mkdir()
    calls = []
    def run(argv, **kwargs):
        calls.append(argv)
        assert "HF_TOKEN" not in kwargs["env"]
        return SimpleNamespace(returncode=0)
    monkeypatch.setenv("HF_TOKEN", "must-not-leak")
    monkeypatch.setattr(module.subprocess, "run", run)
    module.ensure_modules(Path("/node/bin/node"), repo, cache, "content-hash")
    assert len(calls) == 6
    assert all("--include=dev" in argv for argv in calls[:4])
    assert [argv[-1] for argv in calls[-2:]] == [str(repo / "packages/planner"), str(repo / "packages/vector")]
    assert all(argv[1:3] == ["run", "build"] for argv in calls[-2:])
    for name in ["apps/renderer/node_modules/remotion/package.json", "packages/schema/node_modules/ajv/package.json",
                 "packages/vector/node_modules/@resvg/resvg-js/package.json", "packages/planner/node_modules/typescript/bin/tsc",
                 "packages/planner/dist/src/index.js", "packages/vector/dist/src/index.js"]:
        marker = repo / name
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("{}")
    calls.clear()
    module.ensure_modules(Path("/node/bin/node"), repo, cache, "content-hash")
    assert calls == []
    (repo / "packages/vector/dist/src/index.js").unlink()
    module.ensure_modules(Path("/node/bin/node"), repo, cache, "content-hash")
    assert len(calls) == 6


def test_failed_workspace_build_does_not_commit_cache_stamp(tmp_path, monkeypatch):
    module = load_render()
    def run(argv, **kwargs):
        if "build" in argv:
            raise module.subprocess.CalledProcessError(1, argv)
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(module.subprocess, "run", run)
    with pytest.raises(module.subprocess.CalledProcessError):
        module.ensure_modules(Path("/node/bin/node"), tmp_path / "repo", tmp_path, "new-source")
    assert not (tmp_path / "bundle-stamp").exists()


def test_pinned_hyperframes_is_installed_verified_reused_and_repaired(tmp_path, monkeypatch):
    module = load_render()
    root = tmp_path / "hyperframes" / module.HYPERFRAMES_VERSION / "node_modules/hyperframes"
    calls = []
    def run(argv, **kwargs):
        calls.append(argv)
        assert kwargs["env"]["HYPERFRAMES_NO_TELEMETRY"] == "1"
        assert "HF_TOKEN" not in kwargs["env"]
        if "install" in argv:
            assert argv[-1] == "hyperframes@0.8.181"
            (root / "bin").mkdir(parents=True, exist_ok=True)
            (root / "bin/hyperframes.mjs").write_text("// installed")
            (root / "package.json").write_text(json.dumps({"version": module.HYPERFRAMES_VERSION}))
        return SimpleNamespace(returncode=0, stdout=module.HYPERFRAMES_VERSION + "\n")
    monkeypatch.setattr(module.subprocess, "run", run)
    monkeypatch.setenv("HF_TOKEN", "not-in-render-env")
    env = module.ensure_hyperframes(Path("/vm/node/bin/node"), tmp_path, "/vm/browser/chrome")
    assert env["COMFYRIZZ_HYPERFRAMES_NODE"] == "/vm/node/bin/node"
    assert env["HYPERFRAMES_BROWSER_PATH"] == "/vm/browser/chrome"
    assert env["COMFYRIZZ_HYPERFRAMES_CLI"] == str(root / "bin/hyperframes.mjs")
    calls.clear()
    module.ensure_hyperframes(Path("/vm/node/bin/node"), tmp_path, "/vm/browser/chrome")
    assert not any("install" in argv for argv in calls)
    (root / "package.json").write_text('{"version":"0.0.1"}')
    module.ensure_hyperframes(Path("/vm/node/bin/node"), tmp_path, "/vm/browser/chrome")
    assert any("install" in argv for argv in calls)


def test_browser_discovery_includes_remotion_install_not_just_home(tmp_path, monkeypatch):
    module = load_render()
    repo, cache = tmp_path / "repo", tmp_path / "cache"
    browser = repo / "apps/renderer/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell"
    browser.parent.mkdir(parents=True)
    browser.write_text("#!/bin/sh\necho Chromium\n")
    browser.chmod(0o755)
    original = module._browser_candidates
    monkeypatch.setattr(module, "_browser_candidates", lambda root: [p for p in original(root) if p.is_relative_to(tmp_path)])
    assert module.ensure_browser(Path("/node/bin/node"), repo, cache) == str(browser)


def test_vm_job_returns_new_composition_files_and_discards_stale_output(tmp_path, monkeypatch):
    import zipfile
    module = load_render()
    repo, project, out, cache = [tmp_path / name for name in ["repo", "project", "out", "cache"]]
    cache.mkdir()
    out.mkdir()
    (out / "old-failure.json").write_text("stale")
    bundle = tmp_path / "bundle.zip"
    with zipfile.ZipFile(bundle, "w") as archive:
        archive.writestr("apps/renderer/package.json", "{}")
    inputs = tmp_path / "project.zip"
    with zipfile.ZipFile(inputs, "w") as archive:
        archive.writestr("package.json", "{}")
        archive.writestr("compositions/manifest.json", '{"version":1,"scenes":[]}')
    job = dict(cacheRoot=str(cache), repoDir=str(repo), projectDir=str(project), outDir=str(out),
               stamp="fresh", bundleZip=str(bundle), projectZip=str(inputs), mediaRoot=str(tmp_path / "generated"),
               nodeMajor=22, compositions=True, archiveFiles=[], linkFiles=[], voiced=False,
               outputs=["video.mp4", "render.json", "verification.json", "composition-files.json"],
               resultsZip=str(out / "results.zip"), mediaZip=str(out / "media.zip"))
    module.JOB_PATH = tmp_path / "job.json"
    module.JOB_PATH.write_text(json.dumps(job))
    steps = []
    monkeypatch.setattr(module, "ensure_node", lambda *args: Path("/vm/node"))
    monkeypatch.setattr(module, "ensure_ffmpeg", lambda: None)
    monkeypatch.setattr(module, "ensure_modules", lambda *args: steps.append("build"))
    monkeypatch.setattr(module, "ensure_browser", lambda *args: "/vm/browser")
    monkeypatch.setattr(module, "ensure_composition_fonts", lambda *args: steps.append("fonts"))
    def hyperframes(*args):
        steps.append("hyperframes")
        return {"COMFYRIZZ_HYPERFRAMES_CLI": "/vm/cli.mjs", "COMFYRIZZ_HYPERFRAMES_NODE": "/vm/node", "HYPERFRAMES_BROWSER_PATH": "/vm/browser", "HYPERFRAMES_NO_TELEMETRY": "1"}
    monkeypatch.setattr(module, "ensure_hyperframes", hyperframes)
    names = ["assets/derived/plate.mp4", "assets/derived/plate.composition.json", "assets/derived/plate.composition.html"]
    def render(command, cwd, env):
        assert not (out / "old-failure.json").exists()
        assert steps == ["build", "fonts", "hyperframes"]
        assert env["REMOTION_BROWSER"] == env["HYPERFRAMES_BROWSER_PATH"]
        assert env["COMFYRIZZ_HYPERFRAMES_CLI"] == "/vm/cli.mjs"
        for name in names:
            file = project / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("new VM output")
        (out / "video.mp4").write_text("video")
        (out / "render.json").write_text("{}")
        (out / "composition-files.json").write_text(json.dumps(names))
        return 0
    monkeypatch.setattr(module, "_stream", render)
    monkeypatch.setattr(module, "verify", lambda *args: (out / "verification.json").write_text('{"passed":true}'))
    assert module.main() == 0
    with zipfile.ZipFile(job["mediaZip"]) as archive:
        assert archive.namelist() == names
    with zipfile.ZipFile(job["resultsZip"]) as archive:
        assert "composition-files.json" in archive.namelist()


def test_missing_local_fonts_are_provisioned_in_the_vm(tmp_path, monkeypatch):
    module = load_render()
    calls = []
    monkeypatch.setattr(module.subprocess, "run", lambda argv, **kwargs: calls.append(argv))
    module.ensure_composition_fonts(Path("/vm/node"), tmp_path, tmp_path / "fonts")
    assert calls[-1] == ["apt-get", "install", "-y", "fontconfig", "fonts-liberation"]
    calls.clear()
    (tmp_path / "fonts").mkdir()
    (tmp_path / "fonts/DejaVuSans.ttf").write_bytes(b"font")
    module.ensure_composition_fonts(Path("/vm/node"), tmp_path, tmp_path / "fonts")
    assert calls == []


def test_vm_hyperframes_pin_matches_worker_and_job_plan():
    module = load_render()
    worker = (REPO_ROOT / "apps/renderer/scripts/composition-worker.mjs").read_text()
    plan = (REPO_ROOT / "packages/backends/src/colab-render-plan.mjs").read_text()
    assert re.search(r"HYPERFRAMES_VERSION = '([^']+)'", worker).group(1) == module.HYPERFRAMES_VERSION
    assert f'version: "{module.HYPERFRAMES_VERSION}"' in plan
