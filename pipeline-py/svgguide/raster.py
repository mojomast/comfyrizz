"""SVG -> raster on CPU.

The rasteriser is `@resvg/resvg-js` through a tiny node shim (`_resvg.mjs`), which is the same
renderer Pi's `packages/vector` render-check uses, reached read-only through that package's
installed `node_modules` (PLAN.md A5/E1: "resvg, via Pi's packages/vector sanitizer when
available"). If node or the module is missing, `rasterize` raises :class:`RasterError` with the
install hint instead of silently producing a blank image.

The sanitizer is the Python allow-list mirror of Pi's TypeScript one: shapes, paths, text,
gradients, patterns and simple groups survive; scripts, event handlers, `foreignObject`,
external `href`s, `@import` and external fonts/images do not. Everything rasterised here has
been through it, so a hostile SVG from an LLM cannot reach the renderer or the VM.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from .paths import RESVG_INDEX, RESVG_SHIM, VECTOR_NODE_MODULES

RASTER_BACKEND = "resvg-js (packages/vector node_modules)"

ALLOWED_ELEMENTS = {
    "svg",
    "g",
    "defs",
    "title",
    "desc",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "path",
    "text",
    "tspan",
    "linearGradient",
    "radialGradient",
    "stop",
    "pattern",
    "clipPath",
    "mask",
    "use",
    "animate",
    "animateTransform",
}
ALLOWED_ATTRIBUTES = {
    "id",
    "class",
    "viewBox",
    "width",
    "height",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "d",
    "points",
    "transform",
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "opacity",
    "offset",
    "stop-color",
    "stop-opacity",
    "gradientUnits",
    "patternUnits",
    "patternTransform",
    "clip-path",
    "mask",
    "preserveAspectRatio",
    "text-anchor",
    "dominant-baseline",
    "font-family",
    "font-size",
    "font-weight",
    "letter-spacing",
    "attributeName",
    "values",
    "dur",
    "repeatCount",
    "from",
    "to",
    "type",
    "xmlns",
    "version",
}
FORBIDDEN_PATTERNS = (
    (re.compile(r"<\s*script", re.I), "script element"),
    (re.compile(r"<\s*foreignObject", re.I), "foreignObject element"),
    (re.compile(r"<\s*iframe", re.I), "iframe element"),
    (re.compile(r"\son[a-z]+\s*=", re.I), "event handler attribute"),
    (re.compile(r"javascript:", re.I), "javascript: URL"),
    (re.compile(r"@import", re.I), "@import rule"),
    (re.compile(r"<!ENTITY", re.I), "entity declaration"),
    (re.compile(r"<!DOCTYPE[^>]*SYSTEM", re.I), "external DTD"),
)
VIEWBOX_RE = re.compile(r'viewBox\s*=\s*"([^"]+)"')
TAG_RE = re.compile(r"<\s*/?\s*([A-Za-z][A-Za-z0-9:_-]*)")
ATTR_RE = re.compile(r'([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"')
EXTERNAL_HREF_RE = re.compile(r'(?:xlink:)?href\s*=\s*"(?!#)([^"]*)"', re.I)


class RasterError(RuntimeError):
    """Raised when the SVG cannot be sanitised or rasterised."""


def sanitize_svg(text: str, *, max_bytes: int = 400_000, max_elements: int = 4000) -> tuple[str, list[str]]:
    """Allow-list filter. Returns (clean_svg, removed) - `removed` names what was stripped."""
    if not isinstance(text, str) or not text.strip():
        raise RasterError("the SVG is empty")
    if len(text.encode("utf-8")) > max_bytes:
        raise RasterError(f"the SVG is larger than {max_bytes} bytes")
    removed = []
    for pattern, label in FORBIDDEN_PATTERNS:
        if pattern.search(text):
            removed.append(label)
            text = pattern.sub("", text)
    for match in EXTERNAL_HREF_RE.finditer(text):
        target = match.group(1).strip()
        if target and (target.startswith("data:") is False):
            removed.append(f"external href ({target[:40]})")
    text = EXTERNAL_HREF_RE.sub("", text)

    tags = TAG_RE.findall(text)
    if len(tags) > max_elements:
        raise RasterError(f"the SVG has {len(tags)} elements, more than the {max_elements} limit")
    for tag in sorted(set(tags)):
        if tag.lower() not in {name.lower() for name in ALLOWED_ELEMENTS}:
            removed.append(f"element {tag}")
            text = re.sub(rf"<\s*/?\s*{re.escape(tag)}\b[^>]*>", "", text)
    for name in sorted({match.group(1) for match in ATTR_RE.finditer(text)}):
        if name.lower() not in {attr.lower() for attr in ALLOWED_ATTRIBUTES}:
            removed.append(f"attribute {name}")
            text = re.sub(rf'\s{re.escape(name)}\s*=\s*"[^"]*"', "", text)
    if "viewBox" not in text:
        raise RasterError("the SVG has no viewBox, so its scale is undefined")
    if "xmlns" not in text:
        text = text.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    return text, removed


def viewbox(text: str) -> tuple[float, float, float, float]:
    match = VIEWBOX_RE.search(text)
    if not match:
        raise RasterError("the SVG has no viewBox")
    parts = [float(value) for value in re.split(r"[ ,]+", match.group(1).strip()) if value]
    if len(parts) != 4:
        raise RasterError(f"viewBox '{match.group(1)}' is not four numbers")
    return parts[0], parts[1], parts[2], parts[3]


def rasterize(
    svg: str | Path, *, width: int, height: int | None = None, node: str | None = None
) -> tuple[bytes, bytes, dict]:
    """Rasterise an SVG on CPU.

    Returns ``(png_bytes, rgba_raw)``: the PNG is for a human/contact sheet, the raw RGBA buffer
    is what the control maps are computed from (no image library needed).
    """
    text = svg.read_text(encoding="utf-8") if isinstance(svg, Path) else str(svg)
    clean, removed = sanitize_svg(text)
    node_bin = node or shutil.which("node")
    if not node_bin:
        raise RasterError("node is required to run the resvg shim (install Node >= 20)")
    if not VECTOR_NODE_MODULES.is_dir():
        raise RasterError(f"resvg-js is not installed at {VECTOR_NODE_MODULES}; run pnpm install in packages/vector")
    if height is None:
        _, _, box_w, box_h = viewbox(clean)
        height = max(1, round(width * box_h / box_w))
    payload = json.dumps({"svg": clean, "width": int(width), "height": int(height)})
    result = subprocess.run(
        [node_bin, str(RESVG_SHIM), str(RESVG_INDEX)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=60,
        env={"PATH": "/usr/bin:/bin:/usr/local/bin", "NODE_PATH": str(VECTOR_NODE_MODULES), "HOME": str(Path.home())},
        check=False,
    )
    if result.returncode != 0:
        raise RasterError(f"resvg failed: {result.stderr.strip()[:400] or result.stdout.strip()[:400]}")
    try:
        output = json.loads(result.stdout)
    except json.JSONDecodeError as exc:  # pragma: no cover - defensive
        raise RasterError(f"resvg shim returned nothing readable: {result.stdout[:200]}") from exc
    return Path(output["png"]).read_bytes(), Path(output["rgba"]).read_bytes(), output
