"""R3 step 4: transcribe the take back and retry when it was mispronounced."""
from qa import WER_LIMIT, missing_pronunciations, should_regenerate, wer
from narrate_qwen import narrate_qwen
from qwen import Qwen3Asr, QwenRuntimeUnavailable
from test_qwen_engine import FakeTts, package


class ScriptedAsr:
    def __init__(self, transcripts):
        self.transcripts = list(transcripts)
        self.calls = 0

    def transcribe(self, samples, sample_rate, lang):
        text = self.transcripts[min(self.calls, len(self.transcripts) - 1)]
        self.calls += 1
        return text


def test_wer_above_about_five_percent_asks_for_another_take():
    reference = " ".join(["alpha"] * 20)
    one_off = "beta " + " ".join(["alpha"] * 19)
    two_off = "beta gamma " + " ".join(["alpha"] * 18)
    assert wer(reference, reference) == 0.0
    assert abs(wer(reference, one_off) - 0.05) < 1e-9
    assert WER_LIMIT == 0.05
    assert should_regenerate(reference, one_off) is False
    assert should_regenerate(reference, two_off) is True


def test_a_missing_pronunciation_map_phrase_retries_even_when_wer_is_low():
    filler = " ".join(f"w{i}" for i in range(40))
    spoken = f"Comfy rizz {filler}"
    hypothesis = f"company name {filler}"
    assert wer(spoken, hypothesis) < 0.05
    assert missing_pronunciations(spoken, hypothesis) == ["Comfy rizz"]
    assert should_regenerate(spoken, hypothesis) is True


def test_real_asr_is_unavailable_without_the_optional_install():
    asr = Qwen3Asr()
    assert asr.available() is False
    try:
        asr.transcribe(b"", 24000, "English")
    except QwenRuntimeUnavailable:
        return
    raise AssertionError("missing qwen-asr should be reported, not fetched")


def test_a_bad_transcript_is_retried_with_a_new_seed_then_kept(tmp_path):
    spoken = "Hello there friend."
    asr = ScriptedAsr(["goodbye there friend", spoken])
    tts = FakeTts(seconds_per_word=0.5)
    doc = package([{"id": "s1", "narration": "Hello there friend.", "narration_spoken": spoken}])
    report = narrate_qwen(doc, tmp_path / "audio", tts=tts, asr=asr)
    assert len(tts.synth_calls) == 2
    assert tts.synth_calls[1]["seed"] == tts.synth_calls[0]["seed"] + 1
    qa = report["scenes"]["s1"]["qa"]
    assert qa["flagged"] is False
    assert qa["attempts"] == 2
    assert qa["wer"] == 0.0
    assert qa["seeds"] == [tts.synth_calls[0]["seed"], tts.synth_calls[1]["seed"]]


def test_a_missing_map_word_regenerates(tmp_path):
    filler = " ".join(f"w{i}" for i in range(40))
    spoken = f"Comfy rizz {filler}"
    asr = ScriptedAsr([f"company name {filler}", spoken])
    tts = FakeTts(seconds_per_word=0.2)
    doc = package([{"id": "s1", "narration": "Comfyrizz stays in the caption.", "narration_spoken": spoken}])
    report = narrate_qwen(doc, tmp_path / "audio", tts=tts, asr=asr)
    assert len(tts.synth_calls) == 2
    assert tts.synth_calls[0]["text"] == spoken
    assert report["scenes"]["s1"]["chunks"][0]["text"] == "Comfyrizz stays in the caption."
    assert report["scenes"]["s1"]["qa"]["flagged"] is False
    assert report["scenes"]["s1"]["qa"]["attempts"] == 2


def test_retries_are_bounded_and_the_last_failure_is_flagged(tmp_path):
    asr = ScriptedAsr(["nope", "still wrong", "no again"])
    tts = FakeTts(seconds_per_word=0.5)
    doc = package([{"id": "s1", "narration": "Hello there friend."}])
    out = tmp_path / "audio"
    report = narrate_qwen(doc, out, tts=tts, asr=asr)
    assert len(tts.synth_calls) == 3
    qa = report["scenes"]["s1"]["qa"]
    assert qa["attempts"] == 3
    assert qa["flagged"] is True
    assert qa["wer"] > 0.05
    assert (out / "narration" / "s1.wav").is_file()


def test_without_an_asr_there_is_no_retry(tmp_path):
    tts = FakeTts()
    report = narrate_qwen(package([{"id": "s1", "narration": "Hello there friend."}]), tmp_path / "audio", tts=tts)
    assert len(tts.synth_calls) == 1
    assert report["scenes"]["s1"]["qa"]["skipped"] == "asr-unavailable"
    assert report["scenes"]["s1"]["qa"]["flagged"] is False
