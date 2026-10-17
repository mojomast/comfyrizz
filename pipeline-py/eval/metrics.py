"""The E1/E2 evaluation rubric, CPU only (PLAN.md E1, spec §6.11).

Layout fidelity is measured against the SVG's control maps (edge IoU, chamfer distance, mask IoU,
palette ΔE); aesthetic quality is separate and honest about its cost (a CLIP score is optional and
slow on CPU, and a human 1-5 sheet is the ground truth the sweep is picked on). Nothing here
downloads weights unless CLIP is explicitly asked for.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from svgguide.controlmaps import hex_to_rgb

CLIP_NOTE = "optional: needs a CLIP checkpoint; CPU-only and slow, so it is off by default"


def _as_bool(array: np.ndarray) -> np.ndarray:
    data = np.asarray(array)
    if data.dtype == bool:
        return data
    return data > 0.02


def _grow(mask: np.ndarray, pixels: int) -> np.ndarray:
    grown = mask.copy()
    for _ in range(int(pixels)):
        grown = grown | np.roll(grown, 1, 0) | np.roll(grown, -1, 0) | np.roll(grown, 1, 1) | np.roll(grown, -1, 1)
    return grown


def edge_iou(reference: np.ndarray, candidate: np.ndarray, *, tolerance: int = 0) -> float:
    """IoU of two edge maps.

    `tolerance` dilates *both* maps by that many pixels: it measures agreement when the two are
    allowed to be off by that much, which is the question an SVG-guided comparison actually asks
    (a one-pixel offset is not a composition error). Symmetric on purpose — growing only one map
    would punish and reward the same mistake.
    """
    reference_bool = _as_bool(reference)
    candidate_bool = _as_bool(candidate)
    if reference_bool.shape != candidate_bool.shape:
        raise ValueError(f"shape mismatch: {reference_bool.shape} vs {candidate_bool.shape}")
    if tolerance > 0:
        reference_bool = _grow(reference_bool, tolerance)
        candidate_bool = _grow(candidate_bool, tolerance)
    union = np.logical_or(reference_bool, candidate_bool).sum()
    if union == 0:
        return 1.0
    return float(np.logical_and(reference_bool, candidate_bool).sum() / union)


def mask_iou(reference: np.ndarray, candidate: np.ndarray) -> float:
    """IoU of two region masks (the same measure as edge IoU, named for the rubric)."""
    return edge_iou(reference, candidate)


def chamfer_distance(reference: np.ndarray, candidate: np.ndarray, *, max_points: int = 2000) -> float:
    """Mean symmetric nearest-neighbour distance between two edge maps, in pixels."""
    reference_points = np.argwhere(_as_bool(reference))
    candidate_points = np.argwhere(_as_bool(candidate))
    if len(reference_points) == 0 or len(candidate_points) == 0:
        return float("nan")
    rng = np.random.default_rng(7)
    if len(reference_points) > max_points:
        reference_points = reference_points[rng.choice(len(reference_points), max_points, replace=False)]
    if len(candidate_points) > max_points:
        candidate_points = candidate_points[rng.choice(len(candidate_points), max_points, replace=False)]
    forward = np.mean([np.min(np.linalg.norm(candidate_points - point, axis=1)) for point in reference_points])
    backward = np.mean([np.min(np.linalg.norm(reference_points - point, axis=1)) for point in candidate_points])
    return float((forward + backward) / 2)


def srgb_to_lab(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    def linear(channel: float) -> float:
        channel = max(0.0, min(1.0, channel))
        return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4

    r, g, b = (linear(channel / 255.0) for channel in rgb)
    x = r * 0.4124 + g * 0.3576 + b * 0.1805
    y = r * 0.2126 + g * 0.7152 + b * 0.0722
    z = r * 0.0193 + g * 0.1192 + b * 0.9505
    xn, yn, zn = 0.95047, 1.0, 1.08883

    def f(value: float) -> float:
        return value ** (1 / 3) if value > 0.008856 else 7.787 * value + 16 / 116

    fx, fy, fz = f(x / xn), f(y / yn), f(z / zn)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def delta_e(colour_a: str | tuple[float, float, float], colour_b: str | tuple[float, float, float]) -> float:
    """CIE76 colour difference between two hex colours (or RGB triples)."""
    first = hex_to_rgb(colour_a) if isinstance(colour_a, str) else colour_a
    second = hex_to_rgb(colour_b) if isinstance(colour_b, str) else colour_b
    lab_a, lab_b = srgb_to_lab(tuple(first)), srgb_to_lab(tuple(second))
    return float(math.sqrt(sum((a - b) ** 2 for a, b in zip(lab_a, lab_b))))


def palette_delta_e(palette_a: list[str], palette_b: list[str]) -> dict[str, Any]:
    """Best-match ΔE per colour in the reference palette, plus the mean."""
    if not palette_a or not palette_b:
        raise ValueError("both palettes need at least one colour")
    best = [
        {
            "reference": colour,
            "closest": min(palette_b, key=lambda other: delta_e(colour, other)),
            "delta_e": round(min(delta_e(colour, other) for other in palette_b), 2),
        }
        for colour in palette_a
    ]
    return {
        "per_colour": best,
        "mean_delta_e": round(sum(item["delta_e"] for item in best) / len(best), 2),
        "note": "CIE76; below about 5 is a close match, above about 15 is a different family",
    }


def _local_mean(image: np.ndarray, radius: int = 2) -> np.ndarray:
    """A box blur, so subtracting it leaves the high-frequency structure (strokes, letters)."""
    total = np.zeros(np.shape(image), dtype=np.float64)
    count = 0
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            total += np.roll(np.roll(image, dy, 0), dx, 1)
            count += 1
    return total / count


def label_structure_retention(
    reference: np.ndarray,
    candidate: np.ndarray,
    mask: np.ndarray,
    *,
    radius: int = 2,
) -> dict[str, Any]:
    """How much of the *label* structure survived, inside the label mask. No OCR, no weights.

    GPU test 2 recorded why this exists next to edge IoU: edge IoU against the SVG raster rewards a
    low-denoise copy and punishes exactly the reference edits that look best, and it says nothing
    about whether a label is still readable ("you cannot overlay crisp SVG text on it without
    misalignment ... a label-OCR/text-legibility check would fit 'keeps the labels' better"). This is
    the dependency-free half of that: inside the mask, correlate the high-pass (the strokes) and
    compare the contrast of the two images, so a label that was blurred away, repainted, or shuffled
    scores low and a preserved one scores near 1.

    [unverified] It is a *proxy*: it cannot read a moved or misspelled label, and the human 1-5
    sheet stays the ground truth. `eval.legibility` adds the real OCR comparison when an engine is
    installed.
    """
    reference_gray = np.asarray(reference, dtype=np.float64)
    candidate_gray = np.asarray(candidate, dtype=np.float64)
    mask_bool = _as_bool(mask)
    if reference_gray.shape != candidate_gray.shape or reference_gray.shape != mask_bool.shape:
        raise ValueError(
            f"shape mismatch: reference {reference_gray.shape}, candidate {candidate_gray.shape}, mask {mask_bool.shape}"
        )
    pixels = int(mask_bool.sum())
    if pixels == 0:
        return {"score": 1.0, "pixels": 0, "correlation": 1.0, "contrast_ratio": 1.0, "note": "the label mask is empty"}

    reference_hp = (reference_gray - _local_mean(reference_gray, radius))[mask_bool]
    candidate_hp = (candidate_gray - _local_mean(candidate_gray, radius))[mask_bool]
    reference_spread = float(reference_hp.std())
    candidate_spread = float(candidate_hp.std())
    if reference_spread == 0 and candidate_spread == 0:
        correlation = 1.0
    elif reference_spread == 0 or candidate_spread == 0:
        correlation = 0.0
    else:
        correlation = float(np.corrcoef(reference_hp, candidate_hp)[0, 1])
        if math.isnan(correlation):
            correlation = 0.0

    reference_contrast = float(reference_gray[mask_bool].std())
    candidate_contrast = float(candidate_gray[mask_bool].std())
    contrast_ratio = 1.0 if reference_contrast == 0 else candidate_contrast / reference_contrast
    score = max(0.0, correlation) * min(1.0, contrast_ratio)
    return {
        "score": round(score, 4),
        "pixels": pixels,
        "correlation": round(correlation, 4),
        "contrast_ratio": round(contrast_ratio, 4),
        "note": "high-pass correlation x min(1, contrast ratio) inside the label mask; a proxy, not OCR",
    }


def clip_score(image: Any, caption: str, *, model: Any = None) -> dict[str, Any]:
    """Optional CLIP score. Returns `available: False` rather than failing when CLIP is absent."""
    if model is None:
        return {"available": False, "note": CLIP_NOTE}
    raise NotImplementedError("pass a loaded CLIP model; the M3 spike wires the real checkpoint")


def evaluate(
    reference: dict[str, np.ndarray],
    candidate: dict[str, np.ndarray],
    *,
    palette_a: list[str] | None = None,
    palette_b: list[str] | None = None,
    edge_tolerance: int = 1,
) -> dict[str, Any]:
    """One row of the sweep's CSV: every layout-fidelity number for one generated image."""
    report: dict[str, Any] = {
        "edge_iou": round(edge_iou(reference.get("canny"), candidate.get("canny"), tolerance=edge_tolerance), 4),
        "edge_iou_tolerance_0": round(edge_iou(reference.get("canny"), candidate.get("canny")), 4),
        "chamfer_px": round(chamfer_distance(reference.get("canny"), candidate.get("canny")), 3),
    }
    if reference.get("region") is not None and candidate.get("region") is not None:
        report["mask_iou"] = round(mask_iou(reference["region"], candidate["region"]), 4)
    label_mask = reference.get("label_mask")
    if label_mask is not None and candidate.get("gray") is not None and reference.get("gray") is not None:
        report["label_structure_retention"] = label_structure_retention(reference["gray"], candidate["gray"], label_mask)
    if palette_a and palette_b:
        report["palette"] = palette_delta_e(palette_a, palette_b)
    return report
