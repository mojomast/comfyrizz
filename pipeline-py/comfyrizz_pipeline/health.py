"""Health checks for a Comfy endpoint (SPEC.md 6.5).

Three layers, cheapest first:

1. **v2 alive**: the SDK's own surface answers (``GET {v2}/jobs?limit=1``).
2. **ComfyUI reachable, nodes and models present**: ``GET {comfyui}/system_stats`` and
   ``GET {comfyui}/object_info`` — the latter names every node class and, in each input
   spec, the model files the node can load, which is how "required model files present"
   is checked without guessing at paths.
3. **Smoke job** (opt-in, ``--smoke <workflow.api.json>``): submit a small graph and wait.
   A 256 px smoke job proves the wiring, not that the real workload fits — say so in the
   output rather than implying more.

``python -m comfyrizz_pipeline.health --v2-url URL --comfyui-url URL --require-node X``
prints a JSON report and exits 0 (ok) or 1 (not ok).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import httpx

DEFAULT_TIMEOUT = 10.0


def _problem(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def v2_root(base_url: str) -> str:
    """Accept either the deployment root (``http://127.0.0.1:8189``) or its v2 root."""
    url = base_url.rstrip("/")
    return url if url.endswith("/api/v2") else f"{url}/api/v2"


def check_v2(base_url: str, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    url = v2_root(base_url)
    try:
        response = httpx.get(f"{url}/jobs", params={"limit": 1}, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 - reported, never raised
        return {"ok": False, "detail": f"v2 endpoint unreachable at {url}: {_problem(exc)}", "url": url}
    if response.status_code != 200:
        return {"ok": False, "detail": f"v2 endpoint answered {response.status_code}", "url": url, "body": response.text[:200]}
    jobs = response.json().get("jobs", [])
    return {"ok": True, "detail": f"v2 endpoint alive ({len(jobs)} job(s) on the first page)", "url": url}


def check_comfyui(base_url: str, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    url = base_url.rstrip("/")
    report: dict[str, Any] = {"ok": False, "url": url, "node_types": [], "model_files": []}
    try:
        stats = httpx.get(f"{url}/system_stats", timeout=timeout)
        if stats.status_code != 200:
            report["detail"] = f"/system_stats answered {stats.status_code}"
            return report
        info = httpx.get(f"{url}/object_info", timeout=timeout)
        if info.status_code != 200:
            report["detail"] = f"/object_info answered {info.status_code}"
            return report
    except Exception as exc:  # noqa: BLE001
        report["detail"] = f"ComfyUI unreachable at {url}: {_problem(exc)}"
        return report

    payload = info.json()
    report["node_types"] = sorted(payload.keys())
    report["model_files"] = sorted(collect_model_files(payload))
    devices = (stats.json() or {}).get("devices") or []
    if devices:
        device = devices[0]
        total = device.get("vram_total")
        free = device.get("vram_free")
        report["device"] = device.get("name")
        report["vramFreeGB"] = round(free / 1024**3, 2) if isinstance(free, (int, float)) else None
        report["vramTotalGB"] = round(total / 1024**3, 2) if isinstance(total, (int, float)) else None
    report["system"] = (stats.json() or {}).get("system", {})
    report["ok"] = True
    report["detail"] = f"{len(report['node_types'])} node types, {len(report['model_files'])} model files"
    return report


def collect_model_files(object_info: dict[str, Any]) -> set[str]:
    """Every candidate filename an input spec offers (ComfyUI lists them in the first slot)."""
    found: set[str] = set()
    for node in object_info.values():
        if not isinstance(node, dict):
            continue
        for group in ("required", "optional"):
            for spec in (node.get("input", {}) or {}).get(group, {}).values():
                if isinstance(spec, list) and spec and isinstance(spec[0], list):
                    found.update(str(item) for item in spec[0] if isinstance(item, str))
    return found


def missing(node_types: list[str], require_nodes: list[str]) -> list[str]:
    return [name for name in require_nodes if name not in node_types]


def missing_models(model_files: list[str], require_models: list[str]) -> list[str]:
    have = set(model_files)
    return [name for name in require_models if name not in have]


def smoke_job(v2_url: str, workflow: Path, timeout: float = 600.0) -> dict[str, Any]:
    """Submit a small workflow through the SDK and wait. Never called without a workflow file."""
    from .client import ComfyClient

    client = ComfyClient(base_url=v2_url)
    try:
        outcome = client.submit(Path(workflow), params={}, idempotency_key="comfyrizz-smoke-0001")
        if not outcome.submitted:
            return {"ok": False, "detail": f"smoke submit did not succeed: {outcome.kind} {outcome.error}"}
        snapshot = client.wait(outcome.job_id, timeout=timeout)
        ok = snapshot.status == "succeeded"
        return {
            "ok": ok,
            "detail": f"smoke job ended {snapshot.status} (proves wiring, not that the real workload fits)",
            "job_id": outcome.job_id,
            "outputs": len(snapshot.outputs),
            "error": (snapshot.error or {}).get("message") if not ok else None,
        }
    finally:
        client.close()


def health_report(
    *,
    v2_url: str | None = None,
    comfyui_url: str | None = None,
    require_nodes: list[str] | None = None,
    require_models: list[str] | None = None,
    smoke_workflow: Path | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    report: dict[str, Any] = {"ok": True, "checks": {}}
    if v2_url:
        report["checks"]["v2"] = check_v2(v2_url, timeout)
    if comfyui_url:
        comfy = check_comfyui(comfyui_url, timeout)
        missing_nodes = missing(comfy.get("node_types", []), require_nodes or [])
        missing_model_files = missing_models(comfy.get("model_files", []), require_models or [])
        comfy["missingNodes"] = missing_nodes
        comfy["missingModelFiles"] = missing_model_files
        if missing_nodes or missing_model_files:
            comfy["ok"] = False
            comfy["detail"] = "missing required " + ", ".join(
                ([f"node {n}" for n in missing_nodes] + [f"model file {m}" for m in missing_model_files])
            )
        report["checks"]["comfyui"] = comfy
    if smoke_workflow is not None:
        report["checks"]["smoke"] = smoke_job(v2_url or comfyui_url or "", smoke_workflow, timeout=timeout * 60)
    report["ok"] = all(check.get("ok") for check in report["checks"].values()) if report["checks"] else False
    if not report["checks"]:
        report["detail"] = "nothing to check: pass --v2-url, --comfyui-url or --smoke"
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="comfyrizz_pipeline.health")
    parser.add_argument("--v2-url", default=None, help="comfy-api-proxy v2 endpoint")
    parser.add_argument("--comfyui-url", default=None, help="ComfyUI itself (/system_stats, /object_info)")
    parser.add_argument("--require-node", action="append", default=[])
    parser.add_argument("--require-model-file", action="append", default=[])
    parser.add_argument("--smoke", default=None, help="API-format workflow to submit as a smoke job")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    report = health_report(
        v2_url=args.v2_url,
        comfyui_url=args.comfyui_url,
        require_nodes=args.require_node,
        require_models=args.require_model_file,
        smoke_workflow=Path(args.smoke) if args.smoke else None,
        timeout=args.timeout,
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"health: {'ok' if report['ok'] else 'NOT ok'}")
        for name, check in report["checks"].items():
            print(f"  {name}: {'ok' if check.get('ok') else 'FAIL'} - {check.get('detail')}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
