"""B2 unit tests: attempt records, the manifest, JSON-lines progress, the cache index,
jobs.json validation, params injection / submit classification, and health checks."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from comfyrizz_pipeline import health
from comfyrizz_pipeline.attempts import Attempt, AttemptStore, attempts_jsonl
from comfyrizz_pipeline.atomic import read_json, sha256_bytes, write_json_atomic
from comfyrizz_pipeline.client import (
    classify_submit_error,
    inject_params,
    load_params_map,
)
from comfyrizz_pipeline.manifest import (
    build_manifest,
    manifest_decides_success,
    read_manifest,
    write_manifest,
)
from comfyrizz_pipeline.progress import ProgressWriter, parse_lines
from comfyrizz_pipeline.schema import validate_jobs
from conftest import FIXTURES, load_jsonl


# --------------------------------------------------------------------------- attempts
def test_attempt_record_lifecycle_is_append_only(tmp_path: Path):
    store = AttemptStore(tmp_path / "attempts")
    attempt = Attempt(attempt_id="att_a_01", job="a.still", state="submitting", idempotency_key="key-1", inputs_hash="h")
    store.open(attempt)
    on_disk = json.loads((tmp_path / "attempts" / "att_a_01.json").read_text())
    assert on_disk["state"] == "submitting"
    assert on_disk["job_id"] is None

    with pytest.raises(FileExistsError):
        store.open(Attempt(attempt_id="att_a_01", job="a.still", state="submitting", idempotency_key="k2", inputs_hash="h"))

    store.update(attempt, state="submitted", job_id="job_001")
    reloaded = store.load("att_a_01")
    assert reloaded.state == "submitted"
    assert reloaded.job_id == "job_001"
    assert reloaded.submitted_at is not None
    assert reloaded.updated_at >= reloaded.created_at

    store.update(attempt, state="succeeded", outputs=[{"file": "x.png", "sha256": "0" * 64}])
    assert store.unresolved_for_job("a.still") is None
    assert store.next_seq("a.still") == 2
    assert [a.attempt_id for a in store.load_all()] == ["att_a_01"]
    assert "att_a_01" in attempts_jsonl(store.load_all())


def test_open_attempt_is_found_so_it_is_never_resubmitted(tmp_path: Path):
    store = AttemptStore(tmp_path / "attempts")
    store.open(Attempt(attempt_id="att_b_01", job="b.plate", state="submitting", idempotency_key="k", inputs_hash="h"))
    assert store.unresolved_for_job("b.plate").state == "submitting"
    store.update(store.load("att_b_01"), state="submission_unknown")
    assert store.unresolved_for_job("b.plate").state == "submission_unknown"


def test_atomic_write_leaves_no_temp_files(tmp_path: Path):
    target = tmp_path / "state" / "manifest.json"
    write_json_atomic(target, {"a": 1})
    write_json_atomic(target, {"a": 2})
    assert read_json(target) == {"a": 2}
    leftovers = [p.name for p in target.parent.iterdir() if p.name != "manifest.json"]
    assert leftovers == []


# --------------------------------------------------------------------------- manifest
def _jobs_doc(job_ids: list[str]) -> dict:
    return {
        "v": 1,
        "hash": "a" * 64,
        "jobs": [{"id": job_id} for job_id in job_ids],
    }


def test_manifest_only_completes_when_every_job_landed(tmp_path: Path):
    jobs = _jobs_doc(["a.still", "a.plate"])
    partial = build_manifest(
        run_id="run1",
        jobs_doc=jobs,
        results={"a.still": {"status": "succeeded", "attempt_id": "att_1", "outputs": []}},
        started_at="2026-10-17T00:00:00+00:00",
    )
    assert partial["complete"] is False
    assert partial["counts"] == {"succeeded": 1, "pending": 1}
    ok, why = manifest_decides_success(partial, jobs)
    assert ok is False and "not complete" in why

    done = build_manifest(
        run_id="run1",
        jobs_doc=jobs,
        results={
            "a.still": {"status": "succeeded", "attempt_id": "att_1"},
            "a.plate": {"status": "cached", "attempt_id": "att_2"},
        },
        started_at="2026-10-17T00:00:00+00:00",
    )
    assert done["complete"] is True
    ok, why = manifest_decides_success(done, jobs)
    assert ok is True

    write_manifest(tmp_path, done)
    assert read_manifest(tmp_path)["run_id"] == "run1"
    assert not [p for p in tmp_path.iterdir() if p.suffix == ".tmp"]


def test_manifest_must_match_the_jobs_json_it_ran(tmp_path: Path):
    jobs = _jobs_doc(["a.still"])
    other = dict(jobs, hash="b" * 64)
    manifest = build_manifest(run_id="r", jobs_doc=jobs, results={"a.still": {"status": "succeeded"}}, started_at="t")
    ok, why = manifest_decides_success(manifest, other)
    assert ok is False and "jobsHash" in why
    ok, why = manifest_decides_success(None, jobs)
    assert ok is False and "no manifest" in why


# --------------------------------------------------------------------------- progress
def test_progress_is_json_lines_with_monotonic_seq(tmp_path: Path):
    writer = ProgressWriter(path=tmp_path / "progress.jsonl", echo=False)
    writer.emit("run_start", value={"jobs": 2})
    writer.emit("attempt_open", job="a.still", attempt="att_1")
    writer.emit("submitted", job="a.still", attempt="att_1", value="job_001")
    writer.emit("progress", job="a.still", attempt="att_1", value=0.42)
    lines = load_jsonl(tmp_path / "progress.jsonl")
    assert [line["seq"] for line in lines] == [1, 2, 3, 4]
    assert all(line["v"] == 1 for line in lines)
    assert lines[3] == {**lines[3], "job": "a.still", "event": "progress", "value": 0.42}
    assert parse_lines("\n".join(json.dumps(line) for line in lines)) == lines
    with pytest.raises(ValueError):
        parse_lines("{not json}")


# --------------------------------------------------------------------------- cache
def test_cache_lookup_requires_the_file_and_its_hash(make_runner, out_dir: Path):
    runner = make_runner(None, client="unused")
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = b"cached-plate"
    (out_dir / "assets").mkdir(parents=True, exist_ok=True)
    (out_dir / "assets" / "a_plate.mp4").write_bytes(payload)
    write_json_atomic(
        out_dir / "cache" / "index.json",
        {"v": 1, "entries": {"k" * 64: {"job": "a.plate", "file": "assets/a_plate.mp4", "sha256": sha256_bytes(payload), "attempt_id": "att_old"}}},
    )
    job = {"id": "a.plate", "cacheKey": "k" * 64}
    assert runner.cache_lookup(job)["attempt_id"] == "att_old"
    (out_dir / "assets" / "a_plate.mp4").write_bytes(b"tampered")
    assert runner.cache_lookup(job) is None, "a file that no longer matches its hash is not a cache hit"


# --------------------------------------------------------------------------- jobs doc
def test_jobs_document_validation(repo_root: Path):
    doc = json.loads((FIXTURES / "jobs.json").read_text())
    assert validate_jobs(doc) == []

    broken = json.loads(json.dumps(doc))
    broken["jobs"][0]["output"] = "/etc/passwd"
    broken["jobs"][1]["deps"] = ["ghost.still"]
    broken["jobs"][2]["id"] = broken["jobs"][0]["id"]
    broken["jobs"][3]["cacheKey"] = "nope"
    problems = {p["code"] for p in validate_jobs(broken)}
    assert "JOBS_PATH_NOT_RELATIVE" in problems
    assert "JOBS_UNKNOWN_DEPENDENCY" in problems
    assert "JOBS_DUPLICATE_JOB_ID" in problems
    assert "JOBS_PATTERN" in problems

    assert validate_jobs({"v": 2}) != [], "a wrong version is refused"


# --------------------------------------------------------------------------- client
def test_params_are_injected_and_an_unmapped_param_is_an_error():
    mapping = load_params_map(FIXTURES / "workflows" / "ltx25_i2v.api.json")
    # a map entry is a list of targets, each [node_id, field] or [node_id, field, options]
    assert mapping["width"] == [["5", "width"]]
    graph = json.loads((FIXTURES / "workflows" / "ltx25_i2v.api.json").read_text())
    inject_params(graph, mapping, {"width": 960, "frames": 97, "upscale": "x2+crop"})
    assert graph["5"]["inputs"]["width"] == 960
    assert graph["5"]["inputs"]["length"] == 97
    with pytest.raises(ValueError) as excinfo:
        inject_params(graph, mapping, {"prompt": "x", "brand_new_param": 1})
    assert "brand_new_param" in str(excinfo.value)


def test_a_target_option_scales_one_planned_value_for_one_node():
    """The LTX two-stage geometry: the plan's size, halved into the stage-1 latent."""
    graph = {"8": {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": 960, "height": 544}}}
    inject_params(graph, {"width": [["8", "width", {"mul": 0.5}]]}, {"width": 960})
    assert graph["8"]["inputs"]["width"] == 480
    # no option: the planned value lands unchanged
    inject_params(graph, {"height": [["8", "height"]]}, {"height": 544})
    assert graph["8"]["inputs"]["height"] == 544


def test_submit_errors_are_classified_the_way_the_recovery_rules_need():
    assert classify_submit_error(httpx.ConnectError("refused")).kind == "refused"
    assert classify_submit_error(httpx.ConnectError("refused")).error["code"] == "connect_failed"
    for exc in (httpx.ReadTimeout("no reply"), httpx.RemoteProtocolError("dropped"), httpx.ReadError("reset")):
        outcome = classify_submit_error(exc)
        assert outcome.kind == "ambiguous", f"{type(exc).__name__} must stay ambiguous"

    class FakeComfyError(Exception):
        def __init__(self, code: str, status: int):
            super().__init__(code)
            self.code = code
            self.http_status = status

    assert classify_submit_error(FakeComfyError("idempotency_key_reuse", 422)).kind == "duplicate_key"
    assert classify_submit_error(FakeComfyError("invalid_workflow", 422)).kind == "refused"
    assert classify_submit_error(FakeComfyError("internal_error", 500)).kind == "ambiguous"


# --------------------------------------------------------------------------- health
def test_health_checks_against_the_fake_server(fake, workdir: Path):
    v2 = health.check_v2(fake.base_url)
    assert v2["ok"] is True
    assert health.check_v2(fake.v2_url)["ok"] is True, "the v2 root is accepted too"

    comfy = health.check_comfyui(fake.base_url)
    assert comfy["ok"] is True
    assert "KSampler" in comfy["node_types"]
    assert "flux-3-image-klein.safetensors" in comfy["model_files"]
    assert comfy["vramFreeGB"] and comfy["vramFreeGB"] > 1

    report = health.health_report(v2_url=fake.base_url, comfyui_url=fake.base_url, require_nodes=["KSampler"])
    assert report["ok"] is True
    bad = health.health_report(
        v2_url=fake.base_url,
        comfyui_url=fake.base_url,
        require_nodes=["MissingNode"],
        require_models=["missing.safetensors"],
    )
    assert bad["ok"] is False
    assert "MissingNode" in bad["checks"]["comfyui"]["detail"]
    assert "missing.safetensors" in bad["checks"]["comfyui"]["detail"]


def test_smoke_job_runs_through_the_sdk(fake, workdir: Path):
    result = health.smoke_job(fake.base_url, workdir / "workflows" / "flux3_klein_t2i.api.json", timeout=10.0)
    assert result["ok"] is True, result
    assert result["job_id"].startswith("job_")
    assert "proves wiring" in result["detail"]
    assert fake.submit_count() == 1


def test_health_reports_nothing_to_check_rather_than_ok():
    report = health.health_report()
    assert report["ok"] is False
    assert report["checks"] == {}
    assert "nothing to check" in report["detail"]
