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
    # CCL3c: `lora` / `lora_strength` select a trained character LoRA in character_lora_klein
    "still": {"prompt", "image", "reference", "_reference_2", "mask", "audio", "width", "height", "seed", "steps", "denoise", "megapixels", "cutout", "lora", "lora_strength"},
    # R1: `strength` (stage-1 LTXVImgToVideoInplace) and `stage2_strength` (the stage-2 one) are the
    # knobs that hold a UI/diagram frame still; the graph's own default is 0.7
    # RL12: the FastH3 Omni plate is a plate too, and it takes a voice reference as `audio`
    "plate": {"prompt", "image", "reference", "audio", "width", "height", "frames", "fps", "seed", "stage2_seed", "stage2_sigmas", "upscale", "strength", "stage2_strength"},
    "upscale": {"prompt", "image", "width", "height", "frames", "fps", "seed", "source", "upscale", "strength", "stage2_strength"},
    "audio": {"text", "voice", "speed", "language", "sample_rate"},
    # H17: the presenter graph takes the portrait as its first frame and the narration as its audio
    "presenter": {
        "prompt",
        "image",
        "reference",
        "audio",
        "width",
        "height",
        "frames",
        "fps",
        "seed",
        "strength",
        "stage2_seed",
        "stage2_sigmas",
        "stage2_strength",
    },
}

GRAPH_FILES = sorted(p for p in WORKFLOWS.glob("*.api.json") if not p.name.endswith(".params.json"))


def test_presenter_freezes_original_audio_in_both_sampling_stages():
    graph = json.loads((WORKFLOWS / "ltx25_a2v_2stage.api.json").read_text())
    for concat in ("10", "22"):
        frozen = graph[graph[concat]["inputs"]["audio_latent"][0]]
        assert frozen["class_type"] == "SetLatentNoiseMask"
        encoded = graph[frozen["inputs"]["samples"][0]]
        assert encoded["class_type"] == "LTXVAudioVAEEncode"
        mask = graph[frozen["inputs"]["mask"][0]]
        assert mask["class_type"] == "SolidMask"
        assert mask["inputs"]["value"] == 0
    assert graph["12"]["inputs"]["sampler_name"] == "euler"


#: The GPU-test-1 set the fixture package plans jobs for.
GPU1_WORKFLOWS = {
    "fasth3_omni_ref2va.api.json",
    "flux3_klein_t2i.api.json",
    "flux3_klein_img2img.api.json",
    "flux3_klein_ref_edit.api.json",
    "ltx25_a2v_2stage.api.json",
    "ltx25_i2v_2stage.api.json",
    "ltx25_t2v_2stage.api.json",
}
#: Character-creator workflows (CCL2a PuLID identity, CCL3c character LoRA). They are
#: contract-checked like the rest, but the GPU-test-1 fixture package does not plan jobs for them.
CHARACTER_WORKFLOWS = {
    "character_identity_pulid.api.json",
    "character_lora_klein.api.json",
}
TWO_REFERENCE_WORKFLOWS = {"flux3_klein_ref2_edit.api.json"}
#: RL12: the experimental FastH3 Omni reference-to-video+audio graph. The fixture package plans a
#: job for it, so it is contract-checked against the planner like the rest.
FASTH3_WORKFLOWS = {
    "fasth3_omni_ref2va.api.json",
}
FASTH3_NOCLIP_WORKFLOWS = {"fasth3_omni_ref2v_noclip.api.json"}


def test_the_committed_workflow_set_is_present():
    names = {p.name for p in GRAPH_FILES}
    assert names == GPU1_WORKFLOWS | CHARACTER_WORKFLOWS | FASTH3_WORKFLOWS | FASTH3_NOCLIP_WORKFLOWS | TWO_REFERENCE_WORKFLOWS, names


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


