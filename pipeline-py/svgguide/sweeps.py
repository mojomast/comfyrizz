"""The E2 sweep spec and its unit estimate (E1).

The spec is data, not code: seeds, a denoise grid, the reference weights per approach and the
prompt templates, plus what to measure. `estimate_units` uses the same reserve formula constants
as `packages/backends/src/budget.mjs` (SPEC.md 6.6). The minutes per job are *measured*: the Google
Colab GPU test 3 run (docs/GPU_TEST_3.md) rendered exactly these shapes, and the estimate labels
itself an estimate because a session's cost is account-level and never exact.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .workflows import SWEEP_AXES, check_sweep_axes

#: Kept in step with packages/backends/src/budget.mjs.
RATE_PER_HOUR_DEFAULT = 8.9
COLLECT_AND_STOP_RESERVE_MINUTES = 6
#: Google Colab GPU test 3 measured 218.5 s of setup (clone 1.7 + requirements/proxy/SDK 193.5 +
#: 60.0 GB of model downloads 193.5 in parallel + the text-encoder merge 22.2), plus ComfyUI ready
#: in 14 s: four minutes, rounded up. Same figure as packages/backends.
BOOTSTRAP_OVERHEAD_MINUTES = 4

#: Measured wall minutes per approach (Google Colab GPU test 3, docs/GPU_TEST_3.md). The shapes
#: are the sweep's own: img2img at 1280x720 / 16 steps measured 2.5 s, and ltx_i2v at 1024x576 /
#: 97 frames measured 13.3-17.0 s. Rounded up, so the admission check stays conservative.
APPROACH_MINUTES = {"img2img": 0.05, "ltx_i2v": 0.3}

#: The same run measured the reference edit against its own axis: 2.5 s at 0.5 reference
#: megapixels, 5.6 s at 1.0, 8.5 s at 1.5. So the estimate follows the axis instead of charging
#: the 1.5 MP price for a 0.5 MP job (the GPU test 2 sweep priced every edit the same, which is
#: the same mistake as an axis that reaches no node).
REFERENCE_EDIT_MINUTES = {0.5: 0.05, 1.0: 0.1, 1.5: 0.15}


def minutes_for(approach: str, reference_megapixels: float | None = None) -> float:
    """Measured minutes for one sweep job of this exact shape."""
    if approach == "ref_edit":
        if reference_megapixels is None:
            return max(REFERENCE_EDIT_MINUTES.values())
        return REFERENCE_EDIT_MINUTES.get(float(reference_megapixels), max(REFERENCE_EDIT_MINUTES.values()))
    return APPROACH_MINUTES.get(approach, 1.0)

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
    reference_megapixels: tuple[float, ...] = (0.5, 1.0, 1.5),
    templates_version: str = "0.1.0",
    rate_per_hour: float = RATE_PER_HOUR_DEFAULT,
) -> dict[str, Any]:
    """The full sweep: every scene x seed x approach (x denoise for the img2img family).

    ``ref_edit`` sweeps the reference **budget** (``ReferenceMultiLatent``'s
    ``resolution.megapixels``), not a weight: that node has no weight input, so the old
    ``reference_weight`` axis was a no-op that made every reference-edit job in GPU test 2 the same
    render (issue 5). Every axis produced here is checked against the approach's params map before
    any job exists, so an axis with no target node cannot be planned again.
    """
    if not scenes:
        raise ValueError("a sweep needs at least one scene")
    known = ("img2img", "ref_edit", "ltx_i2v")
    jobs = []
    checked: set[str] = set()
    for scene in scenes:
        for approach in approaches:
            if approach not in known:
                raise ValueError(f"unknown approach {approach!r}; expected {', '.join(known)}")
            problems = check_sweep_axes(approach) if approach not in checked else []
            if problems:
                raise ValueError(f"{approach} sweep axes do not reach a node: " + "; ".join(problems))
            checked.add(approach)
            denominators = denoise_grid if approach == "img2img" else (None,)
            budgets = reference_megapixels if approach == "ref_edit" else (None,)
            width, height = APPROACH_GEOMETRY[approach]
            # the fields this approach's jobs actually vary; each must be a declared axis
            varied = {"seed"}
            if approach == "img2img":
                varied |= {"denoise"}
            if approach == "ref_edit":
                varied |= {"reference_megapixels"}
            undeclared = sorted(varied - set(SWEEP_AXES[approach]))
            if undeclared:
                raise ValueError(f"{approach} varies {', '.join(undeclared)}, which SWEEP_AXES does not declare")
            for seed in seeds:
                for denoise in denominators:
                    for budget in budgets:
                        jobs.append(
                            {
                                "id": f"{scene['id']}.{approach}.s{seed}"
                                + (f".d{denoise}" if denoise is not None else "")
                                + (f".mp{budget}" if budget is not None else ""),
                                "scene": scene["id"],
                                "role": scene.get("role", "hero-subject"),
                                "approach": approach,
                                "seed": seed,
                                "denoise": denoise,
                                "reference_megapixels": budget,
                                "width": width,
                                "height": height,
                                "guide": scene.get("guide"),
                                "caption_template": scene.get("template_id"),
                                "minutes_estimate": minutes_for(approach, budget),
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
        "basis": (
            "measured wall minutes per approach from the Google Colab GPU test 3 run (docs/GPU_TEST_3.md: "
            "img2img 2.5 s, ref_edit 2.5/5.6/8.5 s at 0.5/1.0/1.5 reference megapixels, ltx_i2v 13.3-17.0 s), "
            "each rounded up; overhead measured at 218.5 s of setup"
        ),
        "reserve_formula": "gpu + bootstrap overhead + collect-and-stop reserve <= project budget (SPEC.md 6.6)",
    }


def write_sweep_spec(path: Path, spec: dict[str, Any]) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")
    return path
