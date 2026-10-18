"""H7: the model pin (`colab/models.lock.json`) and the spend estimate's measured numbers.

Two things are checked here, both without a GPU and without Google Colab:

- the lock is a real pin (repo + 40-hex revision + file + size + where the file has to land), its
  sizes add up to the 60.0 GB the GPU test 3 run measured, and `colab/bootstrap.py` downloads *from
  the lock* with `--revision` rather than from a second list that can drift;
- the spend estimate quotes the measured minutes instead of placeholders, and the run it cites
  exists (docs/GPU_TEST_3.md) with the numbers the estimate claims.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

from conftest import REPO_ROOT

LOCK_PATH = REPO_ROOT / "colab" / "models.lock.json"
BOOTSTRAP = REPO_ROOT / "colab" / "bootstrap.py"
GPU_TEST_3 = REPO_ROOT / "docs" / "GPU_TEST_3.md"
ESTIMATE_SOURCE = REPO_ROOT / "packages" / "backends" / "src" / "colab-backend.mjs"
SWEEPS = REPO_ROOT / "pipeline-py" / "svgguide" / "sweeps.py"

#: What test/gpu3/logs/setup.log measured (`DOWNLOAD {...} total 60.02 GB`), byte for byte.
MEASURED_TOTAL_BYTES = 60_019_207_384


def load_bootstrap(name: str = "colab_bootstrap"):
    """Load `colab/bootstrap.py` by path (it is uploaded to the VM as a script, not a package)."""
    colab_dir = str(REPO_ROOT / "colab")
    if colab_dir not in sys.path:
        sys.path.insert(0, colab_dir)
    spec = importlib.util.spec_from_file_location(name, BOOTSTRAP)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def lock() -> dict:
    return json.loads(LOCK_PATH.read_text(encoding="utf-8"))


# ------------------------------------------------------------------------------ the pin itself


def test_the_lock_pins_a_revision_per_repo(lock: dict):
    assert lock["v"] == 1
    assert set(lock["hosts"]) == {"klein", "ltx"}
    for name, host in lock["hosts"].items():
        assert host["repo"].count("/") == 1, name
        assert len(host["revision"]) == 40 and int(host["revision"], 16) >= 0, f"{name}: revision is not a 40-hex commit"
        assert host["localDir"].startswith("/content/hf/"), name
        assert host["gated"], f"{name}: a gated repo is the reason the token exists at all"


def test_every_file_says_where_it_lands_and_what_it_weighs(lock: dict):
    targets = []
    for entry in lock["files"]:
        assert entry["host"] in lock["hosts"]
        assert entry["path"].endswith(".safetensors")
        assert entry["bytes"] > 0
        assert entry.get("target") or entry.get("mergedInto"), f"{entry['path']} goes nowhere"
        if entry.get("target"):
            targets.append(entry["target"])
    assert len(targets) == len(set(targets)), "two files cannot claim the same ComfyUI path"


def test_the_lock_weighs_what_the_gpu_test_3_run_downloaded(lock: dict):
    # the API sizes were cross-checked against `ls -l` on the VM (test/gpu3/logs/setup.log)
    assert sum(entry["bytes"] for entry in lock["files"]) == MEASURED_TOTAL_BYTES
    assert lock["measured"]["totalBytes"] == MEASURED_TOTAL_BYTES
    assert round(MEASURED_TOTAL_BYTES / 1e9, 1) == 60.0
    per_host = {}
    for entry in lock["files"]:
        per_host[entry["host"]] = per_host.get(entry["host"], 0) + entry["bytes"]
    assert per_host["klein"] == 20_309_335_148
    assert per_host["ltx"] == 39_709_872_236


def test_the_sharded_text_encoder_is_declared_as_a_merge(lock: dict):
    merge = lock["merge"][0]
    shard_paths = {entry["path"] for entry in lock["files"] if entry.get("mergedInto") == merge["id"]}
    assert shard_paths == set(merge["shards"])
    assert merge["target"] == "text_encoders/qwen3vl_4b_bf16.safetensors"
    assert merge["bytes"] > sum(entry["bytes"] for entry in lock["files"] if entry["path"] in shard_paths) - 100
    assert "shards deleted" in merge["operation"]


def test_the_lock_records_the_run_it_was_derived_from(lock: dict):
    measured = lock["measured"]
    assert measured["doc"] == "docs/GPU_TEST_3.md"
    assert measured["downloadSeconds"] > 0
    assert "sha256" not in json.dumps(lock["files"]), "no sha256 is claimed for a gated repo: the API masks it"
    assert any("sha256" in note for note in lock["authoringNotes"])


# ------------------------------------------------------- bootstrap.py downloads from the pin


def test_bootstrap_refuses_to_run_without_the_lock(tmp_path: Path):
    bootstrap = load_bootstrap()
    with pytest.raises(SystemExit, match="no model lock"):
        bootstrap.load_lock(tmp_path / "missing.lock.json")


def test_bootstrap_refuses_a_lock_that_names_a_host_it_does_not_declare(tmp_path: Path, lock: dict):
    broken = json.loads(json.dumps(lock))
    broken["files"][0]["host"] = "someone-elses-repo"
    path = tmp_path / "models.lock.json"
    path.write_text(json.dumps(broken), encoding="utf-8")
    bootstrap = load_bootstrap()
    with pytest.raises(SystemExit, match="not declared"):
        bootstrap.load_lock(path)


def test_the_plan_is_the_lock_and_nothing_else(lock: dict):
    bootstrap = load_bootstrap()
    plan = bootstrap.model_plan(lock)
    assert set(plan) == {"klein", "ltx"}
    assert plan["klein"] == ("black-forest-labs/flux-3-image-klein", [entry["path"] for entry in lock["files"] if entry["host"] == "klein"])
    assert len(plan["ltx"][1]) == 5
    links = bootstrap.link_plan(lock)
    assert links["/content/hf/klein/model.safetensors"] == "diffusion_models/flux-3-image-klein-bf16.safetensors"
    assert all(source != f"/content/ComfyUI/models/{target}" for source, target in links.items()), "a link must not point at itself"
    assert len(links) == len([entry for entry in lock["files"] if entry.get("target")])


def test_the_download_command_carries_the_pinned_revision(tmp_path: Path, lock: dict, monkeypatch: pytest.MonkeyPatch):
    """A pin that is not passed to `hf download` is a comment, not a pin."""
    log = tmp_path / "hf.jsonl"
    fake_hf = tmp_path / "hf"
    fake_hf.write_text(
        "#!/usr/bin/env bash\n"
        f'python3 -c "import json,sys;open(r\'{log}\',\'a\').write(json.dumps(sys.argv[1:])+chr(10))" "$@"\n'
        "echo downloaded\n"
    )
    fake_hf.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ.get('PATH', '')}")

    bootstrap = load_bootstrap("colab_bootstrap_dl")
    results = bootstrap.download_models("hf_fake_token", bootstrap.model_plan(lock), lock)

    calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    assert len(calls) == 2
    # G5-11: the hosts download at the same time now, so the log order is not the lock's order - find
    # each host's own call by its repo instead of assuming which finished first
    by_repo = {call[1]: call for call in calls}
    for host in ("klein", "ltx"):
        call = by_repo[lock["hosts"][host]["repo"]]
        assert call[0] == "download"
        assert call[call.index("--revision") + 1] == lock["hosts"][host]["revision"]
        assert call[call.index("--local-dir") + 1] == lock["hosts"][host]["localDir"]
    assert results["klein"]["revision"] == lock["hosts"]["klein"]["revision"]
    assert results["klein"]["files"] == 4 and results["ltx"]["files"] == 5
    assert "hf_fake_token" not in json.dumps(results), "the token never reaches a result"


# ------------------------------------------------------------- the estimate quotes the run


def test_the_estimate_quotes_measured_minutes_not_placeholders():
    source = ESTIMATE_SOURCE.read_text(encoding="utf-8")
    assert "MEASURED_JOB_MINUTES" in source
    assert "PLACEHOLDER_JOB_MINUTES" not in source
    assert "placeholder minutes per job kind" not in source
    assert "docs/GPU_TEST_3.md" in source, "the estimate must cite the run its numbers come from"
    for kind in ("still", "plate", "upscale", "audio"):
        assert f"{kind}:" in source


def test_the_sweep_estimate_quotes_measured_minutes_too():
    source = SWEEPS.read_text(encoding="utf-8")
    assert "placeholder minutes per approach" not in source
    assert "GPU test 3" in source
    assert "REFERENCE_EDIT_MINUTES" in source, "the reference budget axis is priced per value"


def test_the_document_the_estimates_cite_records_those_numbers():
    assert GPU_TEST_3.is_file(), "the estimates cite docs/GPU_TEST_3.md; it has to exist"
    doc = GPU_TEST_3.read_text(encoding="utf-8")
    for number in ("2.5", "5.6", "8.5", "17.0", "218.5", "1.90", "60.0 GB"):
        assert number in doc, f"docs/GPU_TEST_3.md must record the measured {number}"
