"""R3 step 2: forced-aligner tokens supersede the syllable fallback.

Bad tokens are rejected by ``word_timings`` and the chunk falls back. The fake
aligner speaks ``start_ts`` / ``end_ts``, the same names Kokoro's pipeline uses.
"""
import pytest

from narrate_qwen import narrate_qwen, build_chunks
from qwen import ALIGNER_MODEL, Qwen3Aligner, QwenRuntimeUnavailable
from test_qwen_engine import FakeTts, package
from words import word_timings


class ScriptedAligner:
    def __init__(self, script):
        self.script = script
        self.calls = []

    def align(self, samples, sample_rate, text, lang):
        self.calls.append({"text": text, "lang": lang, "samples": len(samples), "sample_rate": sample_rate})
        if text not in self.script:
            raise KeyError(text)
        return self.script[text]


class BoomAligner:
    def align(self, samples, sample_rate, text, lang):
        raise RuntimeError("aligner blew up")


def test_real_aligner_is_unavailable_without_the_optional_install():
    aligner = Qwen3Aligner()
    assert aligner.available() is False
    with pytest.raises(QwenRuntimeUnavailable):
        aligner.align(b"", 24000, "Hello.", "English")


def test_aligned_tokens_supersede_the_syllable_fallback(tmp_path):
    # 2 words * 0.5s and 2 words * 0.5s -> 2.0s of speech.
    tokens = [
        {"text": "One", "start_ts": 0.0, "end_ts": 0.2},
        {"text": "package.", "start_ts": 0.2, "end_ts": 0.5},
        {"text": "One", "start_ts": 0.7, "end_ts": 1.0},
        {"text": "video.", "start_ts": 1.0, "end_ts": 2.0},
    ]
    aligner = ScriptedAligner({"One package. One video.": tokens})
    tts = FakeTts(seconds_per_word=0.5)
    doc = package([{"id": "s1", "narration": "One package. One video."}])
    report = narrate_qwen(doc, tmp_path / "audio", tts=tts, aligner=aligner)
    chunks = report["scenes"]["s1"]["chunks"]
    assert [chunk["text"] for chunk in chunks] == ["One package.", "One video."]
    assert chunks[0]["timing"] == "aligner"
    assert chunks[0]["seconds"] == 0.7
    assert chunks[0]["words"] == [
        {"text": "One", "start": 0.0, "end": 0.2},
        {"text": "package.", "start": 0.2, "end": 0.7},
    ]
    assert chunks[1]["words"][0]["start"] == 0.0
    assert chunks[1]["words"][-1]["end"] == chunks[1]["seconds"]
    assert chunks[0]["words"] != word_timings("One package.", chunks[0]["seconds"])
    assert report["aligner"] == ALIGNER_MODEL
    assert aligner.calls[0]["lang"] == "English"
    assert len(tts.synth_calls) == 1


def test_bad_tokens_are_rejected_and_the_syllable_fallback_is_used(tmp_path):
    bad = [
        {"text": "Meet", "start_ts": 0.0, "end_ts": 0.2},
        {"text": "Orbit.", "start_ts": 0.2, "end_ts": 5.0},
    ]
    aligner = ScriptedAligner({"Meet Orbit.": bad})
    report = narrate_qwen(
        package([{"id": "s1", "narration": "Meet Orbit."}]),
        tmp_path / "audio",
        tts=FakeTts(seconds_per_word=0.5),
        aligner=aligner,
    )
    chunk = report["scenes"]["s1"]["chunks"][0]
    assert chunk["timing"] == "syllable-fallback"
    assert chunk["words"] == word_timings("Meet Orbit.", chunk["seconds"])
    assert report["aligner"] == "syllable-fallback"


def test_an_aligner_error_also_falls_back(tmp_path):
    report = narrate_qwen(
        package([{"id": "s1", "narration": "Meet Orbit."}]),
        tmp_path / "audio",
        tts=FakeTts(seconds_per_word=0.5),
        aligner=BoomAligner(),
    )
    chunk = report["scenes"]["s1"]["chunks"][0]
    assert chunk["words"] == word_timings(chunk["text"], chunk["seconds"])
    assert chunk["timing"] == "syllable-fallback"


def test_real_alignment_keeps_leading_silence_and_holds_the_tail():
    chunks = build_chunks(["Twenty-two changes."], ["Twenty-two changes."], 2.0, [
        {"text": "Twenty", "start_ts": 0.2, "end_ts": 0.5},
        {"text": "two", "start_ts": 0.5, "end_ts": 0.8},
        {"text": "changes", "start_ts": 1.0, "end_ts": 1.7},
    ])
    assert chunks[0]["timing"] == "aligner"
    assert chunks[0]["words"] == [
        {"text": "Twenty-two", "start": 0.2, "end": 0.8},
        {"text": "changes.", "start": 1.0, "end": 2.0},
    ]
