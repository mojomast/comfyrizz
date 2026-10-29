"""Music-video audio trim/reactive schema and JS/Python semantic parity."""

from __future__ import annotations

import copy
import json
import subprocess

import pytest

from comfyrizz_pipeline import schema as S
from conftest import REPO_ROOT


def base_package():
    path = REPO_ROOT / "packages" / "schema" / "fixtures" / "valid" / "minimal.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["assets"]["a_song"] = {
        "kind": "audio",
        "origin": "upload",
        "status": "ready",
        "file": "assets/a_song.mp3",
        "sha256": "b" * 64,
        "bytes": 1234,
        "media": {
            "durationSeconds": 40,
            "codec": "mp3",
            "sampleRate": 44100,
            "channels": 2,
        },
        "source": {"provider": "upload", "id": "ref_0123456789abcdef"},
        "license": {"id": "User-Upload", "approved_by_user": True},
        "redistributable": False,
    }
    doc["audio"] = {
        "music": {
            "asset": "a_song",
            "loop": False,
            "duck": {"enabled": False},
            "trim": {"startSeconds": 0, "endSeconds": 30},
            "reactive": {"style": "waveform", "intensity": 0.8},
        }
    }
    doc["voice"] = {"enabled": False, "engine": "none"}
    return doc


def semantic_pairs(report):
    return [(error["code"], error["path"]) for error in report["semantic"]]


def test_music_video_audio_shape_and_measured_audio_metadata_validate():
    result = S.validate_package(base_package())
    assert result["valid"], result["errors"]
    music = result["document"]["audio"]["music"]
    assert music["trim"] == {"startSeconds": 0, "endSeconds": 30}
    assert music["reactive"] == {"style": "waveform", "intensity": 0.8}
    assert result["document"]["assets"]["a_song"]["media"]["sampleRate"] == 44100
    assert result["document"]["assets"]["a_song"]["media"]["channels"] == 2


@pytest.mark.parametrize("style", ["waveform", "bars"])
@pytest.mark.parametrize("intensity", [0, 1])
def test_reactive_style_and_intensity_bounds(style, intensity):
    doc = base_package()
    doc["audio"]["music"]["reactive"] = {"style": style, "intensity": intensity}
    result = S.validate_package(doc)
    assert result["valid"], result["errors"]


@pytest.mark.parametrize("reactive", [
    {"style": "spectrogram", "intensity": 0.5},
    {"style": "waveform", "intensity": -0.01},
    {"style": "bars", "intensity": 1.01},
    {"style": "waveform"},
    {"style": "waveform", "intensity": 0.5, "extra": True},
])
def test_reactive_rejects_unknown_or_out_of_range_values(reactive):
    doc = base_package()
    doc["audio"]["music"]["reactive"] = reactive
    result = S.validate_package(doc)
    assert result["schemaOk"] is False


def test_trim_order_is_semantic_in_python_and_javascript():
    doc = base_package()
    doc["audio"]["music"]["trim"] = {"startSeconds": 4, "endSeconds": 4}
    python_report = S.validate_package(doc)
    assert python_report["schemaOk"] is True
    assert semantic_pairs(python_report) == [("SEM_AUDIO_TRIM_INVALID", "/audio/music/trim")]

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
    assert [tuple(item) for item in json.loads(run.stdout)] == semantic_pairs(python_report)
    assert "SEM_AUDIO_TRIM_INVALID" in S.SEMANTIC_CODES


def test_old_package_without_music_video_fields_is_unchanged_and_valid():
    path = REPO_ROOT / "packages" / "schema" / "fixtures" / "valid" / "minimal.json"
    original = json.loads(path.read_text(encoding="utf-8"))
    before = copy.deepcopy(original)
    result = S.validate_package(original)
    assert result["valid"], result["errors"]
    assert original == before
    assert "trim" not in original.get("audio", {}).get("music", {})
    assert "reactive" not in original.get("audio", {}).get("music", {})
