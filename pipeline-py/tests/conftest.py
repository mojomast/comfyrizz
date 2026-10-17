"""Shared pytest fixtures for the pipeline tests."""

from __future__ import annotations

import io
import json
import shutil
from pathlib import Path

import pytest

from comfyrizz_pipeline.client import ComfyClient
from comfyrizz_pipeline.progress import ProgressWriter
from comfyrizz_pipeline.runner import Runner, RunnerConfig
from fake_comfy import FakeComfy

TESTS_DIR = Path(__file__).resolve().parent
FIXTURES = TESTS_DIR / "fixtures"
REPO_ROOT = TESTS_DIR.parents[1]


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def planned_jobs_file() -> Path:
    """The planner's committed output for the pending-asset fixture package."""
    return FIXTURES / "jobs.json"


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    """A private copy of the job fixture, so the runner's relative paths resolve and the repo stays clean."""
    shutil.copy(FIXTURES / "jobs.json", tmp_path / "jobs.json")
    shutil.copytree(FIXTURES / "workflows", tmp_path / "workflows")
    return tmp_path


@pytest.fixture
def out_dir(workdir: Path) -> Path:
    return workdir / "out"


@pytest.fixture
def servers():
    started: list[FakeComfy] = []

    def start(**kwargs) -> FakeComfy:
        fake = FakeComfy(**kwargs)
        fake.__enter__()
        started.append(fake)
        return fake

    yield start
    for fake in started:
        fake.__exit__(None, None, None)


@pytest.fixture
def fake(servers) -> FakeComfy:
    return servers()


@pytest.fixture
def progress() -> ProgressWriter:
    return ProgressWriter(stream=io.StringIO(), echo=False)


@pytest.fixture
def make_runner(workdir: Path):
    """Build a Runner against the fake server (or a client the test supplies).

    The runner writes both JSON-lines stdout and a progress log at
    ``<workdir>/progress.jsonl``, which the tests read back.
    """

    def build(fake: FakeComfy | None = None, client: ComfyClient | None = None, **overrides):
        config = RunnerConfig(
            jobs_file=workdir / "jobs.json",
            out_dir=workdir / "out",
            poll_interval=0.05,
            job_timeout=10.0,
            reconcile_timeout=10.0,
            echo_progress=False,
            progress_path=workdir / "progress.jsonl",
        )
        for key, value in overrides.items():
            setattr(config, key, value)
        if client is None:
            client = ComfyClient(base_url=fake.base_url if fake else None, timeout=5.0)
        writer = ProgressWriter(stream=io.StringIO(), echo=False, path=config.progress_path)
        return Runner(config, client=client, progress=writer)

    return build


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
