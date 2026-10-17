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

**Which server that route lives on (H-fix6, from the GPU test 3 findings).** ``/upload/image`` is a
*ComfyUI* route: the v2 proxy in front of it serves ``/api/v2`` and does not forward it, so pointing
an upload at the deployment root failed **5 of 10 jobs** with ``upload_unsupported`` on the GPU test
3 run. ``upload_endpoints`` therefore states the order (explicit, remembered, declared, root,
declared port pairing), ``resolve_upload`` records which one was used and how it was chosen, and
``upload_file`` walks the candidates — a 404/405 means "not this server" and the next one is tried,
with every endpoint tried named in the failure when none of them works.

Uploads are therefore one HTTP call per *file*, not per node, and the content-addressed name the
caller caches means a retry after a lost exec does not upload twice.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

import httpx

from .atomic import sha256_file

#: Parameters the planner sets that are job controls, not node inputs. `text`/`allowText` are
#: planner-only flags: the plan already used them to decide the prompt guards, and a package written
#: by an older planner still carries them in `params` — refusing the job for that would lose a whole
#: GPU job to a flag the graph never sees (GPU test 3, N1).
CONTROL_PARAMS = {"upscale", "cutout", "frames_seconds", "text", "allowText"}

#: Local failures that mean no request was ever made (a missing workflow, an unreadable file).
#: They are clean refusals, never `submission_unknown`: nothing can have reached the server.
FILE_FAILURES = (FileNotFoundError, NotADirectoryError, IsADirectoryError, PermissionError)

#: Image containers whose size is in the header. Cheap and dependency-free, because the manifest's
#: media dims have to be the file's and not the plan's: a reference-edit graph sizes its output from
#: the reference image's megapixels, so the plan's format size was wrong (GPU test 3, N4).
_PNG_SIG = b"\x89PNG\r\n\x1a\n"
_JPEG_SOF = set(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}


