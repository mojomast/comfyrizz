"""CPU evaluation for SVG-guided generation (E1/E2): layout fidelity and palette distance."""

from .metrics import (
    CLIP_NOTE,
    chamfer_distance,
    clip_score,
    delta_e,
    edge_iou,
    evaluate,
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
    "mask_iou",
    "palette_delta_e",
    "srgb_to_lab",
]
