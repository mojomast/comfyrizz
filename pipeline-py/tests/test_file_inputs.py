"""H-fix1: a graph that takes an input file is given a *server-side name* (GPU test 2, issue 2).

The whole path is exercised through the real runner against the local fake Comfy v2 server:

    jobs.json -> the runner resolves each file input (a dependency's output in the output
    directory, or a file shipped next to jobs.json) -> POST /upload/image -> the name the server
    returned is what the submitted graph carries at LoadImage.

The failure this prevents is specific: on the GPU test 2 run, ``a_plate1.plate`` handed
``LoadImage`` the *asset id*, and the server answered "Prompt outputs failed validation" only
after the Google Colab session had been billed.

No GPU, no network beyond loopback.
"""

from __future__ import annotations

import io
import json
import shutil
from pathlib import Path

import pytest

from comfyrizz_pipeline.atomic import sha256_file
from comfyrizz_pipeline.client import ComfyClient, load_file_params
from comfyrizz_pipeline.progress import ProgressWriter
from comfyrizz_pipeline.runner import Runner, RunnerConfig
from comfyrizz_pipeline.schema import validate_jobs
from fake_comfy import UPLOAD_PATH

from conftest import FIXTURES, load_jsonl

WORKFLOW_SHA = "0123456789abcdef" * 4
PLATE_SHA = "1234567890abcdef" * 4
#: the stub graphs use node 1 as LoadImage (ltx25_i2v) and node 8 as SaveImage
LTX_NODE_V0_LOADIMAGE = "1"

#: write the fixture stand-in for the fixture directory (a *.png is enough: the uploader only
#: hashes bytes, and the graph is never executed)
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"comfyrizz-fixture-raster" * 8


def still_job(**overrides) -> dict:
    asset = overrides.get("asset", "a_src")
    job = {
        "id": "a_src.still",
        "kind": "still",
        "batch": "stills",
        "asset": asset,
        "scene": "s1",
        "sceneIndex": 0,
        "generator": "flux3-klein",
        "workflow": "workflows/flux3_klein_t2i.api.json",
        "workflowSha256": WORKFLOW_SHA,
        "deps": [],
        # each job owns its own file: two stills that wrote the same path would collect over
        # each other and change the bytes an upload is keyed on
        "output": f"assets/{asset}.png",
        "outputKind": "image",
        "cacheKey": "c" * 64,
        "dims": {"width": 960, "height": 544},
        "params": {"prompt": "a woodland fox in tall grass", "width": 960, "height": 544, "seed": 1, "steps": 16},
    }
    job.update(overrides)
    return job


def plate_job(**overrides) -> dict:
    """An i2v plate that starts from the still above: the job fileInputs is about."""
    asset = overrides.get("asset", "a_plate")
    job = {
        "id": "a_plate.plate",
        "kind": "plate",
        "batch": "plates",
        "asset": asset,
        "scene": "s2",
        "sceneIndex": 1,
        "generator": "ltx25",
        "workflow": "workflows/i2v_declared.api.json",
        "workflowSha256": PLATE_SHA,
        "deps": ["a_src.still"],
        "output": f"out/intermediates/{asset}.plate.mp4",
        "outputKind": "video",
        "cacheKey": "d" * 64,
        "dims": {"width": 960, "height": 544},
        "frames": 97,
        "fps": 24,
        "fileInputs": [{"param": "image", "from": "job", "job": "a_src.still", "path": "assets/a_src.png"}],
        "params": {
            "prompt": "the fox breathes slowly, static camera",
            "image": "a_src",
            "width": 960,
            "height": 544,
            "frames": 97,
            "fps": 24,
            "seed": 42,
        },
    }
    job.update(overrides)
    return job


def jobs_doc(jobs: list[dict]) -> dict:
    batches = []
    for name in ("stills", "plates", "upscales", "audio"):
        ids = [job["id"] for job in jobs if job["batch"] == name]
        if ids:
            batches.append({"name": name, "jobs": ids})
    return {
        "v": 1,
        "packageId": "pkg_file_inputs",
        "revision": 1,
        "revisionHash": None,
        "fps": 24,
        "batches": batches,
        "jobs": jobs,
        "skipped": [],
        "hash": "f" * 64,
    }


