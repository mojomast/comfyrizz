"""E1 acceptance: the SVG-guided CPU prep, on CPU only.

Covers the sanitizer, the resvg raster, the four control-map kinds, the workflow drafts against
the real GPU-test-1 graphs, the template captions, the sweep spec + its unit estimate, and the
eval metrics. The acceptance line - "3 sample scenes each produce raster + control maps + filled
workflow JSON + caption" - is the `test_three_sample_scenes_produce_every_artifact` case.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from eval.metrics import chamfer_distance, delta_e, edge_iou, evaluate, mask_iou, palette_delta_e
from svgguide import (
    CONTROLNET_STATUS,
    LAYOUT_ROLES,
    RASTER_BACKEND,
    RasterError,
    build_approach,
    build_sweep_spec,
    canny_edges,
    coverage,
    depth_from_layers,
    estimate_units,
    lineart,
    load_rgba,
    rasterize,
    region_mask,
    render_caption,
    sanitize_svg,
    write_gray_png,
)
from svgguide.paths import REPO_ROOT, SAMPLES_DIR, VECTOR_NODE_MODULES
from svgguide.workflows import APPROACHES, GraphError, check_graph
from tools.svgguide_prep import prepare_scene

SAMPLES = sorted(SAMPLES_DIR.glob("*.regions.json"))
HAVE_RESVG = bool(shutil.which("node")) and (VECTOR_NODE_MODULES / "@resvg" / "resvg-js" / "index.js").is_file()
needs_resvg = pytest.mark.skipif(not HAVE_RESVG, reason="node + resvg-js (packages/vector) are required to rasterise")

MALICIOUS = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <script>alert('x')</script>
  <foreignObject width="10" height="10"><body>x</body></foreignObject>
  <rect x="0" y="0" width="100" height="100" fill="#fff" onload="steal()" onclick="steal()"/>
  <image href="https://example.com/track.png" width="10" height="10"/>
  <style>@import url("https://example.com/x.css");</style>
  <circle cx="50" cy="50" r="20" fill="#000"/>
</svg>"""


# --------------------------------------------------------------------------- sanitizer
def test_sanitize_strips_the_dangerous_parts_and_keeps_the_shapes():
    clean, removed = sanitize_svg(MALICIOUS)
    for forbidden in ("script", "foreignObject", "onload", "onclick", "@import", "https://example.com"):
        assert forbidden not in clean, f"{forbidden} survived sanitisation"
    assert "<rect" in clean and "<circle" in clean
    assert "<style>" not in clean
    assert {"script element", "foreignObject element", "event handler attribute", "style block"} <= set(removed)


def test_sanitize_demands_a_viewbox_and_refuses_absurd_input():
    with pytest.raises(RasterError, match="viewBox"):
        sanitize_svg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')
    with pytest.raises(RasterError, match="empty"):
        sanitize_svg("   ")
    with pytest.raises(RasterError, match="larger than"):
        sanitize_svg('<svg viewBox="0 0 1 1">' + "<rect/>" * 10 + "</svg>", max_bytes=10)


# --------------------------------------------------------------------------- raster + maps
@needs_resvg
def test_rasterise_produces_a_png_and_an_rgba_buffer():
    png, rgba_raw, meta = rasterize((SAMPLES_DIR / "hero.svg").read_text(encoding="utf-8"), width=320)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert meta["renderer"] == "resvg-js"
    assert meta["width"] == 320
    rgba = load_rgba(rgba_raw, meta["width"], meta["height"])
    assert rgba.shape == (meta["height"], 320, 4)
    assert rgba[..., 3].min() == 255, "the sample scenes are fully opaque"
    assert len(np.unique(rgba[..., :3].reshape(-1, 3), axis=0)) > 3, "the raster is not a flat fill"
    assert RASTER_BACKEND.startswith("resvg-js")


@needs_resvg
def test_control_maps_are_non_degenerate_and_well_typed():
    png, rgba_raw, meta = rasterize((SAMPLES_DIR / "hero.svg").read_text(encoding="utf-8"), width=480)
    rgba = load_rgba(rgba_raw, meta["width"], meta["height"])
    scene = json.loads((SAMPLES_DIR / "hero.regions.json").read_text(encoding="utf-8"))
    from svgguide.controlmaps import to_gray

    gray = to_gray(rgba)
    assert gray.shape == (meta["height"], meta["width"])
    assert 0.0 <= float(gray.min()) and float(gray.max()) <= 1.0

    edges = canny_edges(gray)
    assert edges.dtype == bool
    assert 0.0005 < coverage(edges) < 0.5, f"edges cover {coverage(edges)}: neither blank nor everything"

    ink = lineart(gray)
    assert ink.dtype == bool and coverage(ink) > 0.0

    depth = depth_from_layers(rgba, scene["palette"])
    assert depth.shape == gray.shape
    assert len(np.unique(np.round(depth, 3))) >= 3, "a layered scene has at least three depth levels"
    assert float(depth.min()) >= 0.0 and float(depth.max()) <= 1.0
    assert abs(float(depth[scene_height(scene, meta) - 10, 10]) - 0.0) < 1e-6, "the far layer reads as the far plane"

    mask = region_mask(rgba, scene["regions"]["subject"])
    assert mask.any() and coverage(mask) < 0.5
    assert region_mask(rgba, "#123456").sum() == 0, "a colour that is not in the scene matches nothing"
    assert 0 < region_mask(rgba, scene["regions"]["subject"], tolerance=90).sum() <= rgba.shape[0] * rgba.shape[1]
    assert png[:4] == b"\x89PNG"


