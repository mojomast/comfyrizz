"""The gate's entry point: `evaluate_run` walks a package's produced assets (R1 section 1.7)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from eval.gate import evaluate_run, main

REPO = Path(__file__).resolve().parents[2]
LAUNCH_DEMO = REPO / "examples" / "launch-demo"

#: The two flat blocks in the synthetic still below, as the SVG would declare them.
ELEMENTS = [
    {"id": "dark", "bbox": (0, 0, 48, 64), "colour": "#0d0f14"},
    {"id": "accent", "bbox": (48, 0, 48, 64), "colour": "#6d8cff"},
]


def package(*, assets: dict, palette=None, width=1920, height=1080) -> dict:
    return {
        "id": "pkg_gate_run",
        "format": {"width": width, "height": height, "fps": 24},
        "theme": {"palette": palette or ["#0d0f14", "#6d8cff"], "font": "Inter"},
        "assets": assets,
    }


def still(path: Path, *, left="#0d0f14", right="#6d8cff") -> Path:
    """A flat two-block still, in the theme's own colours: what the SVG raster would look like."""
    array = np.zeros((64, 96, 3), dtype=np.uint8)
    array[:, :48] = [int(left[1:3], 16), int(left[3:5], 16), int(left[5:7], 16)]
    array[:, 48:] = [int(right[1:3], 16), int(right[3:5], 16), int(right[5:7], 16)]
    from PIL import Image as PILImage

    path.parent.mkdir(parents=True, exist_ok=True)
    PILImage.fromarray(array).save(path)
    return path


def fake_probe(**overrides):
    """A probe that says what a test tells it to, so nothing here needs ffprobe."""
    media = {"status": "ran", "width": 1920, "height": 1080, "frames": 97, "codec": "h264"}
    media.update(overrides)
    return lambda path: dict(media)


def test_a_package_whose_stills_match_its_svg_passes(tmp_path: Path) -> None:
    still(tmp_path / "assets" / "a_panel.png")
    report = evaluate_run(
        # the still is 96x64, so that is what the package says the video is: the dims check compares the
        # file with the plan, and a plan that disagrees with its own render is exactly what it catches
        package(assets={"a_panel": {"kind": "svg", "file": "assets/a_panel.png"}}, width=96, height=64),
        out_dir=tmp_path,
        elements={"a_panel": ELEMENTS},
    )

    assert report["ok"] is True, report["failures"]
    assert report["assets"]["a_panel"]["kind"] == "still"
    assert report["assets"]["a_panel"]["checks"], "the still was judged by nothing"
    assert report["judged"] == 1


def test_a_file_the_package_names_but_does_not_have_fails_with_its_own_code(tmp_path: Path) -> None:
    report = evaluate_run(
        package(assets={"a_ghost": {"kind": "svg", "file": "assets/a_ghost.png"}}),
        out_dir=tmp_path,
    )

    assert report["ok"] is False
    assert report["assets"]["a_ghost"]["code"] == "GATE_ASSET_MISSING"
    assert any(failure["code"] == "GATE_ASSET_MISSING" for failure in report["failures"])


def test_a_plate_is_judged_against_the_dimensions_the_plan_asked_for(tmp_path: Path) -> None:
    plate = tmp_path / "assets" / "a_plate.mp4"
    plate.parent.mkdir(parents=True, exist_ok=True)
    plate.write_bytes(b"\x00\x00\x00\x18ftypmp42")

    good = evaluate_run(
        package(assets={"a_plate": {"kind": "video", "file": "assets/a_plate.mp4", "plannedFrames": 97}}),
        out_dir=tmp_path,
        probe=fake_probe(),
    )
    assert good["ok"] is True, good["failures"]
    assert good["assets"]["a_plate"]["kind"] == "plate"

    wrong = evaluate_run(
        package(assets={"a_plate": {"kind": "video", "file": "assets/a_plate.mp4", "plannedFrames": 241}}),
        out_dir=tmp_path,
        probe=fake_probe(),
    )
    assert wrong["ok"] is False
    assert any(failure["code"] == "GATE_PLATE_DIMS" for failure in wrong["failures"])


def test_a_drifted_palette_is_reported_not_ignored(tmp_path: Path) -> None:
    still(tmp_path / "assets" / "a_panel.png", left="#ff0000", right="#00ff00")
    report = evaluate_run(
        package(assets={"a_panel": {"kind": "svg", "file": "assets/a_panel.png"}}, width=96, height=64),
        out_dir=tmp_path,
    )

    assert report["ok"] is False
    assert any(failure["code"] == "GATE_PALETTE_DRIFT" for failure in report["failures"])


