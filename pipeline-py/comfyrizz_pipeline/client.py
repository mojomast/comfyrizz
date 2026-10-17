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

**File inputs (H-fix1, from the GPU test 2 findings).** A graph node that takes a file —
``LoadImage`` on the i2v / img2img / reference-edit graphs — needs a *name in the server's
input directory*, not an asset id and not a local path. Sending the bare value is exactly how
``a_plate1.plate`` failed with "Prompt outputs failed validation" on the GPU test 2 run. So:

1. the workflow's params file **declares** which parameters are file uploads
   (``"files": ["image", "reference"]``). A file-valued parameter the map does not declare is
   *refused* here (``upload_not_declared``), never passed through — a graph handed a local path
   fails late, on the GPU, after the session is billed;
2. the caller (the runner) resolves each declared parameter to a local file and hands the paths
   in as ``file_inputs``; this module uploads them to ``/upload/image`` and injects the name the
   server returns.

Uploads are therefore one HTTP call per *file*, not per node, and the content-addressed name the
caller caches means a retry after a lost exec does not upload twice.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

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

#: The ComfyUI route that puts a file in the server's own input directory. It is the one a
#: graph's `LoadImage` can name; the v2 asset API takes asset ids, which `LoadImage` cannot use.
UPLOAD_ROUTE = "/upload/image"