def workspace(tmp_path: Path, doc: dict | None = None) -> Path:
    """A plan directory: jobs.json + workflows/.

    Two copies of the fixture i2v graph stand in for the real one: ``i2v_declared`` declares
    ``"files": ["image"]`` (what the runner requires of a graph with a LoadImage), and
    ``i2v_undeclared`` is the same map without that declaration, which is the mistake the
    "graph takes a file but does not say so" case is about.
    """
    workflows = tmp_path / "workflows"
    shutil.copytree(FIXTURES / "workflows", workflows)
    mapping = json.loads((workflows / "ltx25_i2v.api.params.json").read_text(encoding="utf-8"))
    undeclared = {key: value for key, value in mapping.items() if key != "files"}
    for name, params in (("i2v_declared", {**mapping, "files": ["image"]}), ("i2v_undeclared", undeclared)):
        shutil.copy(workflows / "ltx25_i2v.api.json", workflows / f"{name}.api.json")
        (workflows / f"{name}.api.params.json").write_text(json.dumps(params, indent=2), encoding="utf-8")
    (tmp_path / "jobs.json").write_text(json.dumps(doc if doc is not None else jobs_doc([still_job(), plate_job()]), indent=2), encoding="utf-8")
    return tmp_path


def write_raster(path: Path, data: bytes = PNG_BYTES) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def runner_for(work: Path, fake=None, **overrides) -> Runner:
    config = RunnerConfig(
        jobs_file=work / "jobs.json",
        out_dir=work / "out",
        poll_interval=0.05,
        job_timeout=10.0,
        reconcile_timeout=10.0,
        echo_progress=False,
        progress_path=work / "progress.jsonl",
    )
    for key, value in overrides.items():
        setattr(config, key, value)
    client = ComfyClient(base_url=fake.base_url if fake is not None else None, timeout=5.0)
    writer = ProgressWriter(stream=io.StringIO(), echo=False, path=config.progress_path)
    return Runner(config, client=client, progress=writer)


def result_for(manifest: dict, job_id: str) -> dict:
    entry = next(item for item in manifest["jobs"] if item["job"] == job_id)
    return entry


# --------------------------------------------------------------------------- the contract


def test_the_fixture_document_is_valid_and_declares_the_upload():
    doc = jobs_doc([still_job(), plate_job()])
    assert validate_jobs(doc) == []
    assert doc["jobs"][1]["fileInputs"] == [
        {"param": "image", "from": "job", "job": "a_src.still", "path": "assets/a_src.png"}
    ]


def test_the_declared_graph_says_which_parameters_are_files(tmp_path: Path):
    work = workspace(tmp_path)
    assert load_file_params(work / "workflows" / "i2v_declared.api.json") == ["image"]
    # the same map without the declaration: the runner refuses instead of passing a path through
    assert load_file_params(work / "workflows" / "i2v_undeclared.api.json") == []


# ------------------------------------------------------------------------- the upload path


def test_a_dependency_output_is_uploaded_and_its_name_is_injected(tmp_path: Path, servers):
    fake = servers()
    work = workspace(tmp_path)
    manifest = runner_for(work, fake).run()

    assert manifest["counts"] == {"succeeded": 2}, manifest
    source = work / "out" / "assets" / "a_src.png"
    assert source.is_file(), "the still job's output must be on disk before the plate needs it"

    uploads = fake.upload_requests()
    assert len(uploads) == 1, uploads
    expected = f"a_src_{sha256_file(source)[:8]}.png"
    assert uploads[0]["filename"] == expected
    assert uploads[0]["bytes"] == source.stat().st_size
    assert fake.state.uploads[expected]["sha256"] == sha256_file(source)

    # what each submitted graph was given at LoadImage: the still graph kept its own default,
    # the plate graph got the uploaded name - never the asset id "a_src"
    assert fake.submitted_input(LTX_NODE_V0_LOADIMAGE) == ["placeholder.png", expected]
    assert all(name != "a_src" for name in fake.submitted_input(LTX_NODE_V0_LOADIMAGE))

    # the failure is recorded in the progress stream as its own event
    events = [line["event"] for line in load_jsonl(work / "progress.jsonl")]
    assert "upload_done" in events


