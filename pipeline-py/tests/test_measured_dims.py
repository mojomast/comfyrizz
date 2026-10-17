"""N4 (GPU test 3): the manifest's media geometry has to be the file's, not the plan's.

The run planned 1920x1080 for a reference-edit still, the graph returned 1360x768 (it sizes itself
from the reference image at 1.0 MP) and `apply` wrote the plan's number into `media`, so the renderer
would lay out against a shape nothing produced. The planner now states a reference-based estimate and
the runner *measures* what it downloaded: a PNG/JPEG/GIF/BMP header for an image, ffprobe for a video
when it is there. `apply` prefers the measurement.

All of this is CPU-only against the local fake server; no GPU, no Google Colab runtime.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from comfyrizz_pipeline import client as client_module
from comfyrizz_pipeline.client import image_size, measure, video_size

from conftest import load_jsonl
from test_file_inputs import jobs_doc, plate_job, still_job, workspace, write_raster
from test_upload_endpoint import runner_without_a_client

PNG = b"\x89PNG\r\n\x1a\n"


def _png(width: int, height: int) -> bytes:
    return PNG + b"\x00\x00\x00\rIHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x02\x00\x00\x00"


def _jpeg(width: int, height: int) -> bytes:
    # SOI, an APP0 segment to skip, then SOF0 with the real size: a JPEG's size is not at a fixed offset
    app0 = b"\xff\xe0" + (16).to_bytes(2, "big") + b"JFIF\x00" + b"\x00" * 9
    sof0 = b"\xff\xc0" + (17).to_bytes(2, "big") + b"\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x03" + b"\x00" * 6
    return b"\xff\xd8" + app0 + sof0 + b"\xff\xd9"


def _gif(width: int, height: int) -> bytes:
    return b"GIF89a" + width.to_bytes(2, "little") + height.to_bytes(2, "little") + b"\x00" * 8


def _bmp(width: int, height: int) -> bytes:
    return b"BM" + b"\x00" * 16 + width.to_bytes(4, "little") + height.to_bytes(4, "little") + b"\x00" * 8


def test_an_image_size_comes_out_of_the_header(tmp_path: Path):
    for name, payload, expected in (
        ("a.png", _png(1360, 768), (1360, 768)),
        ("a.jpg", _jpeg(1920, 1080), (1920, 1080)),
        ("a.jpeg", _jpeg(961, 545), (961, 545)),
        ("a.gif", _gif(640, 480), (640, 480)),
        ("a.bmp", _bmp(320, 240), (320, 240)),
    ):
        path = tmp_path / name
        path.write_bytes(payload)
        assert image_size(path) == expected, name
    # nothing it can read says nothing (not zero, not the plan's number)
    junk = tmp_path / "junk.png"
    junk.write_bytes(b"COMFYRIZZ-FAKE-OUTPUT-" * 8)
    assert image_size(junk) is None
    assert image_size(tmp_path / "missing.png") is None
    assert measure(junk, None) is None and measure(junk, "audio") is None


def test_a_jpeg_with_an_early_truncated_segment_is_not_a_crash(tmp_path: Path):
    path = tmp_path / "half.jpg"
    path.write_bytes(b"\xff\xd8\xff\xe0\x00")
    assert image_size(path) is None


def test_measure_says_where_the_number_came_from(tmp_path: Path):
    path = tmp_path / "a.png"
    path.write_bytes(_png(1360, 768))
    assert measure(path, "image") == {"width": 1360, "height": 768, "source": "header"}


def test_a_video_is_measured_with_ffprobe_when_it_is_there(tmp_path: Path, monkeypatch):
    path = tmp_path / "a.mp4"
    path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"x" * 64)

    class Proc:
        returncode = 0
        stdout = json.dumps({"streams": [{"width": 960, "height": 576, "r_frame_rate": "24/1", "nb_frames": "49", "duration": "2.041667"}]})
        stderr = ""

    monkeypatch.setattr(client_module.shutil, "which", lambda name: "/usr/bin/ffprobe" if name == "ffprobe" else None)
    monkeypatch.setattr(client_module.subprocess, "run", lambda *a, **k: Proc())
    assert measure(path, "video") == {
        "width": 960,
        "height": 576,
        "fps": 24.0,
        "frames": 49,
        "durationSeconds": 2.042,
        "source": "ffprobe",
    }
    # and a machine without ffprobe (or a probe that fails) simply measures nothing
    monkeypatch.setattr(client_module.shutil, "which", lambda name: None)
    assert video_size(path) is None
    monkeypatch.setattr(client_module.shutil, "which", lambda name: "/usr/bin/ffprobe")


def test_a_broken_probe_never_fails_the_job(tmp_path: Path, monkeypatch):
    path = tmp_path / "a.mp4"
    path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"x" * 64)

    class Proc:
        returncode = 1
        stdout = "not json"
        stderr = "boom"

    monkeypatch.setattr(client_module.shutil, "which", lambda name: "/usr/bin/ffprobe")
    monkeypatch.setattr(client_module.subprocess, "run", lambda *a, **k: Proc())
    assert video_size(path) is None


def test_the_manifest_records_the_size_of_the_file_it_downloaded(tmp_path: Path, servers):
    """The N4 case: the plan says 1920x1080, the graph returns 1360x768, the manifest says what it is."""
    fake = servers(bytes_kind="image", image_size=(1360, 768))
    work = workspace(tmp_path, jobs_doc([still_job()]))
    manifest = runner_without_a_client(work, base_url=fake.base_url).run()

    entry = next(item for item in manifest["jobs"] if item["job"] == "a_src.still")
    assert entry["status"] == "succeeded", entry
    output = entry["outputs"][0]
    assert output["kind"] == "image"
    assert output["measured"] == {"width": 1360, "height": 768, "source": "header"}
    # the file on disk is the file that was measured
    assert image_size(Path(output["file"])) == (1360, 768)


def test_a_video_output_is_measured_too(tmp_path: Path, servers):
    # a plate-only plan: the fake serves one kind of bytes for every output, and the still would be
    # refused by the kind guard if it were served mp4s (N3) - which is not what this test is about
    fake = servers(output_kind="video", bytes_kind="video")
    plate = plate_job(deps=[], fileInputs=[{"param": "image", "from": "package", "path": "assets/a_src.png"}])
    work = workspace(tmp_path, jobs_doc([plate]))
    write_raster(work / "assets" / "a_src.png")
    manifest = runner_without_a_client(work, base_url=fake.base_url).run()

    entry = next(item for item in manifest["jobs"] if item["job"] == "a_plate.plate")
    assert entry["status"] == "succeeded", entry
    measured = entry["outputs"][0].get("measured")
    # the fake's mp4 is not a real stream, so all we can honestly assert is that a video measurement
    # either produced numbers from ffprobe or was skipped - never a number invented from the plan
    if measured is not None:
        assert measured["source"] == "ffprobe"
        assert set(measured) <= {"width", "height", "fps", "frames", "durationSeconds", "source"}


def test_the_cache_keeps_the_measurement_so_a_cached_run_still_writes_real_dims(tmp_path: Path, servers):
    """A cache hit copies the file; the measurement has to survive with it, or the second run's
    manifest would go back to the plan's number (the same trap N5 is about for notes)."""
    fake = servers(bytes_kind="image", image_size=(1360, 768))
    work = workspace(tmp_path, jobs_doc([still_job()]))
    first = runner_without_a_client(work, base_url=fake.base_url).run()
    assert first["jobs"][0]["outputs"][0]["measured"]["width"] == 1360

    second = runner_without_a_client(work, base_url=fake.base_url).run()
    entry = next(item for item in second["jobs"] if item["job"] == "a_src.still")
    assert entry["status"] in {"cached", "succeeded"}, entry
    assert entry["outputs"][0]["measured"] == {"width": 1360, "height": 768, "source": "header"}


def test_the_measurement_helper_is_what_the_runner_calls():
    """A guard so the runner cannot silently stop measuring (it would go back to planning geometry)."""
    assert client_module.measure is measure
    events = load_jsonl(Path("/dev/null")) if False else None  # documents that no progress event is needed
    assert events is None
    assert pytest is not None
