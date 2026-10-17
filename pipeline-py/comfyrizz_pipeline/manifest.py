"""``out/manifest.json`` — the only thing that decides success (SPEC.md 6.4).

Written atomically after *every* job, so a run that is killed still leaves a manifest
describing exactly what landed on disk. Exit codes and log lines are supporting
evidence; a missing manifest, or one whose recorded jobs hash does not match the
``jobs.json`` it was run for, means *reconcile*, never "assume it worked".
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .atomic import canonical_hash, read_json, write_json_atomic

MANIFEST_NAME = "manifest.json"
MANIFEST_VERSION = 1
JOB_STATUSES = (
    "pending",
    "submitted",
    "succeeded",
    "failed",
    "canceled",
    "submission_unknown",
    "skipped",
    "cached",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def build_manifest(
    *,
    run_id: str,
    jobs_doc: dict[str, Any],
    results: dict[str, dict[str, Any]],
    started_at: str,
    run_dir: Path | None = None,
    notes: list[str] | None = None,
) -> dict[str, Any]:
    jobs = []
    counts: dict[str, int] = {status: 0 for status in JOB_STATUSES}
    for job in jobs_doc.get("jobs", []):
        result = results.get(job["id"], {})
        status = result.get("status", "pending")
        counts[status] = counts.get(status, 0) + 1
        entry: dict[str, Any] = {"job": job["id"], "status": status}
        for key in ("attempt_id", "job_id", "cache_key", "error", "reason", "duration_seconds"):
            if result.get(key) is not None:
                entry[key] = result[key]
        entry["outputs"] = result.get("outputs", [])
        jobs.append(entry)
    complete = all(entry["status"] in ("succeeded", "cached") for entry in jobs) and bool(jobs)
    manifest = {
        "v": MANIFEST_VERSION,
        "run_id": run_id,
        "jobsHash": jobs_doc.get("hash"),
        "packageId": jobs_doc.get("packageId"),
        "revision": jobs_doc.get("revision"),
        "startedAt": started_at,
        "updatedAt": now_iso(),
        "complete": complete,
        "counts": {k: v for k, v in counts.items() if v},
        "jobs": jobs,
    }
    if run_dir is not None:
        manifest["runDir"] = str(run_dir)
    if notes:
        manifest["notes"] = notes
    return manifest


def write_manifest(out_dir: Path, manifest: dict[str, Any]) -> Path:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    return write_json_atomic(out_dir / MANIFEST_NAME, manifest)


def read_manifest(out_dir: Path) -> dict[str, Any] | None:
    path = Path(out_dir) / MANIFEST_NAME
    if not path.is_file():
        return None
    return read_json(path)


def manifest_status_map(manifest: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not manifest:
        return {}
    return {entry["job"]: entry for entry in manifest.get("jobs", [])}


def manifest_decides_success(manifest: dict[str, Any] | None, jobs_doc: dict[str, Any] | None = None) -> tuple[bool, str]:
    """(success, why). Only a present manifest for the same jobs counts."""
    if manifest is None:
        return False, "no manifest was found in the output directory"
    if manifest.get("v") != MANIFEST_VERSION:
        return False, f"manifest version {manifest.get('v')} is not {MANIFEST_VERSION}"
    if jobs_doc is not None and manifest.get("jobsHash") != jobs_doc.get("hash"):
        return False, "manifest jobsHash does not match this jobs.json; reconcile or rerun"
    if not manifest.get("complete"):
        blocked = [entry["job"] for entry in manifest.get("jobs", []) if entry["status"] not in ("succeeded", "cached")]
        return False, f"manifest is not complete: {', '.join(blocked) or 'no jobs recorded'}"
    return True, "every job succeeded (or was served from cache) and the manifest matches jobs.json"


def manifest_fingerprint(manifest: dict[str, Any]) -> str:
    """A hash of the recorded outputs, for comparing a manifest with what is on disk."""
    return canonical_hash(
        [
            {
                "job": entry["job"],
                "status": entry["status"],
                "outputs": [(o.get("file"), o.get("sha256")) for o in entry.get("outputs", [])],
            }
            for entry in manifest.get("jobs", [])
        ]
    )
