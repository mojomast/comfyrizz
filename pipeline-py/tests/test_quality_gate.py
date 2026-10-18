"""R1 section 1.7: the quality gate. Synthetic frames only - no GPU, no render, no Google Colab.

The synthetic stills are built the way research section 1.2 tells the agent to author the SVG (flat
value blocks, one semantic colour per region), because that is the property palette segmentation needs
and the reason the layout check can be done on CPU at all.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import pytest

from eval.gate import (
    THRESHOLDS,
    contrast_ratio,
    dominant_colours,
    element_box_report,
    evaluate_plate,
    evaluate_still,
    loop_seam,
    palette_report,
    probe_media,
    safe_zone_report,
    segment_palette,
    ssim,
    stationarity,
    stray_text_report,
)

FRAME = (96, 64)  # width, height
THEME = ["#0d0f14", "#6d8cff"]
ELEMENTS = [
    {"id": "panel", "bbox": (0, 0, 48, 64), "colour": "#0d0f14"},
    {"id": "block", "bbox": (48, 0, 48, 64), "colour": "#6d8cff"},
]
LABEL_ZONE = {"id": "lower_third", "bbox": (8, 40, 32, 16)}  # inside one flat block: a caption zone is quiet by construction


def svg_like_still(*, noisy: bool = False) -> np.ndarray:
    """A still authored the way the rules ask: two flat colour blocks, safe zone bottom band."""
    image = np.zeros((FRAME[1], FRAME[0], 3), dtype=np.float64)
    image[:, :48] = (13 / 255, 15 / 255, 20 / 255)
    image[:, 48:] = (109 / 255, 140 / 255, 1.0)
    if noisy:
        rng = np.random.default_rng(3)
        image = np.clip(image + rng.normal(0, 0.25, image.shape), 0, 1)
    return image


def test_ssim_is_one_for_the_same_frame_and_lower_for_a_shifted_one():
    image = svg_like_still()

    assert ssim(image, image) == pytest.approx(1.0, abs=1e-6)
    assert ssim(image, np.roll(image, 4, axis=1)) < 1.0
    with pytest.raises(ValueError):
        ssim(image, image[:, :32])
    with pytest.raises(ValueError):
        ssim(np.zeros((4, 4, 3)), np.zeros((4, 4, 3)))


def test_stationarity_flags_motion_inside_a_label_zone():
    first = svg_like_still()
    second = first.copy()
    second[40:48, 8:16] = 1.0  # a small patch moved inside the label zone, the rest of the frame did not
    mask = np.zeros((FRAME[1], FRAME[0]), dtype=bool)
    mask[40:48, 8:16] = True

    whole = stationarity([first, second])
    scoped = stationarity([first, second], mask=mask)

    assert whole["ok"] is True, whole
    assert scoped["ok"] is False, "a label zone that moves is exactly the GPU test 2 failure"
    assert scoped["scoped_to"] == "mask"
    assert stationarity([first, first])["worst"] == 0.0
    with pytest.raises(ValueError):
        stationarity([first])


def test_loop_seam_measures_the_join():
    first = svg_like_still()
    last = first.copy()
    last[:, 48:] = 0.0

    assert loop_seam([first, first])["ok"] is True
    assert loop_seam([first, last])["ok"] is False


def test_element_boxes_score_an_element_that_moved():
    image = svg_like_still()
    good = element_box_report(image, ELEMENTS)

    assert good["ok"] is True
    assert good["worst"] == 1.0
    assert [check["id"] for check in good["checks"]] == ["panel", "block"]

    moved = image.copy()
    moved[:, :48], moved[:, 48:] = image[:, 48:], image[:, :48]  # the two blocks swapped
    report = element_box_report(moved, ELEMENTS)

    assert report["ok"] is False
    assert all(check["iou"] == 0.0 for check in report["checks"]), report["checks"]

    # an element whose colour the model did not use at all scores zero and reports no box
    missing = element_box_report(image, [{"id": "ghost", "bbox": (0, 0, 10, 10), "colour": "#ff00ff"}])
    assert missing["checks"][0]["found_bbox"] is None
    assert missing["checks"][0]["iou"] == 0.0
    # an element without a colour cannot be segmented: it is reported as unchecked, not as passing
    unchecked = element_box_report(image, [{"id": "no_colour", "bbox": (0, 0, 10, 10)}])
    assert unchecked["unchecked"] == ["no_colour"]
    assert unchecked["ok"] is False


def test_segmentation_finds_the_flat_colour_blocks():
    masks = segment_palette(svg_like_still(), THEME)

    assert masks["#0d0f14"][:, :48].all() and not masks["#0d0f14"][:, 48:].any()
    assert masks["#6d8cff"][:, 48:].all() and not masks["#6d8cff"][:, :48].any()
    with pytest.raises(ValueError):
        segment_palette(svg_like_still(), [])


def test_palette_report_warns_when_the_model_invents_a_palette():
    on_theme = palette_report(svg_like_still(), THEME)

    assert on_theme["ok"] is True, on_theme["dominant"]
    assert on_theme["worst_delta_e"] <= THRESHOLDS["palette_delta_e"]
    assert on_theme["dominant"][0]["nearest_theme"] in THEME

    invented = np.zeros((FRAME[1], FRAME[0], 3))
    invented[:, :] = (1.0, 0.0, 0.0)  # nothing like the theme
    off_theme = palette_report(invented, THEME)

    assert off_theme["ok"] is False
    assert off_theme["worst_delta_e"] > THRESHOLDS["palette_delta_e"]
    with pytest.raises(ValueError):
        palette_report(svg_like_still(), [])


def test_dominant_colours_are_deterministic():
    first = dominant_colours(svg_like_still())
    second = dominant_colours(svg_like_still())

    assert first == second
    assert sum(share for _, share in first) == pytest.approx(1.0, abs=1e-6)


def test_safe_zone_report_catches_a_busy_zone_and_checks_wcag_contrast():
    quiet = safe_zone_report(svg_like_still(), [LABEL_ZONE], text_colour="#ffffff")

    assert quiet["ok"] is True, quiet["checks"]
    assert quiet["checks"][0]["contrast"] >= THRESHOLDS["safe_zone_contrast"]

    busy_image = svg_like_still()
    checker = np.indices((16, 32)).sum(axis=0) % 2
    busy_image[40:56, 8:40] = checker[:, :, None]
    busy = safe_zone_report(busy_image, [LABEL_ZONE], text_colour="#ffffff")

    assert busy["ok"] is False
    assert busy["checks"][0]["edge_density"] > THRESHOLDS["safe_zone_edge_density"]

    unreadable = safe_zone_report(svg_like_still(), [LABEL_ZONE], text_colour="#0d0f14")
    assert unreadable["ok"] is False, "dark text on the dark block is the N13 class of bug"

    outside = safe_zone_report(svg_like_still(), [{"id": "off", "bbox": (200, 200, 10, 10)}])
    assert outside["checks"][0]["ok"] is False


def test_contrast_ratio_matches_the_wcag_reference():
    assert contrast_ratio((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)) == pytest.approx(21.0, abs=0.01)
    assert contrast_ratio((0.5, 0.5, 0.5), (0.5, 0.5, 0.5)) == pytest.approx(1.0, abs=1e-6)


def test_probe_media_is_honest_about_what_it_could_not_do():
    def no_ffprobe(*_args, **_kwargs):
        raise FileNotFoundError("ffprobe")

    skipped = probe_media("/nope.mp4", run=no_ffprobe)

    assert skipped["status"] == "skipped" and skipped["ok"] is None
    assert "ffprobe" in skipped["detail"]

    def failing(*_args, **_kwargs):
        return subprocess.CompletedProcess([], 1, "", "moov atom not found")

    failed = probe_media("/nope.mp4", run=failing)

    assert failed["ok"] is False and "moov atom" in failed["detail"]


def test_probe_media_reads_a_real_file_when_one_is_there():
    candidates = sorted(Path("/home/box/comfyrizz/examples").glob("*/out/*.mp4"))
    if not candidates:
        pytest.skip("no rendered example mp4 in the tree to probe")
    report = probe_media(str(candidates[0]))

    assert report["status"] == "ran", report
    assert report["width"] > 0 and report["height"] > 0


def test_evaluate_still_aggregates_and_keeps_skipped_checks_visible():
    report = evaluate_still(
        svg_like_still(),
        elements=ELEMENTS,
        theme_palette=THEME,
        safe_zones=[LABEL_ZONE],
        text_colour="#ffffff",
        media={"status": "ran", "width": 96, "height": 64},
        planned_dims={"width": 96, "height": 64},
    )

    assert report["ok"] is True, [check for check in report["checks"] if not check["ok"]]
    assert report["score"] == pytest.approx(1.0)
    assert "stray_text" in report["skipped"], "the OCR check must be visible as skipped, never as a pass"

    wrong_dims = evaluate_still(svg_like_still(), media={"status": "ran", "width": 32, "height": 32}, planned_dims={"width": 96, "height": 64})
    assert wrong_dims["ok"] is False, "GPU test 3 N4: the plan's dims are not the file's dims"


def test_evaluate_plate_combines_dims_first_frame_and_stationarity():
    source = svg_like_still()
    frames = [source.copy() for _ in range(4)]
    media = {"status": "ran", "width": 96, "height": 64, "frames": 97, "codec": "h264"}

    good = evaluate_plate(frames, source=source, planned_dims={"width": 96, "height": 64}, planned_frames=97, media=media, loops=True)

    assert good["ok"] is True, [check for check in good["checks"] if not check["ok"]]
    assert {check["id"] for check in good["checks"]} == {"media_dims", "first_frame_ssim", "stationarity", "loop_seam"}

    # a push-in: every frame moves, so the file's own size is right but the frame is not still
    pushed = [np.roll(source, index * 6, axis=1) for index in range(4)]
    drifting = evaluate_plate(pushed, source=source, planned_dims={"width": 96, "height": 64}, planned_frames=97, media=media)

    assert drifting["ok"] is False
    assert drifting["checks"][0]["ok"] is True, "the dims are fine: it is the motion that fails"

    # a plate that came back at the wrong size (N4) fails on the file, not on the motion
    wrong = evaluate_plate(frames, source=source, planned_dims={"width": 96, "height": 64}, media={**media, "width": 48})

    assert wrong["ok"] is False
    assert wrong["checks"][0]["ok"] is False


def test_stray_text_reports_skipped_without_an_ocr_backend():
    report = stray_text_report("/tmp/whatever.png")

    assert report["code"] == "GATE_STRAY_TEXT"
    assert report["status"] in {"skipped", "ran"}
    if report["status"] == "skipped":
        assert report["ok"] is None
        assert "OCR" in report["detail"]
