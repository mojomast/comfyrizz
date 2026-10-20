"""Helpers for the Google Colab render cell. No session is allocated and nothing touches /content."""

from __future__ import annotations

import importlib.util
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
