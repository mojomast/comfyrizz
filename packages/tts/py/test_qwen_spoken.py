"""R3 step 3: narration_spoken is synthesised; captions keep the written line."""
from narrate_qwen import narrate_qwen, spoken_for_scene
from test_qwen_align import ScriptedAligner
from test_qwen_engine import FakeTts, package


def test_pronunciation_map_is_the_default_spoken_form():
    spoken, parts = spoken_for_scene({}, ["Comfyrizz ships."])
    assert spoken == "Comfy rizz ships."
    assert parts == ["Comfy rizz ships."]


def test_narration_spoken_overrides_the_map_and_captions_stay_written(tmp_path):
    tts = FakeTts(seconds_per_word=0.5)
    aligner = ScriptedAligner(
        {
            "Comfyrizz ships.": [
                {"text": "Comfyrizz", "start": 0.0, "end": 0.4},
                {"text": "ships.", "start": 0.4, "end": 1.0},
            ]
        }
    )
    doc = package(
        [
            {
                "id": "s1",
                "narration": "Comfyrizz ships.",
                "narration_spoken": "com-fee-rizz ships.",
                "spoken_text": "this alias must lose",
            }
        ]
    )
    report = narrate_qwen(doc, tmp_path / "audio", tts=tts, aligner=aligner)
    assert tts.synth_calls[0]["text"] == "com-fee-rizz ships."
    chunk = report["scenes"]["s1"]["chunks"][0]
    assert chunk["text"] == "Comfyrizz ships."
    assert chunk["spoken"] == "com-fee-rizz ships."
    assert [word["text"] for word in chunk["words"]] == ["Comfyrizz", "ships."]
    assert aligner.calls[0]["text"] == "Comfyrizz ships."


def test_spoken_text_is_the_alias_when_narration_spoken_is_absent(tmp_path):
    tts = FakeTts(seconds_per_word=0.5)
    doc = package(
        [
            {
                "id": "s1",
                "narration": "Meet Comfyrizz. It runs on the CPU.",
                "spoken_text": "Meet com-fee-rizz. It runs on the C P U.",
            }
        ]
    )
    narrate_qwen(doc, tmp_path / "audio", tts=tts)
    assert tts.synth_calls[0]["text"] == "Meet com-fee-rizz. It runs on the C P U."
    assert len(tts.synth_calls) == 1
