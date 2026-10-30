"""SPW06: Chatterbox voiceover worker uses one ComfyUI prompt per take."""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "colab") not in sys.path:
    sys.path.insert(0, str(ROOT / "colab"))

import chatterbox_narrate as narrate  # noqa: E402
from synth import SAMPLE_RATE, write_wav  # noqa: E402


class FakeComfy:
    """Writes one WAV per submitted graph and records the exact prompts."""

    def __init__(self, out: Path, seconds: float = 2.0):
        self.out = out
        self.seconds = seconds
        self.calls: list[dict] = []

    def __call__(self, graph: dict) -> dict:
        self.calls.append(copy.deepcopy(graph))
        path = self.out / f"comfy-take-{len(self.calls):03d}.wav"
        samples = np.zeros(max(1, int(round(self.seconds * SAMPLE_RATE))), dtype=np.float32)
        write_wav(path, samples)
        return {"path": str(path), "seconds": self.seconds}


class ScriptedAsr:
    def __init__(self, transcripts):
        self.transcripts = list(transcripts)
        self.paths: list[str] = []

    def __call__(self, path):
        self.paths.append(str(path))
        index = min(len(self.paths) - 1, len(self.transcripts) - 1)
        return self.transcripts[index]


def write_package(tmp_path: Path, scenes: list[dict]) -> Path:
    package = {
        "schemaVersion": 1,
        "id": "pkg_chatterbox_test",
        "title": "Chatterbox worker",
        "voice": {"enabled": True, "engine": "chatterbox"},
        "scenes": scenes,
    }
    path = tmp_path / "package.json"
    path.write_text(json.dumps(package, indent=2))
    return path


def one_scene_package(tmp_path: Path) -> Path:
    return write_package(
        tmp_path,
        [{"id": "s_intro", "narration": "The quick brown fox jumps.", "layout": "title"}],
    )


def test_collects_one_line_per_sentence_of_scene_narration():
    package = {
        "scenes": [
            {"id": "s_a", "narration": "First sentence. Second sentence!"},
            {"id": "s_b", "narration": "   "},
            {"id": "s_c", "narration": "Only one?"},
        ]
    }
    lines = narrate.collect_lines(package)
    assert [line["text"] for line in lines] == [
        "First sentence.",
        "Second sentence!",
        "Only one?",
    ]
    assert [line["scene"] for line in lines] == ["s_a", "s_a", "s_c"]
    assert lines[0]["id"] == "s_a_line_001"
    assert lines[1]["id"] == "s_a_line_002"


def test_submit_graph_posts_polls_history_and_downloads_the_saveaudio_file(tmp_path):
    posts = []
    gets = []
    downloads = []

    def post(url, payload):
        posts.append((url, payload))
        return {"prompt_id": "prompt-1"}

    def get(url):
        gets.append(url)
        if len(gets) == 1:
            return {}
        return {
            "prompt-1": {
                "outputs": {
                    "3": {
                        "audio": [
                            {"filename": "chatterbox.wav", "subfolder": "audio", "type": "output"}
                        ]
                    }
                }
            }
        }

    def download(comfy, item):
        downloads.append((comfy, item))
        path = tmp_path / "downloaded.wav"
        path.write_bytes(b"RIFF")
        return path

    graph = {"1": {"class_type": "FL_ChatterboxMultilingualTTS", "inputs": {"text": "hi", "seed": 7}}}
    path = narrate.submit_graph(
        graph,
        comfy="http://127.0.0.1:8188/",
        post=post,
        get=get,
        download=download,
        sleep=lambda _seconds: None,
    )

    assert len(posts) == 1
    assert posts[0][0] == "http://127.0.0.1:8188/prompt"
    assert posts[0][1] == {"prompt": graph}
    assert gets[0] == "http://127.0.0.1:8188/history/prompt-1"
    assert downloads == [
        (
            "http://127.0.0.1:8188",
            {"filename": "chatterbox.wav", "subfolder": "audio", "type": "output"},
        )
    ]
    assert Path(path) == tmp_path / "downloaded.wav"


