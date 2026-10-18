"""Prompt-template library v0 (E1): a layout role, a visual direction and the palette become one
full Klein caption.

FLUX 3 Image Klein's model card is explicit: "Do not use the model without a prompt upsampler",
because Klein needs **full scene captions** (SPEC.md 6.4). The agent's LLM expansion (C3) is the
real upsampler; this template renderer is the deterministic fallback and the thing the captions
are versioned against, so a retry reuses the stored caption instead of re-expanding it.

Every caption carries: the role, the intent, the palette, and the text-safe regions - the parts
of the frame the renderer will overlay with copy, which the image must leave quiet.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

TEMPLATES_VERSION = "0.1.0"

LAYOUT_ROLES = ("hero-subject", "background-plate", "texture", "icon-illustration")

STYLES = {
    "cinematic": "cinematic lighting, shallow depth of field, high dynamic range",
    "editorial": "clean editorial photography, even light, high detail, neutral colour",
    "technical": "isometric technical illustration, crisp edges, flat shading",
    "organic": "organic hand-painted look, soft gradients, subtle grain",
}
LIGHTING = {
    "soft": "soft diffused key light, gentle falloff, no hard shadows",
    "dramatic": "single dramatic key light with deep shadows and a bright rim",
    "ambient": "flat ambient light with no strong direction",
}
MATERIALS = {
    "matte": "matte surfaces, low specularity",
    "glossy": "glossy surfaces with restrained highlights",
    "metallic": "brushed metal accents with controlled reflections",
    "paper": "paper and ink textures, fine fibrous detail",
}
ROLE_PHRASES = {
    "hero-subject": "a single clear subject as the hero of the frame, centred and fully inside the frame with margin around it",
    "background-plate": "a wide atmospheric background with no focal subject, depth layered from foreground haze to distant forms",
    "texture": "a seamless full-frame surface texture with even coverage and no focal point",
    "icon-illustration": "a simple flat illustration of one idea, thick consistent strokes, minimal detail",
}


@dataclass(frozen=True)
class Caption:
    text: str
    template_id: str
    template_version: str
    role: str
    style: str
    lighting: str
    material: str
    palette: tuple[str, ...]
    text_safe_regions: tuple[str, ...]


def render_caption(
    role: str,
    intent: str,
    palette: list[str] | tuple[str, ...],
    text_safe_regions: list[str] | tuple[str, ...] = (),
    *,
    style: str = "cinematic",
    lighting: str = "soft",
    material: str = "matte",
    extra: list[str] | tuple[str, ...] = (),
) -> Caption:
    """Render one caption. Deterministic: the same arguments always produce the same text."""
    if role not in LAYOUT_ROLES:
        raise ValueError(f"unknown layout role {role!r}; expected one of {', '.join(LAYOUT_ROLES)}")
    if style not in STYLES:
        raise ValueError(f"unknown style {style!r}; expected one of {', '.join(STYLES)}")
    if lighting not in LIGHTING:
        raise ValueError(f"unknown lighting {lighting!r}; expected one of {', '.join(LIGHTING)}")
    if material not in MATERIALS:
        raise ValueError(f"unknown material {material!r}; expected one of {', '.join(MATERIALS)}")
    palette = tuple(palette or ())
    text_safe_regions = tuple(text_safe_regions or ())
    if not palette:
        raise ValueError("a caption needs at least one palette colour")

    pieces = [
        f"{ROLE_PHRASES[role]}.",
        str(intent).strip().rstrip(".") + "." if str(intent).strip() else "",
        f"{STYLES[style]}.",
        f"{LIGHTING[lighting]}.",
        f"{MATERIALS[material]}.",
        f"Colour palette: {', '.join(palette)}.",
    ]
    if text_safe_regions:
        pieces.append(
            "Keep these regions free of detail and high contrast for overlaid text: "
            + ", ".join(text_safe_regions)
            + "."
        )
    pieces.append("No text, no lettering, no watermark and no logo anywhere in the image.")
    for item in extra:
        if str(item).strip():
            pieces.append(str(item).strip().rstrip(".") + ".")
    text = " ".join(piece for piece in pieces if piece)

    template_id = f"{role}/{style}+{lighting}+{material}"
    return Caption(
        text=text,
        template_id=template_id,
        template_version=TEMPLATES_VERSION,
        role=role,
        style=style,
        lighting=lighting,
        material=material,
        palette=palette,
        text_safe_regions=text_safe_regions,
    )


# --- R1: reference-edit captions, the per-package style block, and plate motion prompts ----------
#
# Research section 1 came out of GPU tests 2 and 3 and the overnight run (EXAMPLES.md). Three facts
# drive everything below, and each one is a measured failure rather than a preference:
#   * A reference edit is Klein's native conditioning, and its prompt "writes the result, not the
#     change", opens by naming the scope and closes with the one clause saying what stays put.
#   * Box rows (`[top, left, bottom, right]` on 0-1000) are the only placement control Klein has
#     besides the reference itself; they are generated from the SVG element bboxes.
#   * LTX-2.5 i2v ignored "static, locked-off camera" and pushed in on the UI, diagram and flow
#     plates at strength 0.7-0.9 with 145 frames. The explicit sentence in FRAMING_LOCK, at strength
#     1.0 and 97 frames, is what held them.

#: Roles a reference edit can take (research section 1.4 D). The four t2i roles stay in LAYOUT_ROLES.
REF_EDIT_ROLES = ("diagram", "ui-board", "chart-backdrop", "icon-illustration", "hero")

#: Roles a plate's motion prompt can take (research section 1.4, LTX templates).
MOTION_ROLES = ("diagram", "ui-board", "chart-backdrop", "background-loop", "hero-idle")

#: The sentence that held the frame where "static camera" did not (EXAMPLES.md, overnight GPU run).
FRAMING_LOCK = "the frame and framing never change"

#: What a reference edit turns the flat SVG into, per role (one clause, end state only).
REF_EDIT_PHRASES = {
    "diagram": "the same diagram as physical objects: every block a solid slab and every connector a glowing tube",
    "ui-board": "the same interface board as real cards and panels standing in space",
    "chart-backdrop": "the same chart as physical bars on a studio stage",
    "icon-illustration": "the same icon built from a few rounded volumes",
    "hero": "the same composition as a photographed hero shot",
}

#: Motion paragraphs per role (research section 1.4, LTX templates). Every one of them states the
#: framing lock, and none of them asks for a camera move: a push-in on a frame with labels pushed the
#: labels out of view in GPU test 2, and LTX does what the prompt says about stillness only when the
#: sentence is explicit.
MOTION_TEMPLATES = {
    "diagram": (
        "Static locked-off frame; the camera does not move and {lock}. Soft light pulses slowly through the glowing "
        "connectors from left to right, and the blocks breathe with a faint glow that rises and falls once every two "
        "seconds. Tiny dust motes drift upward behind them. The shapes keep their exact positions and outlines."
    ),
    "ui-board": (
        "Static locked-off frame; the camera does not move and {lock}. One highlighted card moves a short step toward "
        "its finished state and stops. The columns, labels and spacing keep their exact positions; nothing scrolls, "
        "nothing opens and no pointer appears."
    ),
    "chart-backdrop": (
        "Static frame; the camera does not move and {lock}. A faint grid of light on the floor shifts slowly and the "
        "background glow breathes once every two seconds. The bars keep their exact heights and positions."
    ),
    "background-loop": (
        "Static frame; {lock}. Translucent ribbons of light drift slowly and continuously from lower left to upper "
        "right, folding over each other; the motion is smooth and even, and the loop closes where it starts."
    ),
    "hero-idle": (
        "Static camera; {lock}. The subject breathes gently and shifts its weight once; light glints across its "
        "surface from left to right. The background stays still."
    ),
}

#: Camera moves that ruin a frame carrying labels (GPU test 2). The templates must not ask for one.
FORBIDDEN_MOTION = r"push[- ]?in|dolly[- ]?in|zoom|orbit\w*|turntable|\bpan\b|handheld"

#: The maximum number of elements Klein is asked to convert in one edit (BFL: describe a collection
#: with a count beyond about ten, rather than listing every one).
MAX_EDIT_ELEMENTS = 10


def _sentence_case(text: str) -> str:
    """Capitalise the start of each sentence, so a block reads the same in every position."""
    return re.sub(r"(^|[.!?]\s+)([a-z])", lambda match: f"{match.group(1)}{match.group(2).upper()}", text)


def render_style_block(
    *,
    style: str = "cinematic",
    lighting: str = "soft",
    material: str = "matte",
    palette: list[str] | tuple[str, ...],
) -> str:
    """One verbatim style block per package (research section 1.5).

    It is built once and reused verbatim in every caption of the package: the medium, the material
    and light, and the palette as hexes. Only the subject text changes between scenes.
    """
    for name, table, value in (("style", STYLES, style), ("lighting", LIGHTING, lighting), ("material", MATERIALS, material)):
        if value not in table:
            raise ValueError(f"unknown {name} {value!r}; expected one of {', '.join(table)}")
    hexes = [str(colour).strip() for colour in (palette or ()) if str(colour).strip()]
    if not hexes:
        raise ValueError("a style block needs at least one palette colour")
    return _sentence_case(f"{STYLES[style]}, {MATERIALS[material]}. {LIGHTING[lighting]}. Palette {', '.join(hexes)}.")


def to_box_row(bbox_px, frame) -> list[int]:
    """A pixel bbox as one Klein anchor row: `[top, left, bottom, right]` on the 0-1000 scale."""
    x, y, width, height = (float(value) for value in bbox_px)
    frame_width, frame_height = (float(value) for value in frame)
    if frame_width <= 0 or frame_height <= 0:
        raise ValueError(f"a frame size must be positive, got {frame}")
    if width <= 0 or height <= 0:
        raise ValueError(f"a bbox must have a positive size, got {bbox_px}")

    def scale(value: float, extent: float) -> int:
        return max(0, min(1000, int(round(value / extent * 1000))))

    return [scale(y, frame_height), scale(x, frame_width), scale(y + height, frame_height), scale(x + width, frame_width)]


def anchor_rows(elements, frame) -> list[dict]:
    """One anchor row per SVG element: where it is now, and where it must stay.

    `elements` are dicts with `id`, `desc`, a pixel `bbox`, and optionally `colour`. The rows are what
    research section 1.4 D puts after the caption text.
    """
    rows = []
    for element in elements or ():
        if not isinstance(element, dict) or "id" not in element or "bbox" not in element:
            raise ValueError(f"an element needs an id and a bbox, got {element!r}")
        row = to_box_row(element["bbox"], frame)
        entry = {
            "id": str(element["id"]),
            "from": "ref_image_0",
            "src_bbox": row,
            "tgt_bbox": row,
            "desc": str(element.get("desc", "")).strip(),
        }
        if element.get("colour"):
            entry["colour"] = str(element["colour"])
        rows.append(entry)
    if len(rows) > MAX_EDIT_ELEMENTS:
        raise ValueError(f"{len(rows)} elements is more than one edit should carry (max {MAX_EDIT_ELEMENTS}); describe a collection with a count instead")
    return rows


def render_ref_edit_caption(
    role: str,
    elements,
    *,
    style_block: str,
    palette: list[str] | tuple[str, ...] = (),
    frame=(1024, 576),
    text_safe_regions: list[str] | tuple[str, ...] = (),
    extra: list[str] | tuple[str, ...] = (),
) -> Caption:
    """The Klein reference-edit caption for a label-free SVG raster (research section 1.4 D).

    Three parts, in this order, because that is the order BFL's own i2i prompt uses: the scope of the
    change, one clause per element (end state only, no verbs of change), then the single compact
    sentence naming everything that stays put. The anchor rows follow as JSON.
    """
    if role not in REF_EDIT_ROLES:
        raise ValueError(f"unknown reference-edit role {role!r}; expected one of {', '.join(REF_EDIT_ROLES)}")
    rows = anchor_rows(elements, frame)
    phrase = REF_EDIT_PHRASES[role]
    pieces = [f"Convert the entire image <ref_image_0> into {style_block} {phrase[0].upper()}{phrase[1:]}."]
    for row in rows:
        description = row["desc"] or row["id"]
        colour = f" in {row['colour']}" if row.get("colour") else ""
        pieces.append(f"The {description} <{row['id']}> keeps its exact position and size{colour}.")
    pieces.append(
        "Keep every element at the same position, size, count and colour family, add nothing and remove nothing; "
        "all surfaces stay blank with no lettering, no numbers and no watermark."
    )
    if text_safe_regions:
        pieces.append(
            "Keep these regions free of detail and high contrast for overlaid text: " + ", ".join(text_safe_regions) + "."
        )
    for item in extra:
        if str(item).strip():
            pieces.append(str(item).strip().rstrip(".") + ".")
    if rows:
        pieces.append(json.dumps(rows, separators=(",", ":")))
    text = " ".join(pieces)
    return Caption(
        text=text,
        template_id=f"ref-edit/{role}",
        template_version=TEMPLATES_VERSION,
        role=role,
        style="ref-edit",
        lighting="ref-edit",
        material="ref-edit",
        palette=tuple(palette or ()),
        text_safe_regions=tuple(text_safe_regions or ()),
    )


def render_motion_caption(role: str, *, subject: str = "") -> Caption:
    """The LTX-2.5 i2v motion prompt for a plate (research section 1.4, LTX templates).

    The prompt describes what *happens*, keeping the frame locked. The strength and the 97-frame
    length that go with it are the planner's motion-role defaults (`packages/jobs/src/defaults.mjs`).
    """
    if role not in MOTION_ROLES:
        raise ValueError(f"unknown motion role {role!r}; expected one of {', '.join(MOTION_ROLES)}")
    paragraph = MOTION_TEMPLATES[role].format(lock=FRAMING_LOCK)
    if str(subject).strip():
        paragraph = f"{paragraph} {str(subject).strip().rstrip('.')}."
    return Caption(
        text=paragraph,
        template_id=f"i2v/{role}",
        template_version=TEMPLATES_VERSION,
        role=role,
        style="motion",
        lighting="motion",
        material="motion",
        palette=(),
        text_safe_regions=(),
    )


def caption_provenance(caption: Caption) -> dict:
    """The `gen.expansion` block for the package: what expanded this intent, and which template."""
    return {
        "model": "template-renderer",
        "template": "t2i",
        "template_version": caption.template_version,
        "template_id": caption.template_id,
    }
