"""B1 acceptance: the shared fixture corpus, plus the semantic rules that cannot be
expressed as a JSON fixture (non-finite numbers, path forms)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from comfyrizz_pipeline import schema as S

FIXTURES = S.repo_root() / "packages" / "schema" / "fixtures"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
ENTRIES = MANIFEST["fixtures"]
VALID = [e for e in ENTRIES if e["kind"] == "valid"]
INVALID = [e for e in ENTRIES if e["kind"] == "invalid"]


def load(entry):
    return json.loads((FIXTURES / entry["file"]).read_text(encoding="utf-8"))


def test_corpus_is_not_trivial():
    assert len(ENTRIES) >= 30, "the corpus should cover every rule"
    assert len(VALID) >= 4
    assert len(INVALID) >= 25


@pytest.mark.parametrize("entry", ENTRIES, ids=[e["file"] for e in ENTRIES])
def test_fixture_matches_declared_expectation(entry):
    result = S.validate_package(load(entry))
    codes = sorted(e["code"] for e in result["semantic"])
    assert result["schemaOk"] is entry["schemaOk"], f"{entry['file']}: structural verdict {result['schemaOk']} != declared {entry['schemaOk']}"
    assert codes == sorted(entry["semantic"]), f"{entry['file']}: semantic codes {codes} != declared {entry['semantic']}"
    for code in entry.get("schemaCodes") or []:
        assert code in {e["code"] for e in result["errors"] if e["source"] == "schema"}, (
            f"{entry['file']}: declared structural code {code} not reported"
        )
    if entry["warnings"] is not None:
        warnings = sorted(w["code"] for w in result["warnings"])
        assert warnings == sorted(entry["warnings"]), f"{entry['file']}: warnings {warnings} != declared {entry['warnings']}"
    expected_valid = entry["schemaOk"] and not entry["semantic"]
    assert result["valid"] is expected_valid


def test_every_semantic_code_is_exercised():
    covered = {code for entry in ENTRIES for code in entry["semantic"]}
    assert set(S.SEMANTIC_CODES) == covered, f"uncovered rules: {set(S.SEMANTIC_CODES) - covered}"


def test_spec_6_3_example_validates():
    doc = json.loads((FIXTURES / "valid" / "spec-6.3-example.json").read_text(encoding="utf-8"))
    result = S.validate_package(doc)
    assert result["valid"], result["errors"]
    # entities from the section: five layouts defined, two asset kinds plus generated kinds
    assert doc["assets"]["a_plate1"]["kind"] == "video"
    assert doc["assets"]["a_logo"]["kind"] == "svg"
    assert doc["assets"]["a_plate1"]["gen"]["generator"] == "ltx25"
    assert doc["assets"]["a_plate1"]["model_license"]["id"] == "LTX-2.x-Community"
    assert doc["assets"]["a_plate1"]["license"]["id"] == "CC0-1.0"


@pytest.mark.parametrize("layout", ["title", "hero", "stat", "chart", "list"])
def test_every_layout_appears_in_a_valid_fixture(layout):
    seen = False
    for entry in VALID:
        doc = load(entry)
        if any(scene.get("layout") == layout for scene in doc.get("scenes", [])):
            seen = True
    assert seen, f"no valid fixture uses the {layout} layout"


def test_non_finite_number_is_reported():
    doc = load(VALID[0])
    doc["datasets"] = {"d_bad": {"unit": "x", "values": [{"label": "a", "value": float("nan")}], "source": "user"}}
    result = S.validate_package(doc)
    assert "SEM_NUMBER_NOT_FINITE" in {e["code"] for e in result["semantic"]}
    assert math.isnan(doc["datasets"]["d_bad"]["values"][0]["value"])  # sanity: the probe really is NaN


@pytest.mark.parametrize(
    "value,expected",
    [
        ("assets/a.png", None),
        ("out/final.mp4", None),
        ("/etc/passwd", "absolute path"),
        ("~/secrets.txt", "home-relative path"),
        ("C:/windows/thing.png", "Windows drive path"),
        ("assets\\a.png", "backslash separator"),
        ("../outside.mp4", "parent-directory traversal"),
        ("assets/../../outside.mp4", "parent-directory traversal"),
        ("https://example.com/a.png", "URL where a relative path is expected"),
        ("assets//a.png", "empty path segment"),
        ("./assets/a.png", "leading ./ is noise; use a clean relative path"),
        ("", "empty path"),
        (None, "empty path"),
        (12, "empty path"),
    ],
)
def test_path_problem_table(value, expected):
    assert S.path_problem(value) == expected


def test_layout_limits_are_published_and_enforced():
    doc = load(VALID[0])
    doc["scenes"][0]["copy"]["headline"] = "x" * (S.LAYOUTS["title"]["limits"]["headline"] + 1)
    result = S.validate_package(doc)
    assert [e["code"] for e in result["semantic"]] == ["SEM_COPY_TOO_LONG"]
    assert "title" in S.LAYOUTS and S.LAYOUTS["chart"]["requiresData"] is True


def test_apply_defaults_fills_generated_first_defaults():
    doc = json.loads((FIXTURES / "valid" / "defaults-unfilled.json").read_text(encoding="utf-8"))
    out = S.apply_defaults(doc)
    asset = out["assets"]["a_bg"]
    assert asset["license"] == {"id": "CC0-1.0"}
    assert asset["redistributable"] is True
    assert asset["cutout"] is False
    scene = out["scenes"][0]
    assert scene["locked"] is False
    assert scene["transitionOut"] == {"type": "fade", "frames": 15}
    assert scene["background"]["fit"] == "cover"
    assert scene["background"]["loop"] is True
    assert scene["foreground"][0]["anim"] == "none"
    assert out["datasets"]["d_maybe"]["approved"] is False
    # pure: the input document is untouched
    assert "license" not in doc["assets"]["a_bg"]


def test_validator_does_not_depend_on_network():
    # jsonschema must resolve the local $refs from the file itself
    result = S.validate_package(load(VALID[0]))
    assert result["schemaOk"], result["errors"]
