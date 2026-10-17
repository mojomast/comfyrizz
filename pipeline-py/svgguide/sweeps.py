"""The E2 sweep spec and its unit estimate (E1).

The spec is data, not code: seeds, a denoise grid, the reference weights per approach and the
prompt templates, plus what to measure. `estimate_units` uses the same reserve formula constants
as `packages/backends/src/budget.mjs` (SPEC.md 6.6) and labels the result an estimate, because a
placeholder minute-per-job is exactly that until the M3 spike measures real times.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

#: Kept in step with packages/backends/src/budget.mjs.
RATE_PER_HOUR_DEFAULT = 8.9
COLLECT_AND_STOP_RESERVE_MINUTES = 6
BOOTSTRAP_OVERHEAD_MINUTES = 5

#: Placeholder GPU minutes per approach until the M3 spike measures the real ones.
APPROACH_MINUTES = {"img2img": 0.5, "ref_edit": 0.5, "ltx_i2v": 1.5}

#: The geometry each approach runs at, from the GPU test 2 measurements (docs/GPU_TEST_2.md).
#: The img2img/edit stills ran at 1280x720; the i2v plates at 1024x576, which is the aspect an
#: i2v source has to be *at* - a 1:1 source fed to a 16:9 plate was centre-cropped on the GPU test
#: and cut the subject's head off. One 16:9 source per scene serves both, and every dimension here
#: is a multiple of 16 so the model pads or crops nothing (GPU test 2, issues 6 and the i2v note).
APPROACH_GEOMETRY: dict[str, tuple[int, int]] = {
    "img2img": (1280, 720),
    "ref_edit": (1280, 720),
    "ltx_i2v": (1024, 576),
}

#: The rubric the contact sheets are scored against (PLAN.md E1).
RUBRIC = {
    "layout_fidelity": ["edge_iou", "chamfer_distance", "mask_iou", "palette_delta_e"],
    "aesthetic": ["clip_score (optional, CPU)", "human 1-5 rating sheet"],
    "notes": "layout fidelity is computed against the SVG control maps; aesthetic quality is scored separately",
}


def build_sweep_spec(
    scenes: list[dict[str, Any]],
    *,
    seeds: tuple[int, ...] = (42, 43),
    denoise_grid: tuple[float, ...] = (0.35, 0.5, 0.65, 0.85),
    approaches: tuple[str, ...] = ("img2img", "ref_edit", "ltx_i2v"),
    reference_weights: tuple[float, ...] = (0.0, 0.25, 0.5),
    templates_version: str = "0.1.0",
    rate_per_hour: float = RATE_PER_HOUR_DEFAULT,
) -> dict[str, Any]:
    """The full sweep: every scene x seed x approach (x denoise for the img2img family)."""
    if not scenes:
        raise ValueError("a sweep needs at least one scene")
    jobs = []
    for scene in scenes:
        for approach in approaches:
            if approach not in APPROACH_MINUTES:
                raise ValueError(f"unknown approach {approach!r}; expected {', '.join(APPROACH_MINUTES)}")
            denominators = denoise_grid if approach == "img2img" else (None,)
            weights = reference_weights if approach == "ref_edit" else (None,)
            width, height = APPROACH_GEOMETRY[approach]
            for seed in seeds:
                for denoise in denominators:
                    for weight in weights:
                        jobs.append(
                            {
                                "id": f"{scene['id']}.{approach}.s{seed}"
                                + (f".d{denoise}" if denoise is not None else "")
                                + (f".w{weight}" if weight is not None else ""),
                                "scene": scene["id"],
                                "role": scene.get("role", "hero-subject"),
                                "approach": approach,
                                "seed": seed,
                                "denoise": denoise,
                                "reference_weight": weight,
                                "width": width,
                                "height": height,
                                "guide": scene.get("guide"),
                                "caption_template": scene.get("template_id"),
                                "minutes_estimate": APPROACH_MINUTES[approach],
                            }
                        )
    spec = {
        "v": 1,
        "purpose": "E2 SVG-guided GPU sweep: which guidance setting wins per layout role",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "templates_version": templates_version,
        "rate_per_hour": rate_per_hour,
        "rubric": RUBRIC,
        "contact_sheet": "one sheet per scene per approach, columns = seed, rows = denoise/reference weight",
        "scenes": [{"id": scene["id"], "role": scene.get("role"), "guide": scene.get("guide"), "caption": scene.get("caption")} for scene in scenes],
        "jobs": jobs,
        "human_gate": "Kyle approves the session and the unit budget before any of this runs (SPEC.md 6.6)",
    }
    spec["estimate"] = estimate_units(spec, rate_per_hour=rate_per_hour)
    return spec


def estimate_units(spec: dict[str, Any], *, rate_per_hour: float = RATE_PER_HOUR_DEFAULT) -> dict[str, Any]:
    """GPU minutes and units for a sweep, from the same shape as the reserve formula."""
    jobs = spec.get("jobs", [])
    gpu_minutes = sum(float(job.get("minutes_estimate") or 0) for job in jobs)
    overhead = BOOTSTRAP_OVERHEAD_MINUTES
    reserve = COLLECT_AND_STOP_RESERVE_MINUTES
    total_minutes = gpu_minutes + overhead + reserve
    units = total_minutes / 60 * rate_per_hour
    return {
        "jobs": len(jobs),
        "gpu_minutes": round(gpu_minutes, 2),
        "overhead_minutes": overhead,
        "collect_and_stop_reserve_minutes": reserve,
        "total_minutes": round(total_minutes, 2),
        "units": round(units, 3),
        "next_job_upper_units": round((max([float(job.get("minutes_estimate") or 0) for job in jobs] or [0])) * 1.35 / 60 * rate_per_hour, 3),
        "label": "estimate",
        "basis": "placeholder minutes per approach until the M3 spike measures real times; the metadata notes exactly this",
        "reserve_formula": "gpu + bootstrap overhead + collect-and-stop reserve <= project budget (SPEC.md 6.6)",
    }


def write_sweep_spec(path: Path, spec: dict[str, Any]) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")
    return path
