"""B4 contract test: the planner's jobs.json must be acceptable to each real workflow's
params map, and every map entry must point at a node input that actually exists.

This is the test that would have caught a params map written from memory: it plans a package
with the TypeScript planner, then feeds each planned job's resolved params through the same
`inject_params` the runner uses, against the real GPU-test-1 workflow graphs.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from comfyrizz_pipeline.client import CONTROL_PARAMS, inject_params, load_params_map
from comfyrizz_pipeline.schema import validate_jobs, validate_package

from conftest import FIXTURES, REPO_ROOT

WORKFLOWS = REPO_ROOT / "workflows"
PACKAGE = REPO_ROOT / "pipeline-py" / "tests" / "fixtures" / "package-gpu1-workflows.json"
PLANNER = REPO_ROOT / "packages" / "jobs" / "bin" / "plan-jobs.mjs"
NODE = shutil.which("node")

#: Parameter names the planner can emit for a job. A params map may only use these (or a
#: documented node-specific extra), so a typo cannot silently become a dead entry.
KNOWN_PARAMS = {
    "still": {"prompt", "image", "reference", "mask", "audio", "width", "height", "seed", "steps", "denoise", "megapixels", "cutout"},
    "plate": {"prompt", "image", "reference", "width", "height", "frames", "fps", "seed", "stage2_seed", "stage2_sigmas", "upscale"},
    "upscale": {"prompt", "image", "width", "height", "frames", "fps", "seed", "source", "upscale"},
    "audio": {"text", "voice", "speed", "language", "sample_rate"},
}

GRAPH_FILES = sorted(p for p in WORKFLOWS.glob("*.api.json") if not p.name.endswith(".params.json"))


def test_the_gpu_test_1_workflow_set_is_present():
    names = {p.name for p in GRAPH_FILES}
    assert names == {
        "flux3_klein_t2i.api.json",
        "flux3_klein_img2img.api.json",
        "flux3_klein_ref_edit.api.json",
        "ltx25_i2v_2stage.api.json",
        "ltx25_t2v_2stage.api.json",
    }, names


@pytest.mark.parametrize("graph_path", GRAPH_FILES, ids=[p.name for p in GRAPH_FILES])
def test_every_workflow_is_api_format_and_has_a_params_map(graph_path: Path):
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    assert isinstance(graph, dict) and graph, graph_path.name
    for ui_key in ("nodes", "links", "last_node_id", "extra"):
        assert ui_key not in graph, f"{graph_path.name} looks like a UI export ({ui_key} present)"
    for node_id, node in graph.items():
        assert "class_type" in node, f"{graph_path.name}: node {node_id} has no class_type"
        assert isinstance(node.get("inputs", {}), dict)

    params_path = graph_path.with_suffix(".params.json")
    assert params_path.is_file(), f"{graph_path.name} has no {params_path.name}"
    doc = json.loads(params_path.read_text(encoding="utf-8"))
    assert doc["v"] == 1
    assert doc["kind"] in KNOWN_PARAMS, doc["kind"]
    assert set(doc["map"]).issubset(KNOWN_PARAMS[doc["kind"]] | {"text"}), sorted(set(doc["map"]) - KNOWN_PARAMS[doc["kind"]])
    assert not set(doc["map"]) & CONTROL_PARAMS, "job-level controls are not node inputs"


@pytest.mark.parametrize("graph_path", GRAPH_FILES, ids=[p.name for p in GRAPH_FILES])
def test_every_mapped_target_exists_in_the_graph(graph_path: Path):
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    mapping = load_params_map(graph_path)
    assert mapping, f"{graph_path.name} maps nothing"
    for name, targets in mapping.items():
        for pair in targets:
            assert 2 <= len(pair) <= 3, f"{graph_path.name}: {name} -> {pair} is not [node_id, field] or [node_id, field, options]"
            node_id, field = str(pair[0]), str(pair[1])
            assert node_id in graph, f"{graph_path.name}: {name} points at missing node {node_id}"
            assert field in graph[node_id].get("inputs", {}), (
                f"{graph_path.name}: {name} points at {node_id}.{field}, which is not an input of "
                f"{graph_node_class(graph, node_id)}"
            )
            if len(pair) == 3:
                options = pair[2]
                assert isinstance(options, dict) and set(options) <= {"mul"}, (
                    f"{graph_path.name}: {name} -> {node_id}.{field} options {options!r} are not a known transform"
                )
                assert isinstance(graph[node_id]["inputs"][field], (int, float)) or options.get("mul") == 1, (
                    f"{graph_path.name}: {name} scales {node_id}.{field}, whose default is not a number"
                )


def graph_node_class(graph: dict, node_id: str) -> str:
    return graph.get(node_id, {}).get("class_type", "?")


def plan(package_path: Path, target: Path) -> dict:
    if NODE is None:
        pytest.skip("node is required to run the planner")
    result = subprocess.run([NODE, str(PLANNER), str(package_path), "--out", str(target)], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(target.read_text(encoding="utf-8"))


def test_the_fixture_package_is_valid_and_plans_jobs_for_every_workflow(tmp_path: Path):
    package = json.loads(PACKAGE.read_text(encoding="utf-8"))
    result = validate_package(package)
    assert result["errors"] == [], result["errors"]

    doc = plan(PACKAGE, tmp_path / "jobs.json")
    assert validate_jobs(doc) == []
    workflows_planned = {job["workflow"] for job in doc["jobs"]}
    expected = {f"workflows/{p.name}" for p in GRAPH_FILES}
    assert workflows_planned == expected, sorted(expected - workflows_planned)


def test_every_planned_job_injects_into_its_real_workflow(tmp_path: Path):
    """The contract: planner output -> the workflow's params map -> node inputs, no drops."""
    doc = plan(PACKAGE, tmp_path / "jobs.json")
    assert doc["jobs"], "the fixture must produce jobs"

    injected_total = 0
    for job in doc["jobs"]:
        graph_path = REPO_ROOT / job["workflow"]
        assert graph_path.is_file(), f"{job['workflow']} is not in the repository"
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
        mapping = load_params_map(graph_path)
        # raises ValueError naming any parameter with no mapping: that is the contract
        inject_params(graph, mapping, job.get("params", {}))
        injected_total += 1
        for name, targets in mapping.items():
            if name not in (job.get("params") or {}):
                continue
            for pair in targets:
                node_id, field = str(pair[0]), str(pair[1])
                options = pair[2] if len(pair) > 2 else None
                value = job["params"][name]
                if options and "mul" in options:
                    value = int(round(value * options["mul"]))
                assert graph[node_id]["inputs"][field] == value, (
                    f"{job['id']}: {name} did not reach {node_id}.{field}"
                )
    assert injected_total == len(doc["jobs"]) >= 5


