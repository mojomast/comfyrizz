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
    previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the manifest for this run, carrying over what an earlier run already recorded (G5-8).

    The backend runs the runner once per batch (`--batch stills`, then `--batch plates`), and every run
    writes this same file. Rewriting it from just this run's jobs means `out/manifest.json` describes
    the *last* batch only: GPU test 5's final manifest said `{succeeded: 2}` for the two plates while
    the three finished stills were nowhere, so they were never applied. Entries from this run win; the
    ones already there are kept, and the counts and `complete` describe the whole set.
    """
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
    carried = manifest_status_map(previous)
    # G5-8: a re-run of one batch must not erase the other jobs' verdicts either. A job this run did
    # not touch comes back as "pending" (there is no result for it), which would quietly reset a
    # succeeded or cached job; the entry already on the VM is the better answer for it.
    settled = {"pending", "skipped"}
    this_run = {entry["job"]: entry for entry in jobs}
    merged: list[dict[str, Any]] = []
    for job_id, before in carried.items():
        entry = this_run.pop(job_id, None)
        if entry is None or (entry["status"] in settled and before["status"] not in settled):
            merged.append(before)
        else:
            merged.append(entry)
    # the order is the plan's: what the earlier batches recorded, then the jobs only this run knows
    merged.extend(this_run.values())
    jobs = merged
    counts = {status: 0 for status in JOB_STATUSES}
    for entry in jobs:
        counts[entry["status"]] = counts.get(entry["status"], 0) + 1
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
    # a run history, so `out/manifest.json` says which invocations made it up
    history = list((previous or {}).get("runs") or [])
    history.append({"run_id": run_id, "startedAt": started_at, "complete": bool(manifest.get("complete")), "jobs": [entry["job"] for entry in jobs]})
    manifest["runs"] = history
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
