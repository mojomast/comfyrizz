"""H-fix3: the job-label contract and the two ways out of ``submission_unknown``.

GPU test 2, issues 1 and 8. The SDK sends ``metadata`` as an object; ``comfy-api-proxy`` refuses
anything but *no* metadata (its words: "'metadata' must be a string (opaque label)"). The runner
therefore asks for labels — they are what makes an ambiguous submit recoverable — and, when a server
says no, submits again without them and says so in the manifest. And because labels are not always
available, the user can resolve an ambiguous attempt by hand: adopt the job id they found on the
server, or clear the attempt so the job can be retried.

No GPU, no network beyond loopback.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

from comfyrizz_pipeline.attempts import Attempt
from comfyrizz_pipeline.client import ComfyClient, classify_metadata_refusal, SubmitOutcome
from comfyrizz_pipeline.progress import ProgressWriter
from comfyrizz_pipeline.runner import Runner, RunnerConfig

from conftest import FIXTURES, load_jsonl

#: The refusal the real proxy sent (docs/GPU_TEST_2.md, issue 1).
PROXY_REFUSAL = SubmitOutcome(
    "refused",
    error={"code": "invalid_request", "message": "'metadata' must be a string (opaque label)"},
)


def workdir(tmp_path: Path) -> Path:
    import shutil

    tmp_path.mkdir(parents=True, exist_ok=True)
    shutil.copy(FIXTURES / "jobs.json", tmp_path / "jobs.json")
    shutil.copytree(FIXTURES / "workflows", tmp_path / "workflows")
    return tmp_path


def runner_for(work: Path, fake=None, **overrides) -> Runner:
    config = RunnerConfig(
        jobs_file=work / "jobs.json",
        out_dir=work / "out",
        poll_interval=0.05,
        job_timeout=10.0,
        reconcile_timeout=10.0,
        echo_progress=False,
        progress_path=work / "progress.jsonl",
    )
    for key, value in overrides.items():
        setattr(config, key, value)
    client = ComfyClient(base_url=fake.base_url if fake is not None else None, timeout=5.0)
    writer = ProgressWriter(stream=io.StringIO(), echo=False, path=config.progress_path)
    return Runner(config, client=client, progress=writer)


def test_the_refusal_is_recognised_in_the_words_the_proxy_used():
    assert classify_metadata_refusal(PROXY_REFUSAL) is True
    # an unrelated refusal is not a label problem, and neither is a successful submit
    assert classify_metadata_refusal(SubmitOutcome("refused", error={"code": "invalid_workflow", "message": "no params mapping for width"})) is False
    assert classify_metadata_refusal(SubmitOutcome("submitted", job_id="job_1")) is False
    assert classify_metadata_refusal(SubmitOutcome("ambiguous", error={"code": "transport_ambiguous", "message": "no reply"})) is False


def test_labels_are_sent_to_a_server_that_takes_them(tmp_path: Path, servers):
    fake = servers()
    work = workdir(tmp_path)
    manifest = runner_for(work, fake).run()

    assert manifest["counts"] == {"succeeded": 5}, manifest
    labels = fake.submitted_metadata()
    assert len(labels) == 5
    assert all(isinstance(entry, dict) and entry.get("comfyrizz_job") for entry in labels)
    assert fake.metadata_rejections == 0
    assert "notes" not in manifest, "nothing to explain when the server accepted the labels"


def test_a_server_that_refuses_labels_gets_a_second_submit_without_them(tmp_path: Path, servers):
    """The run must not stop being honest just because labels are unavailable."""
    fake = servers(reject_metadata=True)
    work = workdir(tmp_path)
    manifest = runner_for(work, fake).run()

    assert manifest["counts"] == {"succeeded": 5}, manifest
    assert fake.metadata_rejections == 1, "exactly one job pays for discovering the contract"
    labels = fake.submitted_metadata()
    assert isinstance(labels[0], dict) and labels[0].get("comfyrizz_job"), "the first attempt asked for labels"
    assert labels[1] is None, "the retry dropped them"
    assert all(entry is None for entry in labels[2:]), "and the rest of the run never asked again"

    events = [line["event"] for line in load_jsonl(work / "progress.jsonl")]
    assert events.count("metadata_unsupported") == 1
    assert any("job labels" in note for note in manifest["notes"]), manifest["notes"]

    # the ambiguous-submit recovery path knows labels are gone, so it does not pretend to have searched
    assert runner_for(work, fake).job_labels_enabled() is True  # a fresh runner asks again (a new server may differ)
    runner = runner_for(work, fake)
    runner.labels_ok = False
    assert runner.job_labels_enabled() is False


def test_the_labels_note_survives_an_all_cached_rerun(tmp_path: Path, servers):
    """GPU test 3, N5: the second run submits nothing, and it rewrote the manifest without the note."""
    fake = servers(reject_metadata=True)
    work = workdir(tmp_path)
    first = runner_for(work, fake).run()
    note = next(n for n in first["notes"] if "job labels" in n)

    second = runner_for(work, fake).run()
    assert second["counts"] == {"cached": 5}, second["counts"]
    assert fake.metadata_rejections == 1, "a cached run asks the server for nothing"
    carried = [n for n in second["notes"] if "job labels" in n]
    assert len(carried) == 1, second["notes"]
    assert carried[0].startswith(note), "the same note, not a paraphrase"
    assert "earlier run against this deployment" in carried[0], "and it says where it comes from"
    # the store is keyed by deployment: a fresh Google Colab VM cannot inherit another server's note
    store = json.loads((work / "out" / "cache" / "notes.json").read_text(encoding="utf-8"))
    assert list(store["deployments"]) == [fake.base_url], store
    other = servers(reject_metadata=True)
    third = runner_for(work, other).run()
    assert third["counts"] == {"cached": 5}, third["counts"]
    assert not [n for n in third.get("notes", []) if "earlier run" in n], third.get("notes")


def test_labels_can_be_forced_on_or_off(tmp_path: Path, servers):
    fake = servers()
    work = workdir(tmp_path)
    manifest = runner_for(work, fake, job_labels=False).run()
    assert manifest["counts"] == {"succeeded": 5}
    assert all(entry is None for entry in fake.submitted_metadata())

    forced = servers(reject_metadata=True)
    work2 = workdir(tmp_path / "second")
    blocked = runner_for(work2, forced, job_labels=True).run()
    # with labels pinned on, the proxy's refusal is final: the job fails with the server's own words
    assert blocked["counts"].get("failed", 0) > 0
    failed = next(entry for entry in blocked["jobs"] if entry["status"] == "failed")
    assert failed["error"]["code"] == "invalid_request"
    assert "opaque label" in failed["error"]["message"]


# ------------------------------------------------------- getting out of submission_unknown


def ambiguous_runner(work: Path, fake) -> Runner:
    """A runner whose first job already has an unresolved attempt from an earlier run."""
    runner = runner_for(work, fake, job_labels=False)
    runner.load_jobs()
    runner.attempts.open(
        Attempt(
            attempt_id="att_a_cutout.still_01",
            job="a_cutout.still",
            state="submission_unknown",
            idempotency_key="comfyrizz-a_cutout.still-abc-1",
            inputs_hash="0" * 64,
            error={"code": "submission_unknown", "message": "the submit outcome was never resolved"},
        )
    )
    return runner


def test_clearing_an_unresolved_attempt_makes_the_job_retryable(tmp_path: Path, servers):
    fake = servers()
    work = workdir(tmp_path)
    runner = ambiguous_runner(work, fake)

    reconcile = runner.reconcile()
    assert next(entry for entry in reconcile["jobs"] if entry["job"] == "a_cutout.still")["status"] == "submission_unknown"

    cleared = runner.clear("a_cutout.still", "checked the server console: no job for this attempt")
    entry = next(item for item in cleared["jobs"] if item["job"] == "a_cutout.still")
    assert entry["status"] == "failed"
    assert any("cleared by hand" in note for note in cleared["notes"])
    attempts = [json.loads(p.read_text()) for p in sorted((work / "out" / "attempts").glob("*.json"))]
    record = next(a for a in attempts if a["attempt_id"] == "att_a_cutout.still_01")
    assert record["state"] == "failed"
    assert record["error"]["code"] == "cleared_by_user"
    assert record["events"][-1]["event"] == "cleared_by_user"
    assert fake.state.submit_count() == 0, "clearing never submits anything"

    # and the next run picks the job up instead of reporting it as unresolved
    rerun = runner_for(work, fake).run()
    assert next(item for item in rerun["jobs"] if item["job"] == "a_cutout.still")["status"] in ("succeeded", "cached")
    assert fake.state.submit_count("a_cutout.still") == 1


def test_adopting_the_job_id_you_found_polls_it_and_never_resubmits(tmp_path: Path, servers):
    fake = servers()
    work = workdir(tmp_path)
    # a job that already exists on the server: the attempt's submit did reach it after all
    created = fake.state.create_job({"metadata": {}}, "comfyrizz-adopt")
    job_id = created["id"]
    runner = ambiguous_runner(work, fake)

    adopted = runner.adopt("a_cutout.still", job_id)
    entry = next(item for item in adopted["jobs"] if item["job"] == "a_cutout.still")
    assert entry["status"] == "succeeded", entry
    assert entry["job_id"] == job_id
    assert entry["outputs"], "the poll collected the adopted job's output"
    assert fake.state.submit_count() == 0, "adopting never submits"
    assert any("adopted server job" in note for note in adopted["notes"])
    record = next(a for a in (json.loads(p.read_text()) for p in sorted((work / "out" / "attempts").glob("*.json"))) if a["attempt_id"] == "att_a_cutout.still_01")
    assert record["state"] == "succeeded"
    assert record["job_id"] == job_id
    assert record["events"][-1]["event"] == "adopted_by_user"


def test_adopt_and_clear_refuse_a_job_with_nothing_open(tmp_path: Path, servers):
    fake = servers()
    work = workdir(tmp_path)
    runner = runner_for(work, fake)
    for call in (lambda: runner.adopt("a_cutout.still", "job_001"), lambda: runner.clear("a_cutout.still")):
        try:
            call()
        except ValueError as exc:
            assert "no unresolved attempt" in str(exc)
        else:  # pragma: no cover - the assertion above is the test
            raise AssertionError("adopt/clear must refuse a job with no open attempt")
    try:
        runner.clear("a_job_that_is_not_planned")
    except ValueError as exc:
        assert "is not in this plan" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("clearing an unknown job must be refused")
