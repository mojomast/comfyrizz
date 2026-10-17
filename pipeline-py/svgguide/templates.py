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


def caption_provenance(caption: Caption) -> dict:
    """The `gen.expansion` block for the package: what expanded this intent, and which template."""
    return {
        "model": "template-renderer",
        "template": "t2i",
        "template_version": caption.template_version,
        "template_id": caption.template_id,
    }
