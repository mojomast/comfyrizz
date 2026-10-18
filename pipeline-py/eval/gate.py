"""R1 (research section 1.7): the automatic quality gate for generated stills and plates.

The gate is what makes "the model did what the plan asked" checkable without a human eye, and every
check in it was chosen because a naive one failed:

* **Not global edge IoU.** GPU test 2 measured edge IoU 0.88 for a denoise-0.45 no-op edit against
  0.30 for the best real reference edit, so a global edge score rewards doing nothing. The gate scores
  each SVG element separately: its region in the output (found by palette segmentation, because the
  SVGs are colour-coded) against the SVG bbox it came from, box IoU, accept 0.5.
* **Palette ΔE2000 of the dominant colours** against the theme hexes, warn above about 15: that is
  the cheap detector for "the model invented its own colour scheme".
* **Text-safe zones are measured, not trusted**: edge density and luminance variance inside the rects
  the renderer will overlay, plus the WCAG contrast of the planned text colour against the zone.
* **OCR is optional and says so.** `eval.legibility` reports whether an OCR backend exists; without
  one the stray-text check comes back as `skipped`, never as a pass.

CPU only: numpy, no GPU, no network, no Google Colab. Plates are checked with the per-plate helpers
(`ssim`, `stationarity`, `loop_seam`, `probe_media`), which are in `gate.py` next to the still checks.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import numpy as np

from .metrics import delta_e, hex_to_rgb, palette_delta_e, srgb_to_lab

GATE_VERSION = "0.1.0"

#: The thresholds the report is judged against, in one place so a plan can cite them.
THRESHOLDS = {
    "box_iou": 0.5,
    "palette_delta_e": 15.0,
    "dominant_colours": 5,
    "safe_zone_edge_density": 0.12,
    "safe_zone_luminance_std": 0.12,
    "safe_zone_contrast": 4.5,
    "first_frame_ssim": 0.85,
    "stationarity_max_delta": 0.02,
    "loop_seam_max_delta": 0.03,
}


def _rgb(image: Any) -> np.ndarray:
    """A float RGB image in 0..1, from whatever the caller has (uint8, float, HxWx3/4)."""
    array = np.asarray(image, dtype=np.float64)
    if array.ndim == 2:
        array = np.repeat(array[:, :, None], 3, axis=2)
    if array.ndim != 3 or array.shape[2] < 3:
        raise ValueError(f"expected an HxWx3 (or HxWx4) image, got shape {np.shape(image)}")
    array = array[:, :, :3]
    if array.max() > 1.0 + 1e-9:
        array = array / 255.0
    return np.clip(array, 0.0, 1.0)


def _lab(image: Any) -> np.ndarray:
    """The image in CIE Lab, so colour distance means what ΔE says it means.

    The same maths as `eval.metrics.srgb_to_lab` (0.04045 linearisation, D65), vectorised: a still is
    ~600k pixels and a per-pixel Python call is seconds of wall clock for no reason.
    """
    rgb = _rgb(image)
    linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    red, green, blue = (linear[:, :, index] for index in range(3))
    x = red * 0.4124 + green * 0.3576 + blue * 0.1805
    y = red * 0.2126 + green * 0.7152 + blue * 0.0722
    z = red * 0.0193 + green * 0.1192 + blue * 0.9505
    xn, yn, zn = 0.95047, 1.0, 1.08883

    def f(value: np.ndarray) -> np.ndarray:
        return np.where(value > 0.008856, np.cbrt(value), 7.787 * value + 16 / 116)

    fx, fy, fz = f(x / xn), f(y / yn), f(z / zn)
    return np.stack([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)], axis=2)


def _hex_to_rgb(colour: str) -> tuple[float, float, float]:
    text = str(colour).strip().lstrip("#")
    if len(text) == 3:
        text = "".join(character * 2 for character in text)
    if len(text) != 6:
        raise ValueError(f"expected a hex colour, got {colour!r}")
    return tuple(int(text[index : index + 2], 16) / 255.0 for index in (0, 2, 4))


def _rgb01(colour: Any) -> tuple[float, float, float]:
    """A colour as 0..1 floats: a hex string (`#0d0f14`), or a triple in 0..1 or 0-255."""
    if isinstance(colour, str):
        return tuple(channel / 255.0 for channel in hex_to_rgb(colour))
    triple = np.asarray(colour, dtype=np.float64).reshape(-1)[:3]
    if triple.size != 3:
        raise ValueError(f"expected a hex colour or an RGB triple, got {colour!r}")
    if triple.max() > 1.0 + 1e-9:
        triple = triple / 255.0
    return tuple(float(np.clip(value, 0.0, 1.0)) for value in triple)


def relative_luminance(colour: Any) -> float:
    """WCAG relative luminance (sRGB linearisation included)."""
    red, green, blue = (
        value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in _rgb01(colour)
    )
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(colour_a: Any, colour_b: Any) -> float:
    """WCAG contrast ratio, 1.0 (identical) to 21.0 (black on white)."""
    first, second = relative_luminance(colour_a), relative_luminance(colour_b)
    lighter, darker = max(first, second), min(first, second)
    return (lighter + 0.05) / (darker + 0.05)


def segment_palette(image: Any, palette: list[str], *, tolerance: float = 30.0) -> dict[str, np.ndarray]:
    """A boolean mask per palette colour: every pixel nearest to that colour within `tolerance` ΔE.

    The SVGs are authored with one flat value block per region (research section 1.2) exactly so this
    works: segmentation is the cheap stand-in for a detector.
    """
    lab = _lab(image)
    palette_lab = [srgb_to_lab(hex_to_rgb(colour)) for colour in palette]
    if not palette_lab:
        raise ValueError("segmentation needs at least one palette colour")
    flat = lab.reshape(-1, 3)
    distances = np.stack([np.linalg.norm(flat - np.array(entry), axis=1) for entry in palette_lab], axis=1)
    nearest = np.argmin(distances, axis=1)
    closest = distances[np.arange(distances.shape[0]), nearest]
    masks = {}
    for index, colour in enumerate(palette):
        mask = (nearest == index) & (closest <= tolerance)
        masks[colour] = mask.reshape(lab.shape[0], lab.shape[1])
    return masks


def _iou_box(box_a: tuple[int, int, int, int], box_b: tuple[int, int, int, int]) -> float:
    """IoU of two pixel boxes, (x, y, width, height)."""
    ax, ay, aw, ah = box_a
    bx, by, bw, bh = box_b
    left, top = max(ax, bx), max(ay, by)
    right, bottom = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if right <= left or bottom <= top:
        return 0.0
    intersection = (right - left) * (bottom - top)
    union = aw * ah + bw * bh - intersection
    return float(intersection / union) if union > 0 else 0.0


def _mask_box(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    rows = np.flatnonzero(mask.any(axis=1))
    columns = np.flatnonzero(mask.any(axis=0))
    if rows.size == 0 or columns.size == 0:
        return None
    return (int(columns[0]), int(rows[0]), int(columns[-1] - columns[0] + 1), int(rows[-1] - rows[0] + 1))


def element_box_report(
    image: Any,
    elements: list[dict],
    *,
    tolerance: float = 30.0,
    threshold: float = THRESHOLDS["box_iou"],
) -> dict[str, Any]:
    """Per-element layout fidelity: where each SVG element ended up, and its box IoU against the SVG.

    Each element needs `id`, `bbox` (x, y, w, h in pixels) and `colour` (the flat colour the SVG gave
    it). An element whose colour cannot be found in the output scores 0 and says so, which is the
    signal a global edge score cannot give.
    """
    prepared = [element for element in elements if isinstance(element, dict) and element.get("bbox") and element.get("colour")]
    palette = [str(element["colour"]) for element in prepared]
    masks = segment_palette(image, palette, tolerance=tolerance) if palette else {}
    checks = []
    for element in prepared:
        expected = tuple(int(round(value)) for value in element["bbox"])
        mask = masks.get(str(element["colour"]))
        found = _mask_box(mask) if mask is not None else None
        iou = _iou_box(expected, found) if found else 0.0
        checks.append(
            {
                "id": str(element["id"]),
                "code": "GATE_ELEMENT_IOU",
                "expected_bbox": list(expected),
                "found_bbox": list(found) if found else None,
                "iou": round(iou, 4),
                "ok": iou >= threshold,
                "threshold": threshold,
            }
        )
    missing = [str(element.get("id")) for element in elements if not (isinstance(element, dict) and element.get("bbox") and element.get("colour"))]
    return {
        "checks": checks,
        "unchecked": missing,
        "worst": min((check["iou"] for check in checks), default=None),
        "ok": bool(checks) and all(check["ok"] for check in checks),
    }


def dominant_colours(image: Any, *, count: int = THRESHOLDS["dominant_colours"], sample: int = 20000, seed: int = 7) -> list[tuple[str, float]]:
    """The top `count` colours by share, as hex, from a seeded k-means on a subsample.

    k-means rather than a histogram because a rendered still has gradients; the seed makes the result
    reproducible, which is what a gate needs.
    """
    rgb = _rgb(image).reshape(-1, 3)
    if rgb.shape[0] > sample:
        step = rgb.shape[0] // sample
        rgb = rgb[::step][:sample]
    k = max(1, min(count, rgb.shape[0]))
    rng = np.random.default_rng(seed)
    centres = rgb[rng.choice(rgb.shape[0], size=k, replace=False)].copy()
    labels = np.zeros(rgb.shape[0], dtype=int)
    for _ in range(20):
        distances = np.linalg.norm(rgb[:, None, :] - centres[None, :, :], axis=2)
        labels = np.argmin(distances, axis=1)
        for index in range(k):
            members = rgb[labels == index]
            if members.size:
                centres[index] = members.mean(axis=0)
    shares = [(centres[index], float((labels == index).mean())) for index in range(k)]
    shares.sort(key=lambda item: item[1], reverse=True)
    return [("#" + "".join(f"{int(round(channel * 255)):02x}" for channel in centre), share) for centre, share in shares]


def palette_report(image: Any, theme_palette: list[str], *, warn_above: float = THRESHOLDS["palette_delta_e"]) -> dict[str, Any]:
    """ΔE2000 of the still's dominant colours against the theme, the cheapest style-drift detector."""
    dominant = dominant_colours(image)
    if not theme_palette:
        raise ValueError("a palette report needs the theme palette")
    pairs = []
    for colour, share in dominant:
        nearest = min(((delta_e(colour, theme), theme) for theme in theme_palette), key=lambda item: item[0])
        pairs.append({"colour": colour, "share": round(share, 4), "nearest_theme": nearest[1], "delta_e": round(float(nearest[0]), 2)})
    worst = max((pair["delta_e"] for pair in pairs), default=0.0)
    return {
        "dominant": pairs,
        "worst_delta_e": worst,
        "threshold": warn_above,
        "ok": worst <= warn_above,
        "theme": list(theme_palette),
        "summary": {key: value for key, value in palette_delta_e([pair["colour"] for pair in pairs], list(theme_palette)).items()},
    }


