"""Package-v1 lyric cues, source-trim rules, and JavaScript/Python parity."""

from __future__ import annotations

import copy
import json
import subprocess

import pytest

from comfyrizz_pipeline import schema as S
from conftest import REPO_ROOT


FIXTURES = REPO_ROOT / "packages" / "schema" / "fixtures"


def lyric_package() -> dict:
    return json.loads((FIXTURES / "valid" / "music-lyrics.json").read_text(encoding="utf-8"))


def semantic_pairs(doc: dict) -> list[tuple[str, str]]:
    return [(error["code"], error["path"]) for error in S.validate_package(doc)["semantic"]]


def javascript_semantic_pairs(doc: dict) -> list[tuple[str, str]]:
    script = """
import { semanticCheck } from './packages/schema/src/semantic.mjs';
const report = semanticCheck(JSON.parse(process.argv[1]));
console.log(JSON.stringify(report.errors.map(error => [error.code, error.path])));
"""
    run = subprocess.run(
        ["node", "--input-type=module", "--eval", script, json.dumps(doc)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert run.returncode == 0, run.stderr
    return [tuple(item) for item in json.loads(run.stdout)]


def test_valid_lyric_fixture_and_absent_style_default_compatibility():
    doc = lyric_package()
    result = S.validate_package(doc)
    assert result["valid"], result["errors"]
    assert result["document"]["audio"]["lyricsStyle"] == "reel"
    assert "endSeconds" not in doc["audio"]["lyrics"][1]

    old = json.loads((FIXTURES / "valid" / "audio-mix.json").read_text(encoding="utf-8"))
    before = copy.deepcopy(old)
    normalised = S.apply_defaults(old)
    assert old == before
    assert "lyricsStyle" not in normalised["audio"]
    assert "lyrics" not in normalised["audio"]
    assert S.validate_package(old)["valid"], "old audio without trim/lyrics remains valid"


@pytest.mark.parametrize("style", ["off", "caption", "reel"])
def test_lyrics_style_and_music_trim_rules(style):
    doc = lyric_package()
    doc["audio"]["lyricsStyle"] = style
    assert S.validate_package(doc)["valid"]

    doc["audio"]["lyrics"] = []
    if style == "off":
        assert S.validate_package(doc)["valid"]
    else:
        assert semantic_pairs(doc) == [("SEM_LYRICS_INVALID", "/audio/lyrics")]

    doc = lyric_package()
    del doc["audio"]["music"]["trim"]
    assert semantic_pairs(doc) == [("SEM_LYRICS_MUSIC_REQUIRED", "/audio/music/trim")]
    assert "SEM_LYRICS_MUSIC_REQUIRED" in S.SEMANTIC_CODES


def test_off_with_real_cues_still_requires_their_master_song():
    doc = lyric_package()
    doc["audio"] = {"lyricsStyle": "off", "lyrics": doc["audio"]["lyrics"]}
    assert semantic_pairs(doc) == [("SEM_LYRICS_MUSIC_REQUIRED", "/audio/music")]


def test_implicit_end_word_boundary_has_exact_python_javascript_parity():
    doc = lyric_package()
    del doc["audio"]["lyrics"][0]["endSeconds"]
    doc["audio"]["lyrics"][0]["words"] = [{"startSeconds": 2.5, "text": "next cue"}]
    expected = [("SEM_LYRICS_INVALID", "/audio/lyrics/0/words/0/startSeconds")]
    assert semantic_pairs(doc) == expected
    assert javascript_semantic_pairs(doc) == expected


@pytest.mark.parametrize(
    "path,value,expected_path",
    [
        (("text",), "   ", "/audio/lyrics/0/text"),
        (("endSeconds",), 0, "/audio/lyrics/0/endSeconds"),
    ],
)
def test_blank_and_bad_end_semantics(path, value, expected_path):
    doc = lyric_package()
    doc["audio"]["lyrics"][0]["words"] = []
    doc["audio"]["lyrics"][0][path[0]] = value
    assert semantic_pairs(doc) == [("SEM_LYRICS_INVALID", expected_path)]


def test_lyric_structure_is_closed_and_start_is_required():
    doc = lyric_package()
    doc["audio"]["lyrics"][0]["unexpected"] = True
    assert S.validate_package(doc)["schemaOk"] is False
    doc = lyric_package()
    del doc["audio"]["lyrics"][0]["startSeconds"]
    assert S.validate_package(doc)["schemaOk"] is False


def test_generated_types_and_fixture_manifest_are_fresh():
    for script in [
        REPO_ROOT / "packages" / "schema" / "scripts" / "gen-types.mjs",
        FIXTURES / "build.mjs",
    ]:
        run = subprocess.run(["node", str(script), "--check"], cwd=REPO_ROOT, capture_output=True, text=True, check=False)
        assert run.returncode == 0, run.stdout + run.stderr
    manifest = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
    entries = {entry["file"]: entry for entry in manifest["fixtures"]}
    assert entries["valid/music-lyrics.json"]["semantic"] == []
    assert entries["invalid/lyrics-caption-without-cues.json"]["semantic"] == ["SEM_LYRICS_INVALID"]
    assert entries["invalid/lyrics-without-music-trim.json"]["semantic"] == ["SEM_LYRICS_MUSIC_REQUIRED"]
