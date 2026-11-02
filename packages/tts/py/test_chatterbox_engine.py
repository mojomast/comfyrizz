"""SP05: one Chatterbox graph call per line per take, with ASR take selection."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from chatterbox import synth_lines
from synth import SAMPLE_RATE, write_wav


class FakeSubmit:
    def __init__(self, out: Path, seconds: float = 1.6):
        self.out = out
        self.seconds = seconds
        self.calls: list[dict] = []

    def __call__(self, graph: dict) -> dict:
        self.calls.append(json.loads(json.dumps(graph)))
        path = self.out / f"take-{len(self.calls):03d}.wav"
        samples = np.zeros(max(1, int(round(self.seconds * SAMPLE_RATE))), dtype=np.float32)
        write_wav(path, samples)
        return {"path": str(path), "seconds": self.seconds}


class ScriptedTranscribe:
    def __init__(self, transcripts):
        self.transcripts = list(transcripts)
        self.paths: list[str] = []

    def __call__(self, path):
        self.paths.append(str(path))
        index = min(len(self.paths) - 1, len(self.transcripts) - 1)
        return self.transcripts[index]


def line(text: str, ident: str = "l1") -> dict:
    return {"id": ident, "text": text, "spoken": text}


def run(tmp_path, lines, transcripts, **options):
    out = tmp_path / "audio"
    submit = FakeSubmit(out)
    asr = ScriptedTranscribe(transcripts)
    report = synth_lines(
        lines,
        {"submit_graph": submit, "transcribe": asr, "out": out, "seed_base": 100, **options},
    )
    return report, submit, asr, out


def test_one_graph_call_per_line_and_the_first_good_take_stops(tmp_path):
    report, submit, asr, out = run(
        tmp_path,
        [line("the quick brown fox")],
        ["the quick brown fox"],
    )
    assert len(submit.calls) == 1
    assert len(asr.paths) == 1
    graph = submit.calls[0]
    assert graph["1"]["inputs"]["text"] == "the quick brown fox"
    assert graph["1"]["inputs"]["seed"] == 100
    assert "audio_prompt" not in json.dumps(graph)
    assert not any(node.get("class_type") == "LoadAudio" for node in graph.values())

    scene = report["scenes"]["l1"]
    chunk = scene["chunks"][0]
    assert chunk["text"] == "the quick brown fox"
    assert chunk["spoken"] == "the quick brown fox"
    assert chunk["seconds"] == 1.6
    assert chunk["samples"] == int(round(1.6 * SAMPLE_RATE))
    assert [word["text"] for word in chunk["words"]] == ["the", "quick", "brown", "fox"]
    assert scene["qa"]["attempts"] == 1
    assert scene["qa"]["flagged"] is False
    assert scene["qa"]["wer"] == 0.0
    assert (out / "durations.json").is_file()


def test_a_bad_take_regenerates_with_a_new_seed_then_selects_the_good_one(tmp_path):
    report, submit, asr, out = run(
        tmp_path,
        [line("the quick brown fox")],
        ["completely wrong words", "the quick brown fox"],
    )
    assert len(submit.calls) == 2
    assert submit.calls[1]["1"]["inputs"]["seed"] == submit.calls[0]["1"]["inputs"]["seed"] + 1
    assert len(asr.paths) == 2
    assert report["scenes"]["l1"]["qa"]["attempts"] == 2
    assert report["scenes"]["l1"]["qa"]["flagged"] is False
    assert report["scenes"]["l1"]["qa"]["transcript"] == "the quick brown fox"


def test_all_failed_takes_stop_after_three_rounds_and_flag_the_line(tmp_path):
    report, submit, asr, out = run(
        tmp_path,
        [line("the quick brown fox")],
        ["completely wrong", "still completely wrong", "wrong again entirely"] * 3,
    )
    # three takes, then two more rounds of three (SP05: "retries up to 2 more")
    assert len(submit.calls) == 9
    assert len(asr.paths) == 9
    qa = report["scenes"]["l1"]["qa"]
    assert qa["attempts"] == 9
    assert qa["flagged"] is True
    assert qa["reasons"]
    assert report["scenes"]["l1"]["chunks"][0]["seconds"] == 1.6


def test_takes_per_line_bounds_the_retries(tmp_path):
    report, submit, _, _ = run(
        tmp_path,
        [line("the quick brown fox")],
        ["wrong one", "wrong two", "wrong three"] * 2,
        takes_per_line=2,
    )
    assert len(submit.calls) == 6
    assert report["scenes"]["l1"]["qa"]["attempts"] == 6


def test_one_call_per_line_for_two_lines(tmp_path):
    report, submit, asr, _ = run(
        tmp_path,
        [line("the quick brown fox", "l1"), line("a second spoken line", "l2")],
        ["the quick brown fox", "a second spoken line"],
    )
    assert len(submit.calls) == 2
    assert [graph["1"]["inputs"]["text"] for graph in submit.calls] == [
        "the quick brown fox",
        "a second spoken line",
    ]
    assert submit.calls[0]["1"]["inputs"]["seed"] == 100
    assert submit.calls[1]["1"]["inputs"]["seed"] == 109
    assert list(report["scenes"]) == ["l1", "l2"]


def test_durations_json_matches_the_synth_chunk_shape(tmp_path):
    report, submit, _, out = run(
        tmp_path,
        [line("the quick brown fox")],
        ["the quick brown fox"],
    )
    saved = json.loads((out / "durations.json").read_text())
    assert saved == report
    assert saved["engine"] == "chatterbox"
    assert saved["sampleRate"] == SAMPLE_RATE
    assert saved["file"] == "narration.raw.wav"
    scene = saved["scenes"]["l1"]
    assert set(scene) >= {"chunks", "gapSeconds", "paddingSeconds", "seconds", "file"}
    chunk = scene["chunks"][0]
    assert set(chunk) >= {"text", "spoken", "seconds", "samples", "words"}
    assert scene["file"] == "audio/narration/l1.wav"
    assert (out / "narration" / "l1.wav").is_file()
    assert (out / "narration.raw.wav").is_file()


def test_voice_reference_is_opt_in_and_never_the_default(tmp_path):
    report, submit, _, _ = run(
        tmp_path,
        [line("the quick brown fox")],
        ["the quick brown fox"],
        voice_reference="/tmp/reference.wav",
    )
    graph = submit.calls[0]
    assert graph["1"]["inputs"]["audio_prompt"] == ["2", 0]
    assert graph["2"]["class_type"] == "LoadAudio"
    assert graph["2"]["inputs"]["audio"] == "/tmp/reference.wav"
    assert report["voice"] == "/tmp/reference.wav"


def test_plain_string_lines_and_narration_scene_fields_are_accepted(tmp_path):
    report, submit, _, _ = run(
        tmp_path,
        ["the quick brown fox", {"id": "s2", "narration": "a second spoken line"}],
        ["the quick brown fox", "a second spoken line"],
    )
    assert len(submit.calls) == 2
    assert list(report["scenes"]) == ["line_001", "s2"]
    assert report["scenes"]["s2"]["chunks"][0]["text"] == "a second spoken line"