def image_size(path: Path) -> tuple[int, int] | None:
    """``(width, height)`` from an image header, or None when this is not an image we can read."""
    try:
        with path.open("rb") as handle:
            head = handle.read(32)
            if head.startswith(_PNG_SIG) and head[12:16] == b"IHDR" and len(head) >= 24:
                return (int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big"))
            if head[:4] == b"GIF8":
                return (int.from_bytes(head[6:8], "little"), int.from_bytes(head[8:10], "little"))
            if head[:2] == b"BM":
                return (int.from_bytes(head[18:22], "little"), int.from_bytes(head[22:26], "little"))
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP" and head[12:16] == b"VP8X":
                return (
                    int.from_bytes(head[24:27], "little") + 1,
                    int.from_bytes(head[27:30], "little") + 1,
                )
            if not head.startswith(b"\xff\xd8"):
                return None
            # JPEG: walk the segments to the frame header (a JPEG's size is not at a fixed offset)
            handle.seek(2)
            for _ in range(128):
                marker = handle.read(2)
                if len(marker) < 2 or marker[0] != 0xFF:
                    return None
                if marker[1] == 0x01 or 0xD0 <= marker[1] <= 0xD7 or marker[1] == 0xFF:
                    continue
                body = handle.read(2)
                if len(body) < 2:
                    return None
                size = int.from_bytes(body, "big")
                if marker[1] in _JPEG_SOF:
                    frame = handle.read(5)
                    if len(frame) < 5:
                        return None
                    return (int.from_bytes(frame[3:5], "big"), int.from_bytes(frame[1:3], "big"))
                if size < 2:
                    return None
                handle.seek(size - 2, 1)
    except OSError:
        return None
    return None


def video_size(path: Path) -> dict[str, Any] | None:
    """Ask ffprobe for the real geometry (Google Colab has it). None when absent or unreadable."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        proc = subprocess.run(
            [
                ffprobe, "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
                "-of", "json", str(path),
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if proc.returncode != 0:
            return None
        streams = (json.loads(proc.stdout) or {}).get("streams") or []
        if not streams:
            return None
        stream = streams[0]
        measured: dict[str, Any] = {}
        for key in ("width", "height"):
            if str(stream.get(key, "")).isdigit():
                measured[key] = int(stream[key])
        rate = str(stream.get("r_frame_rate") or "")
        if "/" in rate:
            num, _, den = rate.partition("/")
            if float(den or 0) > 0:
                measured["fps"] = round(float(num) / float(den), 3)
        if str(stream.get("nb_frames", "")).isdigit():
            measured["frames"] = int(stream["nb_frames"])
        if stream.get("duration"):
            measured["durationSeconds"] = round(float(stream["duration"]), 3)
        return measured or None
    except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError):
        return None


def measure(path: Path, kind: str | None) -> dict[str, Any] | None:
    """The real geometry of a downloaded file, and where the number came from."""
    if kind == "image":
        size = image_size(path)
        return {"width": size[0], "height": size[1], "source": "header"} if size else None
    if kind == "video":
        size = video_size(path)
        return {**size, "source": "ffprobe"} if size else None
    return None

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

#: The deployment's own port pairing (H-fix6, GPU test 3): the runner talks to the v2 proxy on
#: 8189 and ComfyUI itself listens on 8188. This is a *declared* pairing — `colab/bootstrap.py`
#: (PROXY_PORT/COMFY_PORT) and `scripts/setup-local-comfy.sh` both spell it out and both read
#: these same overrides — not a guess about an arbitrary server.
PROXY_PORT_DEFAULT = 8189
COMFY_PORT_DEFAULT = 8188
PROXY_PORT_ENV = "COMFYRIZZ_PROXY_PORT"
COMFY_PORT_ENV = "COMFYRIZZ_COMFY_PORT"
#: Where a deployment can state ComfyUI's own origin outright (`--comfyui-url`/`COMFYUI_URL`).
COMFYUI_URL_ENV = "COMFYUI_URL"
#: What `COMFY_BASE_URL` is called when a caller only knows the deployment root by env.
BASE_URL_ENV = "COMFY_BASE_URL"

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]"})


def _port_env(name: str, default: int) -> int:
    """An int from the environment, falling back to the deployment default rather than raising.

    A typo in `COMFYRIZZ_COMFY_PORT` must not take a run down: the pairing rule simply does not
    apply, and the endpoint is then whatever the caller said or the deployment root.
    """
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(str(raw).strip())
    except ValueError:
        return default
    return value if 0 < value < 65536 else default


def split_origin(url: str) -> tuple[str, str, int]:
    """``(scheme, host, port)`` for a URL, with the scheme's default port when none is spelled."""
    text = str(url).strip()
    parts = urlsplit(text if "//" in text else f"//{text}")
    if not parts.hostname:
        raise ValueError(f"{url!r} has no host")
    port = parts.port
    if port is None:
        port = 443 if (parts.scheme or "http").lower() == "https" else 80
    return (parts.scheme or "http").lower(), parts.hostname.lower(), port


def comfyui_origin_for(base_url: str | None) -> str | None:
    """ComfyUI's own origin behind a v2 proxy, or ``None`` when the base is not that proxy.

    Only the declared pairing qualifies: a loopback deployment root on the deployment's proxy
    port (8189 by default) with ComfyUI on a different port (8188). Anything else — a forwarded
    port, a LAN host, a root that already *is* ComfyUI — returns ``None``, because pointing an
    upload at some other port on somebody's host is not this module's call to make.
    """
    if not base_url:
        return None
    try:
        scheme, host, port = split_origin(base_url)
    except ValueError:
        return None
    if host not in _LOOPBACK_HOSTS:
        return None
    proxy_port = _port_env(PROXY_PORT_ENV, PROXY_PORT_DEFAULT)
    comfy_port = _port_env(COMFY_PORT_ENV, COMFY_PORT_DEFAULT)
    if port != proxy_port or comfy_port == port:
        return None
    return f"{scheme}://{host}:{comfy_port}"


def upload_route_url(url: str) -> str:
    """A bare origin (``http://host:8188``) becomes ComfyUI's upload route; a full route is kept."""
    text = str(url).strip().rstrip("/")
    if not text:
        return text
    try:
        _, _, _ = split_origin(text)
    except ValueError:
        return text
    path = urlsplit(text).path
    return text + UPLOAD_ROUTE if path in ("", "/") else text


def upload_endpoints(
    base_url: str | None = None,
    *,
    explicit: str | None = None,
    preferred: list[str] | None = None,
    declared: str | None = None,
    extra: list[str] | None = None,
) -> list[str]:
    """Every endpoint an upload may legitimately go to, best first (H-fix6).

    - ``explicit`` (`--upload-url`/`COMFY_UPLOAD_URL`) is an *instruction*: it is the only
      candidate, and a failure against it is reported as itself, never papered over by a fallback;
    - ``preferred`` is what this deployment last saw take an upload (the runner's own cache), so
      a fixed run does not re-try the endpoint that already refused;
    - ``declared`` (`--comfyui-url`/`COMFYUI_URL`) is where the deployment says ComfyUI is;
    - the deployment root itself — the pre-H-fix6 default, which is right when the root *is*
      ComfyUI (`scripts/setup-local-comfy.sh` without the proxy) and wrong when it is the v2
      proxy, which is exactly what cost five jobs on the GPU test 3 run;
    - ComfyUI behind the declared port pairing, so a forgotten flag does not fail on the GPU.
    """
    if explicit:
        return [upload_route_url(explicit)]
    endpoints: list[str] = []

    def add(url: str | None) -> None:
        if not url:
            return
        route = upload_route_url(url)
        if route and route not in endpoints:
            endpoints.append(route)

    for url in preferred or []:
        add(url)
    add(declared)
    base = base_url or os.environ.get(BASE_URL_ENV)
    add(base)
    add(comfyui_origin_for(base))
    for url in extra or []:
        add(url)
    return endpoints


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


#: What a saved file's first bytes say it is. A server's claim about an output's *kind* is not
#: evidence — on the GPU test 3 run the SDK reported a `SaveVideo` mp4 as ``image``, and ComfyUI's
#: ``SaveImage`` wrote one PNG per frame into files the plan expected to be videos (N3). The magic
#: bytes are evidence, and an unrecognised container is left to the server rather than guessed at.
_MAGIC_KINDS: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image"),
    (b"\xff\xd8\xff", "image"),
    (b"GIF8", "image"),
    (b"BM", "image"),
    (b"\x1a\x45\xdf\xa3", "video"),  # matroska / webm
    (b"fLaC", "audio"),
    (b"ID3", "audio"),
    (b"OggS", "audio"),
)