def test_hallucinated_tail_take_is_rejected_and_the_clean_take_is_chosen(tmp_path):
    package_path = one_scene_package(tmp_path)
    package = json.loads(package_path.read_text())
    line = narrate.collect_lines(package)[0]
    out = tmp_path / "run"

    submit = FakeComfy(tmp_path)
    asr = ScriptedAsr(
        [
            "The quick brown fox jumps again.",
            "The quick brown fox jumps.",
        ]
    )
    result = narrate.run(
        package_path,
        out,
        submit_graph_fn=submit,
        transcribe_fn=asr,
    )

    assert len(submit.calls) == 2
    assert len(asr.paths) == 2
    assert [call["1"]["inputs"]["text"] for call in submit.calls] == [line["spoken"], line["spoken"]]
    assert len({call["1"]["inputs"]["seed"] for call in submit.calls}) == 2
    assert "audio_prompt" not in json.dumps(submit.calls)
    assert not any(node.get("class_type") == "LoadAudio" for call in submit.calls for node in call.values())

    durations = json.loads((out / "audio" / "durations.json").read_text())
    assert durations["engine"] == "chatterbox"
    assert durations["sampleRate"] == SAMPLE_RATE
    measured = durations["scenes"][line["id"]]
    assert measured["qa"]["attempts"] == 2
    assert measured["qa"]["flagged"] is False
    assert measured["qa"]["transcript"] == "The quick brown fox jumps."
    assert set(measured["chunks"][0]) >= {"text", "spoken", "seconds", "samples", "words"}
    assert (out / "audio" / "s_intro.wav").is_file()
    assert (out / "audio" / "narration" / f"{line['id']}.wav").is_file()

    take_report = json.loads((out / "audio" / "take_report.json").read_text())
    assert len(take_report["takes"]) == 2
    rejected, accepted = take_report["takes"]
    assert rejected["line"] == line["id"]
    assert rejected["status"] == "rejected"
    assert "extra-words" in rejected["reasons"]
    assert rejected["transcript"] == "The quick brown fox jumps again."
    assert accepted["status"] == "accepted"
    assert accepted["reasons"] == []
    assert accepted["transcript"] == "The quick brown fox jumps."
    assert accepted["wer"] == 0.0
    assert take_report["lines"][line["id"]]["selected"] == accepted["path"]
    assert take_report["lines"][line["id"]]["flagged"] is False
    assert result["exitCode"] == 0


def test_a_line_with_no_usable_take_flags_the_run_but_still_writes_audio(tmp_path):
    package_path = write_package(
        tmp_path,
        [{"id": "s_only", "narration": "One two three four five.", "layout": "title"}],
    )
    package = json.loads(package_path.read_text())
    line = narrate.collect_lines(package)[0]
    out = tmp_path / "run"

    submit = FakeComfy(tmp_path)
    asr = ScriptedAsr(["completely wrong words"] * 3)
    result = narrate.run(
        package_path,
        out,
        submit_graph_fn=submit,
        transcribe_fn=asr,
    )

    assert len(submit.calls) == 3
    take_report = json.loads((out / "audio" / "take_report.json").read_text())
    assert take_report["lines"][line["id"]]["flagged"] is True
    assert take_report["lines"][line["id"]]["selected"] is None
    assert [take["status"] for take in take_report["takes"]] == ["rejected", "rejected", "rejected"]
    assert result["exitCode"] == 1
    assert (out / "audio" / "s_only.wav").is_file()


def test_asr_language_strips_the_graph_code():
    import chatterbox_narrate as cn
    assert cn.asr_language("English (en)") == "English"
    assert cn.asr_language("French (fr)") == "French"
    assert cn.asr_language("") == "English"