def test_two_jobs_that_need_the_same_bytes_upload_them_once(tmp_path: Path, servers):
    fake = servers()
    second = plate_job(id="a_plate2.plate", asset="a_plate2", cacheKey="e" * 64, output="out/intermediates/a_plate2.plate.mp4")
    work = workspace(tmp_path, jobs_doc([still_job(), plate_job(), second]))
    manifest = runner_for(work, fake).run()

    assert manifest["counts"] == {"succeeded": 3}, manifest
    assert len(fake.upload_requests()) == 1
    names = fake.submitted_input(LTX_NODE_V0_LOADIMAGE)
    assert names[1] == names[2] and names[1] != "placeholder.png"


def test_a_package_file_next_to_jobs_json_is_uploaded(tmp_path: Path, servers):
    """``from: "package"`` is how an SVG raster shipped with the bundle reaches the graph."""
    fake = servers()
    raster = write_raster(tmp_path / "assets" / "svg_raster.png")
    job = plate_job(
        id="a_svg.plate",
        asset="a_svg",
        deps=[],
        fileInputs=[{"param": "image", "from": "package", "path": "assets/svg_raster.png"}],
        params={**plate_job()["params"], "image": "assets/svg_raster.png"},
    )
    work = workspace(tmp_path, jobs_doc([job]))
    manifest = runner_for(work, fake).run()

    assert manifest["counts"] == {"succeeded": 1}, manifest
    expected = f"svg_raster_{sha256_file(raster)[:8]}.png"
    assert [entry["filename"] for entry in fake.upload_requests()] == [expected]
    assert fake.submitted_input(LTX_NODE_V0_LOADIMAGE) == [expected]


def test_img2img_gets_its_init_image_and_reference_edit_its_reference(tmp_path: Path, servers):
    """The two stills the GPU test 2 findings name: img2img (image) and reference edit (reference)."""
    fake = servers()
    i2i = still_job(
        id="a_i2i.still",
        asset="a_i2i",
        sceneIndex=1,
        workflow="workflows/flux3_klein_img2img.api.json",
        deps=["a_src.still"],
        cacheKey="1" * 64,
        fileInputs=[{"param": "image", "from": "job", "job": "a_src.still", "path": "assets/a_src.png"}],
        params={"prompt": "same scene, warmer", "image": "a_src", "width": 1344, "height": 768, "seed": 7, "steps": 16, "denoise": 0.6},
    )
    ref = still_job(
        id="a_ref.still",
        asset="a_ref",
        sceneIndex=2,
        workflow="workflows/flux3_klein_ref_edit.api.json",
        deps=["a_src.still"],
        cacheKey="2" * 64,
        fileInputs=[{"param": "reference", "from": "job", "job": "a_src.still", "path": "assets/a_src.png"}],
        params={"prompt": "restyle as soft clay, keep every label", "reference": "a_src", "megapixels": 1.0, "seed": 8, "steps": 16, "denoise": 1.0},
    )
    work = workspace(tmp_path, jobs_doc([still_job(), i2i, ref]))
    manifest = runner_for(work, fake).run()

    assert manifest["counts"] == {"succeeded": 3}, manifest
    # one upload of the still, and each graph's LoadImage (node 10) got the same server-side name
    assert len(fake.upload_requests()) == 1
    name = f"a_src_{sha256_file(work / 'out' / 'assets' / 'a_src.png')[:8]}.png"
    assert fake.submitted_input("10") == [None, name, name]
    # ... and nothing was handed the asset id
    assert all(entry != "a_src" for entry in fake.submitted_input("10"))


# ------------------------------------------------------------------------------ refusals


def test_a_missing_input_file_fails_the_job_without_submitting(tmp_path: Path, servers):
    fake = servers()
    job = plate_job(
        id="a_gone.plate",
        asset="a_gone",
        deps=[],
        fileInputs=[{"param": "image", "from": "package", "path": "assets/not_shipped.png"}],
    )
    work = workspace(tmp_path, jobs_doc([still_job(), job]))
    manifest = runner_for(work, fake).run()

    failed = result_for(manifest, "a_gone.plate")
    assert failed["status"] == "failed"
    assert failed["error"]["code"] == "input_file_missing"
    assert "assets/not_shipped.png" in failed["error"]["message"]
    assert manifest["counts"] == {"succeeded": 1, "failed": 1}, manifest
    # nothing was submitted for it, and no attempt record claims otherwise
    assert fake.state.submit_count("a_gone.plate") == 0
    assert fake.state.submit_count() == 1
    assert [a for a in runner_attempts(work) if a["job"] == "a_gone.plate"] == []
    assert fake.upload_requests() == []