def sniff_kind(path: Path) -> str | None:
    """``image``/``video``/``audio`` from a file's magic bytes, or ``None`` when unrecognised."""
    path = Path(path)
    try:
        with path.open("rb") as handle:
            head = handle.read(16)
    except OSError:
        return None
    if len(head) >= 12 and head[4:8] in (b"ftyp", b"moov", b"mdat", b"free", b"skip"):
        return "video"
    if head[:4] == b"RIFF" and len(head) >= 12:
        return "video" if head[8:12] == b"WEBM" else ("audio" if head[8:12] == b"WAVE" else None)
    for magic, kind in _MAGIC_KINDS:
        if head.startswith(magic):
            return kind
    return None



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

    @property
    def refused(self) -> bool:
        """A clean local/server refusal: nothing was accepted, so nothing is ambiguous."""
        return self.kind == "refused"


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
        comfyui_url: str | None = None,
        preferred_upload_urls: list[str] | None = None,
        upload_candidates: list[str] | None = None,
    ):
        self.base_url = base_url
        self.timeout = timeout
        self._client = client
        self._upload_url = upload_url
        self._comfyui_url = comfyui_url
        self._preferred = list(preferred_upload_urls or [])
        self._extra_candidates = list(upload_candidates or [])
        #: the endpoint resolution, computed once: two jobs must not disagree about where
        #: uploads go (the runner keys its upload cache on it)
        self._resolved: dict[str, Any] | None = None

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
    def upload_endpoints(self) -> list[str]:
        """Every endpoint this client may upload to, best first (H-fix6)."""
        return upload_endpoints(
            self.base_url or os.environ.get(BASE_URL_ENV),
            explicit=self._upload_url,
            preferred=self._preferred,
            declared=self._comfyui_url or os.environ.get(COMFYUI_URL_ENV),
            extra=self._extra_candidates,
        )

    def resolve_upload(self) -> dict[str, Any]:
        """Decide where uploads go, once, and say why — never silently and never by guessing.

        No probe: the upload *is* the probe. The candidates are tried in order and the first one
        that returns a name wins, so the only assumption is the one the GPU test 3 run actually
        demonstrated — a 404 on `POST /upload/image` means "this server has no ComfyUI upload
        route", and the endpoint behind the declared pairing is the next thing to try. Asking a
        proxy about some *other* ComfyUI route would be assuming a behaviour nobody has
        measured; a 404'd upload costs one loopback round trip and nothing is submitted.

        Once an upload has landed, the record is *corrected* to the endpoint that really took
        the bytes (`upload_file`), so the manifest, the progress log and the runner's upload
        cache all name the server the inputs are on, not the one they were guessed to be on.

        The result is cached, because the runner keys its upload cache on the endpoint.
        """
        if self._resolved is not None:
            return self._resolved
        candidates = self.upload_endpoints
        if not candidates:
            raise UploadError(
                "upload_url_unknown",
                f"no endpoint to upload to: set --base-url, {UPLOAD_ROUTE}'s full URL via --upload-url, "
                f"ComfyUI's own origin via --comfyui-url (or {COMFYUI_URL_ENV}), or {BASE_URL_ENV}",
            )
        declared = bool(self._comfyui_url or os.environ.get(COMFYUI_URL_ENV))
        if self._upload_url:
            chosen_by = "explicit"
        elif self._preferred and candidates[0] == upload_route_url(self._preferred[0]):
            chosen_by = "remembered"
        elif declared:
            chosen_by = "declared"
        elif len(candidates) > 1:
            chosen_by = "first_candidate"
        else:
            chosen_by = "only_candidate"
        self._resolved = {"url": candidates[0], "candidates": candidates, "chosen_by": chosen_by}
        return self._resolved

    @property
    def upload_url(self) -> str:
        """The endpoint uploads go to — `<deployment root>/upload/image` by default.

        `--upload-url`/`COMFY_UPLOAD_URL` states it outright and is then the only endpoint used.
        Without one, the order is: ComfyUI's declared origin (`--comfyui-url`/`COMFYUI_URL`), the
        deployment root, then ComfyUI behind the deployment's declared port pairing. That last
        step is what the GPU test 3 run needed by hand: the root was the v2 proxy on 8189, which
        does not serve ComfyUI's native upload route.
        """
        return self.resolve_upload()["url"]

    def upload_summary(self) -> dict[str, Any]:
        """What a caller (the runner's manifest, a log line) should record about the endpoint."""
        resolved = self.resolve_upload()
        return dict(resolved)

    def close(self) -> None:
        if self._client is not None:
            self._client.close()

    # -- uploads -------------------------------------------------------------------
    def upload_file(self, path: Path, *, name: str | None = None, timeout: float | None = None) -> dict[str, Any]:
        """Upload one local file to ComfyUI's input directory; return its server-side name.

        The name comes back from the server and is what a ``LoadImage`` node must be given. A
        server without the route is reported as ``upload_unsupported``, after every legitimate
        endpoint has been tried: a proxy that only serves v2 (8189) is exactly the GPU test 3
        failure, and it has a right answer — ComfyUI itself (8188) — so the refusal carries the
        list of endpoints tried and the flag that fixes it.
        """
        path = Path(path)
        if not path.is_file():
            raise UploadError("input_file_missing", f"{path} is not a file")
        resolved = self.resolve_upload()
        tried: list[str] = []
        failures: list[UploadError] = []
        for url in [resolved["url"], *[c for c in resolved["candidates"] if c != resolved["url"]]]:
            try:
                uploaded = self._post_upload(url, path, name=name, timeout=timeout)
            except UploadError as exc:
                failures.append(exc)
                tried.append(f"{url} -> {exc.code}")
                # 404/405 says "this server has no ComfyUI upload route"; a connect refusal says
                # "nothing is listening". Both mean *this* endpoint is the wrong one, and a
                # different candidate may be the right one. Anything else is a real answer.
                if exc.code not in ("upload_unsupported", "upload_unreachable"):
                    raise
                continue
            if url != resolved["url"]:
                # the upload, not the ordering, decided: remember it for the rest of the run so
                # the cache, the progress log and the manifest name the server that has the file
                resolved["url"] = url
                resolved["chosen_by"] = "upload"
            return uploaded
        if len(failures) == 1:
            raise failures[0]
        raise UploadError(
            "upload_unsupported",
            f"{path.name}: none of the {len(failures)} endpoint(s) tried serves ComfyUI's native "
            f"{UPLOAD_ROUTE} route ({'; '.join(tried)}). Uploads are ComfyUI-native and the v2 proxy does not "
            f"forward them. Point --upload-url (or {COMFYUI_URL_ENV}) at ComfyUI itself — on the Google Colab "
            f"deployment that is http://127.0.0.1:{_port_env(COMFY_PORT_ENV, COMFY_PORT_DEFAULT)}",
        )

    def _post_upload(self, url: str, path: Path, *, name: str | None = None, timeout: float | None = None) -> dict[str, Any]:
        """One upload attempt against one endpoint. Raises `UploadError`; never retries by itself."""
        filename = name or path.name
        content_type = _content_type(path)
        try:
            with httpx.Client(timeout=timeout or max(self.timeout, 60.0)) as client:
                with path.open("rb") as handle:
                    response = client.post(
                        url,
                        files={"image": (filename, handle, content_type)},
                        data={"type": "input", "overwrite": "true", "subfolder": ""},
                    )
        except NEVER_REACHED as exc:
            raise UploadError("upload_unreachable", f"{url} refused the upload: {exc}") from exc
        except httpx.HTTPError as exc:
            raise UploadError("upload_failed", f"uploading {path.name} to {url} failed: {type(exc).__name__}: {exc}") from exc

        if response.status_code in (404, 405):
            raise UploadError(
                "upload_unsupported",
                f"{url} answered {response.status_code}: this server does not expose the ComfyUI "
                "upload route, so a workflow that needs an input file cannot run. Point --upload-url at ComfyUI itself.",
            )
        if response.status_code >= 400:
            raise UploadError("upload_failed", f"{url} answered {response.status_code}: {response.text[:300]}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise UploadError("upload_failed", f"{url} did not return JSON: {response.text[:200]}") from exc
        uploaded_name = payload.get("name")
        if not isinstance(uploaded_name, str) or not uploaded_name:
            raise UploadError("upload_failed", f"{url} returned no name: {json.dumps(payload)[:200]}")
        subfolder = str(payload.get("subfolder") or "").strip("/")
        return {
            "name": uploaded_name,
            # what goes into the graph: ComfyUI resolves "subfolder/name"
            "reference": f"{subfolder}/{uploaded_name}" if subfolder else uploaded_name,
            "subfolder": subfolder,
            "type": payload.get("type") or "input",
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "url": url,
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
        """Best-effort job list, always as plain dicts. SPEC.md 5.1 notes job labels do not work on the proxy.

        ``Comfy.list_jobs`` yields :class:`comfy_sdk.jobs.JobSummary` objects (not dicts, and not a
        page), so each item is normalised here: the recovery path treats a list item as a mapping
        (``item["id"]``) and a raw ``JobSummary`` has no ``.get``. Only the id and the labels are
        lifted out — that is all the caller needs to adopt a job it already created.
        """
        try:
            page = self.client.list_jobs(metadata=metadata) if metadata else self.client.list_jobs()
            if isinstance(page, dict):  # a host that answers with one page instead of an iterator
                page = page.get("jobs", page)
            items = list(page or [])
        except Exception:  # noqa: BLE001 - labels are a recovery nicety, not a requirement
            return []
        jobs: list[dict[str, Any]] = []
        for item in items:
            if isinstance(item, dict):
                jobs.append(dict(item))
                continue
            job_id = getattr(item, "id", None)
            if not isinstance(job_id, str):
                continue
            record: dict[str, Any] = {"id": job_id}
            labels = getattr(item, "metadata", None)
            if isinstance(labels, dict):
                record["metadata"] = dict(labels)
            status = getattr(item, "status", None)
            if isinstance(status, str):
                record["status"] = status
            jobs.append(record)
        return jobs

    def download(self, output: dict[str, Any], dest: Path) -> dict[str, Any]:
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.parent / f".{dest.name}.part"
        handle = output.get("_handle")
        if handle is None:
            raise RuntimeError("output has no SDK handle to download; poll the job first")
        handle.to_file(tmp)
        tmp.replace(dest)
        reported = output.get("type")
        sniffed = sniff_kind(dest)
        record = {
            "file": str(dest),
            "sha256": sha256_file(dest),
            "bytes": dest.stat().st_size,
            # the bytes decide the kind when they are recognisable; otherwise the server's word is
            # all there is. `kindSource` is what keeps a *claim* from being treated as evidence
            # (GPU test 3, N3 — the guard only accuses on bytes).
            "kind": sniffed or reported,
            "kindSource": "bytes" if sniffed else "server",
            "name": output.get("name"),
        }
        if reported and sniffed and reported != sniffed:
            record["reportedKind"] = reported
        # the file's own geometry, not the plan's (N4): a reference-edit graph sizes its output from
        # the reference's megapixels, so the plan's format size is not evidence about the file
        measured = measure(dest, record["kind"])
        if measured:
            record["measured"] = measured
        return record
