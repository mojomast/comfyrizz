"""Structured progress for Comfyrizz runs on the Google Colab VM.

The host already reads every stdout line a `colab exec` step prints (the backend's
`progressLines`). This module turns what a notebook shows as gauges into one JSON line per
update, on that same stdout channel, so the host can draw them live:

    {"event":"colab_progress","v":1,"job":"...","stage":"sampler","label":"KSampler",
     "n":12,"total":30,"rate":2.4,"eta":7.5,"ts":"2026-10-20T19:00:00Z"}

Sources:

* tqdm bars: `install_tqdm_hook()` for bars drawn in this process, and `LineTap`, which parses
  tqdm's text (with its carriage returns) out of a child process or a log file;
* ComfyUI's websocket (`ComfyWatcher`): `progress` (sampler value/max), `executing` /
  `executed` / `progress_state` (per-node), `execution_success` / `execution_error`;
* render frame counts in a renderer's output (`frame 120/450`, `Rendered 120 of 450 frames`).

Stdlib only. Never prints the environment or any credential; a failing source is dropped,
never fatal, because progress is evidence and the run is the work.
"""

from __future__ import annotations

import base64
import json
import os
import re
import socket
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

EVENT = "colab_progress"
VERSION = 1
DEFAULT_SINK = Path("/content/comfyrizz/out/colab-progress.jsonl")


