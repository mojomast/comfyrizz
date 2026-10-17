"""H-fix3 / GPU test 2 issue 9: run the runner in a *subprocess*, never in the caller's process.

On the GPU test 2 run the Google Colab driver patched ``ComfyClient.submit`` in place and called the
runner with ``runpy`` in the same kernel; the second run wrapped the wrapper and raised
``RecursionError``. Two tests here:

* the launcher path — two runs from one Python process, both succeed, the parent untouched;
* the escape hatch — installing the metadata shim twice is a no-op, and an in-process run through
  the shim still finishes (no recursion) and really does drop the labels.

No GPU, no network beyond loopback.
"""

from __future__ import annotations

import io
import json
import shutil
from pathlib import Path

from comfyrizz_pipeline import launch
from comfyrizz_pipeline.client import ComfyClient
from comfyrizz_pipeline.progress import ProgressWriter
from comfyrizz_pipeline.runner import Runner, RunnerConfig

from conftest import FIXTURES, load_jsonl


def workdir(tmp_path: Path) -> Path:
    """A private copy of the job fixture, like the conftest ``workdir`` fixture (but per-run)."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    shutil.copy(FIXTURES / "jobs.json", tmp_path / "jobs.json")
    shutil.copytree(FIXTURES / "workflows", tmp_path / "workflows")
    return tmp_path


def runner_for(work: Path, fake) -> Runner:
    """An in-process runner for `work` — the pattern that used to blow the recursion limit."""
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


def manifest_of(work: Path) -> dict:
    return json.loads((work / "out" / "manifest.json").read_text())


def test_two_runner_runs_from_one_python_process_both_succeed(tmp_path: Path, servers):
    """The bug 9 acceptance, with the honest second-run behaviour.

    Two runs of the same plan from one Python process, each in its own output directory. The second
    run re-offers the same idempotency keys (the key is ``job + cacheKey + attempt seq``, so a fresh
    output directory starts at 1 again), the fake server rejects them — as a real deployment does —
    and the runner recovers by looking the job up by label and polling it instead of double-billing.
    Both runs finish complete, in one process, with nothing patched in the parent.
    """
    fake = servers()
    submit_before = ComfyClient.submit

    runs = []
    for index in (1, 2):
        work = workdir(tmp_path / f"run{index}")
        runs.append(
            (
                work,
                launch.run_jobs(
                    work / "jobs.json",
                    work / "out",
                    base_url=fake.base_url,
                    progress_log=work / "progress.jsonl",
                    timeout=120.0,
                ),
            )
        )

    for work, completed in runs:
        assert completed.returncode == 0, (completed.stdout, completed.stderr)
        manifest = manifest_of(work)
        assert manifest["complete"] is True, manifest["counts"]
        assert manifest["counts"] == {"succeeded": 5}, manifest["counts"]

    first, second = (manifest_of(work) for work, _ in runs)
    # 5 submissions offered twice (5 accepted, 5 rejected as reused keys) but only 5 jobs exist
    assert fake.submit_count() == 10, "the second run offered every job again"
    assert len(fake.jobs) == 5, "the reused keys must not have created a second set of jobs"
    assert [entry["job_id"] for entry in second["jobs"]] == [entry["job_id"] for entry in first["jobs"]]

    # the second run got there by *adopting* them after the reuse rejection, not by resubmitting
    recovered = [
        line
        for line in load_jsonl(runs[1][0] / "progress.jsonl")
        if line["event"] == "submitted" and line.get("recovered")
    ]
    assert len(recovered) == 5, "every job came back through the duplicate-key recovery path"

    # the whole point: the calling process is unchanged, so a third run cannot recurse
    assert ComfyClient.submit is submit_before


def test_installing_the_metadata_shim_twice_does_not_wrap_the_wrapper(tmp_path: Path, servers):
    original = ComfyClient.submit
    first_restore = launch.install_metadata_shim()
    assert ComfyClient.submit is not original
    # the second install sees the marker and hands back the same restorer instead of stacking
    assert launch.install_metadata_shim() is first_restore
    assert launch.install_metadata_shim(metadata={"comfyrizz_job": "x"}) is first_restore

    try:
        # a real in-process run **through** the shim, twice in one process: no RecursionError.
        # Each run gets its own deployment, because with labels dropped a re-run of the same plan
        # against the same server can only ever report submission_unknown (that is bug 8's story).
        for index in (1, 2):
            fake = servers()
            work = workdir(tmp_path / f"run{index}")
            manifest = runner_for(work, fake).run()
            assert manifest["counts"] == {"succeeded": 5}, (index, manifest["counts"])
            # ...and the shim really is in effect: the server saw no labels at all
            assert fake.submitted_metadata() == [None] * 5
            assert fake.metadata_rejections == 0
    finally:
        assert launch.uninstall_metadata_shim() is True

    assert ComfyClient.submit is original
    assert launch.uninstall_metadata_shim() is False, "restoring twice reports nothing to do"