def safe_zone_report(image: Any, zones: list[dict], *, text_colour: str | None = None) -> dict[str, Any]:
    """Is an overlaid caption going to be readable? `zones` are `{id, bbox}` pixel rects.

    Edge density and luminance spread inside the rect are the two things that make text hard to read;
    the WCAG contrast of the planned text colour against the zone's mean is the third.
    """
    rgb = _rgb(image)
    gray = rgb @ np.array([0.2126, 0.7152, 0.0722])
    checks = []
    for zone in zones:
        x, y, width, height = (int(round(value)) for value in zone["bbox"])
        x, y = max(0, x), max(0, y)
        patch = gray[y : y + height, x : x + width]
        if patch.size == 0:
            checks.append({"id": str(zone.get("id")), "code": "GATE_SAFE_ZONE_MISSING", "ok": False, "detail": "the safe zone is outside the frame"})
            continue
        gradient_y, gradient_x = np.gradient(patch)
        edge_density = float(np.mean(np.hypot(gradient_x, gradient_y)))
        spread = float(np.std(patch))
        mean = float(np.mean(patch))
        detail = {
            "edge_density": round(edge_density, 4),
            "luminance_std": round(spread, 4),
            "mean_luminance": round(mean, 4),
            "edge_limit": THRESHOLDS["safe_zone_edge_density"],
            "spread_limit": THRESHOLDS["safe_zone_luminance_std"],
        }
        ok = edge_density <= THRESHOLDS["safe_zone_edge_density"] and spread <= THRESHOLDS["safe_zone_luminance_std"]
        if text_colour:
            ratio = float(contrast_ratio(text_colour, np.array([mean, mean, mean])))
            detail["contrast"] = round(ratio, 2)
            detail["contrast_limit"] = THRESHOLDS["safe_zone_contrast"]
            ok = ok and ratio >= THRESHOLDS["safe_zone_contrast"]
        checks.append({"id": str(zone.get("id")), "code": "GATE_SAFE_ZONE_QUIET", "ok": ok, **detail})
    return {"checks": checks, "ok": bool(checks) and all(check["ok"] for check in checks)}


