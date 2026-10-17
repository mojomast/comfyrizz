"""N3 (GPU test 3): LTX plates must come back as one video file, not 97 PNG frames.

What happened on the real run: every LTX graph ended in ``SaveImage``, so ComfyUI wrote one PNG per
frame. The runner collected frame 0 as ``<id>.plate.mp4`` (PNG bytes behind a video name), hashed
that one frame, and the package recorded a ``video`` asset pointing at a PNG. Kyle verified the fix
on the GPU: append ``CreateVideo(fps)`` -> ``SaveVideo(mp4, h264)`` and the same job returns a single
1024x576 h264 mp4 (7.5 s, ``logs/n3_savevideo.log``).

Three things are checked here, all on CPU against the local fake server:

1. the graphs: both two-stage LTX graphs end in ``SaveVideo`` fed by ``CreateVideo``, with the exact
   inputs ComfyUI's schema declares at the ref the GPU runs used (``ce1e922``), and the plan's
   ``fps`` reaches the container as well as the conditioning node;
2. the bytes decide the kind: a download is labelled from its magic bytes, and what the server
   claimed is kept beside it (the SDK reports a ``SaveVideo`` mp4 as ``image``);
3. the guard: a job whose declared ``outputKind`` disagrees with the bytes it got fails with
   ``output_kind_mismatch``, the unusable file is removed and nothing is cached, so a retry re-runs
   it instead of handing the renderer a PNG called a video.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from comfyrizz_pipeline.client import sniff_kind
from comfyrizz_pipeline.runner import Runner

from conftest import REPO_ROOT, load_jsonl
from test_file_inputs import jobs_doc, plate_job, still_job, workspace, write_raster
from test_upload_endpoint import runner_without_a_client

WORKFLOWS = REPO_ROOT / "workflows"
LTX_GRAPHS = ("ltx25_i2v_2stage", "ltx25_t2v_2stage")

#: The inputs ComfyUI declares at the ref the GPU runs used (ce1e922, comfy_extras/nodes_video.py):
#:   CreateVideo(images, fps, audio?, bit_depth?, color_space?, codec?)
#:   SaveVideo(video, filename_prefix, format, codec?)
#: A node input the server does not have makes the whole graph invalid, so this list is the contract.
CREATE_VIDEO_INPUTS = {"images", "fps"}
SAVE_VIDEO_REQUIRED = {"video", "filename_prefix", "format"}

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MP4_MAGIC = b"\x00\x00\x00\x18ftypmp42"
WAV_MAGIC = b"RIFF" + (1024).to_bytes(4, "little") + b"WAVE"


# ------------------------------------------------------------------- the sniffer itself


def test_the_bytes_decide_the_kind(tmp_path: Path):
    cases = {
        "a.png": (PNG_MAGIC + b"x" * 32, "image"),
        "a.jpg": (b"\xff\xd8\xff\xe0" + b"x" * 32, "image"),
        "a.mp4": (MP4_MAGIC + b"x" * 32, "video"),
        "a.mov": (b"\x00\x00\x00\x14ftypqt  " + b"x" * 32, "video"),
        "a.webm": (b"\x1a\x45\xdf\xa3" + b"x" * 32, "video"),
        "a.wav": (WAV_MAGIC + b"x" * 32, "audio"),
        "a.weird": (b"COMFYRIZZ-FAKE-OUTPUT-0001-" * 4, None),
    }
    for name, (payload, expected) in cases.items():
        path = tmp_path / name
        path.write_bytes(payload)
        assert sniff_kind(path) == expected, name
    assert sniff_kind(tmp_path / "missing.png") is None


# ------------------------------------------------------------------- the graphs themselves


def test_the_ltx_graphs_end_in_savevideo_not_saveimage():
    for name in LTX_GRAPHS:
        graph = json.loads((WORKFLOWS / f"{name}.api.json").read_text(encoding="utf-8"))
        kinds = {node_id: node["class_type"] for node_id, node in graph.items()}
        assert "SaveImage" not in kinds.values(), f"{name} still writes one PNG per frame"
        savers = [node_id for node_id, kind in kinds.items() if kind == "SaveVideo"]
        assert len(savers) == 1, f"{name}: exactly one SaveVideo"
        saver = graph[savers[0]]
        assert SAVE_VIDEO_REQUIRED <= set(saver["inputs"]), saver["inputs"]
        assert saver["inputs"]["format"] == "mp4" and saver["inputs"]["codec"] == "h264"
        # the video it saves is built from the decoded frames, by CreateVideo
        creator_id = saver["inputs"]["video"][0]
        creator = graph[creator_id]
        assert creator["class_type"] == "CreateVideo"
        assert set(creator["inputs"]) <= CREATE_VIDEO_INPUTS
        assert creator["inputs"]["images"][0] == "40", "the frames come from VAEDecodeTiled(40)"
        assert creator["inputs"]["fps"] == 24.0


def test_the_plan_fps_reaches_the_container_too():
    for name in LTX_GRAPHS:
        mapping = json.loads((WORKFLOWS / f"{name}.api.params.json").read_text(encoding="utf-8"))["map"]
        assert ["42", "fps"] in mapping["fps"], f"{name}: CreateVideo's fps is unmapped"
        assert ["7", "frame_rate"] in mapping["fps"], f"{name}: the conditioning node still gets it"


# --------------------------------------------------------------- the guard, against the fake


def test_a_png_offered_as_a_plate_is_refused_and_not_cached(tmp_path: Path, servers):
    """The N3 failure mode, exactly: PNG bytes in the file the plan calls a plate."""
    fake = servers(output_kind="video", bytes_kind="image")
    work = workspace(tmp_path, jobs_doc([still_job(), plate_job()]))
    manifest = runner_without_a_client(work, base_url=fake.base_url).run()

    plate = next(entry for entry in manifest["jobs"] if entry["job"] == "a_plate.plate")
    assert plate["status"] == "failed", plate
    assert plate["error"]["code"] == "output_kind_mismatch"
    assert "89 50 4e 47 0d 0a 1a 0a" in plate["error"]["message"], "the message names the bytes"
    assert "image bytes for a video output" in plate["error"]["message"]

    # the file the renderer would have been handed is gone, and so is any cache entry
    assert list((work / "out").rglob("*.plate.mp4")) == [], "the unusable file was removed"
    cache = json.loads((work / "out" / "cache" / "index.json").read_text(encoding="utf-8"))
    assert "d" * 64 not in cache["entries"], "nothing was cached for the refused plate"
    assert "c" * 64 in cache["entries"], "the still that DID produce an image is cached"
    events = [event["event"] for event in load_jsonl(work / "progress.jsonl")]
    assert "job_failed" in events and "job_done" in events  # the still still succeeded


def test_an_mp4_the_server_calls_an_image_is_recorded_as_a_video(tmp_path: Path, servers):
    """The other half of N3: the SDK's kind is a claim, and the bytes win.

    A plate-only plan, so the only thing under test is the disagreement between the server's
    ``type`` and the file's magic bytes.
    """
    fake = servers(output_kind="image", bytes_kind="video")
    plate = plate_job(
        deps=[],
        fileInputs=[{"param": "image", "from": "package", "path": "assets/a_src.png"}],
    )
    work = workspace(tmp_path, jobs_doc([plate]))
    write_raster(work / "assets" / "a_src.png")
    manifest = runner_without_a_client(work, base_url=fake.base_url).run()

    entry = next(item for item in manifest["jobs"] if item["job"] == "a_plate.plate")
    assert entry["status"] == "succeeded", entry
    output = entry["outputs"][0]
    assert output["kind"] == "video", output
    assert output["reportedKind"] == "image", "what the server claimed is kept, not believed"
    assert Path(output["file"]).read_bytes()[:12] == MP4_MAGIC
    assert entry["attempt_id"]


def test_a_still_that_gets_video_bytes_is_refused_as_well(tmp_path: Path, servers):
    """The guard is symmetric: a plate's frames are no more a still than a still is a video."""
    fake = servers(output_kind="image", bytes_kind="video")
    work = workspace(tmp_path, jobs_doc([still_job()]))
    manifest = runner_without_a_client(work, base_url=fake.base_url).run()

    still = next(entry for entry in manifest["jobs"] if entry["job"] == "a_src.still")
    assert still["status"] == "failed", still
    assert still["error"]["code"] == "output_kind_mismatch"
    assert list((work / "out").rglob("a_src.png")) == []


