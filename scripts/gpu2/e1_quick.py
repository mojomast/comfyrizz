#!/usr/bin/env python3
"""Quick E1-style structure check for the GPU test 2 SVG sweep: edge IoU (Hermes's
pipeline-py/eval/metrics.edge_iou, tolerance 2 px) between each agent SVG raster and its
styled outputs, on 672x384 grayscale gradient edges. Prints a markdown table."""
import os, sys
import numpy as np
from PIL import Image, ImageFilter
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
sys.path.insert(0, f"{REPO}/pipeline-py")
from eval.metrics import edge_iou  # noqa: E402
G = sys.argv[1] if len(sys.argv) > 1 else "/workspace/comfy-hackathon/test/gpu2"

def edges(path):
    im = Image.open(path).convert("L").resize((672, 384), Image.LANCZOS).filter(ImageFilter.FIND_EDGES)
    a = np.asarray(im, dtype=np.float32)
    return a > max(24.0, np.percentile(a, 92))

cols = ["d45", "d60", "d75", "ref"]
print("| SVG | style | " + " | ".join(cols) + " |\n|---|---|" + "---|" * len(cols))
for svg in ["solar_flow", "bar_chart", "timeline", "mind_map"]:
    ref = edges(f"{G}/inputs/{svg}.png")
    for style in ["glass", "clay", "editorial"]:
        vals = [edge_iou(ref, edges(f"{G}/raw/svg_{svg}_{style}_{c}_00001_.png"), tolerance=2) for c in cols]
        print(f"| {svg} | {style} | " + " | ".join(f"{v:.2f}" for v in vals) + " |")
