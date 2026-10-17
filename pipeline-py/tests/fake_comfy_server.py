"""Run the fake Comfy v2 server as a process (B5).

    python tests/fake_comfy_server.py --port 0 [--fail-labels a.still,b.plate] [--outputs 1]

Prints "listening on <port>" on stdout so a test can allocate a free port. It is the same
`tests/fake_comfy.py` the pytest suite uses, exposed over HTTP so the TypeScript BYO backend
can drive the real pipeline-py runner against it. No GPU, no network beyond loopback.
"""

from __future__ import annotations

import argparse
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_comfy import FakeComfy  # noqa: E402  (path set above)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fake_comfy_server")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--outputs", type=int, default=1)
    parser.add_argument("--output-kind", default="image")
    parser.add_argument("--fail-labels", default="", help="comma-separated job labels that must fail")
    parser.add_argument("--finish-after", type=float, default=0.0)
    parser.add_argument("--never-finish", action="store_true")
    parser.add_argument("--drop-first-response", action="store_true")
    parser.add_argument("--request-log", default=None, help="append one JSON line per request")
    parser.add_argument("--upload-status", type=int, default=200, help="what /upload/image answers (404 = a server without the route)")
    parser.add_argument("--reject-metadata", action="store_true", help="refuse dict job labels like comfy-api-proxy does")
    parser.add_argument("--lifetime-seconds", type=float, default=300.0, help="exit after this long, so a test can never leak a server")
    args = parser.parse_args(argv)

    fake = FakeComfy(
        port=args.port,
        outputs=args.outputs,
        output_kind=args.output_kind,
        finish_after=args.finish_after,
        never_finish=args.never_finish,
        drop_first_response=args.drop_first_response,
        fail_labels=[label for label in args.fail_labels.split(",") if label],
        request_log=args.request_log,
        upload_status=args.upload_status,
        reject_metadata=args.reject_metadata,
    )
    fake.state.origin = f"http://127.0.0.1:{args.port}" if args.port else fake.base_url
    lifetime = float(args.lifetime_seconds)
    if lifetime > 0:
        # hard bound: a killed test can never leave this process behind
        threading.Timer(lifetime, lambda: fake.__exit__(None, None, None)).start()
    with fake:
        print(f"listening on {fake.base_url.rsplit(':', 1)[1]}", flush=True)
        try:
            fake.thread.join()
        except KeyboardInterrupt:  # pragma: no cover
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
