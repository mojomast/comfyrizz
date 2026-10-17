"""A local fake Comfy v2 server (SPEC.md 6.4 acceptance: "pytest against a local fake
Comfy v2 server", no GPU and no network).

It implements exactly the surface `comfy_sdk` 0.5.0 uses, so the runner is exercised
through the real SDK:

* ``POST /api/v2/jobs`` (201, ``Idempotency-Key`` honoured: a reused key is *rejected*
  with 422 ``idempotency_key_reuse``, as the real server does)
* ``GET  /api/v2/jobs/{id}`` — queued → running → succeeded | failed, with progress
* ``GET  /api/v2/jobs/{id}/cancel``
* ``GET  /api/v2/jobs`` — list (the metadata filter is a best-effort convenience: the
  real proxy ignores job labels, per SPEC.md 5.1)
* ``GET  /api/v2/assets/{id}/content`` — the output bytes
* ``GET  /system_stats`` and ``GET /object_info`` — the ComfyUI endpoints the BYO health
  check reads

Every request is logged, so a test can assert *how many times* a job was submitted — the
whole point of "reconcile polls instead of resubmitting".
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

TERMINAL = ("succeeded", "failed", "canceled", "expired")


def _iso(epoch: float | None) -> str | None:
    if epoch is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


class FakeComfyState:
    def __init__(
        self,
        *,
        outputs: int = 1,
        output_kind: str = "image",
        fail: bool = False,
        never_finish: bool = False,
        finish_after: float = 0.0,
        drop_first_response: bool = False,
        fail_on_submit: int | None = None,
        fail_labels: list[str] | None = None,
        request_log: str | None = None,
        progress_steps: int = 3,
        node_types: list[str] | None = None,
        model_files: list[str] | None = None,
    ):
        self.outputs = outputs
        self.output_kind = output_kind
        self.fail = fail
        self.never_finish = never_finish
        self.finish_after = finish_after
        self.drop_first_response = drop_first_response
        self.fail_on_submit = fail_on_submit
        #: job labels (metadata.comfyrizz_job) that should end as `failed` — one injected failure
        self.fail_labels = fail_labels or []
        #: optional JSONL file of {method, path, label} for cross-process assertions
        self.request_log = request_log
        self.progress_steps = progress_steps
        self.node_types = node_types or ["CheckpointLoaderSimple", "KSampler", "LoadImage", "SaveImage", "LTXVScheduler"]
        self.model_files = model_files or ["flux-3-image-klein.safetensors", "ltx-2.5-22b-distilled.safetensors"]
        self.jobs: dict[str, dict[str, Any]] = {}
        self.idempotency_seen: dict[str, str] = {}
        self.log: list[dict[str, Any]] = []
        #: absolute origin, filled in by FakeComfy once the socket is bound (pydantic's
        #: AnyUrl on output.url requires an absolute URL)
        self.origin: str = ""
        self.lock = threading.Lock()
        self.counter = 0
        self.asset_counter = 0

    # -- helpers used by tests ------------------------------------------------------
    def requests(self, method: str | None = None, path_prefix: str | None = None) -> list[dict[str, Any]]:
        return [
            entry
            for entry in self.log
            if (method is None or entry["method"] == method) and (path_prefix is None or entry["path"].startswith(path_prefix))
        ]

    def submit_count(self, job: str | None = None) -> int:
        posts = self.requests("POST", "/api/v2/jobs")
        posts = [p for p in posts if not p["path"].endswith("/cancel")]
        if job is None:
            return len(posts)
        return len([p for p in posts if (p.get("body") or {}).get("metadata", {}).get("comfyrizz_job") == job])

    def poll_count(self, job_id: str) -> int:
        return len([r for r in self.requests("GET") if r["path"] == f"/api/v2/jobs/{job_id}"])

    def configure(self, **kwargs: Any) -> None:
        for key, value in kwargs.items():
            setattr(self, key, value)

    # -- state machine -------------------------------------------------------------
    def create_job(self, body: dict[str, Any], idempotency_key: str | None) -> dict[str, Any]:
        with self.lock:
            self.counter += 1
            job_id = f"job_{self.counter:03d}"
            self.asset_counter += 1
            outputs = []
            for index in range(self.outputs):
                asset_id = f"asset_{self.asset_counter:03d}_{index}"
                outputs.append(
                    {
                        "node_id": "9",
                        "name": f"comfyrizz_{job_id}_{index}.png" if self.output_kind == "image" else f"comfyrizz_{job_id}_{index}.mp4",
                        "type": self.output_kind,
                        "content_type": "image/png" if self.output_kind == "image" else "video/mp4",
                        "size_bytes": 4096,
                        "id": asset_id,
                        "hash": None,
                        "url": f"{self.origin}/api/v2/assets/{asset_id}/content",
                        "url_expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600)),
                    }
                )
            metadata = body.get("metadata") or {}
            self.jobs[job_id] = {
                "id": job_id,
                "status": "queued",
                "create_time": time.time(),
                "label": metadata.get("comfyrizz_job"),
                "outputs": outputs,
                "metadata": (body.get("metadata") or {}),
                "idempotency_key": idempotency_key,
            }
            if idempotency_key:
                self.idempotency_seen[idempotency_key] = job_id
            return self.jobs[job_id]

    def view_job(self, job_id: str) -> dict[str, Any]:
        job = self.jobs[job_id]
        if job["status"] in TERMINAL:
            return job
        elapsed = time.time() - job["create_time"]
        if self.never_finish:
            job["status"] = "running"
            job["progress"] = {"value": 0.01, "nodes_done": 1, "nodes_total": 31}
            return job
        if (self.fail or job.get("label") in self.fail_labels) and elapsed >= self.finish_after:
            job["status"] = "failed"
            job["completed_at"] = time.time()
            job["error"] = {
                "code": "node_execution_error",
                "message": "KSampler blew up",
                "node_id": "3",
                "class_type": "KSampler",
            }
            return job
        if elapsed >= self.finish_after:
            job["status"] = "succeeded"
            job["completed_at"] = time.time()
            job["progress"] = {"value": 1.0, "nodes_done": 31, "nodes_total": 31}
            return job
        job["status"] = "running"
        job["progress"] = {"value": round(min(0.99, elapsed / max(self.finish_after, 0.001)), 3), "nodes_done": 4, "nodes_total": 31}
        return job

    def content(self, asset_id: str) -> bytes:
        return (f"COMFYRIZZ-FAKE-OUTPUT-{asset_id}-".encode() * 64)[:2048]

    def job_payload(self, job: dict[str, Any]) -> dict[str, Any]:
        """The exact Job shape `comfy_low`'s generated model validates (all fields present)."""
        created = _iso(job["create_time"])
        started = _iso(job["create_time"] + 0.1) if job["status"] != "queued" else None
        completed = _iso(job.get("completed_at")) if job.get("completed_at") else None
        return {
            "id": job["id"],
            "status": job["status"],
            "created_at": created,
            "started_at": started,
            "completed_at": completed,
            "expires_at": _iso(job["create_time"] + 7 * 86400),
            "queue_position": None if job["status"] != "queued" else 1,
            "progress": job.get("progress"),
            "outputs": job["outputs"] if job["status"] == "succeeded" else [],
            "error": job.get("error"),
            "urls": {
                "self": f"/api/v2/jobs/{job['id']}",
                "events": f"/api/v2/jobs/{job['id']}/events",
                "cancel": f"/api/v2/jobs/{job['id']}/cancel",
            },
            "metadata": job.get("metadata") or {},
        }


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state: FakeComfyState

    def log_message(self, *args: Any) -> None:  # silence the default stderr logging
        return

    # -- plumbing ------------------------------------------------------------------
    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {"_raw": raw.decode("utf-8", "replace")}

    def _record(self, method: str, path: str, body: dict[str, Any] | None = None, status: int | None = None) -> None:
        if self.state.request_log:
            label = ((body or {}).get("metadata") or {}).get("comfyrizz_job")
            with open(self.state.request_log, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"method": method, "path": path, "label": label, "at": time.time()}) + "\n")
        self.state.log.append(
            {
                "method": method,
                "path": path,
                "idempotency_key": self.headers.get("Idempotency-Key"),
                "body": body or {},
                "status": status,
                "at": time.time(),
            }
        )

    def _send_json(self, payload: Any, status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, data: bytes, content_type: str = "application/octet-stream") -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # -- routes --------------------------------------------------------------------
    def do_POST(self) -> None:  # noqa: N802 - http.server API
        path = urlparse(self.path).path
        body = self._read_body()
        self._record("POST", path, body)
        state = self.state

        if path == "/api/v2/jobs":
            key = self.headers.get("Idempotency-Key")
            if key and key in state.idempotency_seen:
                self._send_json(
                    {"error": {"code": "idempotency_key_reuse", "message": "this Idempotency-Key was already used"}},
                    status=422,
                )
                return
            if state.fail_on_submit is not None and state.counter == state.fail_on_submit:
                state.create_job(body, key)
                self._send_json({"error": {"code": "internal_error", "message": "the server fell over after accepting"}}, status=500)
                return
            if state.drop_first_response and state.counter == 0:
                # The request is accepted and a job exists (a naive retry would double-bill),
                # but the response never arrives: exactly the "submission_unknown" case.
                state.create_job(body, key)
                self.close_connection = True
                try:
                    self.connection.close()
                except OSError:
                    pass
                return
            job = state.create_job(body, key)
            self._send_json(state.job_payload(job), status=201)
            return

        if path.startswith("/api/v2/jobs/") and path.endswith("/cancel"):
            job_id = path.split("/")[4]
            job = state.jobs.get(job_id)
            if not job:
                self._send_json({"error": {"code": "not_found", "message": job_id}}, status=404)
                return
            if job["status"] not in TERMINAL:
                job["status"] = "canceled"
            self._send_json(state.job_payload(job))
            return

        self._send_json({"error": {"code": "not_found", "message": path}}, status=404)

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        parsed = urlparse(self.path)
        path = parsed.path
        self._record("GET", path)
        state = self.state

        if path == "/api/v2/jobs":
            query = parse_qs(parsed.query)
            wanted = {}
            if "metadata" in query:
                for pair in query["metadata"][0].split(","):
                    if "=" in pair:
                        key, value = pair.split("=", 1)
                        wanted[key] = value
            jobs = []
            for job in state.jobs.values():
                if wanted and any((job.get("metadata") or {}).get(k) != v for k, v in wanted.items()):
                    continue
                jobs.append(
                    {
                        "id": job["id"],
                        "status": job["status"],
                        "create_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(job["create_time"])),
                        "metadata": job.get("metadata") or {},
                    }
                )
            self._send_json({"jobs": jobs})
            return

        if path.startswith("/api/v2/jobs/"):
            job_id = path.split("/")[4]
            job = state.jobs.get(job_id)
            if not job:
                self._send_json({"error": {"code": "not_found", "message": job_id}}, status=404)
                return
            state.view_job(job_id)
            self._send_json(state.job_payload(job))
            return

        if path.startswith("/api/v2/assets/") and path.endswith("/content"):
            asset_id = path.split("/")[4]
            self._send_bytes(state.content(asset_id))
            return

        if path == "/system_stats":
            self._send_json(
                {
                    "system": {"os": "linux", "comfyui_version": "0.41.0-fake", "python_version": "3.13.5"},
                    "devices": [{"name": "fake-gpu", "type": "cuda", "vram_total": 103079215104, "vram_free": 88000000000}],
                }
            )
            return

        if path == "/object_info":
            info = {}
            for index, node in enumerate(state.node_types):
                info[node] = {
                    "input": {"required": {"model_name": [[*state.model_files]] if index == 0 else ["fake.safetensors"]}},
                    "output": ["MODEL"],
                }
            self._send_json(info)
            return

        self._send_json({"error": {"code": "not_found", "message": path}}, status=404)


