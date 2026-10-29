"""W1: the graph that was submitted is saved next to each still and plate.

The fake Comfy server records the workflow body. The file on disk must match
that body after secret-shaped strings are removed, and it must not contain the
token that was in the prompt. No UI-format workflow is written.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from comfyrizz_pipeline.capture import (
    redact_workflow,
    save_captured_workflow,
    sidecar_paths,
)

TOKEN = "hf_TESTTOKENTESTTOKEN"
SECRET_VALUE = "super-secret-value"


def _submitted(fake, job_id: str) -> dict:
    for entry in fake.requests("POST", "/api/v2/jobs"):
        body = entry.get("body") or {}
        if (body.get("metadata") or {}).get("comfyrizz_job") == job_id:
            graph = body.get("workflow")
            assert isinstance(graph, dict)
            return graph
    raise AssertionError(f"no submission for {job_id}")


def _assert_no_bare_colab(text: str) -> None:
    for match in re.finditer(r"colab", text, flags=re.IGNORECASE):
        prefix = text[max(0, match.start() - 7) : match.start()]
        assert prefix == "Google ", text[max(0, match.start() - 12) : match.end() + 12]


def test_redact_keeps_seed_prompt_and_model_and_drops_secrets(tmp_path: Path):
    graph = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "flux-3-image-klein-bf16.safetensors", "weight_dtype": "default"},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": f"a paper boat and a subway token, {TOKEN}",
                "clip": ["2", 0],
            },
        },
        "7": {
            "class_type": "KSampler",
            "inputs": {"seed": 7, "steps": 16, "api_key": SECRET_VALUE, "note": "https://user:s3cret-pass@example.com/x?token=abcdef123456"},
        },
    }
    cleaned, count = redact_workflow(graph)
    assert count >= 3
    blob = json.dumps(cleaned)
    assert TOKEN not in blob
    assert SECRET_VALUE not in blob
    assert "s3cret-pass" not in blob
    assert "abcdef123456" not in blob
    assert cleaned["7"]["inputs"]["seed"] == 7
    assert cleaned["7"]["inputs"]["api_key"] == "[redacted]"
    assert "subway token" in cleaned["4"]["inputs"]["text"]
    assert cleaned["1"]["inputs"]["unet_name"] == "flux-3-image-klein-bf16.safetensors"
    assert cleaned["4"]["inputs"]["clip"] == ["2", 0]
    saved = save_captured_workflow(tmp_path, "assets/a_still.png", graph, meta={"asset": "a_still", "job": "a_still.still", "kind": "still"})
    text = (tmp_path / saved["api"]).read_text(encoding="utf-8")
    readme = (tmp_path / saved["readme"]).read_text(encoding="utf-8")
    assert TOKEN not in text and TOKEN not in readme
    assert SECRET_VALUE not in text and SECRET_VALUE not in readme
    assert "drag-and-drop" in readme
    assert "API format" in readme
    assert "widget order" in readme
    _assert_no_bare_colab(readme)
    assert list(tmp_path.rglob("*.workflow.json")) == []
    with_escape = None
    try:
        sidecar_paths("../secrets.png")
        with_escape = True
    except ValueError:
        with_escape = False
    assert with_escape is False


def test_runner_saves_the_submitted_graph_without_secrets(make_runner, fake, out_dir: Path, workdir: Path):
    jobs_path = workdir / "jobs.json"
    doc = json.loads(jobs_path.read_text(encoding="utf-8"))
    still = next(job for job in doc["jobs"] if job["id"] == "a_cutout.still")
    still["params"]["prompt"] = f"a paper boat and a subway token, {TOKEN}"
    jobs_path.write_text(json.dumps(doc), encoding="utf-8")

    manifest = make_runner(fake, job_timeout=10.0).run()
    assert manifest["complete"] is True

    submitted = _submitted(fake, "a_cutout.still")
    submitted_blob = json.dumps(submitted)
    assert TOKEN in submitted_blob, "the server must receive the real prompt; redaction is only on disk"

    api = out_dir / "assets" / "a_cutout.workflow.api.json"
    readme = out_dir / "assets" / "a_cutout.workflow.md"
    assert api.is_file() and readme.is_file()
    saved = json.loads(api.read_text(encoding="utf-8"))
    cleaned, count = redact_workflow(submitted)
    assert count >= 1
    assert saved == cleaned
    on_disk = api.read_text(encoding="utf-8") + readme.read_text(encoding="utf-8")
    assert TOKEN not in on_disk
    assert SECRET_VALUE not in on_disk
    assert saved["3"]["inputs"]["seed"] == 7 or any(
        isinstance(node, dict) and (node.get("inputs") or {}).get("seed") == 7 for node in saved.values()
    )
    assert "subway token" in on_disk
    assert "drag-and-drop" in readme.read_text(encoding="utf-8")
    _assert_no_bare_colab(readme.read_text(encoding="utf-8"))

    plate = json.loads((out_dir / "assets" / "a_plate1.workflow.api.json").read_text(encoding="utf-8"))
    assert plate == _submitted(fake, "a_plate1.plate")
    assert (out_dir / "assets" / "a_plate1@2x.workflow.api.json").is_file()
    assert not (out_dir / "assets" / "a_narr.workflow.api.json").exists()
    assert list(out_dir.rglob("*.workflow.json")) == []

    by_id = {entry["job"]: entry for entry in manifest["jobs"]}
    assert by_id["a_cutout.still"]["outputs"][0]["workflow"] == "assets/a_cutout.workflow.api.json"
    assert by_id["a_cutout.still"]["outputs"][0]["workflow_submitted"] is True
    plate_provenance = by_id["a_plate1.plate"]["outputs"][0]
    assert plate_provenance["workflow_submitted"] is True
    for consumed in plate_provenance["conditioning_inputs"]:
        assert re.fullmatch(r"[a-f0-9]{64}", consumed["sha256"])
        assert plate[consumed["nodeId"]]["inputs"][consumed["input"]] == consumed["uploadedName"]
    assert "workflow" not in (by_id["a_narr.audio"]["outputs"][0] if by_id["a_narr.audio"]["outputs"] else {})


def test_a_cache_hit_keeps_the_captured_workflow(make_runner, servers, out_dir: Path, workdir: Path):
    first = servers()
    manifest = make_runner(first, job_timeout=10.0).run()
    assert manifest["complete"] is True
    api = out_dir / "assets" / "a_plate1.workflow.api.json"
    original = api.read_bytes()
    assert original

    second = servers()
    again = make_runner(second, job_timeout=10.0).run()
    assert again["counts"].get("cached") == 5
    assert second.submit_count() == 0
    assert all(output.get("workflow_submitted") is not True
               for entry in again["jobs"] for output in entry["outputs"])
    assert api.read_bytes() == original
    assert json.loads(api.read_text(encoding="utf-8")) == _submitted(first, "a_plate1.plate")