def stray_text_report(image_path: str | None = None) -> dict[str, Any]:
    """The OCR stray-text check, which is honest about not being available.

    `eval.legibility` owns the OCR backends; without one installed this comes back `skipped` with the
    reason, never as a pass.
    """
    from .legibility import ocr_available, ocr_engines

    engines = ocr_engines()
    if not ocr_available():
        return {
            "id": "stray_text",
            "code": "GATE_STRAY_TEXT",
            "status": "skipped",
            "ok": None,
            "detail": f"no OCR backend installed (looked for {', '.join(sorted(engines))}); the stray-text check needs pytesseract or paddleocr",
        }
    if image_path is None:
        return {"id": "stray_text", "code": "GATE_STRAY_TEXT", "status": "skipped", "ok": None, "detail": "no image path was given"}
    return {
        "id": "stray_text",
        "code": "GATE_STRAY_TEXT",
        "status": "ran",
        "ok": None,
        "detail": f"OCR backend available ({', '.join(name for name, present in engines.items() if present)}); read the labels with eval.legibility.check_labels",
        "image": str(image_path),
    }

# --- plates (research section 1.7, per-plate) -----------------------------------------------------

def _gray(image: Any) -> np.ndarray:
    return _rgb(image) @ np.array([0.2126, 0.7152, 0.0722])


