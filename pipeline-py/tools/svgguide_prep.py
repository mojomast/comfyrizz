"""E1 deliverable: turn the sample SVG scenes into rasters, control maps, workflow drafts and
captions - on CPU, with no GPU and no Google Colab.

    python -m tools.svgguide_prep --samples workflows/svg-guided/samples \
        --out workflows/svg-guided/samples/out \
        --sweep workflows/svg-guided/sweeps/e2.json

Each scene produces: a raster PNG, `canny` / `lineart` / `depth` maps and one mask per declared
region, a filled API-format workflow + params file for each guidance approach, and a caption from
the template library. The manifest (`out/manifest.json`) records every artifact and the stats the
E2 contact sheets are scored on.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from svgguide.controlmaps import (  # noqa: E402
    canny_edges,
    coverage,
    depth_from_layers,
    lineart,
    load_rgba,
    region_mask,
    write_gray_png,
)
from svgguide.paths import REPO_ROOT, SAMPLES_DIR, SWEEPS_DIR  # noqa: E402
from svgguide.raster import rasterize, sanitize_svg  # noqa: E402
from svgguide.sweeps import APPROACH_GEOMETRY, build_sweep_spec, write_sweep_spec  # noqa: E402
from svgguide.templates import caption_provenance, render_caption  # noqa: E402


def _repo_relative(path: str) -> str:
    """Record guide paths relative to the repo so sweep specs carry no machine paths."""
    try:
        return Path(path).resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)
from svgguide.workflows import CONTROLNET_STATUS, build_approach, write_approach  # noqa: E402


def round_down_to(value: int, multiple: int) -> int:
    return max(multiple, (int(value) // multiple) * multiple)


def prepare_scene(region_path: Path, out_dir: Path, *, width: int = 960) -> dict:
    scene = json.loads(region_path.read_text(encoding="utf-8"))
    svg_path = region_path.with_suffix("").with_suffix(".svg")
    svg_text = svg_path.read_text(encoding="utf-8")
    clean, removed = sanitize_svg(svg_text)
    png, rgba_raw, meta = rasterize(clean, width=width)
    height = meta["height"]
    scene_out = out_dir / scene["id"]
    scene_out.mkdir(parents=True, exist_ok=True)

    raster_path = scene_out / "raster.png"
    raster_path.write_bytes(png)
    rgba = load_rgba(rgba_raw, meta["width"], height)

    maps = {
        "canny": canny_edges(_gray(rgba)),
        "lineart": lineart(_gray(rgba)),
        "depth": depth_from_layers(rgba, scene["palette"]),
    }
    map_files = {}
    for name, array in maps.items():
        path = scene_out / f"{name}.png"
        write_gray_png(array, path)
        map_files[name] = {"file": str(path), "coverage": round(coverage(array), 4)}
    for region_name, colour in (scene.get("regions") or {}).items():
        mask = region_mask(rgba, colour)
        path = scene_out / f"region-{region_name}.png"
        write_gray_png(mask, path)
        map_files[f"region-{region_name}"] = {"file": str(path), "coverage": round(coverage(mask), 4), "colour": colour}

    template = scene.get("template") or {}
    caption = render_caption(
        scene["role"],
        scene.get("intent", ""),
        scene["palette"],
        scene.get("text_safe_regions", []),
        style=template.get("style", "cinematic"),
        lighting=template.get("lighting", "soft"),
        material=template.get("material", "matte"),
    )

    still = scene.get("sweep_params", {}).get("still", {})
    plate = scene.get("sweep_params", {}).get("plate", {})
    try:
        guide_image = raster_path.relative_to(Path(__file__).resolve().parents[2]).as_posix()
    except ValueError:
        # an output directory outside the repository (tests): keep an absolute path
        guide_image = raster_path.as_posix()
    # The drafts carry the geometry the sweep actually runs (GPU test 2): a multiple of 16 raster
    # for every approach, and the plate at the output aspect an i2v first frame has to be at.
    i2i_width, i2i_height = APPROACH_GEOMETRY["img2img"]
    plate_width, plate_height = APPROACH_GEOMETRY["ltx_i2v"]
    documents = {}
    for approach, params in (
        ("img2img", {"image": guide_image, "prompt": caption.text, "width": round_down_to(i2i_width, 8), "height": round_down_to(i2i_height, 8), "seed": 42, "steps": int(still.get("steps", 16)), "denoise": 0.5}),
        ("ref_edit", {"reference": guide_image, "prompt": caption.text, "megapixels": 1.0, "seed": 42, "steps": int(still.get("steps", 16)), "denoise": 1.0}),
        ("ltx_i2v", {"image": guide_image, "prompt": caption.text, "width": round_down_to(plate_width, 32), "height": round_down_to(plate_height, 32), "frames": int(plate.get("frames", 97)), "fps": int(plate.get("fps", 24)), "seed": 42, "stage2_seed": 43}),
    ):
        draft = build_approach(approach, params=params)
        documents[approach] = write_approach(draft, scene_out / "workflows")

    return {
        "scene": scene["id"],
        "role": scene["role"],
        "svg": str(svg_path),
        "sanitizer_removed": removed,
        "raster": {
            "file": str(raster_path),
            "width": meta["width"],
            "height": height,
            "renderer": meta["renderer"],
            "requested": meta.get("requested"),
            "aspectAdjusted": meta.get("aspectAdjusted"),
            "multiple": 16,
        },
        "maps": map_files,
        "caption": {"text": caption.text, "template_id": caption.template_id, "template_version": caption.template_version, "provenance": caption_provenance(caption)},
        "workflows": documents,
        "controlnet": CONTROLNET_STATUS,
        "params": {"still": still, "plate": plate},
    }


def _gray(rgba):
    from svgguide.controlmaps import to_gray

    return to_gray(rgba)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="svgguide_prep")
    parser.add_argument("--samples", default=str(SAMPLES_DIR))
    parser.add_argument("--out", default=str(SAMPLES_DIR / "out"))
    parser.add_argument("--sweep", default=str(SWEEPS_DIR / "e2.json"))
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    samples = Path(args.samples)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    region_files = sorted(samples.glob("*.regions.json"))
    if not region_files:
        print(f"no *.regions.json in {samples}", file=sys.stderr)
        return 2

    prepared = [prepare_scene(path, out_dir, width=args.width) for path in region_files]
    sweep = build_sweep_spec(
        [
            {
                "id": item["scene"],
                "role": item["role"],
                "guide": _repo_relative(item["raster"]["file"]),
                "caption": item["caption"]["text"],
                "template_id": item["caption"]["template_id"],
            }
            for item in prepared
        ]
    )
    sweep_path = write_sweep_spec(Path(args.sweep), sweep)
    manifest = {
        "v": 1,
        "purpose": "E1 CPU prep: raster + control maps + workflow drafts + captions per sample scene",
        "sweep": str(sweep_path),
        "sweep_estimate": sweep["estimate"],
        "scenes": prepared,
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    summary = {
        "scenes": [item["scene"] for item in prepared],
        "manifest": str(manifest_path),
        "sweep": str(sweep_path),
        "units_estimate": sweep["estimate"]["units"],
        "jobs": sweep["estimate"]["jobs"],
    }
    print(json.dumps(summary if args.json else summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
