"""H9 (GPU test 4 dry run): a batch is submitted producer first, whatever order the plan lists.

The GPU test 4 dry run planned three stills into one batch with the *consumers* listed ahead of the
producer they upload:

    batches = [{"name": "stills", "jobs": ["a_ref.still", "a_i2i.still", "a_still.still"]}]

``a_ref.still`` uploads ``assets/a_still.png`` as its reference image, and the runner submits a batch
in list order, so the upload found no file and two jobs failed with ``input_file_missing`` on a plan
whose dependency graph was perfectly correct. The planner's order is not an execution order: the
runner owns the batch, so the runner orders it (``deps``, producers first, stable otherwise).

No GPU, no network beyond loopback.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from conftest import load_jsonl

WORKFLOW_SHA = "0123456789abcdef" * 4


def plate_job(name: str, deps: list[str], file_inputs: list[dict] | None = None) -> dict:
    """One plate in the ``plates`` batch; ``file_inputs`` is how it consumes a sibling's output."""
    job = {
        "id": f"{name}.plate",
        "kind": "plate",
        "batch": "plates",
        "asset": name,
        "scene": "s1",
        "sceneIndex": 0,
        "generator": "ltx25",
        "workflow": "workflows/i2v_declared.api.json",
        "workflowSha256": WORKFLOW_SHA,
        "deps": deps,
        "output": f"out/intermediates/{name}.plate.mp4",
        "outputKind": "video",
        "cacheKey": (name.encode().hex() * 8)[:64],
        "dims": {"width": 960, "height": 544},
        "frames": 97,
        "fps": 24,
        "params": {
            "prompt": f"the {name} shot, static camera",
            "width": 960,
            "height": 544,
            "frames": 97,
            "fps": 24,
            "seed": 3,
        },
    }
    if file_inputs:
        job["fileInputs"] = file_inputs
        job["params"]["image"] = file_inputs[0]["job"].split(".")[0]
    return job


def plan_listing_consumers_first() -> dict:
    """The plan that broke the dry run: consumers ahead of their producer, all in one batch."""
    source = plate_job("a_src", [])
    return {
        "v": 1,
        "packageId": "pkg_batch_order",
        "revision": 1,
        "revisionHash": None,
        "fps": 24,
        "batches": [{"name": "plates", "jobs": ["a_ref.plate", "a_i2i.plate", "a_src.plate"]}],
        "jobs": [
            plate_job("a_ref", ["a_src.plate"], [{"param": "image", "from": "job", "job": "a_src.plate", "path": "out/intermediates/a_src.plate.mp4"}]),
            plate_job("a_i2i", ["a_src.plate"], [{"param": "image", "from": "job", "job": "a_src.plate", "path": "out/intermediates/a_src.plate.mp4"}]),
            source,
        ],
        "skipped": [],
        "hash": "a" * 64,
    }


def prepare(workdir: Path, doc: dict) -> Path:
    """The plan directory the runner expects: jobs.json plus the graphs it names."""
    workflows = workdir / "workflows"
    if not (workflows / "i2v_declared.api.json").exists():
        # the fixture i2v graph with the file input *declared*, which is what a job that uploads a
        # sibling's output needs (test_file_inputs builds the same stand-in)
        declared = json.loads((workflows / "ltx25_i2v.api.params.json").read_text(encoding="utf-8"))
        declared["files"] = ["image"]
        shutil.copy(workflows / "ltx25_i2v.api.json", workflows / "i2v_declared.api.json")
        (workflows / "i2v_declared.api.params.json").write_text(json.dumps(declared, indent=2), encoding="utf-8")
    (workdir / "jobs.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return workdir


def test_a_batch_is_submitted_producer_first(workdir: Path, fake, make_runner):
    prepare(workdir, plan_listing_consumers_first())
    runner = make_runner(fake=fake)

    result = runner.run()

    problems = [(entry["job"], entry["status"], (entry.get("error") or {}).get("code")) for entry in result["jobs"] if entry["status"] != "succeeded"]
    assert problems == [], problems
    assert result["counts"].get("succeeded", 0) == 3, json.dumps(result["counts"])
    # the producer's own output is on disk before the consumers upload it
    assert list((workdir / "out").rglob("a_src.plate.mp4")), sorted(path.name for path in (workdir / "out").rglob("*"))[:8]
    submitted = [event["job"] for event in load_jsonl(workdir / "progress.jsonl") if event.get("event") == "submitted"]
    assert submitted[0] == "a_src.plate", submitted
    assert submitted[1:] == ["a_ref.plate", "a_i2i.plate"], submitted


def test_the_order_is_untouched_when_it_already_respects_deps(workdir: Path, fake, make_runner):
    doc = plan_listing_consumers_first()
    doc["batches"] = [{"name": "plates", "jobs": ["a_src.plate", "a_ref.plate", "a_i2i.plate"]}]
    doc["jobs"] = [doc["jobs"][2], doc["jobs"][0], doc["jobs"][1]]
    prepare(workdir, doc)
    runner = make_runner(fake=fake)

    result = runner.run()

    assert result["counts"].get("succeeded", 0) == 3
    submitted = [event["job"] for event in load_jsonl(workdir / "progress.jsonl") if event.get("event") == "submitted"]
    assert submitted[0] == "a_src.plate", submitted


def test_a_dependency_cycle_does_not_hang_the_ordering(workdir: Path, fake, make_runner):
    """A plan with a cycle is not this pass's business: the order stays as written, nothing loops."""
    doc = plan_listing_consumers_first()
    doc["jobs"][0]["deps"] = ["a_i2i.plate"]
    doc["jobs"][1]["deps"] = ["a_ref.plate"]
    doc["jobs"][2]["deps"] = ["a_ref.plate"]
    doc["jobs"][2]["fileInputs"] = [{"param": "image", "from": "job", "job": "a_ref.plate", "path": "out/intermediates/a_ref.plate.mp4"}]
    prepare(workdir, doc)
    runner = make_runner(fake=fake)

    result = runner.run()  # must return; the jobs themselves may fail, that is not the point here

    assert sum(result["counts"].values()) == 3, result["counts"]