def _gaussian_kernel(size: int = 11, sigma: float = 1.5) -> np.ndarray:
    offsets = np.arange(size) - (size - 1) / 2
    kernel = np.exp(-(offsets**2) / (2 * sigma**2))
    return kernel / kernel.sum()


def ssim(image_a: Any, image_b: Any, *, size: int = 11, sigma: float = 1.5) -> float:
    """Mean SSIM between two images, windowed the standard way (the gate's first-frame check).

    Written out rather than imported: scikit-image is not a dependency of this package, and the check
    only needs the luminance term at a fixed window.
    """
    first = np.asarray(_gray(image_a), dtype=np.float64)
    second = np.asarray(_gray(image_b), dtype=np.float64)
    if first.shape != second.shape:
        raise ValueError(f"SSIM needs two frames of the same shape, got {first.shape} and {second.shape}")
    if min(first.shape) < size:
        raise ValueError(f"SSIM needs frames of at least {size}x{size} pixels, got {first.shape}")
    kernel = _gaussian_kernel(size, sigma)

    def blur(array: np.ndarray) -> np.ndarray:
        window = np.lib.stride_tricks.sliding_window_view(array, size, axis=0)
        rows = np.tensordot(window, kernel, axes=([-1], [0]))
        window = np.lib.stride_tricks.sliding_window_view(rows, size, axis=1)
        return np.tensordot(window, kernel, axes=([-1], [0]))

    mean_a, mean_b = blur(first), blur(second)
    variance_a = blur(first * first) - mean_a**2
    variance_b = blur(second * second) - mean_b**2
    covariance = blur(first * second) - mean_a * mean_b
    c1, c2 = (0.01 * 1.0) ** 2, (0.03 * 1.0) ** 2
    numerator = (2 * mean_a * mean_b + c1) * (2 * covariance + c2)
    denominator = (mean_a**2 + mean_b**2 + c1) * (variance_a + variance_b + c2)
    return float(np.mean(numerator / denominator))


def frame_delta(frame_a: Any, frame_b: Any, *, mask: Any = None) -> float:
    """Mean absolute luminance difference between two frames, optionally inside a mask."""
    difference = np.abs(_gray(frame_a) - _gray(frame_b))
    if mask is not None:
        mask_bool = np.asarray(mask).astype(bool)
        if mask_bool.shape != difference.shape:
            raise ValueError(f"the mask must match the frame shape, got {mask_bool.shape} and {difference.shape}")
        if not mask_bool.any():
            raise ValueError("the mask selects no pixels")
        difference = difference[mask_bool]
    return float(np.mean(difference))


