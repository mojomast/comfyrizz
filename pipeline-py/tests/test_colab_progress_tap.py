"""colab/progress_tap.py: tqdm, ComfyUI websocket and frame gauges. No VM, no network beyond loopback."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import socket
import threading
import time

from conftest import REPO_ROOT


def load_tap():
    spec = importlib.util.spec_from_file_location("progress_tap", REPO_ROOT / "colab" / "progress_tap.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def emitter(tap, **kw):
    out = io.StringIO()
    return tap.Emitter("batch-a", stream=out, **kw), out


def lines(out):
    return [json.loads(line) for line in out.getvalue().splitlines()]


def test_tqdm_text_with_carriage_returns_becomes_gauges():
    tap = load_tap()
    clock = Clock()
    em, out = emitter(tap, clock=clock, min_interval=0.0)
    line_tap = tap.LineTap(em, stage="sampler-log")
    line_tap.feed("  0%|          | 0/20 [00:00<?, ?it/s]\r 45%|####5     | 9/20 [00:03<00:04,  2.50it/s]")
    line_tap.feed("\r100%|##########| 20/20 [00:08<00:00,  2.48it/s]\n")
    got = lines(out)
    assert [r["n"] for r in got] == [0, 9, 20]
    assert got[1]["total"] == 20 and got[1]["rate"] == 2.5 and got[1]["eta"] == 4
    assert all(r["event"] == "colab_progress" and r["job"] == "batch-a" and r["stage"] == "sampler-log" for r in got)
    assert got[-1]["ts"].endswith("Z")


def test_seconds_per_iteration_and_labels():
    tap = load_tap()
    bar = tap.parse_tqdm("Fetching 3 files: 33%|###3      | 1/3 [00:12<00:24, 12.00s/it]")
    assert bar["label"] == "Fetching 3 files" and abs(bar["rate"] - 1 / 12) < 1e-9 and bar["eta"] == 24
    assert tap.parse_tqdm("just a log line") is None


def test_throttle_keeps_completion():
    tap = load_tap()
    clock = Clock()
    em, out = emitter(tap, clock=clock, min_interval=1.0)
    for n in range(10):
        em.emit("tqdm", "bar", n, 10)
        clock.now += 0.1
    em.emit("tqdm", "bar", 10, 10)
    assert [r["n"] for r in lines(out)] == [0, 10]
    assert lines(out)[-1]["rate"] > 0


def test_frame_counts_from_renderer_output():
    tap = load_tap()
    em, out = emitter(tap, min_interval=0.0)
    line_tap = tap.LineTap(em, stage="render", frames_label="frames", frames_total=450)
    line_tap.feed("Rendered 120/450, time remaining: 12s\nEncoded 30/450\nframe=  77 fps=30 q=28.0\n")
    line_tap.feed('{"event":"progress","phase":"render"}\n')  # JSON lines are the host's, not a gauge
    got = lines(out)
    assert [(r["label"], r["n"], r["total"]) for r in got] == [("frames render", 120, 450), ("frames encode", 30, 450), ("frames", 77, 450)]
    assert all(r["stage"] == "frames" for r in got)


def test_comfy_messages_become_sampler_and_node_gauges():
    tap = load_tap()
    em, out = emitter(tap, min_interval=0.0)
    comfy = tap.ComfyProgress(em, class_types={"3": "KSampler"})
    for message in [
        {"type": "execution_start", "data": {"prompt_id": "p1"}},
        {"type": "execution_cached", "data": {"prompt_id": "p1", "nodes": ["1"]}},
        {"type": "progress_state", "data": {"prompt_id": "p1", "nodes": {"1": {"state": "finished"}, "2": {"state": "finished"}, "3": {"state": "running"}, "4": {"state": "pending"}}}},
        {"type": "executing", "data": {"prompt_id": "p1", "node": "3"}},
        {"type": "progress", "data": {"prompt_id": "p1", "node": "3", "value": 7, "max": 30}},
        {"type": "executed", "data": {"prompt_id": "p1", "node": "3"}},
        {"type": "execution_success", "data": {"prompt_id": "p1"}},
    ]:
        comfy.handle(message)
    got = lines(out)
    sampler = [r for r in got if r["stage"] == "sampler"]
    assert sampler == [dict(sampler[0], n=7, total=30, label="KSampler #3", job="p1")]
    nodes = [r for r in got if r["stage"] == "node"]
    assert nodes[1]["n"] == 2 and nodes[1]["total"] == 4
    assert nodes[-1]["state"] == "done" and nodes[-1]["n"] == 4


def _fake_comfy_ws(messages):
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)

    def serve():
        conn, _ = server.accept()
        request = b""
        while b"\r\n\r\n" not in request:
            request += conn.recv(4096)
        key = [l.split(b":", 1)[1].strip() for l in request.split(b"\r\n") if l.lower().startswith(b"sec-websocket-key")][0]
        accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
        conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
        for message in messages:
            payload = json.dumps(message).encode()
            head = bytes([0x81, len(payload)]) if len(payload) < 126 else bytes([0x81, 126]) + len(payload).to_bytes(2, "big")
            conn.sendall(head + payload)
        conn.sendall(bytes([0x82, 3]) + b"img")  # a binary preview frame is ignored
        conn.sendall(bytes([0x88, 0]))
        time.sleep(0.2)
        conn.close()
        server.close()

    threading.Thread(target=serve, daemon=True).start()
    return server.getsockname()[1]


def test_watcher_reads_a_real_websocket():
    tap = load_tap()
    port = _fake_comfy_ws([
        {"type": "status", "data": {"status": {}}},
        {"type": "progress", "data": {"prompt_id": "p9", "node": "5", "value": 3, "max": 8}},
        {"type": "executing", "data": {"prompt_id": "p9", "node": None}},
    ])
    em, out = emitter(tap, min_interval=0.0)
    watcher = tap.ComfyWatcher(em, f"http://127.0.0.1:{port}").start()
    deadline = time.time() + 5
    while time.time() < deadline and len(lines(out)) < 2:
        time.sleep(0.05)
    watcher.close()
    got = lines(out)
    assert got[0]["stage"] == "sampler" and got[0]["n"] == 3 and got[0]["total"] == 8 and got[0]["job"] == "p9"
    assert got[1]["state"] == "done"


def test_sink_file_gets_the_same_lines(tmp_path):
    tap = load_tap()
    sink = tmp_path / "out" / "colab-progress.jsonl"
    em, out = emitter(tap, sink=sink, min_interval=0.0)
    em.emit("tqdm", "x", 1, 2)
    assert sink.read_text().strip() == out.getvalue().strip()


def test_run_jobs_and_render_cells_feed_the_tap():
    run_jobs = (REPO_ROOT / "colab" / "run_jobs.py").read_text()
    render = (REPO_ROOT / "colab" / "render_remote.py").read_text()
    assert "import progress_tap" in run_jobs and "tap.feed(line)" in run_jobs
    assert "import progress_tap" in render and "_FRAMES[\"tap\"] = _frames_tap(project)" in render


def test_unit_scaled_bars_keep_one_unit():
    tap = load_tap()
    bar = tap.parse_tqdm("model.safetensors:  10%|#         | 820M/8.20G [00:01<00:09, 820MB/s]")
    assert bar["n"] == 820e6 and bar["total"] == 8.2e9 and bar["rate"] == 820e6