def test_a_graph_that_takes_a_file_without_declaring_it_is_refused(tmp_path: Path, servers):
    fake = servers()
    work = workspace(tmp_path, jobs_doc([still_job(), plate_job(workflow="workflows/i2v_undeclared.api.json")]))
    manifest = runner_for(work, fake).run()

    refused = result_for(manifest, "a_plate.plate")
    assert refused["status"] == "failed"
    assert refused["error"]["code"] == "upload_not_declared"
    assert "files" in refused["error"]["message"]
    # the declaration is checked before anything is uploaded or submitted
    assert fake.upload_requests() == []
    assert fake.state.submit_count("a_plate.plate") == 0
    assert [a for a in runner_attempts(work) if a["job"] == "a_plate.plate"] == []


def test_a_server_without_the_upload_route_says_so_instead_of_failing_late(tmp_path: Path, servers):
    fake = servers(upload_status=404)
    work = workspace(tmp_path)
    manifest = runner_for(work, fake).run()

    upload_error = result_for(manifest, "a_plate.plate")
    assert upload_error["status"] == "failed"
    assert upload_error["error"]["code"] == "upload_unsupported"
    assert UPLOAD_PATH in upload_error["error"]["message"]
    assert fake.state.submit_count("a_plate.plate") == 0
    # the still, which needs no input file, still ran: a refusal is scoped to one job
    assert result_for(manifest, "a_src.still")["status"] == "succeeded"


def test_uploads_can_be_turned_off(tmp_path: Path, servers):
    fake = servers()
    work = workspace(tmp_path)
    manifest = runner_for(work, fake, uploads_enabled=False).run()

    blocked = result_for(manifest, "a_plate.plate")
    assert blocked["error"]["code"] == "upload_disabled"
    assert fake.upload_requests() == []
    assert fake.state.submit_count() == 1


# ------------------------------------------------------------------------- upload cache


def test_the_upload_cache_is_keyed_by_the_server(tmp_path: Path, servers):
    server_a, server_b = servers(), servers()
    work = workspace(tmp_path)
    raster = write_raster(work / "assets" / "staged.png")

    first = runner_for(work, server_a).upload_input(raster)
    assert len(server_a.upload_requests()) == 1

    # a new runner, same output directory: the name comes from the cache, not a second upload
    again = runner_for(work, server_a).upload_input(raster)
    assert again["name"] == first["name"]
    assert len(server_a.upload_requests()) == 1

    # a different server has an empty input directory, so the same bytes go up again
    third = runner_for(work, server_b).upload_input(raster)
    assert third["name"] == first["name"]
    assert third["url"].startswith(server_b.base_url)
    assert len(server_b.upload_requests()) == 1


def test_a_resubmitted_job_reuses_the_uploaded_name_without_uploading_again(tmp_path: Path, servers):
    """The retry story: one job's result cache entry is dropped (a re-run), the upload is not."""
    fake = servers()
    work = workspace(tmp_path)
    plan = json.loads((work / "jobs.json").read_text(encoding="utf-8"))
    runner_for(work, fake).run()
    assert len(fake.upload_requests()) == 1

    index_path = work / "out" / "cache" / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    plate_key = next(job["cacheKey"] for job in plan["jobs"] if job["id"] == "a_plate.plate")
    assert index["entries"].pop(plate_key), "the plate job must have a cached result to drop"
    index_path.write_text(json.dumps(index), encoding="utf-8")

    manifest = runner_for(work, fake).run()

    assert manifest["counts"] == {"succeeded": 1, "cached": 1}, manifest
    assert len(fake.upload_requests()) == 1, "the file is already in the server's input directory"
    events = [line["event"] for line in load_jsonl(work / "progress.jsonl")]
    assert "upload_cached" in events
    assert fake.submitted_input(LTX_NODE_V0_LOADIMAGE) == ["placeholder.png", "a_src_" + sha256_file(work / "out" / "assets" / "a_src.png")[:8] + ".png", "a_src_" + sha256_file(work / "out" / "assets" / "a_src.png")[:8] + ".png"]


def runner_attempts(work: Path) -> list[dict]:
    directory = work / "out" / "attempts"
    if not directory.is_dir():
        return []
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(directory.glob("*.json"))]
