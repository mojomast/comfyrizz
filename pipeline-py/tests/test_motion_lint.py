"""MS2: the Python mirror of lintMotion() (packages/schema/src/motion.mjs).

The TS suite runs the shared cases through both linters and compares them; these tests make
the Python side stand on its own: good and bad cases, structured findings, autofix, wiring.
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

from comfyrizz_pipeline import schema as S
from comfyrizz_pipeline.motion_lint import (
    MOTION_LINT_CODES,
    MOTION_VOCABULARY,
    TRANSITIONS,
    apply_motion_fixes,
    autofix_motion,
    lint_motion,
)

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "packages" / "schema" / "fixtures" / "valid" / "motion-fields.json"


def base() -> dict:
    return json.loads(BASE.read_text(encoding="utf-8"))


def codes(doc, **kw) -> list[tuple[str, str, str | None]]:
    return sorted((f["code"], f["severity"], f["scene"]) for f in lint_motion(doc, **kw))


def test_vocabulary_matches_the_schema():
    defs = S.load_schema()["$defs"]
    assert list(defs["easingToken"]["enum"]) == list(MOTION_VOCABULARY["easing"])
    assert list(defs["springPreset"]["enum"]) == list(MOTION_VOCABULARY["springs"])
    assert list(defs["motionEnergy"]["enum"]) == list(MOTION_VOCABULARY["energies"])
    assert list(defs["transitionType"]["enum"]) == list(MOTION_VOCABULARY["transitionTypes"])
    assert list(defs["transitionDirection"]["enum"]) == list(MOTION_VOCABULARY["transitionDirections"])
    assert list(defs["sceneMotion"]["properties"]["entry"]["enum"]) == list(MOTION_VOCABULARY["entries"])
    assert list(TRANSITIONS) == list(MOTION_VOCABULARY["transitionTypes"])


def test_motion_fields_validate_and_are_optional():
    doc = base()
    assert S.validate_package(doc)["valid"]
    legacy = base()
    legacy.pop("motion")
    for scene in legacy["scenes"]:
        scene.pop("motion", None)
        scene["transitionOut"] = {"type": "slide", "frames": 12}
    assert S.validate_package(legacy)["valid"]
    assert "motion" not in S.apply_defaults(legacy)
    partial = base()
    partial["motion"] = {"energy": "calm"}
    assert S.apply_defaults(partial)["motion"] == {"energy": "calm", "direction": "left"}


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d["scenes"][0]["transitionOut"].update(type="spin"),
        lambda d: d["scenes"][0]["transitionOut"].update(direction="sideways"),
        lambda d: d["scenes"][1]["motion"].update(entry="bounce"),
        lambda d: d["scenes"][1]["motion"].update(ease="easeInOutQuad"),
        lambda d: d["motion"].update(tempo=120),
    ],
)
def test_unknown_motion_names_are_schema_errors(mutate):
    doc = base()
    mutate(doc)
    assert not S.validate_package(doc)["schemaOk"]


def test_clean_package_lints_clean():
    assert lint_motion(base()) == []


def test_bad_cases_raise_structured_fixable_findings():
    doc = base()
    doc["scenes"][1]["transitionOut"] = {"type": "cut", "frames": 8}  # cut with overlap
    doc["scenes"][2]["transitionOut"]["direction"] = "left"  # zoom on the wrong axis
    doc["scenes"][1]["motion"]["emphasis"] = "hero"  # a second hero
    doc["scenes"][3]["preferredFrames"] = 60  # final hold too short
    found = lint_motion(doc)
    assert sorted((f["code"], f["scene"]) for f in found) == [
        ("MOTION_CUT_HAS_FRAMES", "s2"),
        ("MOTION_DIRECTION_AXIS", "s3"),
        ("MOTION_FINAL_HOLD", "s4"),
        ("MOTION_HERO_MULTIPLE", "s2"),
    ]
    for f in found:
        assert set(f) == {"code", "severity", "scene", "path", "message", "autofix", "source"}
        assert f["severity"] == MOTION_LINT_CODES[f["code"]]
        assert f["autofix"] and f["autofix"]["ops"]
    before = copy.deepcopy(doc)
    result = autofix_motion(doc)
    assert doc == before, "autofix is pure"
    assert [f for f in result["remaining"] if f["severity"] != "info"] == []
    fixed = result["document"]
    assert fixed["scenes"][1]["transitionOut"]["frames"] == 0
    assert fixed["scenes"][2]["transitionOut"]["direction"] == "in"
    assert fixed["scenes"][1]["motion"]["emphasis"] == "none"
    assert fixed["scenes"][3]["preferredFrames"] > 60
    assert S.validate_package(fixed)["valid"]


def test_ping_pong_and_budget():
    doc = base()
    doc["scenes"][1]["transitionOut"]["direction"] = "right"
    assert codes(doc) == [("MOTION_DIRECTION_PINGPONG", "warning", "s2")]
    assert autofix_motion(doc)["document"]["scenes"][1]["transitionOut"]["direction"] == "left"

    doc = base()
    extra = [copy.deepcopy(doc["scenes"][1]) for _ in range(2)]
    extra[0]["id"], extra[1]["id"] = "s5", "s6"
    doc["scenes"].extend(extra)
    doc["scenes"][3]["transitionOut"] = {"type": "wipe", "frames": 12}
    doc["scenes"][4]["transitionOut"] = {"type": "fade", "frames": 15}
    doc["scenes"][5].pop("transitionOut", None)
    assert codes(doc) == [("MOTION_TRANSITION_BUDGET", "warning", "s5")]
    assert autofix_motion(doc)["document"]["scenes"][4]["transitionOut"] == {"type": "push", "frames": 15}


def test_info_findings_have_no_autofix_and_are_not_applied():
    doc = base()
    doc["scenes"][2]["motion"].pop("emphasis")
    found = lint_motion(doc)
    assert [(f["code"], f["autofix"]) for f in found] == [("MOTION_NO_HERO", None)]
    assert apply_motion_fixes(doc, found)["applied"] == []


def test_timeline_overrides_preferred_frames():
    doc = base()
    assert codes(doc, timeline={"scenes": [{"id": "s2", "durationInFrames": 90}]}) == [("MOTION_READING_HOLD", "warning", "s2")]


def test_never_raises_on_malformed_input():
    for doc in (None, 7, "x", [], {}, {"scenes": "no"}, {"scenes": [None, 3, {"id": 9, "motion": "x", "transitionOut": {"type": 4}}]}):
        assert isinstance(lint_motion(doc), list)


def test_validate_package_and_cli_carry_the_motion_report():
    doc = base()
    doc["scenes"][1]["transitionOut"] = {"type": "cut", "frames": 8}
    result = S.validate_package(doc)
    assert result["valid"] is True, "motion findings are advisory"
    assert [f["code"] for f in result["motion"]] == ["MOTION_CUT_HAS_FRAMES"]
    run = subprocess.run(
        [sys.executable, "-m", "comfyrizz_pipeline.validate", "-", "--json"],
        input=json.dumps(doc), capture_output=True, text=True, cwd=ROOT / "pipeline-py",
    )
    assert run.returncode == 0, run.stderr
    assert [f["code"] for f in json.loads(run.stdout)["motion"]] == ["MOTION_CUT_HAS_FRAMES"]
