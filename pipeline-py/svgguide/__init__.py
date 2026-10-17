"""SVG-guided generation, CPU prep (WS-E, owner Hermes; spec §6.11).

An agent-written SVG carries the composition; it is rasterised on CPU, turned into guidance
inputs, and fed to FLUX 3 Image Klein (stills) and LTX-2.5 (motion). Nothing in this package
touches a GPU or Google Colab: it produces rasters, control maps, workflow drafts, a sweep spec
and captions for the M3/E2 GPU sweep that Kyle approves separately.
"""

from .controlmaps import (
    CONTROL_MAP_KINDS,
    coverage,
    canny_edges,
    depth_from_layers,
    lineart,
    load_rgba,
    region_mask,
    write_gray_png,
)
from .raster import RASTER_BACKEND, RasterError, rasterize, sanitize_svg
from .sweeps import build_sweep_spec, estimate_units, write_sweep_spec
from .templates import TEMPLATES_VERSION, LAYOUT_ROLES, render_caption
from .workflows import APPROACHES, CONTROLNET_STATUS, build_approach, write_approach

__all__ = [
    "APPROACHES",
    "CONTROLNET_STATUS",
    "CONTROL_MAP_KINDS",
    "LAYOUT_ROLES",
    "RASTER_BACKEND",
    "RasterError",
    "TEMPLATES_VERSION",
    "build_approach",
    "build_sweep_spec",
    "canny_edges",
    "depth_from_layers",
    "estimate_units",
    "lineart",
    "coverage",
    "load_rgba",
    "rasterize",
    "region_mask",
    "render_caption",
    "sanitize_svg",
    "write_approach",
    "write_gray_png",
    "write_sweep_spec",
]
