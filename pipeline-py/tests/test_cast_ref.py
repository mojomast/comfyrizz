"""CAST1: a Klein reference edit uploads the cast member's ready ref file.

The TypeScript planner turns every still that names a cast member into
``workflows/flux3_klein_ref_edit.api.json``. This test plans that package and runs the real
runner against the local fake Comfy server. ``/upload/image`` receives the ref file's bytes,
and LoadImage (node 10) is given the server-side name.

When the still already names a style ref, that file stays image0 and the cast ref
is connected as image1 in the two-reference graph. Local graphs support at most
two connected references; uploading an unused source is not conditioning.

No GPU and no Google Colab. Scripted fakes only.
"""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from comfyrizz_pipeline.atomic import sha256_file
from comfyrizz_pipeline.client import ComfyClient, inject_params, load_params_map
from comfyrizz_pipeline.progress import ProgressWriter
from comfyrizz_pipeline.runner import Runner, RunnerConfig
from comfyrizz_pipeline.schema import validate_jobs, validate_package

from conftest import REPO_ROOT

PLANNER = REPO_ROOT / "packages" / "jobs" / "bin" / "plan-jobs.mjs"
EXAMPLE = REPO_ROOT / "examples" / "cast-mascot" / "package.json"
WORKFLOW = "flux3_klein_ref_edit.api.json"
NODE = shutil.which("node")
LOADIMAGE = "10"