class UploadError(RuntimeError):
    """An upload that did not produce a server-side name. ``code`` is machine-readable."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def as_error(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message}


#: What the server stores a file as. Only the shapes the planner can produce matter here
#: (a still is a PNG, an alpha cutout a PNG, a reference plate an MP4).
_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".mp3": "audio/mpeg",
}


def _content_type(path: Path) -> str:
    return _CONTENT_TYPES.get(Path(path).suffix.lower(), "application/octet-stream")



def classify_metadata_refusal(outcome: SubmitOutcome) -> bool:
    """Does this refusal say the server will not take job labels? (H-fix3, GPU test 2 issue 1.)

    ``comfy-api-proxy`` rejects the SDK's metadata object — its own words on the GPU test 2 run were
    "'metadata' must be a string (opaque label)" — while the SDK cannot send a string instead. So the
    only contract both accept is *no* metadata, and the runner has to discover that from the refusal
    rather than pretend one form works everywhere. A refusal is safe to retry: a 4xx means the
    submission was not accepted, so nothing is double-billed.
    """
    if not outcome.refused or not outcome.error:
        return False
    code = str(outcome.error.get("code") or "")
    message = str(outcome.error.get("message") or "")
    if code in ("invalid_workflow", "invalid_request", "validation_error") and "metadata" in message.lower():
        return True
    return "metadata" in message.lower() and ("must be a string" in message.lower() or "opaque label" in message.lower())


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


def load_params_doc(workflow_path: Path, source: str | None = None) -> dict[str, Any]:
    """``<workflow>.api.json`` -> sibling ``<workflow>.api.params.json`` (optional).

    Each entry of ``map`` maps a parameter name to ``[node_id, field]`` or to a list of such
    pairs when one value belongs in more than one node (LTX-2.5 keeps the frame count on both
    the video and the audio latent, and its two-stage geometry on the stage-1 latent *and* the
    i2v image scale).

    A target may carry a third element of options, which is how a single planned value lands at
    two different sizes without inventing a second parameter name::

        "width": [["31", "width"], ["8", "width", {"mul": 0.5}]]

    ``files`` names the parameters whose value is a **local file to upload** rather than a node
    value. A file-valued parameter with no ``files`` entry is refused (see ``submit``).

    ``source`` names a specialised map (``<workflow>.api.<source>.params.json``), which is how the
    finals upscale pass declares its own stage-2 controls while still reusing the graph. A missing
    specialised file falls back to the plain map, so a package can name a workflow before anyone
    has written its map.
    """
    workflow_path = Path(workflow_path)
    candidates = []
    if source:
        candidates += [
            workflow_path.with_suffix(f".{source}.params.json"),
            workflow_path.parent / f"{workflow_path.stem}.{source}.params.json",
        ]
    candidates += [
        workflow_path.with_suffix(".params.json"),
        workflow_path.parent / f"{workflow_path.stem}.params.json",
    ]
    for candidate in candidates:
        if candidate.is_file():
            data = json.loads(candidate.read_text(encoding="utf-8"))
            # a target is [node, field] or [node, field, options]; normalise to a list of targets
            mapping: dict[str, list] = {}
            for name, target in (data.get("map") or {}).items():
                target = list(target)
                mapping[name] = target if isinstance(target[0], (list, tuple)) else [target]
            return {"map": mapping, "files": list(data.get("files") or []), "path": candidate}
    return {"map": {}, "files": [], "path": None}


def load_params_map(workflow_path: Path, source: str | None = None) -> dict[str, list[str]]:
    """Just the ``map`` half of :func:`load_params_doc` (the shape the B4 contract test uses)."""
    return load_params_doc(workflow_path, source)["map"]


def load_file_params(workflow_path: Path, source: str | None = None) -> list[str]:
    """The parameters the workflow declares as local files to upload (``files`` in the map)."""
    return load_params_doc(workflow_path, source)["files"]


def _target_value(value: Any, options: Any) -> Any:
    """Apply a target's options to the planned value (currently only ``mul``).

    Kept to one operation on purpose: the params map is a declaration of *where* a value goes,
    and arithmetic there is how a map stops matching the plan.
    """
    if not options:
        return value
    if "mul" in options and isinstance(value, (int, float)):
        return int(round(value * float(options["mul"])))
    return value


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
        for pair in targets:
            node_id, field_name = pair[0], pair[1]
            options = pair[2] if len(pair) > 2 else None
            node = graph.setdefault(str(node_id), {"inputs": {}})
            node.setdefault("inputs", {})[str(field_name)] = _target_value(value, options)
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

    def __init__(
        self,
        base_url: str | None = None,
        timeout: float = 30.0,
        client: Any = None,
        upload_url: str | None = None,
    ):
        self.base_url = base_url
        self.timeout = timeout
        self._client = client
        self._upload_url = upload_url

    @property
    def client(self) -> Any:  # noqa: D401 - see the class docstring
        """The SDK client, built with ``COMFY_BASE_URL`` pointing at this client's base url.

        ``base_url`` is the *deployment root* (SPEC.md 5.1: ``http://127.0.0.1:8189`` for
        the API proxy, or Kyle's forwarded port); the SDK appends ``/api/v2`` itself. The
        SDK reads ``COMFY_BASE_URL`` when a client is constructed (SPEC.md 5.1), which is
        fine here because there is one client per runner process.
        """
        if self._client is None:
            from comfy_sdk import Comfy  # imported lazily so a broken install fails at use, not import

            if self.base_url:
                os.environ["COMFY_BASE_URL"] = self.base_url.rstrip("/")
            self._client = Comfy(timeout=self.timeout)
        return self._client

    @property
    def upload_url(self) -> str:
        """Where files are uploaded: ``<deployment root>/upload/image``.

        ``COMFY_UPLOAD_URL`` (or ``--upload-url``) overrides it, which is how a user points the
        uploads straight at ComfyUI's own port when the proxy in front of it does not forward
        the native ComfyUI routes. **[unverified against a real comfy-api-proxy: the GPU test 1/2
        runs used the SDK path, not a proxy]**
        """
        if self._upload_url:
            return self._upload_url
        base = self.base_url or os.environ.get("COMFY_BASE_URL")
        if not base:
            raise UploadError(
                "upload_url_unknown",
                f"no deployment root to upload to: set --base-url, {UPLOAD_ROUTE}'s full URL via --upload-url, or COMFY_BASE_URL",
            )
        return base.rstrip("/") + UPLOAD_ROUTE

    def close(self) -> None:
        if self._client is not None:
            self._client.close()

    # -- uploads -------------------------------------------------------------------
    def upload_file(self, path: Path, *, name: str | None = None, timeout: float | None = None) -> dict[str, Any]:
        """Upload one local file to the server's input directory; return its server-side name.

        The name comes back from the server and is what a ``LoadImage`` node must be given. A
        server without the route (a proxy that only serves v2) is reported as
        ``upload_unsupported`` rather than as a mystery job failure later.
        """
        path = Path(path)
        if not path.is_file():
            raise UploadError("input_file_missing", f"{path} is not a file")
        filename = name or path.name
        content_type = _content_type(path)
        try:
            with httpx.Client(timeout=timeout or max(self.timeout, 60.0)) as client:
                with path.open("rb") as handle:
                    response = client.post(
                        self.upload_url,
                        files={"image": (filename, handle, content_type)},
                        data={"type": "input", "overwrite": "true", "subfolder": ""},
                    )
        except NEVER_REACHED as exc:
            raise UploadError("upload_unreachable", f"{self.upload_url} refused the upload: {exc}") from exc
        except httpx.HTTPError as exc:
            raise UploadError("upload_failed", f"uploading {path.name} failed: {type(exc).__name__}: {exc}") from exc

        if response.status_code in (404, 405):
            raise UploadError(
                "upload_unsupported",
                f"{self.upload_url} answered {response.status_code}: this server does not expose the ComfyUI "
                "upload route, so a workflow that needs an input file cannot run. Point --upload-url at ComfyUI itself.",
            )
        if response.status_code >= 400:
            raise UploadError("upload_failed", f"{self.upload_url} answered {response.status_code}: {response.text[:300]}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise UploadError("upload_failed", f"{self.upload_url} did not return JSON: {response.text[:200]}") from exc
        name = payload.get("name")
        if not isinstance(name, str) or not name:
            raise UploadError("upload_failed", f"{self.upload_url} returned no name: {json.dumps(payload)[:200]}")
        subfolder = str(payload.get("subfolder") or "").strip("/")
        return {
            "name": name,
            # what goes into the graph: ComfyUI resolves "subfolder/name"
            "reference": f"{subfolder}/{name}" if subfolder else name,
            "subfolder": subfolder,
            "type": payload.get("type") or "input",
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "url": self.upload_url,
        }

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
        params_source: str | None = None,
        file_inputs: dict[str, Path] | None = None,
        upload: Callable[[Path], dict[str, Any]] | None = None,
    ) -> SubmitOutcome:
        """Inject ``params`` (uploading ``file_inputs`` first) and submit one job.

        ``file_inputs`` maps a parameter name to the local file the runner resolved for it.
        Each name must be declared in the workflow's params file ``files`` list: a node that
        takes a file and a map that does not say so is a bug the server would only report as a
        validation error after the job was billed.
        """
        params = dict(params)
        try:
            if file_inputs:
                declared = set(load_file_params(workflow_path, params_source))
                undeclared = sorted(name for name in file_inputs if name not in declared)
                if undeclared:
                    return SubmitOutcome(
                        "refused",
                        idempotency_key=idempotency_key,
                        error={
                            "code": "upload_not_declared",
                            "message": (
                                f"{Path(workflow_path).name} needs the local file(s) {', '.join(undeclared)} uploaded, but its "
                                f"params file declares no `files` entry for them: add e.g. \"files\": [{', '.join(json.dumps(n) for n in undeclared)}]"
                            ),
                        },
                    )
                for name, path in file_inputs.items():
                    if upload is None:
                        raise UploadError("upload_failed", f"no uploader was supplied for {name}")
                    params[name] = upload(Path(path))["reference"]

            workflow = self.load_workflow(workflow_path)
            mapping = load_params_map(workflow_path, params_source)
            inject_params(workflow.json, mapping, params)
            handle = self.client.submit(workflow, idempotency_key=idempotency_key, metadata=metadata)
            return SubmitOutcome("submitted", job_id=handle.id, idempotency_key=idempotency_key)
        except UploadError as exc:
            # nothing reached the job API: this is a refusal, not an ambiguous submit
            return SubmitOutcome("refused", idempotency_key=idempotency_key, error=exc.as_error())
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
