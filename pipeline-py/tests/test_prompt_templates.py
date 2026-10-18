"""R1: the reference-edit caption, the per-package style block and the plate motion prompts.

Every assertion here is tied to something measured: the anchor rows come from the SVG element bboxes
(BFL documents boxes of about 40x25 px as too small), the reference-edit caption follows BFL's own i2i
shape (scope -> end state only -> one clause naming what stays), and the motion prompts state the
framing lock because LTX-2.5 ignored "static, locked-off camera" on the overnight run (EXAMPLES.md).

CPU only, no network, no GPU, no Google Colab.
"""

from __future__ import annotations

import json
import re

import pytest

from svgguide.templates import (
    FORBIDDEN_MOTION,
    FRAMING_LOCK,
    MAX_EDIT_ELEMENTS,
    MOTION_ROLES,
    MOTION_TEMPLATES,
    REF_EDIT_ROLES,
    render_motion_caption,
    render_ref_edit_caption,
    render_style_block,
)
from svgguide.templates import anchor_rows, to_box_row

FRAME = (1024, 576)
ELEMENTS = [
    {"id": "panel_1", "bbox": (512, 0, 128, 288), "desc": "left panel", "colour": "#6d8cff"},
    {"id": "arrow_1", "bbox": (0, 288, 1024, 64), "desc": "curved arrow"},
]
PALETTE = ["#0d0f14", "#6d8cff", "#e6e8ee"]


def test_the_style_block_is_one_verbatim_string_per_package():
    block = render_style_block(palette=PALETTE)

    assert block == render_style_block(palette=PALETTE), "a style block has to be reproducible"
    assert block.startswith("Cinematic"), block
    for colour in PALETTE:
        assert colour in block
    with pytest.raises(ValueError):
        render_style_block(palette=[])
    with pytest.raises(ValueError):
        render_style_block(style="vaporwave", palette=PALETTE)


def test_a_bbox_becomes_an_anchor_row_on_the_0_1000_scale():
    # x=512 y=0 w=128 h=288 in a 1024x576 frame: right half, top half
    assert to_box_row((512, 0, 128, 288), FRAME) == [0, 500, 500, 625]
    assert to_box_row((0, 0, 1024, 576), FRAME) == [0, 0, 1000, 1000]

    with pytest.raises(ValueError):
        to_box_row((0, 0, 0, 10), FRAME)
    with pytest.raises(ValueError):
        to_box_row((0, 0, 10, 10), (0, 576))


def test_anchor_rows_carry_position_size_and_colour_for_every_element():
    rows = anchor_rows(ELEMENTS, FRAME)

    assert [row["id"] for row in rows] == ["panel_1", "arrow_1"]
    assert rows[0]["src_bbox"] == rows[0]["tgt_bbox"], "a reference edit keeps the layout: source and target agree"
    assert rows[0]["from"] == "ref_image_0"
    assert rows[0]["colour"] == "#6d8cff"
    assert rows[1]["desc"] == "curved arrow"
    assert "colour" not in rows[1]


def test_too_many_elements_is_refused_rather_than_half_listed():
    many = [{"id": f"e{index}", "bbox": (0, 0, 100, 100)} for index in range(MAX_EDIT_ELEMENTS + 1)]

    with pytest.raises(ValueError, match="more than one edit should carry"):
        anchor_rows(many, FRAME)


def test_the_reference_edit_caption_takes_the_scope_then_the_end_state_then_what_stays():
    caption = render_ref_edit_caption(
        "diagram",
        ELEMENTS,
        style_block=render_style_block(palette=PALETTE),
        palette=PALETTE,
        frame=FRAME,
        text_safe_regions=["the lower third"],
    )
    text = caption.text

    assert text.startswith("Convert the entire image <ref_image_0> into Cinematic"), text
    assert "The same diagram as physical objects" in text
    # one clause per element, phrased as an end state, never as a change
    assert "The left panel <panel_1> keeps its exact position and size in #6d8cff." in text
    assert "The curved arrow <arrow_1> keeps its exact position and size." in text
    assert "Keep every element at the same position, size, count and colour family, add nothing and remove nothing" in text
    assert "the lower third" in text
    assert "no lettering, no numbers and no watermark" in text
    # the rows travel as JSON after the text, which is how BFL's own i2v prompt shows them
    rows = json.loads(text[text.rindex('[{"'):])
    assert rows[0]["id"] == "panel_1" and rows[0]["tgt_bbox"] == [0, 500, 500, 625]
    assert caption.template_id == "ref-edit/diagram"
    # nothing in an edit prompt asks for a verb of change
    assert not re.search(r"\bbecomes a\b|\bturns into\b|\badds a\b", text), text
    with pytest.raises(ValueError):
        render_ref_edit_caption("portrait", ELEMENTS, style_block="x")


def test_every_motion_role_locks_the_frame_and_asks_for_no_camera_move():
    assert set(MOTION_ROLES) == {"diagram", "ui-board", "chart-backdrop", "background-loop", "hero-idle"}
    for role in MOTION_ROLES:
        text = render_motion_caption(role).text
        assert FRAMING_LOCK in text, role
        assert re.match(r"^Static", text), role
        assert not re.search(FORBIDDEN_MOTION, text), role
        assert text == render_motion_caption(role).text, f"{role} must be deterministic"
        assert render_motion_caption(role).template_id == f"i2v/{role}"


def test_the_motion_templates_are_the_screened_ones():
    # the templates are the only motion prompts the product ships, so a forbidden camera move has to
    # be caught here rather than on a GPU run
    for role, template in MOTION_TEMPLATES.items():
        rendered = template.format(lock=FRAMING_LOCK)
        assert not re.search(FORBIDDEN_MOTION, rendered), role
        assert "{lock}" in template, role


def test_a_motion_prompt_can_carry_the_subject_clause():
    text = render_motion_caption("diagram", subject="the tube glows brighter at the midpoint").text

    assert text.endswith("the tube glows brighter at the midpoint.")
    assert FRAMING_LOCK in text
