"""Attempt records: the JSON file that survives a lost exec (SPEC.md 6.4).

Order of operations that makes the record useful:

1. ``record = store.open(job, ...)`` writes ``attempts/<attempt_id>.json`` with
   ``state="submitting"`` **before** the submit call is made. A request that reaches the
   server but whose reply is lost therefore still leaves evidence that we sent it.
2. as soon as the API returns a job id, ``store.update(record, state="submitted",
   job_id=...)`` writes it — *before* any progress line is printed.
3. terminal outcomes update ``state`` to ``succeeded`` / ``failed`` / ``canceled``.

``submission_unknown`` is the state for "the request may have reached the server but no
job id was recorded". Nothing in this package ever resubmits such a record
automatically; :meth:`AttemptStore.unresolved_for_job` is how the runner finds one.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .atomic import ensure_dir, read_json, sha256_file, write_json_atomic

#: The complete set of states. submissions are append-only in effect: a new attempt for
#: the same job is a new file, never a rewrite of an old outcome.
STATES = (
    "submitting",
    "submitted",
    "submission_unknown",
    "succeeded",
    "failed",
    "canceled",
)

TERMINAL_STATES = ("succeeded", "failed", "canceled")
OPEN_STATES = ("submitting", "submitted", "submission_unknown")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Attempt:
    attempt_id: str
    job: str
    state: str
    idempotency_key: str
    inputs_hash: str
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    seq: int = 1
    job_id: str | None = None
    submitted_at: str | None = None
    finished_at: str | None = None
    backend: str | None = None
    cache_key: str | None = None
    outputs: list[dict[str, Any]] = field(default_factory=list)
    error: dict[str, Any] | None = None
    events: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Attempt":
        known = {f: data[f] for f in cls.__dataclass_fields__ if f in data}  # type: ignore[attr-defined]
        return cls(**known)

    @property
    def is_open(self) -> bool:
        return self.state in OPEN_STATES


class AttemptStore:
    """A directory of attempt records, one JSON file per attempt."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)

    def path(self, attempt_id: str) -> Path:
        return self.directory / f"{attempt_id}.json"

    def open(self, attempt: Attempt) -> Attempt:
        """Write a *new* attempt record. Refuses to overwrite an existing one."""
        ensure_dir(self.directory)
        target = self.path(attempt.attempt_id)
        if target.exists():
            raise FileExistsError(f"attempt record already exists: {target}")
        write_json_atomic(target, attempt.to_dict())
        return attempt

    def update(self, attempt: Attempt, **fields: Any) -> Attempt:
        for key, value in fields.items():
            if key not in Attempt.__dataclass_fields__:  # type: ignore[attr-defined]
                raise KeyError(f"{key} is not an attempt field")
            setattr(attempt, key, value)
        # timestamps are derived from the state, so a caller can never record a
        # submitted attempt without a submission time
        if attempt.state == "submitted" and attempt.submitted_at is None:
            attempt.submitted_at = now_iso()
        if attempt.state in TERMINAL_STATES and attempt.finished_at is None:
            attempt.finished_at = now_iso()
        attempt.updated_at = now_iso()
        write_json_atomic(self.path(attempt.attempt_id), attempt.to_dict())
        return attempt

    def load(self, attempt_id: str) -> Attempt:
        return Attempt.from_dict(read_json(self.path(attempt_id)))

    def load_all(self) -> list[Attempt]:
        if not self.directory.is_dir():
            return []
        records = [Attempt.from_dict(read_json(p)) for p in sorted(self.directory.glob("*.json"))]
        records.sort(key=lambda a: (a.created_at, a.attempt_id))
        return records

    def for_job(self, job: str) -> list[Attempt]:
        return [a for a in self.load_all() if a.job == job]

    def unresolved_for_job(self, job: str) -> Attempt | None:
        """The newest open attempt for a job: submitted (poll it) or ambiguous (ask the user)."""
        open_attempts = [a for a in self.for_job(job) if a.is_open]
        return open_attempts[-1] if open_attempts else None

    def next_seq(self, job: str) -> int:
        return len(self.for_job(job)) + 1

    def output_hashes(self, attempt: Attempt) -> list[dict[str, Any]]:
        """Re-hash an attempt's outputs from disk (used to prove a collected file)."""
        checked = []
        for output in attempt.outputs:
            path = Path(output.get("file", ""))
            entry = dict(output)
            entry["exists"] = path.is_file()
            entry["sha256_on_disk"] = sha256_file(path) if entry["exists"] else None
            entry["integrity"] = "ok" if entry["sha256_on_disk"] == output.get("sha256") else "mismatch"
            checked.append(entry)
        return checked


def summarise(attempts: list[Attempt]) -> dict[str, int]:
    counts: dict[str, int] = {state: 0 for state in STATES}
    for attempt in attempts:
        counts[attempt.state] = counts.get(attempt.state, 0) + 1
    return counts


def attempts_jsonl(attempts: list[Attempt]) -> str:
    """The host-side copy on Google Colab: ``runs/<run_id>/attempts.jsonl`` (SPEC.md 6.4)."""
    return "".join(json.dumps(a.to_dict(), sort_keys=True) + "\n" for a in attempts)