def test_the_two_stage_maps_render_half_the_planned_size():
    """GPU test 2, issues 3 and 4: the graph's stage 1 is half the finished frame, and the i2v
    image scale is wired to the same value, so a planned size comes back as the planned size."""
    planned = {"width": 960, "height": 544, "frames": 97, "fps": 24, "prompt": "x", "seed": 42, "stage2_seed": 43}
    for name, nodes in (("ltx25_i2v_2stage", ["8", "31"]), ("ltx25_t2v_2stage", ["8"])):
        graph_path = WORKFLOWS / f"{name}.api.json"
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
        inject_params(graph, load_params_map(graph_path), dict(planned))
        for node in nodes:
            assert graph[node]["inputs"]["width"] == 480, f"{name}: node {node} renders stage 1"
            assert graph[node]["inputs"]["height"] == 272, f"{name}: node {node} renders stage 1"
        assert graph["8"]["inputs"]["length"] == 97, f"{name}: no temporal upsampling, frames unchanged"

    # the committed fixture plan states the same lattice, so the plan and the map cannot drift apart
    doc = json.loads((FIXTURES / "jobs.json").read_text(encoding="utf-8"))
    job = next(entry for entry in doc["jobs"] if entry["kind"] == "plate")
    assert job["stage1Dims"] == {"width": job["dims"]["width"] / 2, "height": job["dims"]["height"] / 2}
    # the fixture graph is a stand-in with its own node numbering; the real graph's map is what the
    # runner injects, so feed it this plan's params and read the stage-1 latent back
    graph_path = WORKFLOWS / "ltx25_i2v_2stage.api.json"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    inject_params(graph, load_params_map(graph_path), dict(job["params"]))
    assert graph["8"]["inputs"]["width"] == job["stage1Dims"]["width"]
    assert graph["8"]["inputs"]["height"] == job["stage1Dims"]["height"]


def test_a_parameter_with_no_mapping_is_refused_naming_it():
    graph_path = WORKFLOWS / "flux3_klein_t2i.api.json"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    mapping = load_params_map(graph_path)
    with pytest.raises(ValueError) as excinfo:
        inject_params(graph, mapping, {"prompt": "x", "vibe": "extra"})
    assert "vibe" in str(excinfo.value)