def test_an_unrecognised_container_is_left_to_the_server(tmp_path: Path, servers):
    """The fake's default bytes are not any format: no sniff, so no accusation."""
    fake = servers()  # arbitrary bytes, output_kind image
    work = workspace(tmp_path, jobs_doc([still_job()]))
    manifest = runner_without_a_client(work, base_url=fake.base_url).run()

    still = next(entry for entry in manifest["jobs"] if entry["job"] == "a_src.still")
    assert still["status"] == "succeeded", still
    output = still["outputs"][0]
    assert output["kind"] == "image" and "reportedKind" not in output


def test_the_guard_is_off_when_the_plan_declares_nothing(tmp_path: Path, servers):
    fake = servers(bytes_kind="image")
    job = still_job()
    job.pop("outputKind", None)
    work = workspace(tmp_path, jobs_doc([job]))
    runner = runner_without_a_client(work, base_url=fake.base_url)
    manifest = runner.run()

    still = next(entry for entry in manifest["jobs"] if entry["job"] == "a_src.still")
    assert still["status"] == "succeeded", still
    assert still["outputs"][0]["kind"] == "image"


def test_the_runner_is_the_only_thing_that_changed_about_kinds():
    """A guard against the fixture drifting away from what these tests assume."""
    doc = jobs_doc([still_job(), plate_job()])
    kinds = {job["id"]: job["outputKind"] for job in doc["jobs"]}
    assert kinds == {"a_src.still": "image", "a_plate.plate": "video"}
    assert Runner is not None and pytest is not None
