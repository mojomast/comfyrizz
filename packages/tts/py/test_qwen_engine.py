"""R3 step 1: Qwen3-TTS is optional, one design per package, one call per scene.

The fake returns a tone whose length is ``words * seconds_per_word``. No weights
are downloaded and the real adapter is only asked to report that it is absent.
"""
import json

import numpy as np
import pytest

from narrate_qwen import FallbackToKokoro, narrate_qwen
from qwen import (
    SAMPLE_RATE,
    Qwen3Tts,
    QwenRuntimeUnavailable,
    qwen_language_name,
    resolve_engine,
    strict_voice,
    to_sample_rate,
)
from synth import SAMPLE_RATE as KOKORO_RATE
from words import word_timings


def tone(seconds: float, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    count = max(1, int(round(seconds * sample_rate)))
    timeline = np.arange(count, dtype=np.float32) / sample_rate
    return (0.2 * np.sin(2 * np.pi * 440.0 * timeline)).astype(np.float32)


class FakeTts:
    def __init__(self, seconds_per_word: float = 0.5):
        self.seconds_per_word = seconds_per_word
        self.design_calls = []
        self.synth_calls = []

    def design(self, *, persona, lang, reference_line):
        prompt = {"voice_clone_prompt": {"persona": persona, "lang": lang, "ref_text": reference_line}}
        self.design_calls.append({"persona": persona, "lang": lang, "reference_line": reference_line, "prompt": prompt})
        return prompt

    def synthesize(self, text, *, prompt, instruct, lang, seed):
        self.synth_calls.append({"text": text, "prompt": prompt, "instruct": instruct, "lang": lang, "seed": seed})
        words = max(1, len(text.split()))
        return tone(words * self.seconds_per_word), SAMPLE_RATE


def package(scenes, **voice):
    base = {
        "enabled": True,
        "engine": "qwen3-tts",
        "voice": "af_heart",
        "speed": 1.0,
        "persona": "warm narrator, measured pace",
    }
    base.update(voice)
    return {"voice": base, "scenes": scenes}


def test_missing_engine_stays_on_kokoro_and_only_qwen_selects_the_adapter():
    assert resolve_engine({}) == "kokoro"
    assert resolve_engine({"engine": "kokoro"}) == "kokoro"
    assert resolve_engine({"engine": "none"}) == "kokoro"
    assert resolve_engine({"engine": "qwen3-tts"}) == "qwen3-tts"
    assert strict_voice({}) is False
    assert strict_voice({"strict": False}) is False
    assert strict_voice({"strict": True}) is True


def test_language_is_english_or_french():
    assert qwen_language_name({}) == "English"
    assert qwen_language_name({"lang": "en"}) == "English"
    assert qwen_language_name({"lang": "fr"}) == "French"
    assert qwen_language_name({"language": "fr-fr"}) == "French"
    assert qwen_language_name({"lang": "en", "language": "fr-fr"}) == "English"
    assert qwen_language_name({"language": "en-gb"}) == "English"


def test_sample_rate_matches_kokoro_and_resample_keeps_the_duration():
    assert SAMPLE_RATE == KOKORO_RATE == 24_000
    audio = np.ones(16_000, dtype=np.float32)
    assert len(to_sample_rate(audio, 16_000, 24_000)) == 24_000
    assert len(to_sample_rate(audio, SAMPLE_RATE)) == len(audio)


def test_real_adapter_is_unavailable_and_does_not_fetch_weights():
    adapter = Qwen3Tts()
    assert adapter.available() is False
    with pytest.raises(QwenRuntimeUnavailable):
        adapter.design(persona="warm narrator", lang="English", reference_line="Hello.")


def test_voice_design_once_then_one_clone_per_scene(tmp_path):
    tts = FakeTts()
    doc = package(
        [
            {"id": "s1", "narration": "One package. One finished video.", "narration_style": "calm, slightly amused"},
            {"id": "s2", "narration": "Kokoro runs on the CPU.", "narration_style": "bright"},
        ],
        lang="fr",
    )
    out = tmp_path / "audio"
    report = narrate_qwen(doc, out, tts=tts)
    assert len(tts.design_calls) == 1
    assert tts.design_calls[0]["persona"] == "warm narrator, measured pace"
    assert tts.design_calls[0]["lang"] == "French"
    assert len(tts.synth_calls) == 2
    assert tts.synth_calls[0]["prompt"] is tts.synth_calls[1]["prompt"]
    assert tts.synth_calls[0]["text"] == "One package. One finished video."
    assert tts.synth_calls[0]["instruct"] == "calm, slightly amused"
    assert tts.synth_calls[0]["lang"] == "French"
    assert tts.synth_calls[1]["text"] == "Koh koh roh runs on the C P U."
    assert tts.synth_calls[1]["seed"] != tts.synth_calls[0]["seed"]

    chunks = report["scenes"]["s1"]["chunks"]
    assert [chunk["text"] for chunk in chunks] == ["One package.", "One finished video."]
    assert report["gapSeconds"] == 0.0
    assert report["engine"] == "qwen3-tts"
    assert report["sampleRate"] == 24_000
    assert report["lang"] == "French"
    speech = round(sum(chunk["seconds"] for chunk in chunks), 4)
    assert report["scenes"]["s1"]["seconds"] == pytest.approx(speech + report["paddingSeconds"], abs=0.02)
    spoken_chunk = report["scenes"]["s2"]["chunks"][0]
    assert spoken_chunk["text"] == "Kokoro runs on the CPU."
    assert spoken_chunk["spoken"] == "Koh koh roh runs on the C P U."
    assert [word["text"] for word in spoken_chunk["words"]] == ["Kokoro", "runs", "on", "the", "CPU."]
    assert spoken_chunk["words"][0]["start"] == 0.0
    assert spoken_chunk["words"][-1]["end"] == spoken_chunk["seconds"]
    assert spoken_chunk["words"] == word_timings(spoken_chunk["text"], spoken_chunk["seconds"])
    assert (out / "narration" / "s1.wav").is_file()
    saved = json.loads((out / "durations.json").read_text())
    assert saved["scenes"]["s2"]["chunks"][0]["text"] == "Kokoro runs on the CPU."


def test_unavailable_runtime_falls_back_to_the_injected_kokoro(tmp_path):
    class Missing:
        def available(self):
            return False

    def kokoro():
        return {"engine": "kokoro-onnx", "scenes": {}}

    report = narrate_qwen(package([{"id": "s1", "narration": "Hello there."}]), tmp_path / "audio", tts=Missing(), kokoro_runner=kokoro)
    assert report["engine"] == "kokoro-onnx"
    assert report["engineFallback"] == "kokoro"
    assert report["requestedEngine"] == "qwen3-tts"
    assert not (tmp_path / "audio" / "durations.json").exists()


def test_strict_mode_fails_instead_of_falling_back(tmp_path):
    class Missing:
        def available(self):
            return False

    doc = package([{"id": "s1", "narration": "Hello there."}], strict=True)
    with pytest.raises(SystemExit, match="strict"):
        narrate_qwen(doc, tmp_path / "audio", tts=Missing(), kokoro_runner=lambda: {"engine": "kokoro-onnx"})


def test_synth_receives_the_fallback_signal_when_no_runner_is_injected(tmp_path):
    class Missing:
        def available(self):
            return False

    with pytest.raises(FallbackToKokoro):
        narrate_qwen(package([{"id": "s1", "narration": "Hello there."}]), tmp_path / "audio", tts=Missing())