class FakeComfy:
    """Context manager around the fake server: ``with FakeComfy() as fake: fake.base_url``."""

    def __init__(self, port: int = 0, **kwargs: Any):
        self.state = FakeComfyState(**kwargs)
        handler = type("BoundHandler", (_Handler,), {"state": self.state})
        # port 0 = allocate one; an explicit port is what the BYO backend's proxyCommand needs
        self.httpd = ThreadingHTTPServer(("127.0.0.1", int(port)), handler)
        self.httpd.daemon_threads = True
        self.state.origin = self.base_url
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    # -- convenience passthroughs so tests can read the log without reaching into .state
    def requests(self, method: str | None = None, path_prefix: str | None = None):
        return self.state.requests(method, path_prefix)

    def submit_count(self, job: str | None = None) -> int:
        return self.state.submit_count(job)

    def poll_count(self, job_id: str) -> int:
        return self.state.poll_count(job_id)

    def configure(self, **kwargs: Any) -> None:
        self.state.configure(**kwargs)

    @property
    def jobs(self) -> dict[str, Any]:
        return self.state.jobs

    @property
    def log(self) -> list[dict[str, Any]]:
        return self.state.log

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    @property
    def v2_url(self) -> str:
        return f"{self.base_url}/api/v2"

    def __enter__(self) -> "FakeComfy":
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