def scene_height(scene: dict, meta: dict) -> int:
    return meta["height"]


def test_write_gray_png_writes_a_real_png(tmp_path: Path):
    path = write_gray_png(np.pad(np.ones((4, 6), dtype=bool), 0), tmp_path / "m.png")
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    assert (width, height) == (6, 4)
    assert write_gray_png(np.zeros((2, 2), dtype=np.float32), tmp_path / "f.png").is_file()


# --------------------------------------------------------------------------- templates
def test_captions_are_deterministic_and_carry_the_palette_and_the_safe_regions():
    first = render_caption("hero-subject", "a lit figure in haze", ["#0d0f14", "#6d8cff"], ["top-left quadrant"])
    second = render_caption("hero-subject", "a lit figure in haze", ["#0d0f14", "#6d8cff"], ["top-left quadrant"])
    assert first.text == second.text
    assert "#0d0f14" in first.text and "#6d8cff" in first.text
    assert "top-left quadrant" in first.text
    assert "No text, no lettering" in first.text
    assert first.template_id == "hero-subject/cinematic+soft+matte"
    assert first.template_version and first.template_version.count(".") == 2
    assert set(LAYOUT_ROLES) == {"hero-subject", "background-plate", "texture", "icon-illustration"}


def test_captions_refuse_an_unknown_role_or_style():
    with pytest.raises(ValueError, match="unknown layout role"):
        render_caption("portrait", "x", ["#000000"])
    with pytest.raises(ValueError, match="unknown style"):
        render_caption("texture", "x", ["#000000"], style="vaporwave")
    with pytest.raises(ValueError, match="palette"):
        render_caption("texture", "x", [])


# --------------------------------------------------------------------------- workflow drafts
def test_every_approach_drafts_against_the_real_graph_and_injects_its_parameters():
    params = {
        "img2img": {"image": "raster.png", "prompt": "x", "width": 960, "height": 544, "seed": 1, "steps": 16, "denoise": 0.5},
        "ref_edit": {"reference": "raster.png", "prompt": "x", "megapixels": 1.0, "seed": 1, "steps": 16, "denoise": 1.0},
        "ltx_i2v": {"image": "raster.png", "prompt": "x", "width": 960, "height": 544, "frames": 97, "fps": 24, "seed": 1, "stage2_seed": 2},
    }
    for approach, values in params.items():
        draft = build_approach(approach, params=values)
        assert check_graph(draft["graph"]) == []
        assert Path(REPO_ROOT / draft["base_graph"]).is_file(), draft["base_graph"]
        assert draft["map"], f"{approach} has no params map"
        assert set(APPROACHES[approach]["params"]) <= set(draft["map"])
    assert build_approach("img2img", params=params["img2img"])["graph"]["7"]["inputs"]["denoise"] == 0.5
    assert build_approach("ltx_i2v", params=params["ltx_i2v"])["graph"]["9"]["inputs"]["frames_number"] == 97
    with pytest.raises(GraphError, match="unknown approach"):
        build_approach("controlnet", params={})


def test_controlnet_is_recorded_as_not_found_rather_than_invented():
    assert CONTROLNET_STATUS["found"] is False
    assert CONTROLNET_STATUS["verified"] is False
    assert "No ControlNet" in CONTROLNET_STATUS["note"]
    assert "rather than substituting" in CONTROLNET_STATUS["note"]
    assert "img2img" in APPROACHES and "ref_edit" in APPROACHES and "ltx_i2v" in APPROACHES
    assert set(APPROACHES) == {"img2img", "ref_edit", "ltx_i2v"}, "approach 3 is drafted only if weights exist"


def test_a_draft_can_be_written_and_read_back(tmp_path: Path):
    draft = build_approach(
        "img2img",
        params={"image": "raster.png", "prompt": "x", "width": 960, "height": 544, "seed": 1, "steps": 16, "denoise": 0.65},
    )
    from svgguide.workflows import write_approach

    written = write_approach(draft, tmp_path / "drafts")
    graph = json.loads(Path(written["graph"]).read_text(encoding="utf-8"))
    params = json.loads(Path(written["params"]).read_text(encoding="utf-8"))
    assert graph["7"]["inputs"]["denoise"] == 0.65
    assert params["v"] == 1 and params["map"] == draft["map"]


