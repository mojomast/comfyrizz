"""Thin wrapper over ``comfy_sdk``.

It exists for three reasons (SPEC.md 6.4/5.1):

1. **Explicit submit classification.** The SDK documents that a reused idempotency key is
   *rejected*, not replayed, and that a transport failure which never reached a response
   carries no request id. The runner needs to tell "the server never saw this request"
   (safe to retry) from "the server may have it" (``submission_unknown``, never
   auto-resubmitted), so the classification lives in one named place.
2. **Params injection.** ``workflows/<name>.api.json`` plus a sibling
   ``<name>.api.params.json`` maps a job parameter name to ``[node_id, field]`` inside
   that node's ``inputs``. A parameter with no mapping is an error, never a silent drop —
   a plate rendered without its prompt is worse than a failed job.
3. **One place that touches the network**, so tests can run the real SDK against a local
   fake Comfy v2 server.

The workflow cache/upload plumbing that a real Comfy server needs for reference images is
deliberately *not* wired here: it is M3 work against a real endpoint (SPEC.md 6.4), and
this module passes a local path through instead of pretending the upload was verified.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from .atomic import sha256_file

#: Parameters the planner sets that are job controls, not node inputs.
CONTROL_PARAMS = {"upscale", "cutout", "frames_seconds"}

#: Local failures that mean no request was ever made (a missing workflow, an unreadable file).
#: They are clean refusals, never `submission_unknown`: nothing can have reached the server.
FILE_FAILURES = (FileNotFoundError, NotADirectoryError, IsADirectoryError, PermissionError)

#: Transport failures after which the request definitely never reached the server.
NEVER_REACHED = (httpx.ConnectError, httpx.ConnectTimeout)
#: Transport failures that leave "did the server see it?" unanswered.
AMBIGUOUS = (
    httpx.ReadTimeout,
    httpx.WriteTimeout,
    httpx.PoolTimeout,
    httpx.ReadError,
    httpx.WriteError,
    httpx.RemoteProtocolError,
    httpx.LocalProtocolError,
)


@dataclass
class SubmitOutcome:
    """``kind`` is one of submitted | ambiguous | refused | duplicate_key."""

    kind: str
    job_id: str | None = None
    idempotency_key: str | None = None
    error: dict[str, Any] | None = None

    @property
    def submitted(self) -> bool:
        return self.kind == "submitted"


def classify_submit_error(exc: BaseException, idempotency_key: str | None = None) -> SubmitOutcome:
    code = getattr(exc, "code", None)
    status = getattr(exc, "http_status", None)
    payload = {
        "code": code or type(exc).__name__,
        "message": str(exc) or type(exc).__name__,
        "exception": type(exc).__name__,
    }
    if code == "idempotency_key_reuse":
        return SubmitOutcome("duplicate_key", idempotency_key=idempotency_key, error=payload)
    if isinstance(exc, FILE_FAILURES):
        payload["code"] = "workflow_unreadable"
        return SubmitOutcome("refused", idempotency_key=idempotency_key, error=payload)
    if isinstance(exc, NEVER_REACHED):
        payload["code"] = "connect_failed"
        return SubmitOutcome("refused", idempotency_key=idempotency_key, error=payload)
    if isinstance(exc, AMBIGUOUS):
        payload["code"] = "transport_ambiguous"
        return SubmitOutcome("ambiguous", idempotency_key=idempotency_key, error=payload)
    if isinstance(status, int) and 400 <= status < 500:
        return SubmitOutcome("refused", idempotency_key=idempotency_key, error=payload)
    # 5xx, a QueueFull after the retry budget, or anything unrecognised: assume the
    # request may have landed. Never resubmit it automatically.
    payload.setdefault("code", "submit_unknown_error")
    return SubmitOutcome("ambiguous", idempotency_key=idempotency_key, error=payload)


def load_params_map(workflow_path: Path) -> dict[str, list[str]]:
    """``<workflow>.api.json`` -> sibling ``<workflow>.api.params.json`` (optional).

    Each entry maps a parameter name to ``[node_id, field]`` or to a list of such pairs when
    one value belongs in more than one node (LTX-2.5 keeps the frame count on both the video
    and the audio latent).
    """
    workflow_path = Path(workflow_path)
    candidates = [
        workflow_path.with_suffix(".params.json"),
        workflow_path.parent / f"{workflow_path.stem}.params.json",
    ]
    for candidate in candidates:
        if candidate.is_file():
            data = json.loads(candidate.read_text(encoding="utf-8"))
            return {name: list(target) for name, target in (data.get("map") or {}).items()}
    return {}


def inject_params(graph: dict[str, Any], mapping: dict[str, list[str]], params: dict[str, Any]) -> dict[str, Any]:
    """Set ``node.inputs[field]`` for every mapped parameter. Unknown params are an error."""
    unmapped = [
        name
        for name in params
        if name not in mapping and name not in CONTROL_PARAMS and not name.startswith("_")
    ]
    if unmapped:
        raise ValueError(
            "no params.json mapping for "
            + ", ".join(sorted(unmapped))
            + " — add them to the workflow's params file instead of letting a value be dropped"
        )
    for name, value in params.items():
        target = mapping.get(name)
        if not target:
            continue
        # one target ([node, field]) or several ([[node, field], ...]) - the LTX audio latent
        # needs the same frame count as the video latent
        targets = target if isinstance(target[0], (list, tuple)) else [target]
        for node_id, field_name in targets:
            node = graph.setdefault(str(node_id), {"inputs": {}})
            node.setdefault("inputs", {})[str(field_name)] = value
    return graph


@dataclass
class JobSnapshot:
    """The parts of a job the runner needs, from either a `Job` handle or a poll."""

    id: str
    status: str
    outputs: list[dict[str, Any]] = field(default_factory=list)
    error: dict[str, Any] | None = None
    progress: float | None = None
    raw: Any = None


class ComfyClient:
    """Everything the runner needs from Comfy, in one wrapper."""

    def __init__(self, base_url: str | None = None, timeout: float = 30.0, client: Any = None):
        self.base_url = base_url
        self.timeout = timeout
        self._client = client

    @property
    def client(self) -> Any:
        """The SDK client, built with ``COMFY_BASE_URL`` pointing at this client's base url.

        ``base_url`` is the *deployment root* (SPEC.md 5.1: ``http://127.0.0.1:8189`` for
        the API proxy, or Kyle's forwarded port); the SDK appends ``/api/v2`` itself. The
        SDK reads ``COMFY_BASE_URL`` when a client is constructed (SPEC.md 5.1), which is
        fine here because there is one client per runner process.
        """
        if self._client is None:
            import os

            from comfy_sdk import Comfy  # imported lazily so a broken install fails at use, not import

            if self.base_url:
                os.environ["COMFY_BASE_URL"] = self.base_url.rstrip("/")
            self._client = Comfy(timeout=self.timeout)
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()

    # -- workflows -----------------------------------------------------------------
    def load_workflow(self, path: Path) -> Any:
        return self.client.workflows.from_file(str(path))

    def submit(
        self,
        workflow_path: Path,
        *,
        params: dict[str, Any],
        idempotency_key: str,
        metadata: dict[str, str] | None = None,
    ) -> SubmitOutcome:
        try:
            workflow = self.load_workflow(workflow_path)
            mapping = load_params_map(workflow_path)
            inject_params(workflow.json, mapping, params)
            handle = self.client.submit(workflow, idempotency_key=idempotency_key, metadata=metadata)
            return SubmitOutcome("submitted", job_id=handle.id, idempotency_key=idempotency_key)
        except ValueError as exc:  # local validation (params mapping, UI-format graph)
            return SubmitOutcome("refused", idempotency_key=idempotency_key, error={"code": "invalid_workflow", "message": str(exc)})
        except Exception as exc:  # noqa: BLE001 - classified, never swallowed
            return classify_submit_error(exc, idempotency_key)

    # -- observation ---------------------------------------------------------------
    def _snapshot(self, handle: Any) -> JobSnapshot:
        outputs = []
        for output in getattr(handle, "outputs", []) or []:
            outputs.append(
                {
                    "name": getattr(output, "name", None),
                    "type": getattr(output, "type", None),
                    "content_type": getattr(getattr(output, "model", None), "content_type", None),
                    "size_bytes": getattr(getattr(output, "model", None), "size_bytes", None),
                    "_handle": output,
                }
            )
        error = None
        raw_error = getattr(handle, "error", None)
        if raw_error is not None:
            error = {
                "code": getattr(raw_error, "code", "job_failed"),
                "message": getattr(raw_error, "message", str(raw_error)),
                "node_id": getattr(raw_error, "node_id", None),
                "class_type": getattr(raw_error, "class_type", None),
            }
        progress = None
        data = getattr(handle, "data", None)
        if isinstance(data, dict):
            progress_obj = data.get("progress")
            if isinstance(progress_obj, dict):
                progress = progress_obj.get("value")
        return JobSnapshot(
            id=getattr(handle, "id", None) or "unknown",
            status=getattr(handle, "status", "unknown"),
            outputs=outputs,
            error=error,
            progress=progress,
            raw=handle,
        )

    def get(self, job_id: str) -> JobSnapshot:
        return self._snapshot(self.client.jobs.get(job_id))

    def poll(self, job_id: str) -> JobSnapshot:
        return self.get(job_id)

    def wait(self, job_id: str, *, timeout: float, on_poll: Any = None) -> JobSnapshot:
        handle = self.client.jobs.get(job_id)
        snapshot = self._snapshot(handle)
        if on_poll is not None:
            on_poll(snapshot)
        completed = handle.wait(timeout=timeout) if timeout else handle.wait()
        snapshot = self._snapshot(completed)
        if on_poll is not None:
            on_poll(snapshot)
        return snapshot

    def list_jobs(self, metadata: dict[str, str] | None = None) -> list[dict[str, Any]]:
        """Best-effort. SPEC.md 5.1 notes job labels do not work on the proxy."""
        try:
            page = self.client.list_jobs(metadata=metadata) if metadata else self.client.list_jobs()
        except Exception:  # noqa: BLE001 - labels are a recovery nicety, not a requirement
            return []
        items = page.get("jobs", page) if isinstance(page, dict) else page
        return list(items or [])

    def download(self, output: dict[str, Any], dest: Path) -> dict[str, Any]:
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.parent / f".{dest.name}.part"
        handle = output.get("_handle")
        if handle is None:
            raise RuntimeError("output has no SDK handle to download; poll the job first")
        handle.to_file(tmp)
        tmp.replace(dest)
        return {
            "file": str(dest),
            "sha256": sha256_file(dest),
            "bytes": dest.stat().st_size,
            "kind": output.get("type"),
            "name": output.get("name"),
        }
