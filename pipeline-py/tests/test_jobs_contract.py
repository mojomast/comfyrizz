"""B2 contract test: the planner (TypeScript) and the runner (Python) agree on one artifact.

The runner's fixture ``tests/fixtures/jobs.json`` *is* the planner's output for
``packages/jobs/test/fixtures/package-pending.json``. This test re-plans it with node and
requires the bytes to match, so a change to either side that breaks the contract fails
here rather than on a GPU session. It also recomputes the document hash in Python, which
proves both languages hash the same canonical form.
"""

from __future__ import annotations

import json
import copy
import shutil
import subprocess
from pathlib import Path

import pytest

from comfyrizz_pipeline.atomic import canonical_hash
from comfyrizz_pipeline.schema import validate_jobs

from conftest import FIXTURES, REPO_ROOT

NODE = shutil.which("node")
PLANNER = REPO_ROOT / "packages" / "jobs" / "bin" / "plan-jobs.mjs"
PACKAGE = REPO_ROOT / "packages" / "jobs" / "test" / "fixtures" / "package-pending.json"
COMMITTED = FIXTURES / "jobs.json"


def test_the_runner_fixture_is_a_valid_jobs_document():
    doc = json.loads(COMMITTED.read_text())
    assert validate_jobs(doc) == []
    assert [job["id"] for job in doc["jobs"]] == [
        "a_cutout.still",
        "a_plate1_still.still",
        "a_plate1.plate",
        "a_plate1.upscale",
        "a_narr.audio",
    ]
    assert [batch["name"] for batch in doc["batches"]] == ["stills", "plates", "upscales", "audio"]
    assert doc["skipped"] and "llm-svg" in doc["skipped"][0]["reason"]


def test_python_recomputes_the_planner_hash():
    doc = json.loads(COMMITTED.read_text())
    assert canonical_hash({**doc, "hash": None}) == doc["hash"], "the two languages disagree on the canonical form"


@pytest.mark.parametrize("override", ["third_param", "images", "third_file", "duplicate_file", "single_graph", "custom_map", "alias_collision"])
def test_direct_jobs_refuse_unconnected_klein_references(override):
    doc = json.loads(COMMITTED.read_text())
    job = next(job for job in doc["jobs"] if job["generator"] == "flux3-klein")
    job["workflow"] = "workflows/flux3_klein_ref2_edit.api.json"
    job["params"] = {"reference": "first.png", "_reference_2": "second.png"}
    job["fileInputs"] = [
        {"param": "reference", "from": "package", "path": "assets/first.png"},
        {"param": "_reference_2", "from": "package", "path": "assets/second.png"},
    ]
    assert validate_jobs(doc) == []
    if override == "third_param":
        job["params"]["_reference_3"] = "third.png"
    elif override == "images":
        job["params"]["images"] = ["first.png", "second.png", "third.png"]
    elif override == "third_file":
        job["fileInputs"].append({"param": "_reference_3", "from": "package", "path": "assets/third.png"})
    elif override == "duplicate_file":
        job["fileInputs"].append(copy.deepcopy(job["fileInputs"][0]))
    elif override == "single_graph":
        job["workflow"] = "workflows/flux3_klein_ref_edit.api.json"
    elif override == "custom_map":
        job["paramsSource"] = "custom"
    else:
        job["params"]["image"] = "third.png"
    assert any(problem["code"] == "JOBS_KLEIN_REFERENCE_UNSUPPORTED" for problem in validate_jobs(doc))


def test_ref_edit_parameter_maps_only_declare_connected_uploads():
    for name in ("flux3_klein_ref_edit", "flux3_klein_ref2_edit"):
        graph = json.loads((REPO_ROOT / "workflows" / f"{name}.api.json").read_text())
        mapping = json.loads((REPO_ROOT / "workflows" / f"{name}.api.params.json").read_text())
        for param in mapping["files"]:
            node, field = mapping["map"][param]
            assert field == "image"
            assert graph[node]["class_type"] == "LoadImage"
            assert [node, 0] in graph["12"]["inputs"].values()


@pytest.mark.skipif(NODE is None, reason="node is required to re-run the planner")
def test_the_committed_jobs_json_is_current(tmp_path: Path):
    target = tmp_path / "jobs.json"
    planned = subprocess.run(
        [NODE, str(PLANNER), str(PACKAGE), "--out", str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert planned.returncode == 0, planned.stderr
    fresh = json.loads(target.read_text())
    committed = json.loads(COMMITTED.read_text())
    assert fresh["hash"] == committed["hash"], "re-planning produced a different hash"
    assert fresh == committed, "the committed fixture is stale: re-run the planner and commit it"
    checked = subprocess.run(
        [NODE, str(PLANNER), str(PACKAGE), "--out", str(COMMITTED), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert checked.returncode == 0, f"{checked.stdout}{checked.stderr}"
    assert "jobs.json is current" in checked.stdout
