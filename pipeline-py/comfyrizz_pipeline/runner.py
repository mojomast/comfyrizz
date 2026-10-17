"""The pipeline runner: ``jobs.json`` -> Comfy -> ``out/manifest.json`` (SPEC.md 6.4).

Run it locally, on a Google Colab VM, or through the BYO backend — the same code path
(§6.5). What it guarantees:

* an attempt record is written **before** the submit call, and the job id is written the
  moment the API returns it, before any progress line;
* ``submission_unknown`` is recorded and never resubmitted automatically — ``run()`` sees
  an open attempt and polls it instead of sending a second request;
* the manifest is rewritten atomically after every job, so a killed run still leaves the
  truth about what landed;
* outputs are collected after each job, so a later failure never discards earlier work;
* a cache key of ``(workflow sha, resolved inputs, model revision, seed, dims, frames)``
  lets an unchanged job be served from disk without touching the GPU.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .atomic import canonical_hash, ensure_dir, read_json, sha256_file, write_json_atomic
from .attempts import Attempt, AttemptStore, attempts_jsonl, now_iso
from .client import ComfyClient, UploadError, classify_metadata_refusal, load_file_params
from .manifest import build_manifest, manifest_decides_success, read_manifest, write_manifest
from .progress import stdout_writer
from .schema import validate_jobs

KILL_AFTER_SUBMIT_ENV = "COMFYRIZZ_TEST_KILL_AFTER_SUBMIT"
CACHE_INDEX = "cache/index.json"
#: sha256 -> the name the server gave that file, per deployment root. A new VM has an empty
#: input directory, so the cache is keyed by (url, sha256): reusing a name across servers would
#: hand the graph a file that is not there. **[this is the invariant that keeps a retry honest]**
UPLOAD_INDEX = "cache/uploads.json"



def _truthy(value: str | None) -> bool:
    return str(value).lower() in ("1", "true", "yes", "on")


@dataclass
class RunnerConfig:
    jobs_file: Path
    out_dir: Path
    base_url: str | None = None
    run_id: str | None = None
    poll_interval: float = 0.25
    job_timeout: float = 3600.0
    submit_timeout: float = 30.0
    reconcile_timeout: float = 120.0
    cache_enabled: bool = True
    allow_retry_failed: bool = True
    progress_path: Path | None = None
    echo_progress: bool = True
    #: upload endpoint override; default is ``<base_url>/upload/image`` (a proxy that does not
    #: forward ComfyUI's native routes can be bypassed by pointing this at ComfyUI itself)
    upload_url: str | None = None
    uploads_enabled: bool = True
    #: Job labels (`metadata`): `"auto"` sends them and drops them for the rest of the run if the
    #: server refuses them (comfy-api-proxy does: GPU test 2, issue 1); True/False force one way.
    job_labels: bool | str = "auto"
    #: run only one batch of the plan ("stills" | "plates" | "upscales" | "audio"); the Google
    #: Colab backend admits and collects batch by batch so the reserve is checked mid-package
    batch: str | None = None
    kill_after_submit: bool = field(default_factory=lambda: _truthy(os.environ.get(KILL_AFTER_SUBMIT_ENV)))

    def run_dir(self) -> Path:
        return Path(self.out_dir) / "runs" / (self.run_id or "unknown")



class Runner:
    def __init__(self, config: RunnerConfig, client: ComfyClient | None = None, progress: Any = None):
        self.config = config
        self.config.out_dir = Path(self.config.out_dir)
        self.config.jobs_file = Path(self.config.jobs_file)
        self.attempts = AttemptStore(self.config.out_dir / "attempts")
        self.client = client or ComfyClient(
            base_url=config.base_url,
            timeout=config.submit_timeout,
            upload_url=config.upload_url or os.environ.get("COMFY_UPLOAD_URL"),
        )
        self.progress = progress or stdout_writer(config.progress_path, echo=config.echo_progress)
        self.jobs_doc: dict[str, Any] = {}
        self.results: dict[str, dict[str, Any]] = {}
        self.started_at = now_iso()
        #: sha256 -> {name, url, at}: what this run has already uploaded, so two jobs that need
        #: the same bytes (a still used as an i2v source twice) upload them once
        self._uploads: dict[str, dict[str, Any]] = {}
        #: job labels state: None until the server says something, then True/False
        self.labels_ok: bool | None = None
        self.label_note: str | None = None
        self.run_id = config.run_id or f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:6]}"
        # the run directory is named after the run id, so keep the two in step
        self.config.run_id = self.run_id


    # -- setup ---------------------------------------------------------------------
    def load_jobs(self) -> dict[str, Any]:
        raw = read_json(self.config.jobs_file)
        problems = validate_jobs(raw)
        if problems:
            detail = "\n".join(f"  {p['path']} {p['code']}: {p['message']}" for p in problems)
            raise ValueError(f"{self.config.jobs_file} is not a valid comfyrizz.jobs/v1 document:\n{detail}")
        if self.config.batch:
            raw = self._filter_batch(raw, self.config.batch)
        self.jobs_doc = raw
        return raw

    def _filter_batch(self, doc: dict[str, Any], batch: str) -> dict[str, Any]:
        """Keep one batch, and refuse to run it before its dependencies have landed."""
        known = {job["batch"] for job in doc.get("jobs", [])}
        if batch not in known:
            raise ValueError(f"batch {batch!r} is not in this plan (it has: {', '.join(sorted(known))})")
        succeeded = {attempt.job for attempt in self.attempts.load_all() if attempt.state == "succeeded"}
        kept = []
        for job in doc.get("jobs", []):
            if job.get("batch") != batch:
                continue
            blocked = [dep for dep in job.get("deps", []) if dep not in succeeded and all(other["id"] != dep or other.get("batch") != batch for other in doc.get("jobs", []))]
            if blocked:
                job = {**job, "_blockedBy": blocked}
            kept.append(job)
        filtered = {**doc, "jobs": kept, "batch": batch, "batches": [entry for entry in doc.get("batches", []) if entry["name"] in (batch,)]}
        filtered["hash"] = doc.get("hash")
        return filtered

    def _jobs_by_id(self) -> dict[str, dict[str, Any]]:
        return {job["id"]: job for job in self.jobs_doc.get("jobs", [])}

    def job_params_source(self, job: dict[str, Any]) -> str | None:
        return job.get("paramsSource")

    # -- cache ---------------------------------------------------------------------
    def _cache_path(self) -> Path:
        return self.config.out_dir / CACHE_INDEX

    def _cache_load(self) -> dict[str, Any]:
        path = self._cache_path()
        if not path.is_file():
            return {"v": 1, "entries": {}}
        data = read_json(path)
        data.setdefault("entries", {})
        return data

    def cache_lookup(self, job: dict[str, Any]) -> dict[str, Any] | None:
        if not self.config.cache_enabled:
            return None
        entry = self._cache_load()["entries"].get(job.get("cacheKey"))
        if not entry:
            return None
        path = self.config.out_dir / entry["file"]
        if not path.is_file() or sha256_file(path) != entry["sha256"]:
            return None
        return entry

    def _cache_store(self, job: dict[str, Any], outputs: list[dict[str, Any]], attempt_id: str) -> None:
        if not self.config.cache_enabled or not outputs:
            return
        data = self._cache_load()
        primary = outputs[0]
        rel = str(Path(primary["file"]).relative_to(self.config.out_dir))
        data["entries"][job["cacheKey"]] = {
            "job": job["id"],
            "file": rel,
            "sha256": primary["sha256"],
            "attempt_id": attempt_id,
            "at": now_iso(),
        }
        write_json_atomic(self._cache_path(), data)

    # -- file inputs (uploads) ------------------------------------------------------
    def _upload_cache_path(self) -> Path:
        return self.config.out_dir / UPLOAD_INDEX

    def _upload_cache_load(self) -> dict[str, Any]:
        path = self._upload_cache_path()
        if not path.is_file():
            return {"v": 1, "entries": {}}
        data = read_json(path)
        data.setdefault("entries", {})
        return data

    def file_input_paths(self, job: dict[str, Any]) -> tuple[dict[str, Path], dict[str, Any] | None]:
        """Resolve a job's declared file inputs to files on disk.

        ``from: "job"`` is a path relative to the output directory (a dependency's output — the
        still an i2v plate starts from); ``from: "package"`` is relative to the plan directory
        (an SVG raster shipped with the bundle, or a file the caller staged next to jobs.json).

        A missing file is returned as a problem, *before* any attempt record: this is a local
        refusal, nothing was submitted, and the manifest says so instead of the GPU finding out.
        """
        entries = job.get("fileInputs") or []
        paths: dict[str, Path] = {}
        for entry in entries:
            param = str(entry.get("param") or "")
            source = str(entry.get("from") or "")
            rel = entry.get("path")
            if not param or source not in ("job", "package") or not isinstance(rel, str):
                return {}, {
                    "code": "input_file_unresolved",
                    "message": f"{job['id']}: fileInputs entry {json.dumps(entry)} needs param, from (job|package) and path",
                }
            root = self.config.out_dir if source == "job" else self.config.jobs_file.parent
            path = Path(rel)
            if path.is_absolute():
                return {}, {
                    "code": "input_file_unresolved",
                    "message": f"{job['id']}: fileInputs path {rel} is absolute; plan paths are relative to the {source} root",
                }
            resolved = root / path
            if not resolved.is_file():
                depends_on = entry.get("job")
                detail = f"the {source} file {rel} is not on disk"
                if source == "job" and depends_on:
                    status = (self.results.get(depends_on) or {}).get("status")
                    detail += f" (its source job {depends_on} is {status or 'not in this run'})"
                return {}, {
                    "code": "input_file_missing",
                    "message": f"{job['id']}: {param} needs {detail}; nothing was submitted",
                }
            paths[param] = resolved
        return paths, None

    def upload_input(self, path: Path) -> dict[str, Any]:
        """Upload once per (deployment root, content) and reuse the server's name after that.

        The name the server returns is content-addressed by us (``<stem>_<sha8><suffix>``) and
        cached in ``out/cache/uploads.json``. That cache is what makes a reconcile-after-lost-exec
        cheap *and* correct: the file is already in that server's input directory, so a re-polled
        job and a retried job both name the same file.
        """
        path = Path(path)
        if not self.config.uploads_enabled:
            raise UploadError("upload_disabled", f"uploads are disabled and {path.name} is needed as an input")
        digest = sha256_file(path)
        url = self.client.upload_url
        entry = self._uploads.get(digest) or self._upload_cache_load()["entries"].get(digest)
        if entry and entry.get("url") == url:
            self._uploads[digest] = entry
            self.progress.emit("upload_cached", job=None, value=entry["name"])
            return entry

        name = f"{path.stem}_{digest[:8]}{path.suffix}"
        uploaded = self.client.upload_file(path, name=name)
        entry = {
            "name": uploaded["name"],
            "reference": uploaded["reference"],
            "sha256": digest,
            "bytes": uploaded["bytes"],
            "url": url,
            "file": str(path),
            "at": now_iso(),
        }
        self._uploads[digest] = entry
        data = self._upload_cache_load()
        data["entries"][digest] = entry
        write_json_atomic(self._upload_cache_path(), data)
        self.progress.emit("upload_done", value={"name": entry["name"], "bytes": entry["bytes"], "file": str(path)})
        return entry

    # -- manifest ------------------------------------------------------------------
    def _write_manifest(self, notes: list[str] | None = None) -> dict[str, Any]:
        if self.label_note:
            notes = [*(notes or []), self.label_note]
        manifest = build_manifest(
            run_id=self.run_id,
            jobs_doc=self.jobs_doc,
            results=self.results,
            started_at=self.started_at,
            run_dir=self.config.run_dir(),
            notes=notes,
        )
        write_manifest(self.config.out_dir, manifest)
        run_dir = self.config.run_dir()
        ensure_dir(run_dir)
        (run_dir / "attempts.jsonl").write_text(attempts_jsonl(self.attempts.load_all()), encoding="utf-8")
        self.manifest = manifest
        return manifest

    def workflow_path(self, job: dict[str, Any]) -> Path:
        """A relative workflow path is resolved against the jobs.json directory.

        That is the layout on the Google Colab VM (`/content/comfyrizz/jobs.json` next to
        `workflows/`), and it makes the plan directory-relocatable.
        """
        path = Path(job["workflow"])
        if path.is_absolute():
            return path
        return self.config.jobs_file.parent / path

    # -- one job -------------------------------------------------------------------
    def _outputs_dest(self, job: dict[str, Any], index: int, snapshot: Any) -> Path:
        if index == 0:
            return self.config.out_dir / job["output"]
        name = Path(job["output"]).name
        suffix = Path(name).suffix
        return self.config.out_dir / "out" / "extras" / f"{Path(name).stem}_{index}{suffix}"

    def _collect(self, job: dict[str, Any], snapshot: Any, attempt: Attempt) -> list[dict[str, Any]]:
        collected = []
        for index, output in enumerate(snapshot.outputs):
            dest = self._outputs_dest(job, index, snapshot)
            saved = self.client.download(output, dest)
            saved["relative"] = str(Path(saved["file"]).relative_to(self.config.out_dir))
            collected.append(saved)
            self.progress.emit("output_saved", job=job["id"], attempt=attempt.attempt_id, value=saved["relative"])
        return collected

    def _resolve_open_attempt(self, job: dict[str, Any], attempt: Attempt) -> dict[str, Any]:
        """An open attempt from an earlier run: poll it or surface it. Never submit again."""
        if not attempt.job_id:
            # "submitting" (killed before the reply) and "submission_unknown" both land here:
            # there is no job id to poll, so the user decides whether to retry.
            if attempt.state == "submitting":
                attempt = self.attempts.update(
                    attempt,
                    state="submission_unknown",
                    error={
                        "code": "submission_unknown",
                        "message": "attempt record was left in submitting with no job id; the request may have reached the server",
                    },
                )
            else:
                attempt = self.attempts.update(
                    attempt,
                    error=attempt.error
                    or {"code": "submission_unknown", "message": "the submit outcome was never resolved"},
                )
            self.progress.emit("submission_unknown", job=job["id"], attempt=attempt.attempt_id, value=(attempt.error or {}).get("code"))
            return self._result(
                job,
                "submission_unknown",
                attempt,
                error=attempt.error,
                reason="ambiguous submit; not resubmitted automatically",
            )
        return self._poll_attempt(job, attempt, timeout=self.config.reconcile_timeout, collecting=True)

    def _poll_attempt(self, job: dict[str, Any], attempt: Attempt, *, timeout: float, collecting: bool) -> dict[str, Any]:
        if not attempt.job_id:
            raise ValueError(f"cannot poll attempt {attempt.attempt_id}: it has no job id (state {attempt.state})")
        deadline = time.monotonic() + timeout
        snapshot = None
        while True:
            snapshot = self.client.poll(attempt.job_id)
            if snapshot.progress is not None:
                self.progress.emit("progress", job=job["id"], attempt=attempt.attempt_id, value=snapshot.progress)
            if snapshot.status in ("succeeded", "failed", "canceled", "expired"):
                break
            if time.monotonic() >= deadline:
                return self._result(job, "submitted", attempt, reason=f"still {snapshot.status} after {timeout:g}s; poll again later")
            time.sleep(self.config.poll_interval)

        if snapshot.status == "succeeded":
            outputs = self._collect(job, snapshot, attempt) if collecting else []
            attempt = self.attempts.update(attempt, state="succeeded", outputs=outputs, finished_at=now_iso())
            self._cache_store(job, outputs, attempt.attempt_id)
            self.progress.emit("job_done", job=job["id"], attempt=attempt.attempt_id, value=len(outputs))
            return self._result(job, "succeeded", attempt, outputs=outputs)
        state = "canceled" if snapshot.status == "canceled" else "failed"
        error = snapshot.error or {"code": f"job_{snapshot.status}", "message": f"job ended as {snapshot.status}"}
        attempt = self.attempts.update(attempt, state=state, error=error, finished_at=now_iso())
        self.progress.emit("job_failed", job=job["id"], attempt=attempt.attempt_id, value=error.get("code"))
        return self._result(job, state, attempt, error=error)

    def job_labels_enabled(self) -> bool:
        """Whether the *next* submit carries metadata labels.

        ``auto`` starts optimistic: labels are what make an ambiguous submit recoverable, so the
        runner asks for them until a server says no. ``comfy-api-proxy`` refuses the SDK's metadata
        object (GPU test 2, issue 1), so a run against it pays one refused submit and then goes
        label-free — recorded in the manifest note rather than silently.
        """
        if self.config.job_labels is True:
            return True
        if self.config.job_labels is False:
            return False
        return self.labels_ok is not False

    def _job_labels(self, attempt_id: str, job: dict[str, Any]) -> dict[str, str] | None:
        if not self.job_labels_enabled():
            return None
        return {"comfyrizz_attempt": attempt_id, "comfyrizz_job": job["id"]}

    def _note_labels_unsupported(self, job: dict[str, Any], outcome: Any) -> None:
        self.labels_ok = False
        self.label_note = (
            f"this server refused job labels ({outcome.error.get('code') if outcome.error else 'refused'}"
            f"{': ' + str(outcome.error.get('message'))[:160] if outcome.error else ''}); "
            "the run continued without metadata, so a lost submit cannot be recovered from its label"
        )
        self.progress.emit("metadata_unsupported", job=job["id"], attempt=None, value=self.label_note)

    def _submit_job(self, job: dict[str, Any], *, file_inputs: dict[str, Path] | None = None) -> dict[str, Any]:
        params = dict(job.get("params") or {})
        file_inputs = file_inputs or {}
        # 1. the files this job needs go to the server's input directory first: a graph that
        #    names a file that was never uploaded fails late, on the GPU, after the session
        #    was billed. An upload that fails is a refusal - no attempt record, nothing submitted.
        declared = set(load_file_params(self.workflow_path(job), self.job_params_source(job)))
        misdeclared = sorted(name for name in file_inputs if name not in declared)
        if misdeclared:
            problem = {
                "code": "upload_not_declared",
                "message": (
                    f"{job['id']}: {self.workflow_path(job).name} needs {', '.join(misdeclared)} uploaded, but its params file "
                    f"declares no `files` entry for it: add \"files\": [{', '.join(json.dumps(name) for name in misdeclared)}] "
                    "so the runner knows the value is a file and not a node value"
                ),
            }
            self.progress.emit("job_failed", job=job["id"], value=problem["code"])
            return self._result(job, "failed", error=problem, reason="the workflow does not declare this input as a file")
        uploaded: dict[str, dict[str, Any]] = {}
        for param, path in file_inputs.items():
            try:
                uploaded[param] = self.upload_input(path)
            except UploadError as exc:
                self.progress.emit("job_failed", job=job["id"], value=exc.code)
                return self._result(job, "failed", error=exc.as_error(), reason="the input file could not be uploaded; nothing was submitted")
        params.update({param: entry["reference"] for param, entry in uploaded.items()})

        seq = self.attempts.next_seq(job["id"])
        attempt_id = f"att_{job['id'].replace('/', '_')}_{seq:02d}"
        idempotency_key = f"comfyrizz-{job['id']}-{job['cacheKey'][:16]}-{seq}"
        attempt = Attempt(
            attempt_id=attempt_id,
            job=job["id"],
            state="submitting",
            idempotency_key=idempotency_key,
            inputs_hash=canonical_hash(
                {
                    "params": params,
                    # the *content* of every uploaded input, so two runs that differ only in the
                    # bytes behind an asset id are not the same attempt
                    "files": {param: entry["sha256"] for param, entry in uploaded.items()},
                    "cacheKey": job.get("cacheKey"),
                }
            ),
            seq=seq,
            backend=self.config.base_url or os.environ.get("COMFY_BASE_URL"),
            cache_key=job.get("cacheKey"),
            events=(
                [{"at": now_iso(), "event": "inputs_uploaded", "files": {param: entry["name"] for param, entry in uploaded.items()}}]
                if uploaded
                else []
            ),
        )
        # 2. the record exists before the request is made
        self.attempts.open(attempt)
        self.progress.emit("attempt_open", job=job["id"], attempt=attempt_id, value=attempt.state)
        if os.environ.get("COMFYRIZZ_TEST_KILL_BEFORE_SUBMIT") and _truthy(os.environ["COMFYRIZZ_TEST_KILL_BEFORE_SUBMIT"]):
            os._exit(137)

        outcome = self.client.submit(
            self.workflow_path(job),
            params=params,
            idempotency_key=idempotency_key,
            metadata=self._job_labels(attempt_id, job),
            params_source=self.job_params_source(job),
            # the paths go back in so the workflow's own `files` declaration is enforced; the
            # uploader is the same cache, so this second pass makes no second upload
            file_inputs=file_inputs,
            upload=self.upload_input,
        )

        if outcome.kind == "refused" and self.job_labels_enabled() and classify_metadata_refusal(outcome):
            # one contract, chosen by the server: ask for labels, and if it says no, ask again
            # without them. A refusal means nothing was accepted, so this cannot double-bill.
            self._note_labels_unsupported(job, outcome)
            attempt = self.attempts.update(
                attempt,
                events=[*(attempt.events or []), {"at": now_iso(), "event": "metadata_retry", "because": (outcome.error or {}).get("code")}],
            )
            outcome = self.client.submit(
                self.workflow_path(job),
                params=params,
                idempotency_key=idempotency_key,
                metadata=None,
                params_source=self.job_params_source(job),
                file_inputs=file_inputs,
                upload=self.upload_input,
            )

        if outcome.submitted:
            # 3. the job id is written the moment we have it, before any progress line
            attempt = self.attempts.update(attempt, state="submitted", job_id=outcome.job_id, submitted_at=now_iso())
            self.progress.emit("submitted", job=job["id"], attempt=attempt_id, value=outcome.job_id)
            if self.config.kill_after_submit:
                os._exit(137)
            return self._poll_attempt(job, attempt, timeout=self.config.job_timeout, collecting=True)

        if outcome.kind == "duplicate_key":
            return self._recover_duplicate_key(job, attempt, outcome)
        if outcome.kind == "ambiguous":
            attempt = self.attempts.update(attempt, state="submission_unknown", error=outcome.error)
            self.progress.emit("submission_unknown", job=job["id"], attempt=attempt_id, value=(outcome.error or {}).get("code"))
            return self._result(job, "submission_unknown", attempt, error=outcome.error, reason="submit outcome unknown; not resubmitted")
        attempt = self.attempts.update(attempt, state="failed", error=outcome.error, finished_at=now_iso())
        self.progress.emit("job_failed", job=job["id"], attempt=attempt_id, value=(outcome.error or {}).get("code"))
        return self._result(job, "failed", attempt, error=outcome.error)

    def _recover_duplicate_key(self, job: dict[str, Any], attempt: Attempt, outcome: Any) -> dict[str, Any]:
        """A reused key is rejected, not replayed: adopt the job it created, if we can find it.

        Finding it means listing jobs by label, which the proxy refuses (GPU test 2, issue 1), so with
        labels off this goes straight to ``submission_unknown`` — the honest answer, because a label
        search that cannot run is not evidence that no job exists.
        """
        listed = self.client.list_jobs(metadata={"comfyrizz_job": job["id"]}) if self.job_labels_enabled() else []
        for item in listed:
            if str(item.get("id", "")).startswith("job_"):
                attempt = self.attempts.update(
                    attempt,
                    state="submitted",
                    job_id=item["id"],
                    submitted_at=now_iso(),
                    events=[{"at": now_iso(), "event": "adopted_after_idempotency_reuse"}],
                )
                self.progress.emit("submitted", job=job["id"], attempt=attempt.attempt_id, value=item["id"], recovered=True)
                return self._poll_attempt(job, attempt, timeout=self.config.job_timeout, collecting=True)
        attempt = self.attempts.update(attempt, state="submission_unknown", error=outcome.error)
        self.progress.emit("submission_unknown", job=job["id"], attempt=attempt.attempt_id, value="idempotency_key_reuse")
        return self._result(
            job,
            "submission_unknown",
            attempt,
            error=outcome.error,
            reason="the server rejected a reused idempotency key but no job could be found for this label",
        )

    @staticmethod
    def _result(job: dict[str, Any], status: str, attempt: Attempt | None = None, *, outputs: list[dict[str, Any]] | None = None, error: dict[str, Any] | None = None, reason: str | None = None) -> dict[str, Any]:
        result: dict[str, Any] = {"status": status, "outputs": outputs or [], "cache_key": job.get("cacheKey")}
        if attempt is not None:
            result["attempt_id"] = attempt.attempt_id
            result["job_id"] = attempt.job_id
        if error is not None:
            result["error"] = error
        if reason is not None:
            result["reason"] = reason
        return result

    # -- entry points --------------------------------------------------------------
    def run(self) -> dict[str, Any]:
        self.load_jobs()
        ensure_dir(self.config.out_dir)
        self.progress.emit("run_start", value={"run_id": self.run_id, "jobs": len(self.jobs_doc["jobs"]), "out": str(self.config.out_dir)})
        jobs = self.jobs_doc["jobs"]
        failed_jobs: set[str] = set()
        for job in jobs:
            dependencies = [dep for dep in job.get("deps", []) if dep in failed_jobs]
            blocked = list(job.get("_blockedBy") or [])
            if dependencies or blocked:
                failed_jobs.add(job["id"])
                reason = (
                    f"dependency not in this batch and not already succeeded: {', '.join(blocked)}"
                    if blocked
                    else f"dependency failed: {', '.join(dependencies)}"
                )
                self.results[job["id"]] = self._result(job, "skipped", reason=reason)
                self.progress.emit("job_skipped", job=job["id"], value=reason)
                self._write_manifest()
                continue

            self.progress.emit("job_start", job=job["id"], value=job["batch"])
            started = time.monotonic()

            cached = self.cache_lookup(job)
            if cached:
                outputs = [
                    {
                        "file": str(self.config.out_dir / cached["file"]),
                        "relative": cached["file"],
                        "sha256": cached["sha256"],
                        "bytes": (self.config.out_dir / cached["file"]).stat().st_size,
                        "kind": job.get("outputKind"),
                        "from_cache": True,
                    }
                ]
                self.results[job["id"]] = self._result(job, "cached", outputs=outputs, reason=f"cache hit from attempt {cached['attempt_id']}")
                self.progress.emit("cache_hit", job=job["id"], value=cached["file"])
                self._write_manifest()
                continue

            open_attempt = self.attempts.unresolved_for_job(job["id"])
            if open_attempt is None:
                prior = [a for a in self.attempts.for_job(job["id"]) if a.state in ("failed", "canceled")]
                if prior and not self.config.allow_retry_failed:
                    self.results[job["id"]] = self._result(job, "failed", prior[-1], reason="a previous attempt failed and retries are disabled")
                    self.progress.emit("job_failed", job=job["id"], attempt=prior[-1].attempt_id, value="retry_disabled")
                    self._write_manifest()
                    continue
                # every file this job takes has to be on disk *before* an attempt record exists
                file_inputs, problem = self.file_input_paths(job)
                if problem is not None:
                    self.results[job["id"]] = self._result(job, "failed", error=problem, reason="a local input file is missing")
                    self.progress.emit("job_failed", job=job["id"], value=problem["code"])
                    failed_jobs.add(job["id"])
                    self._write_manifest()
                    continue
                result = self._submit_job(job, file_inputs=file_inputs)

            else:
                self.progress.emit("job_start", job=job["id"], value=f"open attempt {open_attempt.attempt_id} ({open_attempt.state}); polling, not resubmitting")
                result = self._resolve_open_attempt(job, open_attempt)

            result["duration_seconds"] = round(time.monotonic() - started, 3)
            self.results[job["id"]] = result
            if result["status"] not in ("succeeded", "cached"):
                failed_jobs.add(job["id"])
            self._write_manifest()

        manifest = self._write_manifest()
        success, why = manifest_decides_success(manifest, self.jobs_doc)
        self.progress.emit("run_done", value={"complete": manifest["complete"], "success": success, "counts": manifest["counts"]})
        return manifest

    def reconcile(self) -> dict[str, Any]:
        """After a lost exec: read the attempt records and poll the known job ids.

        Never submits. Attempts left in ``submitting`` with no job id become
        ``submission_unknown`` (the request may have reached the server) which the UI shows
        to the user rather than retrying behind their back.
        """
        self.load_jobs()
        ensure_dir(self.config.out_dir)
        self.progress.emit("reconcile_start", value={"run_id": self.run_id})
        jobs = self._jobs_by_id()
        open_attempts = [a for a in self.attempts.load_all() if a.is_open]
        for attempt in open_attempts:
            job = jobs.get(attempt.job)
            if job is None:
                self.progress.emit("reconcile_unknown_job", job=attempt.job, attempt=attempt.attempt_id, value="attempt record has no matching job in jobs.json")
                continue
            if not attempt.job_id:
                attempt = self.attempts.update(
                    attempt,
                    state="submission_unknown",
                    error=attempt.error
                    or {"code": "submission_unknown", "message": "left in submitting with no job id after a lost run"},
                )
                self.results[job["id"]] = self._result(job, "submission_unknown", attempt, reason="ambiguous submit from a lost run")
                self.progress.emit("submission_unknown", job=job["id"], attempt=attempt.attempt_id, value="submitting_without_job_id")
                continue
            self.progress.emit("reconcile_poll", job=job["id"], attempt=attempt.attempt_id, value=attempt.job_id)
            self.results[job["id"]] = self._poll_attempt(job, attempt, timeout=self.config.reconcile_timeout, collecting=True)

        # jobs that were never attempted at all stay pending and are named as such
        for job in self.jobs_doc["jobs"]:
            self.results.setdefault(job["id"], self._result(job, "pending", reason="no attempt record: this job never started"))
        manifest = self._write_manifest()
        success, why = manifest_decides_success(manifest, self.jobs_doc)
        self.progress.emit("reconcile_done", value={"complete": manifest["complete"], "success": success, "reason": why})
        return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="comfyrizz_pipeline.runner", description="run jobs.json against Comfy (SPEC.md 6.4)")
    parser.add_argument("--jobs", required=True, help="path to jobs.json")
    parser.add_argument("--out", required=True, help="output directory (manifest.json, attempts/, assets/)")
    parser.add_argument("--base-url", default=None, help="COMFY_BASE_URL override (comfy-api-proxy v2 endpoint)")
    parser.add_argument(
        "--upload-url",
        default=None,
        help="where input files are uploaded (default <base-url>/upload/image; COMFY_UPLOAD_URL overrides)",
    )
    parser.add_argument("--no-uploads", action="store_true", help="refuse jobs that need an input file uploaded")

    parser.add_argument("--reconcile", action="store_true", help="poll known job ids instead of running")
    parser.add_argument("--poll-interval", type=float, default=0.25)
    parser.add_argument("--timeout", type=float, default=3600.0, help="per-job wall-clock budget in seconds")
    parser.add_argument("--reconcile-timeout", type=float, default=120.0)
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--progress-log", default=None, help="also append JSON-lines progress to this file")
    parser.add_argument("--batch", default=None, help="run one batch of the plan (stills|plates|upscales|audio)")
    parser.add_argument("--quiet", action="store_true", help="do not echo progress lines")
    parser.add_argument("--json", action="store_true", help="print the manifest summary as JSON")
    args = parser.parse_args(argv)

    config = RunnerConfig(
        jobs_file=Path(args.jobs),
        out_dir=Path(args.out),
        base_url=args.base_url,
        poll_interval=args.poll_interval,
        job_timeout=args.timeout,
        reconcile_timeout=args.reconcile_timeout,
        cache_enabled=not args.no_cache,
        progress_path=Path(args.progress_log) if args.progress_log else None,
        echo_progress=not args.quiet,
        batch=args.batch,
        upload_url=args.upload_url,
        uploads_enabled=not args.no_uploads,
    )
    runner = Runner(config)
    try:
        manifest = runner.reconcile() if args.reconcile else runner.run()
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    success, why = manifest_decides_success(manifest, runner.jobs_doc)
    if args.json:
        print(json.dumps({"complete": manifest["complete"], "success": success, "reason": why, "counts": manifest["counts"]}, indent=2))
    elif not args.quiet:
        print(f"manifest: complete={manifest['complete']} success={success} ({why})", file=sys.stderr)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
