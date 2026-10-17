"""CPU evaluation for SVG-guided generation (E1/E2): layout fidelity, palette distance, label legibility.

`legibility` is loaded lazily (PEP 562): importing it eagerly here made `python -m eval.legibility`
print a runpy RuntimeWarning, because the package imported the module before runpy executed it as
`__main__`. `from eval import check_labels` still works.
"""

from .metrics import (
    CLIP_NOTE,
    chamfer_distance,
    clip_score,
    delta_e,
    edge_iou,
    evaluate,
    label_structure_retention,
    mask_iou,
    palette_delta_e,
    srgb_to_lab,
)

__all__ = [
    "CLIP_NOTE",
    "chamfer_distance",
    "clip_score",
    "delta_e",
    "edge_iou",
    "evaluate",
    "label_structure_retention",
    "mask_iou",
    "palette_delta_e",
    "srgb_to_lab",
    # from .legibility (lazy, see below)
    "DEFAULT_MATCH_THRESHOLD",
    "OCR_INSTALL_NOTE",
    "check_labels",
    "label_legibility",
    "observed_tokens",
    "ocr_available",
    "ocr_engines",
    "read_labels",
]

#: The names that live in `eval.legibility`, resolved on first use.
_LAZY_FROM_LEGIBILITY = frozenset(
    {
        "DEFAULT_MATCH_THRESHOLD",
        "OCR_INSTALL_NOTE",
        "check_labels",
        "label_legibility",
        "observed_tokens",
        "ocr_available",
        "ocr_engines",
        "read_labels",
    }
)


def __getattr__(name: str):
    if name in _LAZY_FROM_LEGIBILITY:
        from . import legibility

        return getattr(legibility, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(__all__)
