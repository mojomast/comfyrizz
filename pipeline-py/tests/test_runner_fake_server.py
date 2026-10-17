"""B2 acceptance: the runner driven against a local fake Comfy v2 server, through the
real `comfy-sdk` client, with no GPU and no network.

Scenarios: success path, kill mid-run then reconcile (polls, never resubmits),
`submission_unknown` surfaced and not retried, dependency failure, cache hits, and an
in-flight job that outlives the per-job timeout.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from comfyrizz_pipeline.client import ComfyClient
from comfyrizz_pipeline.manifest import read_manifest

from conftest import load_jsonl


def run_cli(workdir: Path, out_dir: Path, base_url: str, *extra: str, env: dict | None = None) -> subprocess.CompletedProcess:
    command = [
        sys.executable,
        "-m",
        "comfyrizz_pipeline.runner",
        "--jobs",
        str(workdir / "jobs.json"),
        "--out",
        str(out_dir),
        "--base-url",
        base_url,
        "--quiet",
        *extra,
    ]
    environment = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1]), **(env or {})}
    return subprocess.run(command, capture_output=True, text=True, env=environment)


def attempts_of(out_dir: Path) -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted((out_dir / "attempts").glob("*.json"))]


def plan_job_ids(workdir: Path) -> list[str]:
    return [job["id"] for job in json.loads((workdir / "jobs.json").read_text())["jobs"]]


def test_success_path_writes_a_matching_manifest(make_runner, fake, out_dir: Path, workdir: Path):
    runner = make_runner(fake, job_timeout=10.0)
    manifest = runner.run()

    assert manifest["complete"] is True
    assert manifest["counts"] == {"succeeded": 5}
    assert manifest["jobsHash"] == json.loads((workdir / "jobs.json").read_text())["hash"]

    jobs = json.loads((workdir / "jobs.json").read_text())["jobs"]
    by_id = {entry["job"]: entry for entry in manifest["jobs"]}
    for job in jobs:
        entry = by_id[job["id"]]
        assert entry["status"] == "succeeded"
        assert entry["job_id"].startswith("job_")
        assert entry["attempt_id"]
        destination = out_dir / job["output"]
        assert destination.is_file(), f"{job['id']} produced no file at {job['output']}"
        assert entry["outputs"], f"{job['id']} recorded no outputs"
        assert entry["outputs"][0]["sha256"] == __import__("hashlib").sha256(destination.read_bytes()).hexdigest()
        assert entry["outputs"][0]["bytes"] == destination.stat().st_size

    # one submission per job, in the planned order (every still before any plate)
    submitted_order = [
        entry["body"]["metadata"]["comfyrizz_job"]
        for entry in fake.requests("POST", "/api/v2/jobs")
        if entry["body"].get("metadata")
    ]
    assert submitted_order == plan_job_ids(workdir)
    assert fake.submit_count() == 5

    # attempt records: every job retried zero times, all terminal
    records = attempts_of(out_dir)
    assert len(records) == 5
    assert {r["state"] for r in records} == {"succeeded"}
    assert all(r["job_id"] and r["submitted_at"] and r["finished_at"] for r in records)
    assert {r["job"] for r in records} == set(plan_job_ids(workdir))

    # progress JSON-lines: keys, monotonic seq, and the ids the manifest records
    lines = load_jsonl(workdir / "progress.jsonl")
    assert [line["seq"] for line in lines] == list(range(1, len(lines) + 1))
    assert all(line["v"] == 1 and "event" in line for line in lines)
    events = {line["event"] for line in lines}
    assert {"run_start", "attempt_open", "submitted", "output_saved", "job_done", "run_done"} <= events
    submitted_attempts = {line["attempt"] for line in lines if line["event"] == "submitted"}
    assert submitted_attempts == {entry["attempt_id"] for entry in manifest["jobs"]}

    # the host-side copy of the records and the cache index exist
    assert (out_dir / "runs" / manifest["run_id"] / "attempts.jsonl").is_file()
    cache = json.loads((out_dir / "cache" / "index.json").read_text())
    assert len(cache["entries"]) == 5

    # nothing half-written is left behind
    leftovers = [p.name for p in out_dir.rglob("*") if p.name.endswith(".tmp") or p.name.endswith(".part")]
    assert leftovers == []


def test_kill_mid_run_then_reconcile_polls_and_never_resubmits(workdir: Path, out_dir: Path):
    from fake_comfy import FakeComfy

    with FakeComfy(finish_after=0.0) as fake:
        killed = run_cli(workdir, out_dir, fake.base_url, env={"COMFYRIZZ_TEST_KILL_AFTER_SUBMIT": "1"})
        assert killed.returncode == 137, (killed.returncode, killed.stdout, killed.stderr)

        # the kill happened after the job id was recorded, before anything was collected
        records = attempts_of(out_dir)
        assert len(records) == 1
        assert records[0]["state"] == "submitted"
        assert records[0]["job_id"].startswith("job_")
        assert fake.submit_count() == 1
        first_attempt = records[0]["attempt_id"]
        first_job = records[0]["job"]

        # reconcile: poll the known job id, submit nothing
        reconciled = run_cli(workdir, out_dir, fake.base_url, "--reconcile")
        assert fake.submit_count() == 1, "reconcile must never resubmit"
        manifest = read_manifest(out_dir)
        assert manifest is not None
        by_id = {entry["job"]: entry for entry in manifest["jobs"]}
        assert by_id[first_job]["status"] == "succeeded"
        assert by_id[first_job]["attempt_id"] == first_attempt
        assert by_id[first_job]["outputs"]
        assert manifest["complete"] is False, "the other four jobs were never attempted"
        assert manifest["counts"] == {"succeeded": 1, "pending": 4}, manifest["counts"]
        assert fake.poll_count(records[0]["job_id"]) >= 1
        assert reconciled.returncode == 1

        # a normal re-run finishes the batch: the already-submitted job is polled, not resubmitted
        finished = run_cli(workdir, out_dir, fake.base_url)
        assert finished.returncode == 0, (finished.stdout, finished.stderr)
        assert fake.submit_count() == 5, "four new submissions, and no duplicate for the recovered job"
        assert len([r for r in attempts_of(out_dir) if r["job"] == first_job]) == 1, "no second attempt for the recovered job"
        manifest = read_manifest(out_dir)
        assert manifest["complete"] is True
        # the recovered job came back from the cache this time, the other four were submitted
        assert manifest["counts"] == {"succeeded": 4, "cached": 1}, manifest["counts"]
        recovered = next(entry for entry in manifest["jobs"] if entry["job"] == first_job)
        assert recovered["status"] == "cached"
        assert "cache hit" in recovered["reason"]


def test_submission_unknown_is_surfaced_and_never_automatically_retried(make_runner, servers, out_dir: Path, workdir: Path):
    fake = servers(drop_first_response=True, finish_after=0.0)
    runner = make_runner(fake)
    manifest = runner.run()

    unknown = [entry for entry in manifest["jobs"] if entry["status"] == "submission_unknown"]
    assert len(unknown) == 1, manifest["counts"]
    assert unknown[0]["error"]["code"] == "transport_ambiguous"
    assert "not resubmitted" in unknown[0]["reason"]
    assert manifest["complete"] is False
    assert fake.submit_count() == 5, "the ambiguous job was still sent; it just never got a reply"
    assert "job_id" not in unknown[0], "no job id was ever observed, so none is recorded"
    # the request did reach the server: proof that resubmitting would have double-billed
    labels = [entry["body"]["metadata"]["comfyrizz_job"] for entry in fake.requests("POST", "/api/v2/jobs") if entry["body"].get("metadata")]
    assert unknown[0]["job"] in labels
    ran = [job for job in fake.jobs.values() if (job.get("metadata") or {}).get("comfyrizz_job") == unknown[0]["job"]]
    assert len(ran) == 1, "the server accepted the request: a resubmit would have created a second job"

    unknown_attempt = unknown[0]["attempt_id"]
    record = next(r for r in attempts_of(out_dir) if r["attempt_id"] == unknown_attempt)
    assert record["state"] == "submission_unknown"
    assert record["job_id"] is None, "no job id was ever observed for this attempt"

    # a fresh run must not send a second request for the same job, and must not touch the record
    before = fake.submit_count()
    runner2 = make_runner(fake)
    second = runner2.run()
    assert fake.submit_count() == before, "submission_unknown was resubmitted"
    assert second["jobs"][0]["status"] == "submission_unknown"
    assert len([r for r in attempts_of(out_dir) if r["job"] == unknown[0]["job"]]) == 1

    # and reconcile does not retry it either — it reports, for the user to decide
    runner3 = make_runner(fake)
    third = runner3.reconcile()
    assert fake.submit_count() == before
    assert third["jobs"][0]["status"] == "submission_unknown"


def test_a_failed_job_blocks_its_dependents_and_normalises_the_error(make_runner, servers, out_dir: Path):
    fake = servers(fail=True, finish_after=0.0)
    manifest = make_runner(fake).run()

    by_id = {entry["job"]: entry for entry in manifest["jobs"]}
    assert by_id["a_cutout.still"]["status"] == "failed"
    assert by_id["a_cutout.still"]["error"]["code"] == "node_execution_error"
    assert by_id["a_cutout.still"]["error"]["node_id"] == "3"
    assert by_id["a_plate1_still.still"]["status"] == "failed"
    assert by_id["a_plate1.plate"]["status"] == "skipped"
    assert "dependency failed: a_plate1_still.still" in by_id["a_plate1.plate"]["reason"]
    assert by_id["a_plate1.upscale"]["status"] == "skipped"
    assert by_id["a_narr.audio"]["status"] == "failed"
    assert manifest["complete"] is False
    assert fake.submit_count() == 3, "the plate and the upscale were never submitted"


def test_a_cache_hit_skips_the_gpu_entirely(make_runner, servers, out_dir: Path, workdir: Path):
    first = servers(finish_after=0.0)
    assert make_runner(first).run()["complete"] is True
    assert first.submit_count() == 5

    second = servers(finish_after=0.0, fail_on_submit=1)  # any submission now 500s
    manifest = make_runner(second).run()
    assert second.submit_count() == 0, "an unchanged job must not reach the server again"
    assert manifest["complete"] is True
    assert manifest["counts"] == {"cached": 5}
    assert all("cache hit" in entry["reason"] for entry in manifest["jobs"])
    assert [entry["outputs"][0]["sha256"] for entry in manifest["jobs"]] == [
        entry["outputs"][0]["sha256"] for entry in json.loads((out_dir / "manifest.json").read_text())["jobs"]
    ]


def test_a_job_that_outlives_its_timeout_is_recorded_not_hung(make_runner, servers, out_dir: Path):
    fake = servers(never_finish=True)
    manifest = make_runner(fake, job_timeout=0.2, poll_interval=0.02).run()
    assert manifest["complete"] is False
    assert manifest["counts"] == {"submitted": 3, "skipped": 2}, manifest["counts"]
    assert "poll again later" in manifest["jobs"][0]["reason"]
    skipped = [entry for entry in manifest["jobs"] if entry["status"] == "skipped"]
    assert all("dependency failed" in entry["reason"] for entry in skipped)
    assert fake.submit_count() == 3, "each independent job ran once; the plate never raced its still"
    record = attempts_of(out_dir)[0]
    assert record["state"] == "submitted" and record["finished_at"] is None
    assert read_manifest(out_dir) is not None


def test_runner_refuses_a_jobs_file_that_is_not_a_jobs_document(workdir: Path, out_dir: Path):
    (workdir / "jobs.json").write_text(json.dumps({"v": 1, "jobs": [{"id": "x", "output": "/etc/passwd"}]}))
    completed = run_cli(workdir, out_dir, "http://127.0.0.1:1")
    assert completed.returncode == 2
    assert "not a valid comfyrizz.jobs/v1 document" in completed.stderr
    assert not (out_dir / "manifest.json").exists()


def test_runner_reports_a_wrong_base_url_rather_than_hanging(make_runner, workdir: Path, out_dir: Path):
    runner = make_runner(None, client=ComfyClient(base_url="http://127.0.0.1:9", timeout=1.0))
    manifest = runner.run()
    assert manifest["complete"] is False
    assert manifest["counts"] == {"failed": 3, "skipped": 2}, manifest["counts"]
    assert manifest["jobs"][0]["error"]["code"] == "connect_failed"
