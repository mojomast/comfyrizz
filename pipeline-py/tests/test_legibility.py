"""H-fix4 acceptance: the label-legibility check, on CPU, with no OCR dependency required.

GPU test 2 (E1 caveat): edge IoU rewards a low-denoise near-copy and punishes the reference edits
that look best, and it says nothing about whether a label is still readable. Two halves are tested
here: the dependency-free pixel-side retention score (`eval.metrics.label_structure_retention`) on
fixture images and on a real resvg raster, and the readable-text comparison plus OCR interface in
`eval.legibility` (a stub engine stands in for tesseract, which this box does not have).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from eval.legibility import (
    OCR_INSTALL_NOTE,
    check_labels,
    label_legibility,
    main,
    observed_tokens,
    ocr_available,
    ocr_engines,
    read_labels,
)
from eval.metrics import evaluate, label_structure_retention
from svgguide.controlmaps import load_rgba, region_mask, to_gray
from svgguide.paths import VECTOR_NODE_MODULES
from svgguide.raster import rasterize

HAVE_RESVG = bool(shutil.which("node")) and (VECTOR_NODE_MODULES / "@resvg" / "resvg-js" / "index.js").is_file()
needs_resvg = pytest.mark.skipif(not HAVE_RESVG, reason="node + resvg-js (packages/vector) are required to rasterise")


# --------------------------------------------------------------------------- fixture images
def label_fixture(*, size: int = 64) -> tuple[np.ndarray, np.ndarray]:
    """A dark frame with a bright "word" band: vertical strokes, and the mask that covers them."""
    frame = np.zeros((size, size), dtype=np.float64)
    mask = np.zeros((size, size), dtype=bool)
    for stroke in range(6, size - 6, 5):
        frame[size // 3 : 2 * size // 3, stroke : stroke + 2] = 0.95
    mask[size // 3 - 2 : 2 * size // 3 + 2, 4 : size - 4] = True
    return frame, mask


def _blur(image: np.ndarray, radius: int = 4) -> np.ndarray:
    total = np.zeros_like(image, dtype=np.float64)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            total += np.roll(np.roll(image, dy, 0), dx, 1)
    return total / ((2 * radius + 1) ** 2)


# ------------------------------------------------------------------- pixel-side retention score
def test_a_preserved_label_scores_one_and_a_lost_one_scores_much_lower():
    frame, mask = label_fixture()
    assert label_structure_retention(frame, frame, mask)["score"] == pytest.approx(1.0, abs=1e-6)

    blurred = label_structure_retention(frame, _blur(frame), mask)
    assert blurred["score"] < 0.5, blurred
    assert blurred["contrast_ratio"] < 1.0, "blurring loses contrast inside the label"

    repainted = label_structure_retention(frame, np.full_like(frame, 0.5), mask)
    assert repainted["score"] == 0.0, "a repainted label keeps no structure at all"

    shifted = label_structure_retention(frame, np.roll(frame, 3, axis=1), mask)
    assert shifted["score"] < 0.5, "a label whose strokes moved is not registered any more"
    assert all(entry["note"].startswith("high-pass correlation") for entry in (blurred, repainted, shifted))


def test_the_retention_score_reports_its_parts_and_refuses_a_shape_mismatch():
    frame, mask = label_fixture()
    report = label_structure_retention(frame, frame, mask)
    assert set(report) == {"score", "pixels", "correlation", "contrast_ratio", "note"}
    assert report["pixels"] == int(mask.sum()) > 0
    # an empty mask is not a failure: there is nothing to read, and the score says so
    assert label_structure_retention(frame, _blur(frame), np.zeros_like(mask))["pixels"] == 0
    with pytest.raises(ValueError, match="shape mismatch"):
        label_structure_retention(frame, frame[:32], mask)


def test_the_sweep_row_gains_the_label_number_when_a_label_mask_is_given():
    frame, mask = label_fixture()
    reference = {"canny": frame > 0.5, "gray": frame, "label_mask": mask}
    candidate = {"canny": _blur(frame) > 0.5, "gray": _blur(frame)}
    report = evaluate(reference, candidate)
    assert report["label_structure_retention"]["score"] < 0.5
    # and it stays absent when the sweep has no label mask to score against
    assert "label_structure_retention" not in evaluate({"canny": frame > 0.5}, {"canny": frame > 0.5})


@needs_resvg
def test_a_real_resvg_raster_of_a_label_scores_one_against_itself():
    """The fixture images are synthetic; this one comes from the actual CPU rasteriser."""
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">'
        '<rect width="320" height="180" fill="#0d0f14"/>'
        '<rect x="40" y="80" width="240" height="10" fill="#6d8cff"/>'
        '<rect x="40" y="110" width="160" height="10" fill="#e6e8ee"/>'
        "</svg>"
    )
    png, rgba_raw, meta = rasterize(svg, width=320)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    rgba = load_rgba(rgba_raw, meta["width"], meta["height"])
    label_mask = region_mask(rgba, "#6d8cff")
    gray = to_gray(rgba)
    report = label_structure_retention(gray, gray, label_mask)
    assert report["pixels"] > 100, "the blue label bar is in the mask"
    assert report["score"] == pytest.approx(1.0, abs=1e-6)
    # the same raster against a blank frame: the label is gone
    assert label_structure_retention(gray, np.zeros_like(gray), label_mask)["score"] == 0.0


# --------------------------------------------------------------------- the readable-text half
def test_labels_are_matched_against_the_text_that_was_read():
    report = label_legibility(["Solar Panel", "Inverter", "Battery"], "Solar Panel Inverter Home")
    assert report["total"] == 3 and report["kept"] == 2
    assert report["score"] == pytest.approx(2 / 3, abs=1e-4)
    kept = {entry["label"]: entry["kept"] for entry in report["per_label"]}
    assert kept == {"Solar Panel": True, "Inverter": True, "Battery": False}
    missing = next(entry for entry in report["per_label"] if entry["label"] == "Battery")
    assert missing["ratio"] < report["threshold"], "a missing label is a near miss, reported with its ratio"


def test_matching_ignores_case_punctuation_and_layout_but_not_word_order():
    assert label_legibility(["solar panel"], "SOLAR, PANEL.")["score"] == 1.0
    assert label_legibility(["Timeline"], "time line")["score"] == 1.0, "two OCR words for one label still match"
    assert label_legibility(["Home Load"], "Load Home")["score"] < 1.0, "a shuffled label is not a kept label"
    with pytest.raises(ValueError, match="at least one expected label"):
        label_legibility([], "anything")
    assert observed_tokens("a\nb, c!") == ["a", "b", "c"]


def test_the_ocr_interface_takes_an_injected_engine_and_never_invents_a_reading():
    def stub_engine(image):  # a stand-in for tesseract: the interface is all this needs
        assert image == "frame.png"
        return "Solar Panel\nInverter"

    reading = read_labels("frame.png", engine=stub_engine)
    assert reading["available"] is True and reading["engine"] == "stub_engine"
    assert reading["labels"] == ["Solar", "Panel", "Inverter"]

    report = check_labels(["Solar Panel", "Inverter"], image="frame.png", engine=stub_engine)
    assert report["reading"]["available"] is True
    assert report["labels"]["score"] == 1.0

    # a caller who already knows the text (a human transcription) needs no engine at all
    given = check_labels(["Inverter"], observed="inverter")
    assert given["reading"]["engine"] == "given" and given["labels"]["score"] == 1.0


@pytest.mark.skipif(ocr_available(), reason="an OCR engine is installed here, so the stub path is not the default")
def test_with_no_engine_installed_it_says_so_instead_of_pretending():
    assert ocr_available() is False
    reading = read_labels("frame.png")
    assert reading == {"available": False, "engine": None, "text": "", "labels": [], "note": OCR_INSTALL_NOTE}
    assert "tesseract" in reading["note"]
    report = check_labels(["Solar Panel"], image="frame.png")
    assert report["labels"] is None and report["note"] == OCR_INSTALL_NOTE
    assert ocr_engines() == {"pytesseract": False, "easyocr": False}


def test_the_cli_prints_a_row_per_label(capsys):
    assert main(["--labels", "Solar Panel", "Battery", "--observed", "Solar Panel", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["labels"]["score"] == 0.5 and payload["reading"]["engine"] == "given"

    assert main(["--labels", "Inverter", "--observed", "Inverter"]) == 0
    text = capsys.readouterr().out
    assert "kept" in text and "score 1.0 (1/1)" in text


def test_the_engine_note_names_what_to_install_when_nothing_is_available():
    assert "tesseract" in OCR_INSTALL_NOTE and "pip install" in OCR_INSTALL_NOTE
