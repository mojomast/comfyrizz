"""Simulated Google Colab cell for the live gauges: no VM, no GPU.

Drives colab/progress_tap.py the way run_jobs.py and render_remote.py do - a fake ComfyUI websocket
(sampler steps, per-node progress), a tqdm bar repainted with carriage returns (a model download),
a ComfyUI log tail, and a renderer's frame counter - and prints the colab_progress lines on stdout.
`node scripts/colab/simulate-progress.mjs` feeds that stdout through the host's real path.
"""

from __future__ import annotations

import base64
import hashlib
import json
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "colab"))
import progress_tap  # noqa: E402

SPEED = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
nap = lambda seconds: time.sleep(seconds / SPEED)  # noqa: E731


def fake_comfy(prompt: str, steps: int, nodes: list[str]) -> int:
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(1)

    def send(conn, message):
        payload = json.dumps(message).encode()
        head = bytes([0x81, len(payload)]) if len(payload) < 126 else bytes([0x81, 126]) + len(payload).to_bytes(2, "big")
        conn.sendall(head + payload)

    def serve():
        conn, _ = server.accept()
        request = b""
        while b"\r\n\r\n" not in request:
            request += conn.recv(4096)
        key = [l.split(b":", 1)[1].strip() for l in request.split(b"\r\n") if l.lower().startswith(b"sec-websocket-key")][0]
        accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
        conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
        send(conn, {"type": "execution_start", "data": {"prompt_id": prompt}})
        state = {node: "pending" for node in nodes}
        for node in nodes:
            state[node] = "running"
            send(conn, {"type": "progress_state", "data": {"prompt_id": prompt, "nodes": {k: {"state": v} for k, v in state.items()}}})
            send(conn, {"type": "executing", "data": {"prompt_id": prompt, "node": node}})
            if node == "3":
                for step in range(1, steps + 1):
                    send(conn, {"type": "progress", "data": {"prompt_id": prompt, "node": node, "value": step, "max": steps}})
                    nap(0.12)
            else:
                nap(0.3)
            state[node] = "finished"
            send(conn, {"type": "executed", "data": {"prompt_id": prompt, "node": node}})
        send(conn, {"type": "progress_state", "data": {"prompt_id": prompt, "nodes": {k: {"state": v} for k, v in state.items()}}})
        send(conn, {"type": "executing", "data": {"prompt_id": prompt, "node": None}})
        send(conn, {"type": "execution_success", "data": {"prompt_id": prompt}})
        nap(0.5)
        conn.close()
        server.close()

    threading.Thread(target=serve, daemon=True).start()
    return server.getsockname()[1]


def main() -> None:
    log = Path(tempfile.mkdtemp()) / "comfyui.log"
    log.write_text("")
    # the same observers run_jobs.py starts: websocket + ComfyUI log tail (+ tqdm hook)
    port = fake_comfy("prompt-sim-0001", steps=30, nodes=["4", "6", "3", "8", "9"])
    emitter, close = progress_tap.start_run_observers("batch-sim", comfy_url=f"http://127.0.0.1:{port}", comfy_log=str(log), sink=None)
    stdout_tap = progress_tap.LineTap(emitter)

    # a model download in the runner's stdout, repainted with \r like tqdm does
    for i in range(0, 11):
        bar = "#" * i + " " * (10 - i)
        stdout_tap.feed(f"\rflux2-klein.safetensors: {i * 10:3d}%|{bar}| {i * 820}M/8.20G [00:{i:02d}<00:{10 - i:02d}, 820MB/s]")
        nap(0.25)
    stdout_tap.feed("\n")
    # ComfyUI's own sampler bar lands in its log file
    with open(log, "a") as handle:
        for step in range(0, 31, 3):
            handle.write(f"\r{int(step / 30 * 100):3d}%|{'#' * (step // 3)}| {step}/30 [00:{step // 3:02d}<00:{(30 - step) // 3:02d},  3.10it/s]")
            handle.flush()
            nap(0.4)
        handle.write("\n")
    nap(1.5)
    close()
    # the render cell: frame counts from the renderer's output
    render = progress_tap.LineTap(progress_tap.Emitter("render", sink=None), stage="render", frames_label="frames", frames_total=450)
    for frame in range(0, 451, 15):
        render.feed(f"Rendered {frame}/450, time remaining: {(450 - frame) // 30}s\n")
        nap(0.1)
    for frame in range(0, 451, 45):
        render.feed(f"Encoded {frame}/450\n")
        nap(0.08)
    print("COMFYRIZZ_OK simulate", flush=True)


main()
