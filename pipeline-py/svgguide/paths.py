"""Paths shared by the SVG-guided CPU prep (WS-E)."""

from __future__ import annotations

from pathlib import Path

SVGGUIDE_DIR = Path(__file__).resolve().parent
PIPELINE_DIR = SVGGUIDE_DIR.parent
REPO_ROOT = PIPELINE_DIR.parent

#: Pi's packages/vector owns the resvg dependency; WS-E uses it read-only (PLAN.md A5/E1).
VECTOR_NODE_MODULES = REPO_ROOT / "packages" / "vector" / "node_modules"
RESVG_INDEX = VECTOR_NODE_MODULES / "@resvg" / "resvg-js" / "index.js"
RESVG_SHIM = SVGGUIDE_DIR / "_resvg.mjs"

WORKFLOWS_DIR = REPO_ROOT / "workflows"
SVGGUIDE_WORKFLOWS = WORKFLOWS_DIR / "svg-guided"
SAMPLES_DIR = SVGGUIDE_WORKFLOWS / "samples"
SWEEPS_DIR = SVGGUIDE_WORKFLOWS / "sweeps"

#: The real, already-tested GPU-test-1 graphs the approaches start from (B4 params maps).
BASE_GRAPHS = {
    "img2img": WORKFLOWS_DIR / "flux3_klein_img2img.api.json",
    "ref_edit": WORKFLOWS_DIR / "flux3_klein_ref_edit.api.json",
    "ltx_i2v": WORKFLOWS_DIR / "ltx25_i2v_2stage.api.json",
}
