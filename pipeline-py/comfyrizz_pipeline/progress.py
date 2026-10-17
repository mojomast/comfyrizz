"""JSON-lines progress (SPEC.md 6.4):

    {"v":1,"attempt":"...","job":"s1.plate","seq":12,"event":"progress","value":0.42}

One JSON object per line on stdout (and optionally appended to a log file, which is what
the Google Colab backend tails). ``seq`` is monotonic per process so a reader can tell a
dropped line from a reordered one.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO

PROGRESS_VERSION = 1


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class ProgressWriter:
    def __init__(self, stream: TextIO | None = None, path: Path | None = None, echo: bool = True):
        self.stream = stream
        self.path = Path(path) if path else None
        self.echo = echo
        self.seq = 0
        self.lines: list[dict[str, Any]] = []
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(
        self,
        event: str,
        *,
        job: str | None = None,
        attempt: str | None = None,
        value: Any = None,
        **extra: Any,
    ) -> dict[str, Any]:
        self.seq += 1
        record: dict[str, Any] = {
            "v": PROGRESS_VERSION,
            "attempt": attempt,
            "job": job,
            "seq": self.seq,
            "event": event,
        }
        if value is not None:
            record["value"] = value
        record["at"] = now_iso()
        for key, item in extra.items():
            if item is not None:
                record[key] = item
        line = json.dumps(record, sort_keys=False)
        self.lines.append(record)
        if self.echo and self.stream is not None:
            print(line, file=self.stream, flush=True)
        if self.path:
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        return record

    def events(self) -> list[str]:
        return [record["event"] for record in self.lines]

    def for_job(self, job: str) -> list[dict[str, Any]]:
        return [record for record in self.lines if record["job"] == job]


def stdout_writer(path: Path | None = None, echo: bool = True) -> ProgressWriter:
    return ProgressWriter(stream=sys.stdout, path=path, echo=echo)


def parse_lines(text: str) -> list[dict[str, Any]]:
    """Parse JSON-lines output; raises on a malformed line so a test cannot pass silently."""
    records = []
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError as exc:  # pragma: no cover - defensive
            raise ValueError(f"progress line {number} is not JSON: {line!r}") from exc
    return records
