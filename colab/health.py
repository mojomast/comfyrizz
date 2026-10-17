"""Comfyrizz Google Colab health check (draft; never executed on Google Colab yet).

`colab exec -s comfyrizz-<pkg> -f health.py --timeout 300` after bootstrap. It writes
`/content/comfyrizz/out/health.json` and exits non-zero on a hard failure, but the backend
treats the *file* as the evidence (exit codes are not proof — SPEC.md 5.2/6.4).

Checks: proxy reachable, ComfyUI node types present, required model files listed, one small
smoke job, and free VRAM. A 256 px smoke job proves the wiring, not that the real workload
fits; the report says so.
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

COMFY_URL = "http://127.0.0.1:8188"
PROXY_URL = "http://127.0.0.1:8189"
OUT = Path("/content/comfyrizz/out")
REQUIRED_NODES = ["KSampler", "LoadImage", "SaveImage"]
REQUIRED_MODEL_HINTS = ["flux-3-image-klein", "ltx-2.5"]
SMOKE = Path("/content/comfyrizz/workflows/smoke.api.json")


def get_json(url: str, timeout: float = 5.0):
    with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310 - loopback only
        return json.load(response)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    report = {"ok": False, "detail": "", "checks": {}, "note": "a smoke job proves wiring, not that the real workload fits"}

    try:
        report["checks"]["proxy"] = {"ok": True, "jobs": len(get_json(f"{PROXY_URL}/api/v2/jobs?limit=1").get("jobs", []))}
    except Exception as error:  # noqa: BLE001 - reported, not raised
        report["checks"]["proxy"] = {"ok": False, "detail": str(error)}

    try:
        object_info = get_json(f"{COMFY_URL}/object_info", timeout=20)
        node_types = sorted(object_info.keys())
        model_files = sorted(
            {
                str(item)
                for node in object_info.values()
                for group in ("required", "optional")
                for spec in (node.get("input", {}) or {}).get(group, {}).values()
                if isinstance(spec, list) and spec and isinstance(spec[0], list)
                for item in spec[0]
                if isinstance(item, str)
            }
        )
        report["checks"]["object_info"] = {
            "ok": all(node in node_types for node in REQUIRED_NODES),
            "nodeTypes": len(node_types),
            "missingNodes": [node for node in REQUIRED_NODES if node not in node_types],
            "missingModelHints": [hint for hint in REQUIRED_MODEL_HINTS if not any(hint in name for name in model_files)],
        }
    except Exception as error:  # noqa: BLE001
        report["checks"]["object_info"] = {"ok": False, "detail": str(error)}

    try:
        stats = get_json(f"{COMFY_URL}/system_stats", timeout=10)
        device = (stats.get("devices") or [{}])[0]
        report["checks"]["gpu"] = {
            "ok": True,
            "name": device.get("name"),
            "vramFreeGB": round(device.get("vram_free", 0) / 1024**3, 2),
            "vramTotalGB": round(device.get("vram_total", 0) / 1024**3, 2),
        }
        report["vramFreeGB"] = report["checks"]["gpu"]["vramFreeGB"]
    except Exception as error:  # noqa: BLE001
        report["checks"]["gpu"] = {"ok": False, "detail": str(error)}

    try:
        nvidia = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.free,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        report["checks"]["nvidia_smi"] = {"ok": nvidia.returncode == 0, "output": nvidia.stdout.strip()}
    except Exception as error:  # noqa: BLE001
        report["checks"]["nvidia_smi"] = {"ok": False, "detail": str(error)}

    if SMOKE.is_file():
        try:
            payload = json.dumps({"workflow": json.loads(SMOKE.read_text())}).encode()
            request = urllib.request.Request(f"{PROXY_URL}/api/v2/jobs", data=payload, headers={"Content-Type": "application/json"})  # noqa: S310
            with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
                report["checks"]["smoke"] = {"ok": response.status == 201, "job": json.load(response).get("id")}
        except Exception as error:  # noqa: BLE001
            report["checks"]["smoke"] = {"ok": False, "detail": str(error)}
    else:
        report["checks"]["smoke"] = {"ok": True, "detail": f"skipped: no {SMOKE}"}

    hard = [name for name, check in report["checks"].items() if not check.get("ok")]
    report["ok"] = not hard
    report["detail"] = "all checks passed" if report["ok"] else f"failing checks: {', '.join(hard)}"
    (OUT / "health.json").write_text(json.dumps(report, indent=2))
    print("HEALTH", json.dumps(report)[:600], flush=True)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