def test_a_plate_without_frames_says_the_motion_checks_were_skipped(tmp_path: Path) -> None:
    plate = tmp_path / "assets" / "a_plate.mp4"
    plate.parent.mkdir(parents=True, exist_ok=True)
    plate.write_bytes(b"\x00\x00\x00\x18ftypmp42")

    report = evaluate_run(
        package(assets={"a_plate": {"kind": "video", "file": "assets/a_plate.mp4"}}),
        out_dir=tmp_path,
        probe=fake_probe(),
    )

    checks = {check["id"] for check in report["assets"]["a_plate"]["checks"]}
    assert "media_dims" in checks
    assert "stationarity" not in checks, "a plate with no decoded frames cannot claim to be still"


def test_the_launch_demo_is_judged_as_a_package_with_assets(tmp_path: Path) -> None:
    doc = json.loads((LAUNCH_DEMO / "package.json").read_text(encoding="utf-8"))
    report = evaluate_run(doc, package_dir=LAUNCH_DEMO)

    # the demo ships SVGs, not produced PNGs: every asset is judged, and the missing renders are the
    # reason it does not pass - which is exactly what the reporter needs to see
    assert set(report["assets"]) == set(doc["assets"])
    assert report["ok"] is False, "the demo ships SVGs, not the renders: nothing judged can pass"
    assert all(asset["status"] == "source" for asset in report["assets"].values()), "its files are SVG sources"
    assert report["judged"] == 0, "an SVG source is not a render to judge"

    # and an asset with no file at all is a different kind of answer from a file that is not there
    with_ghost = dict(doc)
    with_ghost["assets"] = {**doc["assets"], "a_ghost": {"kind": "svg"}}
    report = evaluate_run(with_ghost, package_dir=LAUNCH_DEMO)
    assert report["assets"]["a_ghost"]["status"] == "no-file"
    assert report["assets"]["a_ghost"]["ok"] is None, "nothing to judge is not a failure, it is a hole"


def test_the_cli_prints_a_report_and_exits_nonzero_when_the_package_is_not_ok(tmp_path: Path) -> None:
    package_path = tmp_path / "package.json"
    package_path.write_text(
        json.dumps(package(assets={"a_ghost": {"kind": "svg", "file": "assets/a_ghost.png"}})),
        encoding="utf-8",
    )

    assert main(["--package", str(package_path), "--out", str(tmp_path)]) == 1
    still(tmp_path / "assets" / "a_panel.png")
    good_path = tmp_path / "good.json"
    good_path.write_text(
        json.dumps(package(assets={"a_panel": {"kind": "svg", "file": "assets/a_panel.png"}}, width=96, height=64)),
        encoding="utf-8",
    )
    assert main(["--package", str(good_path), "--out", str(tmp_path), "--json", "--quiet"]) == 0


def test_audio_is_named_and_left_alone(tmp_path: Path) -> None:
    """A real run's package carries the narration too (GPU test 5: a .wav under a still kind)."""
    (tmp_path / "audio").mkdir(parents=True, exist_ok=True)
    (tmp_path / "audio" / "narration.norm.wav").write_bytes(b"RIFF....WAVEfmt ")
    still(tmp_path / "assets" / "a_panel.png")
    report = evaluate_run(
        package(
            assets={
                "a_panel": {"kind": "svg", "file": "assets/a_panel.png"},
                "a_narration": {"kind": "audio", "file": "audio/narration.norm.wav"},
            },
            width=96,
            height=64,
        ),
        out_dir=tmp_path,
    )

    assert report["assets"]["a_narration"]["status"] == "not-judged"
    assert report["assets"]["a_narration"]["ok"] is None, "not judged is not a pass"
    assert report["not_judged"] == ["a_narration"]
    assert report["ok"] is True, report["failures"]


def test_a_render_that_cannot_be_read_is_a_failure_not_a_crash(tmp_path: Path) -> None:
    broken = tmp_path / "assets" / "a_panel.png"
    broken.parent.mkdir(parents=True, exist_ok=True)
    broken.write_bytes(b"this is not a png")

    report = evaluate_run(
        package(assets={"a_panel": {"kind": "svg", "file": "assets/a_panel.png"}}, width=96, height=64),
        out_dir=tmp_path,
    )

    assert report["ok"] is False
    assert report["assets"]["a_panel"]["status"] == "unreadable"
    assert any(failure["code"] == "GATE_ASSET_UNREADABLE" for failure in report["failures"])
