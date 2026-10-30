"""Select a Chatterbox take by transcript and measured duration (SP05).

The transcript check reuses ``qa.tokenize`` / the ``wer`` exported by
``qa_qwen``; this module never reimplements normalisation or WER.

``select_take`` returns ``{"take": selected_or_none, "reasons": [...]}`` plus
per-take diagnostics. A take is rejected when it drops the line's trailing
words, inserts or repeats words, has WER above 0.1, or falls outside
0.6-1.8 times the words-per-second duration estimate.
"""
from __future__ import annotations

from difflib import SequenceMatcher
from pathlib import Path
from typing import Mapping

from qa import tokenize
from qa_qwen import wer

WER_LIMIT = 0.1
WORDS_PER_SECOND = 2.5
MIN_DURATION_SCALE = 0.6
MAX_DURATION_SCALE = 1.8
# Chatterbox takes carry lead-in/tail silence; on a three-word line that alone breaks the 1.8x
# bound (GPU e2e 2026-10-30: "His never was." 2.4 s vs 2.16 s). Allow it once per take.
SILENCE_ALLOWANCE_SECONDS = 1.0
REASON_ORDER = ("truncated", "extra-words", "repeated-word", "wer", "duration")


class TakeReasons(list):
    """Reason codes in canonical order, also indexable by take path."""

    def __init__(self, labels: list[str], by_path: Mapping[str, list[str]]):
        super().__init__(labels)
        self.by_path = dict(by_path)

    @staticmethod
    def _key(value) -> str:
        return Path(value).as_posix() if isinstance(value, Path) else str(value)

    def __getitem__(self, key):
        if isinstance(key, (str, Path)):
            return self.by_path[self._key(key)]
        return super().__getitem__(key)

    def __contains__(self, item) -> bool:
        if super().__contains__(item):
            return True
        return isinstance(item, (str, Path)) and self._key(item) in self.by_path

    def get(self, key, default=None):
        return self.by_path.get(self._key(key), default)

    def keys(self):
        return self.by_path.keys()

    def values(self):
        return self.by_path.values()

    def items(self):
        return self.by_path.items()


def expected_seconds(spoken: str, words_per_second: float = WORDS_PER_SECOND) -> float:
    return len(tokenize(spoken)) / words_per_second


def _structure(spoken: list[str], transcript: list[str]) -> tuple[bool, bool, bool]:
    truncated = extra = False
    matcher = SequenceMatcher(None, spoken, transcript, autojunk=False)
    for tag, ref_start, ref_end, hyp_start, hyp_end in matcher.get_opcodes():
        ref_count = ref_end - ref_start
        hyp_count = hyp_end - hyp_start
        if tag == "insert":
            extra = True
        elif tag == "delete" and ref_end == len(spoken) and ref_count:
            truncated = True
        elif tag == "replace":
            if hyp_count > ref_count:
                extra = True
            if ref_end == len(spoken) and ref_count > hyp_count:
                truncated = True
    repeated = any(
        transcript.count(word) > max(1, spoken.count(word)) and transcript.count(word) > 1
        for word in set(transcript)
    )
    return truncated, extra, repeated


def _classify(spoken: str, take: Mapping, expected: float, words: list[str]) -> list[str]:
    transcript = take.get("transcript")
    transcript = transcript if isinstance(transcript, str) else ""
    hyp = tokenize(transcript)
    truncated, extra, repeated = _structure(words, hyp)
    reasons: list[str] = []
    if truncated:
        reasons.append("truncated")
    if extra and "extra-words" not in reasons:
        reasons.append("extra-words")
    if repeated:
        if "extra-words" not in reasons:
            reasons.append("extra-words")
        reasons.append("repeated-word")
    if wer(spoken, transcript) > WER_LIMIT:
        reasons.append("wer")
    try:
        seconds = float(take.get("seconds"))
    except (TypeError, ValueError):
        seconds = float("nan")
    if not (expected * MIN_DURATION_SCALE <= seconds <= expected * MAX_DURATION_SCALE + SILENCE_ALLOWANCE_SECONDS):
        reasons.append("duration")
    return reasons


def select_take(spoken: str, takes: list[Mapping]) -> dict:
    """Pick the lowest-WER valid take; on a tie, the expected-duration one."""
    words = tokenize(spoken)
    expected = expected_seconds(spoken)
    reasons_by_path: dict[str, list[str]] = {}
    wers: dict[str, float] = {}
    valid: list[tuple[float, float, int, Mapping]] = []

    for index, take in enumerate(takes):
        path = str(take.get("path"))
        reasons = _classify(spoken, take, expected, words)
        reasons_by_path[path] = reasons
        transcript = take.get("transcript")
        wers[path] = round(wer(spoken, transcript if isinstance(transcript, str) else ""), 4)
        if reasons:
            continue
        try:
            seconds = float(take.get("seconds"))
        except (TypeError, ValueError):
            continue
        valid.append((wers[path], abs(seconds - expected), index, take))

    selected = min(valid, key=lambda item: (item[0], item[1], item[2]))[3] if valid else None
    labels = [reason for reason in REASON_ORDER if any(reason in found for found in reasons_by_path.values())]
    return {
        "take": selected,
        "reasons": TakeReasons(labels, reasons_by_path),
        "rejections": reasons_by_path,
        "wer": wers,
        "expectedSeconds": round(expected, 4),
    }
