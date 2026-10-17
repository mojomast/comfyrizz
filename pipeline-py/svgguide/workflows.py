"""Workflow drafts for SVG-guided generation (E1).

The drafts start from the **real** GPU-test-1 graphs (`workflows/flux3_klein_img2img.api.json`,
`flux3_klein_ref_edit.api.json`, `ltx25_i2v_2stage.api.json`) and their B4 params maps, so a draft
cannot drift from what actually ran on the VM: `build_approach` injects the guide's parameters
with the runner's own `inject_params` and refuses to hand back a graph whose links dangle.

Approach 3 (ControlNet-style conditioning) is deliberately **not** drafted: PLAN.md E1 allows it
only if Klein-compatible control weights exist, and nothing found so far establishes that.
`CONTROLNET_STATUS` records that honestly instead of substituting another model's ControlNet.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from comfyrizz_pipeline.client import inject_params, load_params_map

from .paths import BASE_GRAPHS

APPROACHES = {
    "img2img": {
        "summary": "rasterised SVG as the init latent, denoise swept 0.35 -> 0.85 (PLAN.md E1 approach 1)",
        "guide_input": "the sanitised raster (optionally blurred/noised) plus the caption",
        "params": ("image", "prompt", "width", "height", "seed", "steps", "denoise"),
    },
    "ref_edit": {
        "summary": "the rasterised SVG as Klein reference image 0, bounding boxes in the prompt (approach 2)",
        "guide_input": "the sanitised raster plus per-region boxes from the SVG",
        "params": ("reference", "prompt", "megapixels", "seed", "steps", "denoise"),
    },
    "ltx_i2v": {
        "summary": "the SVG-guided still as the first frame of an LTX-2.5 plate (approach 4)",
        "guide_input": "the generated still (not the SVG) plus the caption",
        "params": ("image", "prompt", "width", "height", "frames", "fps", "seed", "stage2_seed"),
    },
}

#: Approach 3 needs weights that exist. None were established for FLUX 3 Image Klein here, and
#: silently borrowing another model's ControlNet is exactly what PLAN.md forbids.
CONTROLNET_STATUS = {
    "found": False,
    "approaches": ["canny", "depth", "lineart"],
    "verified": False,
    "note": (
        "No ControlNet or control-LoRA weights for FLUX 3 Image Klein were established while "
        "writing this (checks belong to the M3 GPU spike, which has network access to the model "
        "hub). Nothing is drafted for approach 3 rather than substituting a different model's "
        "ControlNet, and the edges from this package are still useful as an img2img init latent."
    ),
    "recheck_on": "M3 GPU spike (Kyle-approved session); record links in workflows/svg-guided/README.md",
}


class GraphError(ValueError):
    """A graph whose wiring or parameter injection does not hold up."""


def check_graph(graph: dict[str, Any]) -> list[str]:
    """Structural problems that would make a graph invalid on a server, as strings."""
    problems = []
    if not isinstance(graph, dict) or not graph:
        return ["the graph is empty"]
    for ui_key in ("nodes", "links", "last_node_id"):
        if ui_key in graph:
            problems.append(f"the graph is a UI export ({ui_key} present); an API-format graph is required")
    ids = set(graph)
    for node_id, node in graph.items():
        if not isinstance(node, dict) or "class_type" not in node:
            problems.append(f"node {node_id} has no class_type")
            continue
        for field, value in (node.get("inputs") or {}).items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int)):
                if str(value[0]) not in ids:
                    problems.append(f"node {node_id}.{field} links to missing node {value[0]}")
    return problems


def build_approach(
    approach: str,
    *,
    params: dict[str, Any],
    base_graph: Path | None = None,
) -> dict[str, Any]:
    """A filled draft: the base graph with the guide's parameters injected through its B4 map."""
    if approach not in APPROACHES:
        raise GraphError(f"unknown approach {approach!r}; expected one of {', '.join(APPROACHES)}")
    graph_path = Path(base_graph or BASE_GRAPHS[approach])
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    problems = check_graph(graph)
    if problems:
        raise GraphError(f"{graph_path.name}: " + "; ".join(problems))
    mapping = load_params_map(graph_path)
    missing = [name for name in APPROACHES[approach]["params"] if name not in mapping]
    if missing:
        raise GraphError(f"{graph_path.name} has no params mapping for {', '.join(missing)}")
    # the runner's own injection: raises and names any parameter the workflow cannot accept
    inject_params(graph, mapping, params)
    return {
        "approach": approach,
        "base_graph": str(graph_path.relative_to(graph_path.parents[1])),
        "graph": graph,
        "params": params,
        "map": mapping,
        "params_file": f"{graph_path.stem}.params.json",
        "summary": APPROACHES[approach]["summary"],
    }


def write_approach(draft: dict[str, Any], out_dir: Path) -> dict[str, str]:
    """Write ``<approach>.api.json`` + ``<approach>.api.params.json`` into `out_dir`."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    graph_path = out_dir / f"{draft['approach']}.api.json"
    params_path = out_dir / f"{draft['approach']}.api.params.json"
    graph_path.write_text(json.dumps(draft["graph"], indent=2) + "\n", encoding="utf-8")
    params_path.write_text(
        json.dumps(
            {
                "v": 1,
                "generator": draft["approach"],
                "note": draft["summary"],
                "map": draft["map"],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return {"graph": str(graph_path), "params": str(params_path)}
