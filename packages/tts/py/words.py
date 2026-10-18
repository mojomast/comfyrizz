#!/usr/bin/env python3
"""Word timings inside a measured Kokoro sentence (K1).

Stock ``kokoro-onnx`` measures a sentence, not each word, so the default here is
a **syllable-proportional fallback**: split the measured sentence duration by a
crude syllable count. It needs no model, no network and no extra install, and it
always produces a monotonic list that exactly fills the sentence.

A real aligner can supersede the fallback without changing the contract: pass
``tokens`` (``[{text, start, end}, ...]`` in seconds, relative to the sentence;
``start_ts`` / ``end_ts`` are accepted as aliases) and this module validates
them and returns ``{text, start, end}``. The PyTorch ``KPipeline``
``tokens[].start_ts/end_ts`` and R3's Qwen3 forced aligner both plug in here.
"""
from __future__ import annotations

import re

VOWEL_GROUP = re.compile(r"[aeiouy]+")
WORD_SPLIT = re.compile(r"\S+")
# Tolerance for a real aligner's rounding when checking that words fill the sentence.
TOLERANCE = 0.02


def count_syllables(word: str) -> int:
    """A crude but stable syllable count: vowel groups, at least one per word."""
    letters = re.sub(r"[^a-zA-Z]", "", word).lower()
    if not letters:
        return 1
    groups = len(VOWEL_GROUP.findall(letters))
    # A trailing silent 'e' is usually not its own syllable (name, time, scene),
    # except after a consonant + le (table) or in -ee / -ye.
    if groups > 1 and letters.endswith("e") and not re.search(r"[^aeiouy]le$", letters) and not letters.endswith(("ee", "ye")):
        groups -= 1
    return max(1, groups)


def _bounds(weights: list[int], seconds: float) -> list[float]:
    """Cumulative word boundaries that start at 0 and end exactly at ``seconds``."""
    total = sum(weights) or 1
    bounds = [0.0]
    running = 0
    for weight in weights:
        running += weight
        bounds.append(round(seconds * running / total, 4))
    # Rounding can never make a non-decreasing sequence decrease, but force the
    # exact endpoints so the durations sum to the measured sentence.
    bounds[0] = 0.0
    bounds[-1] = round(seconds, 4)
    return bounds


def validate_tokens(tokens: list[dict], seconds: float) -> list[dict]:
    """Accept a real aligner's tokens, or raise if they do not fit the sentence."""
    out: list[dict] = []
    previous = 0.0
    for token in tokens:
        text = str(token.get("text", "")).strip()
        # Kokoro's KPipeline uses start_ts/end_ts; the Qwen3 aligner may too.
        # The words[] we return always use start/end.
        start = float(token["start"] if "start" in token else token.get("start_ts", 0.0))
        end = float(token["end"] if "end" in token else token.get("end_ts", 0.0))
        if not text:
            raise ValueError("word token has no text")
        if start < previous - TOLERANCE or end < start:
            raise ValueError(f"word timings are not monotonic at {text!r}")
        if start < -TOLERANCE or end > seconds + TOLERANCE:
            raise ValueError(f"word {text!r} falls outside the {seconds}s sentence")
        out.append({"text": text, "start": round(start, 4), "end": round(end, 4)})
        previous = start
    if out and abs(out[-1]["end"] - seconds) > TOLERANCE:
        raise ValueError(f"words end at {out[-1]['end']}s, sentence is {seconds}s")
    return out


def word_timings(text: str, seconds: float, tokens: list[dict] | None = None) -> list[dict]:
    """Word timings for one measured sentence, in seconds relative to its start.

    ``tokens`` (a real aligner) wins when supplied; otherwise the syllable
    fallback fills ``seconds``. Always monotonic, inside ``[0, seconds]``, and the
    durations sum to ``seconds``.
    """
    if tokens is not None:
        return validate_tokens(tokens, seconds)
    words = WORD_SPLIT.findall(text.strip())
    if not words:
        return []
    if len(words) == 1:
        return [{"text": words[0], "start": 0.0, "end": round(seconds, 4)}]
    bounds = _bounds([count_syllables(word) for word in words], seconds)
    return [{"text": word, "start": bounds[i], "end": bounds[i + 1]} for i, word in enumerate(words)]
