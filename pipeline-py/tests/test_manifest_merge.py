"""G5-8: the backend runs the runner once per batch, and every run writes `out/manifest.json`.

GPU test 5's final manifest held `{succeeded: 2}` - the two plates - while the three stills the first
batch had already finished were gone, so they were never applied. A run's manifest has to carry over
what earlier batches recorded.
"""

from __future__ import annotations

from pathlib import Path

from comfyrizz_pipeline.manifest import build_manifest, read_manifest, write_manifest


def doc(*jobs: str, batch: str = "stills") -> dict:
    return {"v": 1, "packageId": "pkg_g58", "hash": "a" * 64, "jobs": [{"id": job, "batch": batch} for job in jobs]}


def first_run(tmp_path: Path) -> dict:
    manifest = build_manifest(
        run_id="run_1",
        jobs_doc=doc("a_still", "b_still"),
        results={"a_still": {"status": "succeeded", "outputs": [{"relative": "assets/a_still.png"}]}, "b_still": {"status": "cached"}},
        started_at="2026-10-18T09:00:00.000Z",
    )
    write_manifest(tmp_path, manifest)
    return manifest


def test_a_second_batch_keeps_the_first_batchs_jobs(tmp_path: Path) -> None:
    first_run(tmp_path)

    second = build_manifest(
        run_id="run_2",
        jobs_doc=doc("a_plate", batch="plates"),
        results={"a_plate": {"status": "succeeded"}},
        started_at="2026-10-18T09:05:00.000Z",
        previous=read_manifest(tmp_path),
    )
    write_manifest(tmp_path, second)

    assert [entry["job"] for entry in second["jobs"]] == ["a_still", "b_still", "a_plate"]
    assert second["counts"] == {"succeeded": 2, "cached": 1}
    assert second["complete"] is True
    # and the same reading survives a round trip through the file the backend downloads
    assert [entry["job"] for entry in read_manifest(tmp_path)["jobs"]] == ["a_still", "b_still", "a_plate"]


def test_re_running_one_batch_replaces_its_own_entries(tmp_path: Path) -> None:
    first_run(tmp_path)

    again = build_manifest(
        run_id="run_3",
        jobs_doc=doc("a_still", "b_still"),
        results={"a_still": {"status": "failed", "error": "OOM"}},
        started_at="2026-10-18T09:10:00.000Z",
        previous=read_manifest(tmp_path),
    )

    assert [entry["job"] for entry in again["jobs"]] == ["a_still", "b_still"], "no duplicates"
    assert again["jobs"][0]["status"] == "failed", "the newer run's verdict wins"
    assert again["jobs"][0]["error"] == "OOM"
    assert again["counts"] == {"failed": 1, "cached": 1}
    assert again["complete"] is False, "a failed job is not a complete plan"


def test_the_run_history_names_the_invocations(tmp_path: Path) -> None:
    first_run(tmp_path)

    second = build_manifest(
        run_id="run_2",
        jobs_doc=doc("a_plate", batch="plates"),
        results={"a_plate": {"status": "succeeded"}},
        started_at="2026-10-18T09:05:00.000Z",
        previous=read_manifest(tmp_path),
    )

    assert [entry["run_id"] for entry in second["runs"]] == ["run_1", "run_2"]
    assert second["runs"][0]["jobs"] == ["a_still", "b_still"]


def test_a_manifest_without_a_previous_one_is_just_this_run(tmp_path: Path) -> None:
    manifest = build_manifest(
        run_id="run_1",
        jobs_doc=doc("a_still"),
        results={"a_still": {"status": "succeeded"}},
        started_at="2026-10-18T09:00:00.000Z",
        previous=None,
    )

    assert [entry["job"] for entry in manifest["jobs"]] == ["a_still"]
    assert manifest["runs"] == [
        {"run_id": "run_1", "startedAt": "2026-10-18T09:00:00.000Z", "complete": True, "jobs": ["a_still"]}
    ]