def stationarity(frames: list, *, mask: Any = None, threshold: float = THRESHOLDS["stationarity_max_delta"]) -> dict[str, Any]:
    """How still a plate is: the largest consecutive-frame difference, optionally inside a label zone.

    This is the check that catches a push-in the prompt did not ask for: the camera move shows up as a
    large mean difference across the whole frame, and as a large one inside a label zone even when the
    move is subtle.
    """
    if len(frames) < 2:
        raise ValueError("stationarity needs at least two frames")
    deltas = [round(frame_delta(frames[index - 1], frames[index], mask=mask), 4) for index in range(1, len(frames))]
    worst = max(deltas)
    return {
        "id": "stationarity",
        "code": "GATE_PLATE_STATIONARITY",
        "deltas": deltas,
        "worst": worst,
        "threshold": threshold,
        "ok": worst <= threshold,
        "scoped_to": "mask" if mask is not None else "frame",
    }


def loop_seam(frames: list, *, threshold: float = THRESHOLDS["loop_seam_max_delta"]) -> dict[str, Any]:
    """The first-to-last frame difference: how visible a loop's join is."""
    if len(frames) < 2:
        raise ValueError("a loop seam needs at least two frames")
    delta = round(frame_delta(frames[0], frames[-1]), 4)
    return {"id": "loop_seam", "code": "GATE_PLATE_LOOP_SEAM", "delta": delta, "threshold": threshold, "ok": delta <= threshold}


