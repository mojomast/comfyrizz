"""Round-trip pronunciation check for a narration take (R3).

WER is computed against the spoken form (the text sent to the synthesizer),
not the caption spelling. A pronunciation-map phrase that was part of that
spoken form and is missing from the transcript also asks for another take.
"""
from __future__ import annotations

import re

from pronounce import PRONUNCIATIONS

WER_LIMIT = 0.05
MAX_ATTEMPTS = 3
_TOKEN = re.compile(r"[a-z0-9']+")


def tokenize(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


def _levenshtein(ref: list[str], hyp: list[str]) -> int:
    if not ref:
        return len(hyp)
    if not hyp:
        return len(ref)
    previous = list(range(len(hyp) + 1))
    for index, left in enumerate(ref, start=1):
        current = [index]
        for column, right in enumerate(hyp, start=1):
            cost = 0 if left == right else 1
            current.append(min(current[-1] + 1, previous[column] + 1, previous[column - 1] + cost))
        previous = current
    return previous[-1]


def wer(reference: str, hypothesis: str) -> float:
    """Word error rate. 0 is a perfect transcript of ``reference``."""
    ref = tokenize(reference)
    hyp = tokenize(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    return _levenshtein(ref, hyp) / len(ref)


def missing_pronunciations(spoken: str, hypothesis: str) -> list[str]:
    """Map phrases we asked the model to say that the transcript dropped."""
    spoken_l = spoken.lower()
    hypothesis_l = hypothesis.lower()
    missing: list[str] = []
    seen: set[str] = set()
    for phrase in PRONUNCIATIONS.values():
        folded = phrase.lower()
        if folded in spoken_l and folded not in hypothesis_l and folded not in seen:
            seen.add(folded)
            missing.append(phrase)
    return missing


def should_regenerate(spoken: str, hypothesis: str, limit: float = WER_LIMIT) -> bool:
    return wer(spoken, hypothesis) > limit or bool(missing_pronunciations(spoken, hypothesis))
