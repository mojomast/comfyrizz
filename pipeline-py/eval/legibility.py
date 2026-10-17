"""Does the output still *say* what the SVG said? (GPU test 2, E1 metric caveat.)

The sweep's layout-fidelity numbers are edge IoU / chamfer / mask IoU / palette ΔE, and GPU test 2
found the hole in them: edge IoU against the SVG raster scores a low-denoise near-copy high (0.61 to
0.88) and scores the reference edits that actually look good low (0.07 to 0.74), because an edit
re-renders the texture and shifts geometry slightly. The verdict on that run was that a
label-OCR/text-legibility check fits "keeps the labels" better — so this module is that check.

Two halves, because the box has **no OCR engine installed** (no `tesseract` binary, no pytesseract,
no easyocr, and this project does not add one silently):

* :func:`read_labels` — the OCR interface. It takes an engine, defaulting to the one that is
  importable *and* runnable; with none installed it returns ``available: False`` and a note naming
  what to install, rather than pretending to have read the image. An injected engine (a callable
  ``image -> str``) is how the tests exercise the whole path on CPU with no dependency.
* :func:`label_legibility` — the string comparison, which always runs: the SVG's known label strings
  against whatever text was read (or a human typed in). A label counts as kept when its best match
  in the observed text is close enough, and the near misses are reported with their ratio, so
  "Solar" for "Solar Panel" is visible as a near miss instead of a silent failure.

`eval.metrics.label_legibility` is the dependency-free pixel-side proxy that runs even without OCR;
this module is the readable-text half. A CLI (`python -m eval.legibility`) scores a CSV or prints the
engine situation.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable, Iterable

#: Fuels the note when nothing is installed. Kept as text because this project ships no OCR extra.
OCR_INSTALL_NOTE = (
    "no OCR engine on this box: install one (`apt-get install tesseract-ocr` + `pip install pytesseract`, "
    "or easyocr) to read labels from an image; the string comparison below works without it"
)

#: A label counts as kept at this SequenceMatcher ratio against the best window of observed text.
DEFAULT_MATCH_THRESHOLD = 0.8


def ocr_engines() -> dict[str, bool]:
    """Which OCR engines this interpreter could actually use right now."""
    engines = {"pytesseract": False, "easyocr": False}
    try:
        import pytesseract  # noqa: F401

        engines["pytesseract"] = bool(shutil.which("tesseract"))
    except Exception:  # noqa: BLE001 - a missing engine is the normal case here
        pass
    try:
        import easyocr  # noqa: F401

        engines["easyocr"] = True
    except Exception:  # noqa: BLE001
        pass
    return engines


def ocr_available() -> bool:
    return any(ocr_engines().values())


def _pytesseract_engine(image_path: str | Path) -> str:
    import pytesseract  # noqa: PLC0415 - only reachable when the engine is present
    from PIL import Image  # noqa: PLC0415

    return pytesseract.image_to_string(Image.open(image_path))


def read_labels(
    image: str | Path | None = None,
    *,
    engine: Callable[[Any], str] | None = None,
    engine_name: str | None = None,
) -> dict[str, Any]:
    """The text an OCR engine reads from `image`, or an honest "not available".

    `engine` is any callable taking the image and returning text: the interface exists so a caller
    (or a test) can supply one without this project choosing an OCR dependency. With no engine and
    none installed the result is ``available: False`` plus :data:`OCR_INSTALL_NOTE`.
    """
    if engine is None:
        installed = ocr_engines()
        if installed.get("pytesseract"):
            engine, engine_name = _pytesseract_engine, "pytesseract"
        elif installed.get("easyocr"):  # pragma: no cover - easyocr is not installed here
            def _easyocr(path: str | Path) -> str:
                import easyocr  # noqa: PLC0415

                reader = easyocr.Reader(["en"], gpu=False)
                return " ".join(reader.readtext(str(path), detail=0))

            engine, engine_name = _easyocr, "easyocr"
    if engine is None:
        return {"available": False, "engine": None, "text": "", "labels": [], "note": OCR_INSTALL_NOTE}
    if image is None:
        raise ValueError("read_labels needs an image when an engine is supplied")
    text = engine(image)
    return {
        "available": True,
        "engine": engine_name or getattr(engine, "__name__", "injected"),
        "text": text,
        "labels": observed_tokens(text),
        "note": "read by the supplied OCR engine",
    }


def observed_tokens(text: str) -> list[str]:
    """The words in `text` worth comparing, brackets and punctuation dropped."""
    cleaned = re.sub(r"[^\w\s]+", " ", text.replace("\n", " "))
    return [token for token in cleaned.split() if token]


def _best_window(label: str, observed: list[str], threshold: float) -> tuple[str, float]:
    """The closest run of observed words to `label`.

    Windows of the label's own word count are tried, plus one word either side: OCR splits words
    ("Timeline" -> "time line") and joins them, and a label that was split is still a label that was
    read. Longer windows are only allowed to help, never to reward a word salad, because the ratio is
    computed against the label itself.
    """
    words = label.split()
    if not words or not observed:
        return "", 0.0
    span = len(words)
    spans = sorted({max(1, span - 1), span, span + 1})
    best_text, best_ratio = "", 0.0
    for width in spans:
        for start in range(0, max(1, len(observed) - width + 1)):
            window = " ".join(observed[start : start + width])
            ratio = SequenceMatcher(None, label.casefold(), window.casefold()).ratio()
            if ratio > best_ratio:
                best_text, best_ratio = window, ratio
    return best_text, best_ratio


def label_legibility(
    expected: Iterable[str],
    observed: str | Iterable[str],
    *,
    threshold: float = DEFAULT_MATCH_THRESHOLD,
) -> dict[str, Any]:
    """Which of the SVG's label strings are still readable in `observed`, and how close the rest are.

    `observed` is OCR text (or a human transcription). The score is the fraction of labels whose best
    match reached `threshold`; every label is reported with the window it matched and its ratio, so a
    label that was shuffled into another word is scored low rather than guessed at.
    """
    labels = [label for label in expected if isinstance(label, str) and label.strip()]
    if not labels:
        raise ValueError("label_legibility needs at least one expected label")
    tokens = observed_tokens(observed) if isinstance(observed, str) else [str(token) for token in observed]
    per_label = []
    for label in labels:
        best_text, ratio = _best_window(label, tokens, threshold)
        per_label.append(
            {
                "label": label,
                "best_match": best_text,
                "ratio": round(ratio, 3),
                "kept": ratio >= threshold,
            }
        )
    kept = sum(1 for entry in per_label if entry["kept"])
    return {
        "score": round(kept / len(per_label), 4),
        "kept": kept,
        "total": len(per_label),
        "threshold": threshold,
        "per_label": per_label,
        "note": "fraction of the SVG's labels that are still readable in the output; a near miss is reported, not hidden",
    }


def check_labels(
    expected: Iterable[str],
    *,
    image: str | Path | None = None,
    observed: str | None = None,
    engine: Callable[[Any], str] | None = None,
    threshold: float = DEFAULT_MATCH_THRESHOLD,
) -> dict[str, Any]:
    """One row for a contact sheet: the OCR reading (if any) plus the label comparison.

    Pass `observed` when the text is already known (a human transcription, a fixture); otherwise an
    image and an engine are needed, and without one the row says so.
    """
    reading = {"available": bool(observed is not None), "engine": "given" if observed is not None else None, "text": observed or "", "labels": observed_tokens(observed or ""), "note": "text supplied by the caller"}
    if observed is None:
        reading = read_labels(image, engine=engine)
    report: dict[str, Any] = {"reading": reading}
    if reading["available"]:
        report["labels"] = label_legibility(expected, reading["text"], threshold=threshold)
    else:
        report["labels"] = None
        report["note"] = reading["note"]
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="eval.legibility", description="score an output's labels (CPU, no weights)")
    parser.add_argument("--image", default=None, help="raster of the generated frame (needs an OCR engine)")
    parser.add_argument("--labels", nargs="*", default=[], help="the SVG's known label strings")
    parser.add_argument("--observed", default=None, help="text that was read out of the image, instead of OCR")
    parser.add_argument("--threshold", type=float, default=DEFAULT_MATCH_THRESHOLD)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    report = check_labels(args.labels, image=args.image, observed=args.observed, threshold=args.threshold)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        reading = report["reading"]
        print(f"ocr: {reading['engine'] or 'not available'} ({reading['note']})")
        if report["labels"]:
            for entry in report["labels"]["per_label"]:
                mark = "kept" if entry["kept"] else "MISS"
                print(f"  {mark:4} {entry['label']!r} -> {entry['best_match']!r} ({entry['ratio']})")
            print(f"score {report['labels']['score']} ({report['labels']['kept']}/{report['labels']['total']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