def probe_media(path: str, *, run: Any = subprocess.run) -> dict[str, Any]:
    """ffprobe a file: width, height, frames, codec. Honest when ffprobe is not there.

    The plan's dims and frame count are what a real run has to be checked against (GPU test 3, N3 and
    N4: a plate came back as one PNG per frame, and a still at a different size than the plan).
    """
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_frames",
        "-show_entries",
        "stream=width,height,nb_read_frames,codec_name,nb_frames",
        "-of",
        "json",
        str(path),
    ]
    try:
        completed = run(command, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return {"id": "probe", "code": "GATE_PROBE_NO_FFPROBE", "status": "skipped", "ok": None, "detail": "ffprobe is not installed"}
    if completed.returncode != 0:
        return {
            "id": "probe",
            "code": "GATE_PROBE_FAILED",
            "status": "ran",
            "ok": False,
            "detail": (completed.stderr or "").strip()[:400],
        }
    stream = (json.loads(completed.stdout or "{}").get("streams") or [{}])[0]
    frames = stream.get("nb_read_frames") or stream.get("nb_frames")
    return {
        "id": "probe",
        "code": "GATE_PROBE",
        "status": "ran",
        "ok": True,
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "frames": int(frames) if frames not in (None, "N/A") else None,
        "codec": stream.get("codec_name"),
    }


def evaluate_plate(
    frames: list,
    *,
    source: Any = None,
    planned_dims: dict | None = None,
    planned_frames: int | None = None,
    label_mask: Any = None,
    media: dict | None = None,
    loops: bool = False,
) -> dict[str, Any]:
    """The per-plate report: what the file is, how still it stayed, and whether it loops cleanly."""
    checks: list[dict[str, Any]] = []
    if media is not None and media.get("status") == "ran":
        dims_ok = True
        if planned_dims:
            dims_ok = media["width"] == int(planned_dims.get("width")) and media["height"] == int(planned_dims.get("height"))
        frames_ok = planned_frames is None or media["frames"] == int(planned_frames)
        checks.append(
            {
                "id": "media_dims",
                "code": "GATE_PLATE_DIMS",
                "ok": bool(dims_ok and frames_ok),
                "width": media["width"],
                "height": media["height"],
                "frames": media["frames"],
                "planned_dims": planned_dims,
                "planned_frames": planned_frames,
                "codec": media.get("codec"),
            }
        )
    elif media is not None:
        checks.append({"id": "media_dims", "code": media.get("code", "GATE_PROBE"), "status": media.get("status"), "ok": None, "detail": media.get("detail")})
    if source is not None and frames:
        value = round(ssim(frames[0], source), 4)
        checks.append(
            {
                "id": "first_frame_ssim",
                "code": "GATE_PLATE_FIRST_FRAME",
                "ssim": value,
                "threshold": THRESHOLDS["first_frame_ssim"],
                "ok": value >= THRESHOLDS["first_frame_ssim"],
            }
        )
    if len(frames) > 1:
        checks.append(stationarity(frames, mask=label_mask))
    if loops and len(frames) > 1:
        checks.append(loop_seam(frames))
    judged = [check for check in checks if check.get("ok") is not None]
    return {
        "gate": GATE_VERSION,
        "kind": "plate",
        "checks": checks,
        "skipped": [check["id"] for check in checks if check.get("ok") is None],
        "ok": bool(judged) and all(check["ok"] for check in judged),
        "score": round(sum(1 for check in judged if check["ok"]) / len(judged), 4) if judged else None,
    }


def evaluate_still(
    image: Any,
    *,
    elements: list[dict] | None = None,
    theme_palette: list[str] | None = None,
    safe_zones: list[dict] | None = None,
    text_colour: str | None = None,
    image_path: str | None = None,
    media: dict | None = None,
    planned_dims: dict | None = None,
) -> dict[str, Any]:
    """The per-still report: layout fidelity, palette drift, safe-zone quietness and stray text."""
    checks: list[dict[str, Any]] = []
    if elements:
        element_report = element_box_report(image, elements)
        checks.extend(element_report["checks"])
    if theme_palette:
        palette = palette_report(image, theme_palette)
        checks.append(
            {
                "id": "palette",
                "code": "GATE_PALETTE_DRIFT",
                "ok": palette["ok"],
                "worst_delta_e": palette["worst_delta_e"],
                "threshold": palette["threshold"],
                "dominant": palette["dominant"],
            }
        )
    if safe_zones:
        zone_report = safe_zone_report(image, safe_zones, text_colour=text_colour)
        checks.extend(zone_report["checks"])
    if media is not None:
        dimensions_ok = media.get("status") == "ran" and (
            not planned_dims or (media["width"] == int(planned_dims.get("width")) and media["height"] == int(planned_dims.get("height")))
        )
        checks.append(
            {
                "id": "media_dims",
                "code": "GATE_STILL_DIMS",
                "ok": bool(dimensions_ok),
                "width": media.get("width"),
                "height": media.get("height"),
                "planned_dims": planned_dims,
                "detail": media.get("detail"),
            }
        )
    stray = stray_text_report(image_path)
    checks.append(stray)
    judged = [check for check in checks if check.get("ok") is not None]
    return {
        "gate": GATE_VERSION,
        "kind": "still",
        "checks": checks,
        "skipped": [check["id"] for check in checks if check.get("ok") is None],
        "ok": bool(judged) and all(check["ok"] for check in judged),
        "score": round(sum(1 for check in judged if check["ok"]) / len(judged), 4) if judged else None,
    }

#: What a run's assets are checked against, per asset kind.
RUN_SUFFIXES = {
    "still": (".png", ".jpg", ".jpeg", ".webp"),
    "plate": (".mp4", ".mov", ".webm", ".mkv"),
}


def load_rgb(path: str | Path) -> np.ndarray:
    """A still as an RGB array. PIL only - the gate never needs a GPU or a model."""
    from PIL import Image  # noqa: PLC0415 - only the still path needs PIL

    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"))


def _asset_kind(asset: dict) -> str:
    kind = str(asset.get("kind") or "")
    file = str(asset.get("file") or "")
    if kind in ("video", "plate"):
        return "plate"
    if any(file.lower().endswith(suffix) for suffix in RUN_SUFFIXES["plate"]):
        return "plate"
    return "still"


def evaluate_run(
    package: dict,
    *,
    package_dir: str | Path | None = None,
    out_dir: str | Path | None = None,
    elements: dict | None = None,
    safe_zones: dict | None = None,
    frames: dict | None = None,
    probe: Any = probe_media,
    loader: Any = load_rgb,
) -> dict[str, Any]:
    """Judge the assets a package says it produced (R1, research section 1.7).

    This is the entry point the run path calls: `evaluate_still` and `evaluate_plate` judge one image
    or one plate at a time, and this walks the package, finds each asset's file, and reports per asset.
    A file that is not there is a failure with its own code - a package that claims an asset it cannot
    show is the one thing a quality gate must never pass silently.

    CPU only: numpy and PIL. `frames` (asset id -> decoded plate frames) is optional; without it a
    plate is still checked for its measured dimensions and length, and says the motion checks were
    skipped rather than pretending they passed.
    """
    base = Path(out_dir) if out_dir is not None else (Path(package_dir) if package_dir is not None else Path("."))
    theme = package.get("theme") or {}
    palette = [str(colour) for colour in (theme.get("palette") or [])]
    fmt = package.get("format") or {}
    planned_dims = {"width": int(fmt.get("width") or 0), "height": int(fmt.get("height") or 0)} or None

    reports: dict[str, Any] = {}
    failures: list[dict[str, Any]] = []
    for asset_id, asset in (package.get("assets") or {}).items():
        asset = asset or {}
        relative = asset.get("file")
        if not relative:
            reports[asset_id] = {
                "asset": asset_id,
                "kind": _asset_kind(asset),
                "status": "no-file",
                "ok": None,
                "detail": "the asset names no file, so there is nothing to judge",
            }
            continue
        path = base / str(relative)
        if str(relative).lower().endswith(".svg"):
            # an SVG is the *source* the renderers were given (and the reference the still is compared
            # with), not something this gate judges: raster fidelity is checked against its boxes, which
            # the caller passes in `elements`.
            reports[asset_id] = {
                "asset": asset_id,
                "kind": "source",
                "status": "source",
                "file": str(path),
                "ok": None,
                "detail": "an SVG is the source artwork; the gate judges the render, not the source",
            }
            continue
        if not path.is_file():
            reports[asset_id] = {
                "asset": asset_id,
                "kind": _asset_kind(asset),
                "status": "missing",
                "ok": False,
                "code": "GATE_ASSET_MISSING",
                "path": str(path),
                "detail": "the package names this file but it is not here",
            }
            failures.append({"asset": asset_id, "code": "GATE_ASSET_MISSING", "path": str(path)})
            continue

        kind = _asset_kind(asset)
        media = probe(str(path))
        if kind == "plate":
            planned_frames = asset.get("media", {}).get("frames") or asset.get("plannedFrames")
            report = evaluate_plate(
                list((frames or {}).get(asset_id) or ()),
                media=media,
                planned_dims=planned_dims,
                planned_frames=planned_frames,
                loops=bool(asset.get("loops")),
            )
        else:
            report = evaluate_still(
                loader(path),
                elements=(elements or {}).get(asset_id),
                theme_palette=palette or None,
                safe_zones=(safe_zones or {}).get(asset_id),
                image_path=str(path),
                media=media,
                planned_dims=planned_dims,
            )
        report = {**report, "asset": asset_id, "path": str(path), "status": "ran"}
        reports[asset_id] = report
        for check in report.get("checks", []):
            if check.get("ok") is False:
                failures.append({"asset": asset_id, "code": check.get("code"), "check": check.get("id"), "detail": check.get("detail")})

    judged = [report for report in reports.values() if report.get("ok") is not None]
    return {
        "gate": GATE_VERSION,
        "package": package.get("id"),
        "base": str(base),
        "assets": reports,
        "failures": failures,
        "judged": len(judged),
        "ok": bool(judged) and all(report["ok"] for report in judged) and not any(report.get("status") == "missing" for report in reports.values()),
    }


def main(argv: list[str] | None = None) -> int:
    """`python -m eval.gate --package <package.json> [--out <dir>] [--package-dir <dir>] [--json]`."""
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(prog="eval.gate", description="judge the assets a package produced (research 1.7)")
    parser.add_argument("--package", required=True, help="the applied package (the one that names the produced files)")
    parser.add_argument("--out", default=None, help="the run's output directory, when the assets are not next to the package")
    parser.add_argument("--package-dir", default=None, help="where the package's relative asset paths resolve")
    parser.add_argument("--json", action="store_true", help="print the whole report as JSON")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    package_path = Path(args.package)
    document = json.loads(package_path.read_text(encoding="utf-8"))
    report = evaluate_run(document, package_dir=args.package_dir or package_path.parent, out_dir=args.out)

    if args.json:
        print(json.dumps(report, indent=1))
    elif not args.quiet:
        for asset_id, asset_report in report["assets"].items():
            state = "ok" if asset_report.get("ok") else asset_report.get("status", "failed")
            print(f"{asset_id}: {state}")
        for failure in report["failures"]:
            print(f"  {failure['asset']} {failure.get('code')}: {failure.get('detail') or failure.get('check')}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
