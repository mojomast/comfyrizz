"""K1: the syllable-proportional word timer (no model download).

The fallback must always produce a monotonic word list that exactly fills the
measured sentence, and a real aligner's tokens must be accepted (or rejected when
they do not fit). These tests import `words.py` only, so they never touch Kokoro.
"""
import pytest

from words import count_syllables, validate_tokens, word_timings


def _sum(words):
    return sum(round(word["end"] - word["start"], 4) for word in words)


def test_words_are_monotonic_and_fill_the_sentence():
    text = "Meet Orbit, the agent-customizable workspace."
    words = word_timings(text, 3.2)
    assert [word["text"] for word in words] == text.split()
    assert words[0]["start"] == 0.0
    assert words[-1]["end"] == 3.2
    for previous, current in zip(words, words[1:]):
        assert current["start"] >= previous["start"]
        assert current["end"] >= current["start"]
    assert abs(_sum(words) - 3.2) < 0.001


def test_every_word_gets_time_even_for_one_syllable_sentences():
    words = word_timings("Go", 0.4)
    assert words == [{"text": "Go", "start": 0.0, "end": 0.4}]
    assert word_timings("", 1.0) == []
    assert word_timings("   ", 1.0) == []


def test_longer_words_get_more_time():
    words = word_timings("a extraordinary", 1.0)
    short = words[0]["end"] - words[0]["start"]
    long = words[1]["end"] - words[1]["start"]
    assert long > short


def test_syllable_count_never_drops_below_one():
    assert count_syllables("rhythm") >= 1
    assert count_syllables("...") == 1
    assert count_syllables("Orbit") == 2
    assert count_syllables("workspace") == 2


def test_a_real_aligner_supersedes_the_fallback():
    tokens = [
        {"text": "Meet", "start": 0.0, "end": 0.4},
        {"text": "Orbit", "start": 0.4, "end": 0.9},
    ]
    assert word_timings("Meet Orbit", 0.9, tokens) == tokens


def test_aligner_start_ts_fields_are_accepted_and_rewritten():
    tokens = [
        {"text": "Meet", "start_ts": 0.0, "end_ts": 0.4},
        {"text": "Orbit", "start_ts": 0.4, "end_ts": 0.9},
    ]
    assert word_timings("Meet Orbit", 0.9, tokens) == [
        {"text": "Meet", "start": 0.0, "end": 0.4},
        {"text": "Orbit", "start": 0.4, "end": 0.9},
    ]


def test_a_bad_aligner_result_is_rejected():
    with pytest.raises(ValueError):
        validate_tokens([{"text": "late", "start": 0.5, "end": 0.4}], 1.0)
    with pytest.raises(ValueError):
        validate_tokens([{"text": "over", "start": 0.0, "end": 2.0}], 1.0)
    with pytest.raises(ValueError):
        validate_tokens([{"text": "short", "start": 0.0, "end": 0.2}], 1.0)
