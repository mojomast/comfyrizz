"""SP05: classify and pick a Chatterbox take by transcript and measured duration."""
from __future__ import annotations

import qa_qwen
import take_select
from take_select import WORDS_PER_SECOND, expected_seconds, select_take


def take(path: str, transcript: str, spoken: str = "the quick brown fox") -> dict:
    return {"path": path, "transcript": transcript, "seconds": expected_seconds(spoken)}


def labels(result: dict, path: str | None = None) -> list[str]:
    reasons = result["reasons"]
    if path is None:
        return list(reasons)
    return list(reasons[path])


def test_select_take_reuses_qa_qwen_normalisation_and_wer():
    assert take_select.wer is qa_qwen.wer
    result = select_take("Hello, world!", [{"path": "a.wav", "transcript": "hello world", "seconds": 0.8}])
    assert result["take"]["path"] == "a.wav"
    assert result["wer"]["a.wav"] == 0.0


def test_a_good_take_is_selected_without_a_reason():
    result = select_take("the quick brown fox", [take("good.wav", "The quick, brown fox.")])
    assert result["take"]["path"] == "good.wav"
    assert labels(result) == []
    assert result["take"] is not None
    assert result["expectedSeconds"] == expected_seconds("the quick brown fox")


def test_a_truncated_take_loses_the_trailing_words():
    result = select_take("the quick brown fox", [take("cut.wav", "the quick")])
    assert result["take"] is None
    assert "truncated" in labels(result)


def test_extra_words_and_a_hallucinated_tail_are_rejected():
    spoken = "the quick brown fox"
    for transcript in ("the quick brown fox again", "the quick extra brown fox"):
        result = select_take(spoken, [take("extra.wav", transcript)])
        assert result["take"] is None
        assert "extra-words" in labels(result)


def test_a_repeated_word_is_rejected_with_its_own_reason():
    result = select_take("the quick brown fox", [take("repeat.wav", "the quick quick brown fox")])
    assert result["take"] is None
    assert "repeated-word" in labels(result)
    assert "extra-words" in labels(result)


def test_a_substitution_over_ten_percent_wer_is_rejected():
    spoken = "one two three four five six seven eight nine"
    transcript = "one two three four five six seven eight wrong"
    result = select_take(spoken, [{"path": "wer.wav", "transcript": transcript, "seconds": expected_seconds(spoken)}])
    assert result["take"] is None
    assert labels(result) == ["wer"]


def test_duration_must_stay_inside_the_words_per_second_window():
    spoken = "the quick brown fox"
    expected = expected_seconds(spoken)
    too_fast = select_take(spoken, [{"path": "fast.wav", "transcript": spoken, "seconds": expected * 0.5}])
    too_slow = select_take(spoken, [{"path": "slow.wav", "transcript": spoken, "seconds": expected * 2.0}])
    edge = select_take(spoken, [{"path": "edge.wav", "transcript": spoken, "seconds": expected * 1.8}])
    assert too_fast["take"] is None
    assert too_slow["take"] is None
    assert "duration" in labels(too_fast)
    assert "duration" in labels(too_slow)
    assert edge["take"]["path"] == "edge.wav"


def test_lowest_wer_wins_and_a_tie_goes_to_the_expected_duration():
    spoken = " ".join(["word"] * 20)
    one_error = " ".join(["word"] * 19 + ["wrong"])
    takes = [
        {"path": "close.wav", "transcript": one_error, "seconds": 8.0},
        {"path": "exact.wav", "transcript": spoken, "seconds": 8.0},
    ]
    result = select_take(spoken, takes)
    assert result["take"]["path"] == "exact.wav"

    tied = [
        {"path": "short.wav", "transcript": spoken, "seconds": 6.0},
        {"path": "near.wav", "transcript": spoken, "seconds": 8.1},
    ]
    result = select_take(spoken, tied)
    assert result["take"]["path"] == "near.wav"


def test_all_rejected_returns_no_take_with_reasons_per_take():
    result = select_take(
        "the quick brown fox",
        [
            take("cut.wav", "the quick"),
            {"path": "slow.wav", "transcript": "the quick brown fox", "seconds": 20.0},
        ],
    )
    assert result["take"] is None
    assert "truncated" in result["reasons"]
    assert "duration" in result["reasons"]
    assert result["reasons"]["cut.wav"]
    assert result["reasons"]["slow.wav"] == ["duration"]


def test_words_per_second_estimate_is_the_voiceover_rule():
    assert WORDS_PER_SECOND == 2.5
    assert expected_seconds("one two three four five") == 2.0
