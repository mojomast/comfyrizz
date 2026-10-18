"""The package-level prompt builder (R1, research sections 1.3-1.5).

`templates.py` renders one caption at a time; this is the layer a caller uses. Given a package - and
the SVG each of its assets carries - it produces the prompt every rendered asset is given, with the
single per-package style block (section 1.5), the role's template, and the anchor rows built from the
SVG's own element boxes (section 1.4). One role per asset drives both directions: the same `diagram`
is a reference edit while it is flat and a motion prompt once it moves.

Two rules it will not break:
* an asset that already states its prompt keeps it - a human's words are not replaced by a template;
* a face's framing is the planner's business, not this module's, but a *static* role says so in its
  text (`FRAMING_LOCK`), because "static camera" alone did not hold the frame on the overnight run.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ElementTree
from pathlib import Path

from .templates import (
    FRAMING_LOCK,
    MOTION_ROLES,
    REF_EDIT_ROLES,
    TEMPLATES_VERSION,
    caption_provenance,
    render_caption,
    render_motion_caption,
    render_ref_edit_caption,
    render_style_block,
)

PROMPTS_VERSION = "1.0.0"

#: Motion roles whose plate must not move: the mirror of `STATIC_MOTION_ROLES` in
#: `packages/jobs/src/defaults.mjs`, in this module's role names. Only a hero plate is allowed to
#: drift, and a test asserts exactly that relationship so the two lists cannot drift apart.
STATIC_ROLES = ("diagram", "ui-board", "chart-backdrop", "background-loop")

#: The shapes whose box can be read straight out of the SVG text.
SHAPE_TAGS = ("rect", "circle", "ellipse", "line", "polygon", "polyline", "path")

#: Containers whose children are definitions, not drawings: a `<rect>` inside `<defs>` is not on the
#: canvas where it appears (it is painted only if something references it), so its box is not a box.
NON_DRAWN = ("defs", "clipPath", "mask", "pattern", "symbol", "marker", "lineargradient", "radialgradient", "filter")

#: A path's box is the box of its own numbers, with this much room for the stroke. Real curves bow
#: outside their control points, which is why the quality gate asks for 0.5 IoU rather than 0.9.
PATH_STROKE_ALLOWANCE = 4.0

_NUMBER = re.compile(r"-?\d*\.?\d+(?:e-?\d+)?")


def _tag_name(element: ElementTree.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _float(value: str | None, default: float = 0.0) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _ancestors(root: ElementTree.Element, element: ElementTree.Element) -> list[ElementTree.Element]:
    """The element's ancestors, root first (ElementTree has no parent pointers)."""
    path: list[ElementTree.Element] = []

    def walk(node: ElementTree.Element) -> bool:
        if node is element:
            return True
        for child in node:
            path.append(node)
            if walk(child):
                return True
            path.pop()
        return False

    walk(root)
    return path


def _description(element: ElementTree.Element) -> str:
    """What the element says it is: a `<desc>` child (how our SVGs carry it) or a data attribute."""
    for child in element:
        if _tag_name(child).lower() == "desc" and (child.text or "").strip():
            return (child.text or "").strip()
    return (element.get("data-desc") or "").strip()


def _points(text: str) -> list[tuple[float, float]]:
    numbers = [float(value) for value in _NUMBER.findall(text or "")]
    return list(zip(numbers[0::2], numbers[1::2], strict=False))


