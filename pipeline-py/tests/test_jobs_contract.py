"""B2 contract test: the planner (TypeScript) and the runner (Python) agree on one artifact.

The runner's fixture ``tests/fixtures/jobs.json`` *is* the planner's output for
``packages/jobs/test/fixtures/package-pending.json``. This test re-plans it with node and
requires the bytes to match, so a change to either side that breaks the contract fails
here rather than on a GPU session. It also recomputes the document hash in Python, which
proves both languages hash the same canonical form.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from comfyrizz_pipeline.atomic import canonical_hash
from comfyrizz_pipeline.schema import validate_jobs

from conftest import FIXTURES, REPO_ROOT

NODE = shutil.which("node")
PLANNER = REPO_ROOT / "packages" / "jobs" / "bin" / "plan-jobs.mjs"
PACKAGE = REPO_ROOT / "packages" / "jobs" / "test" / "fixtures" / "package-pending.json"
COMMITTED = FIXTURES / "jobs.json"


def test_the_runner_fixture_is_a_valid_jobs_document():
    doc = json.loads(COMMITTED.read_text())
    assert validate_jobs(doc) == []
    assert [job["id"] for job in doc["jobs"]] == [
        "a_cutout.still",
        "a_plate1_still.still",
        "a_plate1.plate",
        "a_plate1.upscale",
        "a_narr.audio",
    ]
    assert [batch["name"] for batch in doc["batches"]] == ["stills", "plates", "upscales", "audio"]
    assert doc["skipped"] and "llm-svg" in doc["skipped"][0]["reason"]


def test_python_recomputes_the_planner_hash():
    doc = json.loads(COMMITTED.read_text())
    assert canonical_hash({**doc, "hash": None}) == doc["hash"], "the two languages disagree on the canonical form"


@pytest.mark.skipif(NODE is None, reason="node is required to re-run the planner")
def test_the_committed_jobs_json_is_current(tmp_path: Path):
    target = tmp_path / "jobs.json"
    planned = subprocess.run(
        [NODE, str(PLANNER), str(PACKAGE), "--out", str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert planned.returncode == 0, planned.stderr
    fresh = json.loads(target.read_text())
    committed = json.loads(COMMITTED.read_text())
    assert fresh["hash"] == committed["hash"], "re-planning produced a different hash"
    assert fresh == committed, "the committed fixture is stale: re-run the planner and commit it"
    checked = subprocess.run(
        [NODE, str(PLANNER), str(PACKAGE), "--out", str(COMMITTED), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert checked.returncode == 0, f"{checked.stdout}{checked.stderr}"
    assert "jobs.json is current" in checked.stdout
