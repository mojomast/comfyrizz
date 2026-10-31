"""Google Colab e2e 2026-10-30: comfy-api-proxy reports a just-finished job as "expired"."""
from types import SimpleNamespace

from comfyrizz_pipeline import runner as runner_mod
from comfyrizz_pipeline.runner import EXPIRED_CONFIRMATIONS, Runner


def make(statuses):
    polls = iter(statuses)
    r = Runner.__new__(Runner)
    r.config = SimpleNamespace(poll_interval=0)
    r.client = SimpleNamespace(poll=lambda job_id: SimpleNamespace(status=next(polls), progress=None, error=None))
    r.progress = SimpleNamespace(emit=lambda *a, **k: None)
    r.attempts = SimpleNamespace(update=lambda attempt, **k: SimpleNamespace(**{**vars(attempt), **k}))
    r._result = lambda job, state, attempt=None, **k: {"status": state, **k}
    return r


def attempt():
    return SimpleNamespace(job_id="j1", attempt_id="a1", state="submitted")


def test_a_transient_expired_is_polled_again_and_the_real_end_wins():
    r = make(["expired", "failed"])
    assert r._poll_attempt({"id": "x"}, attempt(), timeout=5, collecting=False)["error"]["code"] == "job_failed"


def test_expired_is_believed_once_it_repeats():
    r = make(["expired"] * (EXPIRED_CONFIRMATIONS + 1))
    result = r._poll_attempt({"id": "x"}, attempt(), timeout=5, collecting=False)
    assert result["status"] == "failed"
    assert result["error"]["code"] == "job_expired"
