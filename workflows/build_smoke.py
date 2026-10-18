"""Build the smoke graph `colab/health.py` submits to prove the wiring (GPU test 5, G5-12).

health.py has always been ready to submit a 256 px smoke job and report whether ComfyUI answered -
but nothing ever put a graph at `/content/comfyrizz/workflows/smoke.api.json`, so the check reported
"skipped" on every real run and the only proof that the proxy could reach ComfyUI was the proxy's own
health endpoint.

The graph is *derived* from the still generator the pipeline actually uses
(`workflows/flux3_klein_t2i.api.json`), with the parameters the params map names shrunk to a smoke
size - so a change to the real graph comes along, instead of a hand-written second graph drifting from
it. Run from the repo root: `python3 workflows/build_smoke.py`.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "flux3_klein_t2i.api.json"
PARAMS = ROOT / "flux3_klein_t2i.api.params.json"
OUT_GRAPH = ROOT / "smoke.api.json"
OUT_PARAMS = ROOT / "smoke.api.params.json"

#: Small enough to be a wiring test rather than a GPU test: 256 px and a handful of steps.
SMOKE = {"width": 256, "height": 256, "steps": 4}


def main() -> int:
    graph = json.loads(SOURCE.read_text(encoding="utf-8"))
    params = json.loads(PARAMS.read_text(encoding="utf-8"))
    mapping = params["map"]
    for field, value in SMOKE.items():
        node, key = mapping[field]
        graph[node]["inputs"][key] = value
    # the graph ComfyUI is handed carries its own marker, so a run log says what was submitted
    graph["comfyrizz_smoke"] = {"v": 1, "derivedFrom": SOURCE.name, "sizes": SMOKE}

    OUT_GRAPH.write_text(json.dumps(graph, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    OUT_PARAMS.write_text(
        json.dumps(
            {
                **params,
                "kind": "still",
                "note": "Derived from flux3_klein_t2i by workflows/build_smoke.py: health.py submits this "
                "graph to prove the proxy reaches ComfyUI. It is a wiring check, not a workload.",
            },
            indent=1,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"{OUT_GRAPH.name}: {len(graph)} nodes, {SMOKE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