def test_the_text_flags_are_job_controls_not_node_inputs():
    """GPU test 3, N1: an older planner put `text`/`allowText` in params and the runner refused the
    whole job ("no params.json mapping for text") before it was ever submitted. They are plan-time
    flags, so injecting a job that still carries them must not raise."""
    assert {"text", "allowText"} <= CONTROL_PARAMS
    graph = {"6": {"class_type": "CLIPTextEncode", "inputs": {"text": "from the graph"}}}
    injected = inject_params(graph, {"prompt": ["6", "text"]}, {"prompt": "from the job", "text": True, "allowText": True})
    assert injected["6"]["inputs"]["text"] == "from the job"
    # and a genuinely unmapped parameter still fails loudly
    with pytest.raises(ValueError, match="no params.json mapping for textish"):
        inject_params({"6": {"class_type": "CLIPTextEncode", "inputs": {}}}, {"prompt": ["6", "text"]}, {"textish": 1})


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
    # This is an all-workflow contract fixture, including assets not placed in a scene.
    # Explicit roots exercise every graph without weakening production reachability.
    script = """
import { readFileSync, writeFileSync } from 'node:fs';
import { planJobs } from './packages/jobs/src/plan.mjs';
const pkg = JSON.parse(readFileSync(process.argv[1], 'utf8'));
writeFileSync(process.argv[2], JSON.stringify(planJobs(pkg, { assets: Object.keys(pkg.assets) })));
"""
    result = subprocess.run([NODE, "--input-type=module", "-e", script, str(package_path), str(target)], cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(target.read_text(encoding="utf-8"))


def test_the_fixture_package_is_valid_and_plans_jobs_for_every_workflow(tmp_path: Path):
    package = json.loads(PACKAGE.read_text(encoding="utf-8"))
    result = validate_package(package)
    assert result["errors"] == [], result["errors"]

    doc = plan(PACKAGE, tmp_path / "jobs.json")
    assert validate_jobs(doc) == []
    workflows_planned = {job["workflow"] for job in doc["jobs"]}
    expected = {f"workflows/{name}" for name in GPU1_WORKFLOWS | FASTH3_WORKFLOWS}
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


def test_two_reference_edit_injects_area_and_both_real_image_inputs(tmp_path: Path):
    package = json.loads(PACKAGE.read_text(encoding="utf-8"))
    package["assets"]["a_ref"]["gen"]["inputs"].pop("megapixels")
    package["assets"]["a_ref"]["gen"]["inputs"].update({"width": 1024, "height": 576, "reference_2": "a_i2i"})
    package_path = tmp_path / "package.json"
    package_path.write_text(json.dumps(package), encoding="utf-8")
    doc = plan(package_path, tmp_path / "jobs.json")
    assert validate_jobs(doc) == []
    job = next(entry for entry in doc["jobs"] if entry["asset"] == "a_ref")
    assert job["workflow"] == "workflows/flux3_klein_ref2_edit.api.json"
    assert job["params"]["megapixels"] == 0.589824
    assert not {"width", "height", "reference_2"} & set(job["params"])
    assert job["params"]["_reference_2"] == "a_i2i"
    assert {entry["param"] for entry in job["fileInputs"]} == {"reference", "_reference_2"}

    graph_path = REPO_ROOT / job["workflow"]
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    injected = inject_params(graph, load_params_map(graph_path), job["params"])
    assert injected["12"]["inputs"]["resolution.megapixels"] == 0.589824
    assert injected["10"]["inputs"]["image"] == "a_still"
    assert injected["11"]["inputs"]["image"] == "a_i2i"
    assert injected["12"]["inputs"]["images.image0"] == ["10", 0]
    assert injected["12"]["inputs"]["images.image1"] == ["11", 0]


def test_the_two_stage_maps_render_half_the_planned_size():
    """GPU test 2, issues 3 and 4: the graph's stage 1 is half the finished frame, and the i2v
    image scale is wired to the same value, so a planned size comes back as the planned size."""
    planned = {"width": 1024, "height": 576, "frames": 97, "fps": 30, "prompt": "x", "seed": 42, "stage2_seed": 43}
    for name, nodes in (("ltx25_i2v_2stage", ["8", "31"]), ("ltx25_t2v_2stage", ["8"]), ("ltx25_a2v_2stage", ["8", "31"])):
        graph_path = WORKFLOWS / f"{name}.api.json"
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
        inject_params(graph, load_params_map(graph_path), dict(planned))
        for node in nodes:
            assert graph[node]["inputs"]["width"] == 512, f"{name}: node {node} renders stage 1"
            assert graph[node]["inputs"]["height"] == 288, f"{name}: node {node} renders stage 1"
        assert graph["8"]["inputs"]["length"] == 97, f"{name}: no temporal upsampling, frames unchanged"
        assert graph["7"]["inputs"]["frame_rate"] == graph["42"]["inputs"]["fps"] == 30
        if "9" in graph:
            assert graph["9"]["inputs"]["frames_number"] == 97
            assert graph["9"]["inputs"]["frame_rate"] == 30

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


def test_ltx_template_defaults_are_valid_without_parameter_injection():
    for graph_path in WORKFLOWS.glob("ltx25_*_2stage.api.json"):
        graph = json.loads(graph_path.read_text())
        base = graph["8"]["inputs"]
        assert (base["width"], base["height"]) == (512, 288)
        assert base["width"] % 32 == base["height"] % 32 == 0
        assert base["length"] % 8 == 1
        if "31" in graph:
            assert graph["31"]["inputs"]["width"] == base["width"]
            assert graph["31"]["inputs"]["height"] == base["height"]


def test_upscale_map_renders_uncropped_lattice_and_keeps_audio_video_timing():
    doc = json.loads((FIXTURES / "jobs.json").read_text())
    job = next(entry for entry in doc["jobs"] if entry["kind"] == "upscale")
    graph_path = WORKFLOWS / "ltx25_i2v_2stage.api.json"
    graph = json.loads(graph_path.read_text())
    inject_params(graph, load_params_map(graph_path, "upscale"), {**job["params"], "fps": 30})
    for axis in ("width", "height"):
        base = graph["8"]["inputs"][axis]
        assert base % 32 == 0
        assert base * 2 == job["dims"][axis] == job["params"][axis]
        assert graph["31"]["inputs"][axis] == base
    assert graph["7"]["inputs"]["frame_rate"] == graph["9"]["inputs"]["frame_rate"] == graph["42"]["inputs"]["fps"] == 30


def test_a_parameter_with_no_mapping_is_refused_naming_it():
    graph_path = WORKFLOWS / "flux3_klein_t2i.api.json"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    mapping = load_params_map(graph_path)
    with pytest.raises(ValueError) as excinfo:
        inject_params(graph, mapping, {"prompt": "x", "vibe": "extra"})
    assert "vibe" in str(excinfo.value)