def element_boxes(svg_text: str, *, limit: int = 64) -> list[dict]:
    """Every drawable element's box, in the SVG's own coordinate space, in document order.

    `[{id, tag, fill, bbox: [x, y, width, height]}]`. A `path`'s box is the box of its own numbers
    (exact for straight runs, an over-estimate for curves); a `rect`/`circle`/`ellipse`/`line`/`poly*`
    is exact. Elements with no box at all (defs, groups, text) are skipped.
    """
    try:
        root = ElementTree.fromstring(svg_text)
    except ElementTree.ParseError as error:
        raise ValueError(f"the SVG is not well-formed XML: {error}") from error

    found: list[dict] = []
    for index, element in enumerate(root.iter()):
        tag = _tag_name(element)
        if tag not in SHAPE_TAGS:
            continue
        if any(_tag_name(ancestor).lower() in NON_DRAWN for ancestor in _ancestors(root, element)):
            continue
        box: tuple[float, float, float, float] | None = None
        if tag == "rect":
            box = (
                _float(element.get("x")),
                _float(element.get("y")),
                _float(element.get("width")),
                _float(element.get("height")),
            )
        elif tag in ("circle", "ellipse"):
            radius_x = _float(element.get("r") if tag == "circle" else element.get("rx"))
            radius_y = _float(element.get("r") if tag == "circle" else element.get("ry"))
            centre_x, centre_y = _float(element.get("cx")), _float(element.get("cy"))
            box = (centre_x - radius_x, centre_y - radius_y, radius_x * 2, radius_y * 2)
        elif tag == "line":
            box = (
                _float(element.get("x1")),
                _float(element.get("y1")),
                abs(_float(element.get("x2")) - _float(element.get("x1"))),
                abs(_float(element.get("y2")) - _float(element.get("y1"))),
            )
        elif tag in ("polygon", "polyline"):
            points = _points(element.get("points") or "")
            if points:
                xs = [point[0] for point in points]
                ys = [point[1] for point in points]
                box = (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
        elif tag == "path":
            numbers = [float(value) for value in _NUMBER.findall(element.get("d") or "")]
            pairs = list(zip(numbers[0::2], numbers[1::2], strict=False))
            if pairs:
                xs = [point[0] for point in pairs]
                ys = [point[1] for point in pairs]
                box = (
                    min(xs) - PATH_STROKE_ALLOWANCE,
                    min(ys) - PATH_STROKE_ALLOWANCE,
                    (max(xs) - min(xs)) + PATH_STROKE_ALLOWANCE * 2,
                    (max(ys) - min(ys)) + PATH_STROKE_ALLOWANCE * 2,
                )
        if not box or box[2] <= 0 or box[3] <= 0:
            continue
        found.append(
            {
                "id": element.get("id") or f"{tag}-{index}",
                "tag": tag,
                "fill": element.get("fill") or element.get("stroke") or "",
                "desc": _description(element),
                "bbox": [round(value, 3) for value in box],
            }
        )
        if len(found) >= limit:
            break
    return found


def package_style_block(package: dict) -> str:
    """The one style block the whole package shares (research section 1.5)."""
    theme = package.get("theme") or {}
    palette = [str(colour).strip() for colour in (theme.get("palette") or []) if str(colour).strip()]
    if not palette:
        raise ValueError("a package needs a theme palette before its prompts can be built")
    return render_style_block(
        style=str(theme.get("style") or "cinematic"),
        lighting=str(theme.get("lighting") or "soft"),
        material=str(theme.get("material") or "matte"),
        palette=palette,
    )


def _stated_prompt(asset: dict) -> str | None:
    """A prompt the asset already states, which no template may replace."""
    gen = asset.get("gen") or {}
    for candidate in (asset.get("prompt"), gen.get("prompt"), (gen.get("inputs") or {}).get("text")):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def _role_of(asset: dict, package: dict) -> str:
    gen = asset.get("gen") or {}
    for candidate in (asset.get("role"), gen.get("role"), (gen.get("inputs") or {}).get("role")):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    # an SVG that declares no role is an icon: the least assuming of the roles
    return str((package.get("motion") or {}).get("defaultRole") or "icon-illustration")


def asset_prompt(asset_id: str, asset: dict, package: dict, *, style_block: str, elements=None, frame=None) -> dict:
    """One asset's prompt. `None`-free: every asset this is called for gets a decision, with a note."""
    stated = _stated_prompt(asset)
    if stated:
        return {
            "asset": asset_id,
            "text": stated,
            "templateId": "explicit",
            "templateVersion": TEMPLATES_VERSION,
            "role": _role_of(asset, package),
            "kind": asset.get("kind"),
            "styleBlock": style_block,
            "framingLock": False,
            "note": "the asset states its own prompt; no template touched it",
        }

    role = _role_of(asset, package)
    kind = str(asset.get("kind") or "")
    fmt = package.get("format") or {}
    default_frame = (int(fmt.get("width") or 1024), int(fmt.get("height") or 576))
    motion = bool((asset.get("gen") or {}).get("motion") or asset.get("motion") or kind in ("plate", "video"))
    palette = (package.get("theme") or {}).get("palette") or []

    if motion and role in MOTION_ROLES:
        caption = render_motion_caption(role, subject=str(asset.get("subject") or ""))
        return {
            "asset": asset_id,
            "text": caption.text,
            "templateId": caption.template_id,
            "templateVersion": caption.template_version,
            "role": role,
            "kind": kind or "plate",
            "styleBlock": style_block,
            "framingLock": role in STATIC_ROLES and FRAMING_LOCK in caption.text,
            "note": "an LTX motion prompt: the planner's stay-still defaults go with this role",
        }

    if kind == "svg" and role in REF_EDIT_ROLES:
        caption = render_ref_edit_caption(
            role,
            list(elements or ()),
            style_block=style_block,
            palette=palette,
            frame=frame or default_frame,
        )
        rows = len(elements or ())
        return {
            "asset": asset_id,
            "text": caption.text,
            "templateId": caption.template_id,
            "templateVersion": caption.template_version,
            "role": role,
            "kind": "svg",
            "styleBlock": style_block,
            "anchorRows": rows,
            "framingLock": False,
            "provenance": caption_provenance(caption),
            "note": f"{rows} element row(s) from the SVG" if rows else "no element boxes were given to this build",
        }

    if role in ("hero-subject", "background-plate", "texture", "icon-illustration"):
        # `render_caption` composes its own style words from the theme; the package's single style block
        # goes with them verbatim, because that sentence is what makes two scenes look like one video
        caption = render_caption(
            role,
            str(asset.get("subject") or asset.get("title") or f"{asset_id.replace('_', ' ')}"),
            palette,
            extra=(style_block,),
        )
        return {
            "asset": asset_id,
            "text": caption.text,
            "templateId": caption.template_id,
            "templateVersion": caption.template_version,
            "role": role,
            "kind": kind or "still",
            "styleBlock": style_block,
            "framingLock": False,
            "note": "a layout caption: this asset is not an SVG edit and does not move",
        }

    return {
        "asset": asset_id,
        "text": None,
        "templateId": None,
        "templateVersion": TEMPLATES_VERSION,
        "role": role,
        "kind": kind,
        "styleBlock": style_block,
        "framingLock": False,
        "note": f"no template for role {role!r} with kind {kind!r}: the caller has to say what this asset is",
    }


def build_asset_prompts(package: dict, *, elements=None, frame=None, package_dir: Path | None = None) -> dict[str, dict]:
    """Every asset's prompt, sharing one style block.

    `elements` maps asset id -> element rows; when it is not given and `package_dir` is, each SVG
    asset's own file is read and its boxes are used (that is the SVG-to-render step).
    """
    style_block = package_style_block(package)
    resolved = dict(elements or {})
    if package_dir is not None:
        for asset_id, asset in (package.get("assets") or {}).items():
            if asset_id in resolved or str(asset.get("file") or "").endswith(".svg") is False:
                continue
            path = Path(package_dir) / str(asset.get("file"))
            if path.is_file():
                resolved[asset_id] = element_boxes(path.read_text(encoding="utf-8"))
    return {
        asset_id: asset_prompt(asset_id, asset, package, style_block=style_block, elements=resolved.get(asset_id), frame=frame)
        for asset_id, asset in (package.get("assets") or {}).items()
    }