def plan(package_path: Path, target: Path) -> dict:
    if NODE is None:
        pytest.skip("node is required to run the planner")
    result = subprocess.run(
        [NODE, str(PLANNER), str(package_path), "--out", str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(target.read_text(encoding="utf-8"))


def stage_workflow(work: Path) -> None:
    workflows = work / "workflows"
    workflows.mkdir(parents=True, exist_ok=True)
    source = REPO_ROOT / "workflows"
    for name in (WORKFLOW, "flux3_klein_ref2_edit.api.json"):
        shutil.copy(source / name, workflows / name)
        params = name.replace(".api.json", ".api.params.json")
        shutil.copy(source / params, workflows / params)


def runner_for(work: Path, fake) -> Runner:
    config = RunnerConfig(
        jobs_file=work / "jobs.json",
        out_dir=work / "out",
        poll_interval=0.05,
        job_timeout=10.0,
        reconcile_timeout=10.0,
        echo_progress=False,
        progress_path=work / "progress.jsonl",
    )
    client = ComfyClient(base_url=fake.base_url, timeout=5.0)
    writer = ProgressWriter(stream=io.StringIO(), echo=False, path=config.progress_path)
    return Runner(config, client=client, progress=writer)


def server_name(path: Path) -> str:
    return f"{path.stem}_{sha256_file(path)[:8]}{path.suffix}"


def test_the_mascot_example_uploads_its_synthetic_sheet(tmp_path: Path, servers):
    package = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    checked = validate_package(package)
    assert checked["errors"] == [], checked["errors"]

    work = tmp_path / "plan"
    work.mkdir()
    doc = plan(EXAMPLE, work / "jobs.json")
    assert validate_jobs(doc) == []
    stage_workflow(work)
    ref = work / "assets" / "pip.svg"
    ref.parent.mkdir(parents=True)
    shutil.copy(REPO_ROOT / "examples" / "cast-mascot" / "assets" / "pip.svg", ref)
    assert sha256_file(ref) == package["assets"]["a_pip"]["sha256"]

    graph = json.loads((work / "workflows" / WORKFLOW).read_text(encoding="utf-8"))
    mapping = load_params_map(work / "workflows" / WORKFLOW)
    stills = [job for job in doc["jobs"] if job["kind"] == "still"]
    assert [job["asset"] for job in stills] == ["a_intro", "a_next"]
    for job in stills:
        assert job["fileInputs"] == [{"param": "reference", "from": "package", "path": "assets/pip.svg"}]
        inject_params(json.loads(json.dumps(graph)), mapping, job["params"])

    fake = servers()
    manifest = runner_for(work, fake).run()
    assert manifest["counts"] == {"succeeded": 2}, manifest

    uploads = fake.upload_requests()
    assert len(uploads) == 1, uploads
    assert uploads[0]["sha256"] == hashlib.sha256(ref.read_bytes()).hexdigest()
    expected = server_name(ref)
    assert fake.submitted_input(LOADIMAGE) == [expected, expected]
    assert all(name != "a_pip" for name in fake.submitted_input(LOADIMAGE))


def test_style_and_cast_refs_condition_the_two_reference_graph_in_order(tmp_path: Path, servers):
    work = tmp_path / "styled"
    work.mkdir()
    stage_workflow(work)
    pip = work / "assets" / "pip.svg"
    style = work / "assets" / "style.png"
    pip.parent.mkdir(parents=True)
    pip.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#6d8cff"/></svg>',
        encoding="utf-8",
    )
    style.write_bytes(b"\x89PNG\r\n\x1a\n" + b"synthetic-style-ref" * 4)
    package = {
        "schemaVersion": 1,
        "revision": 1,
        "id": "pkg_caststyle0001",
        "title": "Styled Pip",
        "format": {"width": 1024, "height": 576, "fps": 30},
        "duration": {"mode": "target", "targetFrames": 120},
        "scenes": [
            {
                "id": "s1",
                "layout": "hero",
                "variant": "full-bleed",
                "copy": {"headline": "Pip"},
                "background": {"asset": "a_still"},
                "cast": ["c_pip"],
            }
        ],
        "cast": [{"id": "c_pip", "name": "Pip", "description": "Fictional mascot.", "ref_asset": "a_pip"}],
        "assets": {
            "a_pip": {
                "kind": "svg",
                "origin": "generated",
                "status": "ready",
                "file": "assets/pip.svg",
                "sha256": sha256_file(pip),
                "license": {"id": "CC0-1.0"},
                "redistributable": True,
                "gen": {"generator": "llm-svg", "sanitizer_version": "1.0.0", "render_check": {"ok": True}},
            },
            "a_style": {
                "kind": "image",
                "origin": "upload",
                "status": "ready",
                "file": "assets/style.png",
                "sha256": sha256_file(style),
                "license": {"id": "CC0-1.0"},
            },
            "a_still": {
                "kind": "image",
                "origin": "generated",
                "status": "pending",
                "cast": "c_pip",
                "gen": {
                    "generator": "flux3-klein",
                    "workflow": "workflows/flux3_klein_ref_edit.api.json",
                    "workflow_sha256": "ecf1b281737c8f3bad5afe7be79e76d7aa3595146b97a8df3e8098c21c080e09",
                    "inputs": {
                        "prompt": "Pip the fictional mascot, head and shoulders",
                        "reference": "a_style",
                        "seed": 3,
                        "steps": 16,
                    },
                },
            },
        },
        "compliance": {"open_weights_only": True},
    }
    package_path = work / "package.json"
    package_path.write_text(json.dumps(package), encoding="utf-8")
    doc = plan(package_path, work / "jobs.json")
    assert validate_jobs(doc) == []
    still = next(job for job in doc["jobs"] if job["asset"] == "a_still")
    assert still["params"]["reference"] == "a_style"
    assert still["params"]["_reference_2"] == "a_pip"
    assert still["workflow"] == "workflows/flux3_klein_ref2_edit.api.json"
    assert still["fileInputs"] == [
        {"param": "reference", "from": "package", "path": "assets/style.png"},
        {"param": "_reference_2", "from": "package", "path": "assets/pip.svg"},
    ]

    fake = servers()
    manifest = runner_for(work, fake).run()
    assert manifest["counts"] == {"succeeded": 1}, manifest
    uploads = {entry["sha256"] for entry in fake.upload_requests()}
    assert uploads == {sha256_file(style), sha256_file(pip)}
    assert fake.submitted_input(LOADIMAGE) == [server_name(style)]
    assert fake.submitted_input("11") == [server_name(pip)]
    assert server_name(pip) not in fake.submitted_input(LOADIMAGE)
