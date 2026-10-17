"""Atomic file helpers.

Every state file the pipeline writes (attempt records, the manifest, the cache index,
downloaded outputs) goes through a temp file in the *same directory* plus
``os.replace``, so a reader either sees the previous complete file or the new complete
file — never a half-written one. That matters because the runner is killed mid-run on
Google Colab, and the manifest is what decides success (SPEC.md 6.4).
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any


def ensure_dir(path: Path) -> Path:
    Path(path).mkdir(parents=True, exist_ok=True)
    return Path(path)


def write_bytes_atomic(path: Path, data: bytes) -> Path:
    path = Path(path)
    ensure_dir(path.parent)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path


def write_text_atomic(path: Path, text: str) -> Path:
    return write_bytes_atomic(path, text.encode("utf-8"))


def write_json_atomic(path: Path, data: Any) -> Path:
    return write_text_atomic(path, json.dumps(data, indent=2, sort_keys=False) + "\n")


def read_json(path: Path) -> Any:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def canonical_json(value: Any) -> str:
    """Stable JSON: object keys sorted, no whitespace. Matches the planner's canonical()."""

    def render(node: Any) -> str:
        if isinstance(node, list):
            return "[" + ",".join(render(item) for item in node) + "]"
        if isinstance(node, dict):
            keys = sorted(node)
            return "{" + ",".join(f"{json.dumps(k)}:{render(node[k])}" for k in keys) + "}"
        return json.dumps(node if node is not None else None)

    return render(value)


def canonical_hash(value: Any) -> str:
    return sha256_text(canonical_json(value))