def _iso(at: float | None = None) -> str:
    return datetime.fromtimestamp(at if at is not None else time.time(), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Emitter:
    """Throttled writer of progress records to stdout and (optionally) a JSONL file."""

    def __init__(self, job: str, sink: Path | str | None = None, stream: Any = None, min_interval: float = 0.5,
                 clock: Callable[[], float] = time.time):
        self.job = str(job or "run")
        self.sink = Path(sink) if sink else None
        self.stream = stream if stream is not None else sys.stdout
        self.min_interval = min_interval
        self.clock = clock
        self._last: dict[tuple[str, str], tuple[float, Any]] = {}
        self._first: dict[tuple[str, str], tuple[float, float]] = {}
        self._lock = threading.Lock()
        self.records: list[dict[str, Any]] = []
        if self.sink:
            try:
                self.sink.parent.mkdir(parents=True, exist_ok=True)
            except OSError:
                self.sink = None

    def emit(self, stage: str, label: str, n: float | None, total: float | None = None, *, rate: float | None = None,
             eta: float | None = None, force: bool = False, job: str | None = None, **extra: Any) -> dict[str, Any] | None:
        now = self.clock()
        key = (stage, str(label))
        with self._lock:
            done = n is not None and total is not None and total > 0 and n >= total
            last = self._last.get(key)
            if not force and not done and last and now - last[0] < self.min_interval:
                return None
            if n is not None and (key not in self._first or (last and last[1] is not None and n < last[1])):
                self._first[key] = (now, float(n))
            if rate is None and n is not None and key in self._first:
                t0, n0 = self._first[key]
                if now > t0 and n > n0:
                    rate = (n - n0) / (now - t0)
            if eta is None and rate and total and n is not None and total > n:
                eta = (total - n) / rate
            record: dict[str, Any] = {"event": EVENT, "v": VERSION, "job": job or self.job, "stage": stage, "label": str(label),
                                      "n": n, "total": total,
                                      "rate": round(rate, 4) if rate else None,
                                      "eta": round(eta, 2) if eta is not None else None, "ts": _iso(now)}
            for name, value in extra.items():
                if value is not None:
                    record[name] = value
            self._last[key] = (now, n)
            self.records.append(record)
            line = json.dumps(record)
            try:
                print(line, file=self.stream, flush=True)
            except (OSError, ValueError):
                pass
            if self.sink:
                try:
                    with open(self.sink, "a", encoding="utf-8") as handle:
                        handle.write(line + "\n")
                except OSError:
                    pass
            return record


# -- text parsers -------------------------------------------------------------------------------

_NUM = r"[\d.]+[kMG]?"
TQDM = re.compile(
    r"(?:(?P<label>[^\r\n|]*?):\s*)?(?P<pct>\d{1,3})%\|[^|]*\|\s*(?P<n>" + _NUM + r")/(?P<total>" + _NUM + r"|\?)"
    r"\s*\[(?P<elapsed>[\d:]+)(?:<(?P<eta>[\d:?]+))?(?:,\s*(?P<rate>[\d.?]+)\s*(?P<unit>[^\],]*?))?(?:,[^\]]*)?\]"
)
FRAMES = [
    re.compile(r"\b(?P<verb>rendered|rendering|encoded|encoding|stitched|stitching|captured|capturing)\b[^\d\r\n]{0,12}(?P<n>\d+)\s*(?:/|of)\s*(?P<total>\d+)", re.I),
    re.compile(r"\bframes?\b\s*[:=#]?\s*(?P<n>\d+)\s*(?:/|of)\s*(?P<total>\d+)", re.I),
    re.compile(r"(?P<n>\d+)\s*(?:/|of)\s*(?P<total>\d+)\s*frames?\b", re.I),
]
VERBS = {"rendered": "render", "rendering": "render", "encoded": "encode", "encoding": "encode", "stitched": "stitch",
         "stitching": "stitch", "captured": "capture", "capturing": "capture"}
FFMPEG_FRAME = re.compile(r"^frame=\s*(?P<n>\d+)\b")


def _number(text: str) -> float:
    scale = {"k": 1e3, "M": 1e6, "G": 1e9}.get(text[-1:], 1)
    return round(float(text.rstrip("kMG")) * scale, 3)


def _seconds(clock: str | None) -> float | None:
    if not clock or "?" in clock:
        return None
    total = 0.0
    for part in clock.split(":"):
        total = total * 60 + float(part)
    return total


def parse_tqdm(text: str) -> dict[str, Any] | None:
    """One tqdm repaint -> {label, n, total, rate, eta}; None when the text is not a bar."""
    match = None
    for match in TQDM.finditer(text):
        pass
    if not match:
        return None
    n = _number(match["n"])
    total = None if match["total"] == "?" else _number(match["total"])
    rate = None
    if match["rate"] and match["rate"] != "?":
        rate = float(match["rate"])
        unit = (match["unit"] or "").strip()
        if unit.startswith("s/"):
            rate = 1.0 / rate if rate else None
        elif unit[:1] in ("k", "M", "G") and len(unit) > 1:  # unit_scale: "820MB/s" next to "8.20G"
            rate = _number(f"{rate}{unit[0]}")
    label = (match["label"] or "").strip() or "tqdm"
    return {"label": label[-80:], "n": n, "total": total, "rate": rate, "eta": _seconds(match["eta"])}


def parse_frames(text: str, total_hint: float | None = None) -> dict[str, Any] | None:
    for pattern in FRAMES:
        match = pattern.search(text)
        if match and int(match["total"]) > 0:
            verb = (match.groupdict().get("verb") or "").lower()
            return {"n": float(match["n"]), "total": float(match["total"]), "verb": VERBS.get(verb, verb)}
    match = FFMPEG_FRAME.search(text.strip())
    if match:
        return {"n": float(match["n"]), "total": total_hint}
    return None


class LineTap:
    """Feed raw text (any chunking, `\r` repaints included); emits tqdm and frame gauges."""

    def __init__(self, emitter: Emitter, stage: str = "tqdm", frames_label: str = "render", frames_total: float | None = None):
        self.emitter = emitter
        self.stage = stage
        self.frames_label = frames_label
        self.frames_total = frames_total
        self._pending = ""

    def feed(self, text: str) -> None:
        self._pending += text
        parts = re.split(r"[\r\n]", self._pending)
        self._pending = parts.pop()
        for part in parts:
            self.line(part)
        if len(self._pending) > 8192:
            self._pending = self._pending[-2048:]

    def flush(self) -> None:
        if self._pending:
            self.line(self._pending)
            self._pending = ""

    def line(self, text: str) -> None:
        if not text.strip() or text.lstrip().startswith("{"):
            return
        try:
            bar = parse_tqdm(text)
            if bar:
                self.emitter.emit(self.stage, bar["label"], bar["n"], bar["total"], rate=bar["rate"], eta=bar["eta"])
                return
            frames = parse_frames(text, self.frames_total)
            if frames:
                label = f"{self.frames_label} {frames['verb']}".strip() if frames.get("verb") else self.frames_label
                self.emitter.emit("frames", label, frames["n"], frames["total"])
        except Exception:  # noqa: BLE001 - a gauge must never break the run
            pass


def tail_file(path: Path | str, tap: LineTap, stop: threading.Event, poll: float = 0.5, from_end: bool = True) -> threading.Thread:
    """Follow a log file (ComfyUI's /content/comfyui.log) into a LineTap on a daemon thread."""

    def loop() -> None:
        target = Path(path)
        offset = target.stat().st_size if (from_end and target.exists()) else 0
        while not stop.is_set():
            try:
                size = target.stat().st_size
                if size < offset:
                    offset = 0
                if size > offset:
                    with open(target, "r", encoding="utf-8", errors="replace") as handle:
                        handle.seek(offset)
                        tap.feed(handle.read())
                        offset = handle.tell()
            except OSError:
                pass
            stop.wait(poll)
        tap.flush()

    thread = threading.Thread(target=loop, name="progress-tail", daemon=True)
    thread.start()
    return thread


def install_tqdm_hook(emitter: Emitter, stage: str = "tqdm") -> bool:
    """Report every tqdm bar in this process (in addition to drawing it)."""
    try:
        from tqdm import std  # type: ignore
    except Exception:  # noqa: BLE001
        return False
    if getattr(std.tqdm, "_comfyrizz_hooked", False):
        return True
    original = std.tqdm.update

    def update(self: Any, n: float = 1) -> Any:
        result = original(self, n)
        try:
            info = self.format_dict
            emitter.emit(stage, self.desc or "tqdm", info.get("n"), info.get("total"), rate=info.get("rate"))
        except Exception:  # noqa: BLE001
            pass
        return result

    std.tqdm.update = update  # type: ignore[assignment]
    std.tqdm._comfyrizz_hooked = True  # type: ignore[attr-defined]
    return True


# -- ComfyUI websocket ----------------------------------------------------------------------------


class ComfyProgress:
    """Turns ComfyUI websocket messages into gauges (pure: tests feed it dicts)."""

    def __init__(self, emitter: Emitter, class_types: dict[str, str] | None = None):
        self.emitter = emitter
        self.class_types = class_types or {}
        self.done: dict[str, set[str]] = {}
        self.totals: dict[str, int] = {}

    def node_name(self, node: Any) -> str:
        node = str(node)
        kind = self.class_types.get(node)
        return f"{kind} #{node}" if kind else f"node {node}"

    def handle(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        data = message.get("data") or {}
        prompt = str(data.get("prompt_id") or "")
        job = prompt or None
        if kind == "execution_start":
            self.done[prompt] = set()
            self.emitter.emit("node", "nodes", 0, self.totals.get(prompt), job=job, force=True, state="running")
        elif kind == "execution_cached":
            self.done.setdefault(prompt, set()).update(str(node) for node in data.get("nodes") or [])
        elif kind == "progress":
            self.emitter.emit("sampler", self.node_name(data.get("node")), data.get("value"), data.get("max"), job=job, node=str(data.get("node")))
        elif kind == "progress_state":
            nodes = data.get("nodes") or {}
            if nodes:
                self.totals[prompt] = len(nodes)
                finished = sum(1 for item in nodes.values() if (item or {}).get("state") == "finished")
                self.emitter.emit("node", "nodes", finished, len(nodes), job=job)
        elif kind == "executing":
            node = data.get("node")
            if node is None:
                total = self.totals.get(prompt)
                self.emitter.emit("node", "nodes", total or len(self.done.get(prompt, ())), total, job=job, force=True, state="done")
            else:
                self.emitter.emit("node", "nodes", len(self.done.get(prompt, ())), self.totals.get(prompt), job=job, current=self.node_name(node))
        elif kind == "executed":
            self.done.setdefault(prompt, set()).add(str(data.get("node")))
            self.emitter.emit("node", "nodes", len(self.done[prompt]), self.totals.get(prompt), job=job, current=self.node_name(data.get("node")))
        elif kind == "execution_success":
            total = self.totals.get(prompt)
            self.emitter.emit("node", "nodes", total or len(self.done.get(prompt, ())), total, job=job, force=True, state="done")
        elif kind in ("execution_error", "execution_interrupted"):
            self.emitter.emit("node", "nodes", len(self.done.get(prompt, ())), self.totals.get(prompt), job=job, force=True, state="failed",
                              current=self.node_name(data.get("node_id")) if data.get("node_id") else None)


def _ws_frames(sock: socket.socket, buffer: bytes = b""):
    """Minimal RFC 6455 reader: yields text payloads, answers pings, stops on close."""

    def read(count: int) -> bytes:
        nonlocal buffer
        while len(buffer) < count:
            chunk = sock.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            buffer += chunk
        out, buffer = buffer[:count], buffer[count:]
        return out

    while True:
        head = read(2)
        opcode = head[0] & 0x0F
        length = head[1] & 0x7F
        if length == 126:
            length = int.from_bytes(read(2), "big")
        elif length == 127:
            length = int.from_bytes(read(8), "big")
        mask = read(4) if head[1] & 0x80 else b""
        payload = read(length)
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        if opcode == 0x8:
            return
        if opcode == 0x9:
            key = os.urandom(4)
            sock.sendall(bytes([0x8A, 0x80 | len(payload)]) + key + bytes(b ^ key[i % 4] for i, b in enumerate(payload)))
        elif opcode == 0x1:
            yield payload.decode("utf-8", errors="replace")


class ComfyWatcher:
    """Listens to ComfyUI's /ws on a daemon thread and reconnects until stopped.

    ComfyUI addresses progress to the submitting client_id, or to everyone when the prompt
    carried none; pass the proxy's client_id when it is known.
    """

    def __init__(self, emitter: Emitter, url: str = "http://127.0.0.1:8188", client_id: str | None = None):
        self.progress = ComfyProgress(emitter)
        self.url = urlparse(url)
        self.client_id = client_id or "comfyrizz-progress"
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> "ComfyWatcher":
        self.thread = threading.Thread(target=self._loop, name="comfy-ws", daemon=True)
        self.thread.start()
        return self

    def close(self) -> None:
        self.stop.set()

    def _loop(self) -> None:
        while not self.stop.is_set():
            try:
                with socket.create_connection((self.url.hostname or "127.0.0.1", self.url.port or 80), timeout=10) as sock:
                    key = base64.b64encode(os.urandom(16)).decode()
                    sock.sendall((f"GET /ws?clientId={self.client_id} HTTP/1.1\r\nHost: {self.url.netloc}\r\nUpgrade: websocket\r\n"
                                  f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
                    response = b""
                    while b"\r\n\r\n" not in response:
                        chunk = sock.recv(4096)
                        if not chunk:
                            raise ConnectionError("no handshake")
                        response += chunk
                    head, _, rest = response.partition(b"\r\n\r\n")
                    if b" 101 " not in head.split(b"\r\n", 1)[0]:
                        raise ConnectionError("not upgraded")
                    sock.settimeout(None)
                    for text in _ws_frames(sock, rest):
                        if self.stop.is_set():
                            return
                        try:
                            message = json.loads(text)
                        except ValueError:
                            continue
                        if isinstance(message, dict):
                            self.progress.handle(message)
            except Exception:  # noqa: BLE001 - ComfyUI restarting is normal; try again
                pass
            self.stop.wait(2.0)


def start_run_observers(job: str, comfy_url: str | None = None, comfy_log: str | None = None,
                        sink: Path | str | None = DEFAULT_SINK) -> tuple[Emitter, Callable[[], None]]:
    """Everything run_jobs.py needs in one call; returns the emitter and a stop function."""
    emitter = Emitter(job, sink=sink)
    stop = threading.Event()
    watcher = ComfyWatcher(emitter, comfy_url).start() if comfy_url else None
    if comfy_log:
        tail_file(comfy_log, LineTap(emitter, stage="sampler-log"), stop)
    install_tqdm_hook(emitter)

    def close() -> None:
        stop.set()
        if watcher:
            watcher.close()

    return emitter, close