# --------------------------------------------------------------------------- sweep spec
def test_the_sweep_spec_covers_every_scene_and_labels_its_estimate():
    scenes = [{"id": f"sample_{name}", "role": role, "guide": "raster.png"} for name, role in (("hero", "hero-subject"), ("background", "background-plate"), ("texture", "texture"))]
    spec = build_sweep_spec(scenes, seeds=(42, 43), denoise_grid=(0.35, 0.5, 0.65, 0.85))
    # per scene: 2 seeds x (4 denoise img2img + 1 ref_edit x 3 weights + 1 ltx) = 16 -> 48 jobs
    assert len(spec["jobs"]) == 48
    assert {job["scene"] for job in spec["jobs"]} == {scene["id"] for scene in scenes}
    assert {job["approach"] for job in spec["jobs"]} == {"img2img", "ref_edit", "ltx_i2v"}
    assert spec["jobs"][0]["denoise"] in (0.35, 0.5, 0.65, 0.85)
    estimate = spec["estimate"]
    assert estimate["label"] == "estimate"
    assert estimate["jobs"] == 48
    assert estimate["units"] > estimate["next_job_upper_units"] > 0
    assert estimate["collect_and_stop_reserve_minutes"] == 6
    assert "reserve" in estimate["reserve_formula"]
    assert "Kyle" in spec["human_gate"], "the sweep never runs without Kyle's approval"
    assert spec["rubric"]["layout_fidelity"]
    assert estimate_units(spec) == estimate


def test_the_sweep_spec_refuses_an_unknown_approach():
    with pytest.raises(ValueError, match="unknown approach"):
        build_sweep_spec([{"id": "s1"}], approaches=("controlnet",))


# --------------------------------------------------------------------------- eval metrics
def test_the_eval_metrics_are_sane_on_known_inputs():
    square = np.zeros((32, 32), dtype=bool)
    square[8:24, 8:24] = True
    assert edge_iou(square, square.copy()) == 1.0
    assert mask_iou(square, np.zeros_like(square)) == 0.0
    assert chamfer_distance(square, square.copy()) == 0.0
    shifted = np.zeros_like(square)
    shifted[8:24, 12:28] = True
    assert 0.0 < edge_iou(square, shifted) < 1.0
    assert 0.0 < chamfer_distance(square, shifted) < 4.0, "a 4-pixel shift moves the fill's boundary"
    # a tolerance helps *thin* maps (which is the real case: edge maps), not filled blocks
    ring = np.zeros((32, 32), dtype=bool)
    ring[8, 8:24] = ring[23, 8:24] = ring[8:24, 8] = ring[8:24, 23] = True
    ring_shifted = np.roll(ring, 1, axis=1)
    assert edge_iou(ring, ring_shifted, tolerance=2) > edge_iou(ring, ring_shifted)

    assert delta_e("#ffffff", "#000000") == pytest.approx(100.0, abs=0.5)
    assert delta_e("#6d8cff", "#6d8cff") == 0.0
    report = palette_delta_e(["#6d8cff", "#0d0f14"], ["#6d8cff", "#111111"])
    assert report["mean_delta_e"] < 5
    assert report["per_colour"][0]["delta_e"] == 0.0

    assessed = evaluate({"canny": square, "region": square}, {"canny": shifted, "region": square}, palette_a=["#6d8cff"], palette_b=["#6d8cff"])
    assert assessed["edge_iou"] < 1.0 and assessed["mask_iou"] == 1.0 and assessed["palette"]["mean_delta_e"] == 0.0


# --------------------------------------------------------------------------- acceptance
@needs_resvg
@pytest.mark.parametrize("region_path", SAMPLES, ids=[path.stem for path in SAMPLES])
def test_three_sample_scenes_produce_every_artifact(region_path: Path, tmp_path: Path):
    """E1 acceptance: each sample scene -> raster + control maps + filled workflow JSON + caption."""
    prepared = prepare_scene(region_path, tmp_path, width=480)
    assert prepared["sanitizer_removed"] == [] or isinstance(prepared["sanitizer_removed"], list)

    raster = Path(prepared["raster"]["file"])
    assert raster.is_file() and raster.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    assert prepared["raster"]["renderer"] == "resvg-js"

    for kind in ("canny", "lineart", "depth"):
        entry = prepared["maps"][kind]
        assert Path(entry["file"]).is_file(), kind
        assert entry["coverage"] > 0.0, f"{kind} is blank"
    region_entries = [key for key in prepared["maps"] if key.startswith("region-")]
    assert region_entries, "a scene declares at least one region"
    assert all(prepared["maps"][key]["coverage"] > 0.0 for key in region_entries)

    assert set(prepared["workflows"]) == {"img2img", "ref_edit", "ltx_i2v"}
    for approach, paths in prepared["workflows"].items():
        graph = json.loads(Path(paths["graph"]).read_text(encoding="utf-8"))
        assert check_graph(graph) == [], approach
        assert json.loads(Path(paths["params"]).read_text(encoding="utf-8"))["map"], approach

    caption = prepared["caption"]
    assert caption["text"].startswith(LAYOUT_ROLE_PREFIX[caption["template_id"].split("/")[0]])
    assert caption["provenance"]["template_version"] == caption["template_version"]
    assert prepared["controlnet"]["found"] is False


LAYOUT_ROLE_PREFIX = {
    "hero-subject": "a single clear subject",
    "background-plate": "a wide atmospheric background",
    "texture": "a seamless full-frame surface texture",
    "icon-illustration": "a simple flat illustration",
}
