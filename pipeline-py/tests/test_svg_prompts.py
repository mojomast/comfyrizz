"""R1: the package-level prompt builder.

`templates.py` renders captions; this is the layer that decides which caption each asset gets, reads
the boxes out of the asset's own SVG, and keeps exactly one style block for the whole package.
"""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from svgguide import STATIC_ROLES, build_asset_prompts, element_boxes
from svgguide.prompts import install_prompts, main as prompts_main
from svgguide.templates import FRAMING_LOCK, MOTION_ROLES, REF_EDIT_ROLES

REPO = Path(__file__).resolve().parents[2]
LAUNCH_DEMO = REPO / "examples" / "launch-demo"

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <defs><rect id="not-a-shape-instance" x="0" y="0" width="4" height="4"/></defs>
  <rect id="box" x="10" y="20" width="30" height="40" fill="#112233"><desc>a box</desc></rect>
  <circle id="dot" cx="100" cy="50" r="10" fill="#445566"/>
  <polygon id="wedge" points="150,10 180,10 165,40" fill="#778899"/>
  <path id="curve" d="M 20 80 L 60 80" fill="none" stroke="#000000"/>
  <text id="label" x="5" y="95">ignored</text>
</svg>
"""


def package(**overrides):
    doc = {
        "$schema": "https://comfyrizz.example/schema/package-v1.json",
        "schemaVersion": 1,
        "revision": 1,
        "id": "pkg_prompts",
        "title": "Prompts",
        "createdAt": "2026-10-18T00:00:00.000Z",
        "format": {"width": 1920, "height": 1080, "fps": 24},
        "duration": {"mode": "flexible", "flexibleCeilingFrames": 2700},
        "theme": {"palette": ["#0d0f14", "#6d8cff", "#f4f6fb"], "font": "Inter"},
        "voice": {"enabled": False, "engine": "none"},
        "datasets": {},
        "scenes": [],
        "assets": {},
        "compliance": {
            "open_weights_only": True,
            "llm": {"provider": "local-agent", "model": "llm-svg", "weights": "open"},
            "backends_used": [],
            "closed_apis_used": [],
            "warnings": [],
        },
    }
    doc.update(overrides)
    return doc


def test_element_boxes_reads_the_shapes_and_skips_the_rest() -> None:
    boxes = element_boxes(SVG)
    by_id = {entry["id"]: entry for entry in boxes}

    # a defs child is not drawn: it must not appear
    assert "not-a-shape-instance" not in by_id
    assert "label" not in by_id, "text has no box we can trust, so it is not offered as one"
    assert by_id["box"]["bbox"] == [10, 20, 30, 40]
    assert by_id["box"]["desc"] == "a box"
    assert by_id["box"]["fill"] == "#112233"
    assert by_id["dot"]["bbox"] == [90, 40, 20, 20]
    assert by_id["wedge"]["bbox"] == [150, 10, 30, 30]
    # a straight path is exact apart from the documented stroke allowance
    assert by_id["curve"]["bbox"] == [16, 76, 48, 8]


def test_bad_xml_is_a_refusal_not_a_crash() -> None:
    with pytest.raises(ValueError, match="not well-formed"):
        element_boxes("<svg><rect")


def test_only_a_hero_plate_may_move() -> None:
    # the mirror of packages/jobs/src/defaults.mjs STATIC_MOTION_ROLES, in this module's role names:
    # every motion role except the hero plate holds the frame
    assert set(STATIC_ROLES) == set(MOTION_ROLES) - {"hero-idle"}
    assert STATIC_ROLES[0] == "diagram"
    # and each of them is a role the flat SVG can also be edited as, so one role really does drive both
    assert set(STATIC_ROLES) - {"background-loop"} <= set(REF_EDIT_ROLES)


def test_every_asset_of_the_launch_demo_gets_a_decision_and_one_style_block() -> None:
    doc = json.loads((LAUNCH_DEMO / "package.json").read_text(encoding="utf-8"))
    prompts = build_asset_prompts(doc, package_dir=LAUNCH_DEMO)

    assert set(prompts) == set(doc["assets"]), "every asset has a prompt or an explicit reason it has none"
    renderable = {name: entry for name, entry in prompts.items() if entry["text"]}
    assert renderable, "the launch demo has assets to render"
    style_blocks = {entry["styleBlock"] for entry in renderable.values()}
    assert len(style_blocks) == 1, "one style block per package, verbatim (research 1.5)"
    block = style_blocks.pop()
    for name, entry in renderable.items():
        assert block in entry["text"], f"{name} does not carry the package's style block"

    # a still carries the package's style block; a plate carries the frame lock instead, because its
    # template is a motion paragraph, not a style statement
    for name, entry in renderable.items():
        if entry["templateId"].startswith("i2v/"):
            assert FRAMING_LOCK in entry["text"], f"{name} is a plate without a framing statement"
        else:
            assert block in entry["text"], f"{name} is a still without the style block"

    # the SVG assets are reference edits with the boxes read out of their own files
    svg_assets = {name for name, asset in doc["assets"].items() if asset.get("kind") == "svg"}
    assert svg_assets
    for name in svg_assets:
        assert prompts[name]["templateId"].startswith("ref-edit/"), f"{name} is not a reference edit"
        assert prompts[name]["anchorRows"] >= 1, f"{name} was built with no element rows"


def test_a_static_plate_is_told_to_hold_the_frame_and_a_hero_plate_is_not() -> None:
    doc = package(
        assets={
            "a_board": {"kind": "video", "gen": {"role": "ui-board", "motion": True}},
            "a_hero": {"kind": "video", "gen": {"role": "hero-idle", "motion": True}},
        }
    )
    prompts = build_asset_prompts(doc)

    assert prompts["a_board"]["framingLock"] is True
    assert FRAMING_LOCK in prompts["a_board"]["text"]
    # every motion template mentions the locked frame; what differs is whether the *planner* holds this
    # role still, which is what the flag reports (a hero plate keeps its own strength and length)
    assert prompts["a_hero"]["framingLock"] is False
    assert prompts["a_hero"]["templateId"] == "i2v/hero-idle"


def test_a_hand_written_prompt_is_never_replaced() -> None:
    doc = package(
        assets={
            "a_icon": {"kind": "svg", "gen": {"role": "diagram", "prompt": "  keep my words  "}},
            "a_plate": {"kind": "video", "gen": {"role": "diagram", "motion": True}, "prompt": "and mine"},
        }
    )
    prompts = build_asset_prompts(doc)

    assert prompts["a_icon"]["text"] == "keep my words"
    assert prompts["a_icon"]["templateId"] == "explicit"
    assert prompts["a_plate"]["text"] == "and mine"


def test_the_same_package_always_builds_the_same_prompts() -> None:
    doc = package(assets={"a_icon": {"kind": "svg", "gen": {"role": "chart-backdrop"}}})
    first = build_asset_prompts(doc, elements={"a_icon": element_boxes(SVG)})
    second = build_asset_prompts(deepcopy(doc), elements={"a_icon": element_boxes(SVG)})

    assert first == second


def test_an_asset_the_builder_cannot_place_says_so() -> None:
    doc = package(assets={"a_mystery": {"kind": "mesh", "gen": {"role": "not-a-role"}}})
    prompts = build_asset_prompts(doc)

    assert prompts["a_mystery"]["text"] is None
    assert "no template" in prompts["a_mystery"]["note"]


def test_the_prompts_entry_point_prints_them_and_reports_an_asset_it_cannot_place(tmp_path: Path, capsys) -> None:
    good = tmp_path / "good.json"
    good.write_text(json.dumps(package(assets={"a_icon": {"kind": "svg", "gen": {"role": "diagram"}}})), encoding="utf-8")
    assert prompts_main(["--package", str(good), "--json"]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["a_icon"]["templateId"].startswith("ref-edit/")

    # an asset no template fits is worth a non-zero exit: a caller writing these into a package has to
    # notice that one asset was left to its own words
    poor = tmp_path / "poor.json"
    poor.write_text(json.dumps(package(assets={"a_mystery": {"kind": "mesh", "gen": {"role": "not-a-role"}}})), encoding="utf-8")
    assert prompts_main(["--package", str(poor), "--quiet"]) == 1


def test_installing_the_prompts_puts_them_where_the_planner_looks(tmp_path: Path) -> None:
    """`assets.<id>.gen.inputs.prompt` is the base prompt the planner carries (N1's channel)."""
    doc = package(
        assets={
            "a_diagram": {"kind": "svg", "gen": {"role": "diagram", "inputs": {"seed": 4}}, "file": "assets/a_diagram.svg"},
            "a_plate": {"kind": "video", "gen": {"role": "diagram", "motion": True}},
        }
    )
    prompts = build_asset_prompts(doc)
    written = install_prompts(doc, prompts)

    diagram = written["assets"]["a_diagram"]["gen"]["inputs"]
    assert diagram["prompt"] == prompts["a_diagram"]["text"]
    assert diagram["promptTemplate"].startswith("ref-edit/")
    assert diagram["promptStyleBlock"] == prompts["a_diagram"]["styleBlock"]
    assert diagram["seed"] == 4, "what was there stays there"

    plate = written["assets"]["a_plate"]["gen"]["inputs"]
    assert plate["prompt"] == prompts["a_plate"]["text"]
    assert plate["framingLock"] is True, "a static role says so, in the package too"

    # the source document is untouched: the write is a copy
    assert "gen" not in doc["assets"]["a_plate"] or "prompt" not in doc["assets"]["a_plate"].get("gen", {}).get("inputs", {})


def test_the_write_mode_refuses_to_rewrite_the_package_it_was_given(tmp_path: Path, capsys) -> None:
    path = tmp_path / "package.json"
    path.write_text(json.dumps(package(assets={"a_icon": {"kind": "svg", "gen": {"role": "diagram"}}})), encoding="utf-8")

    assert prompts_main(["--package", str(path), "--out", str(path), "--quiet"]) == 2
    assert "never rewrites" in capsys.readouterr().err

    target = tmp_path / "with-prompts.json"
    assert prompts_main(["--package", str(path), "--out", str(target), "--quiet"]) == 0
    written = json.loads(target.read_text(encoding="utf-8"))
    assert written["assets"]["a_icon"]["gen"]["inputs"]["prompt"]
    assert json.loads(path.read_text(encoding="utf-8"))["assets"]["a_icon"]["gen"].get("inputs") is None, "the original is untouched"
