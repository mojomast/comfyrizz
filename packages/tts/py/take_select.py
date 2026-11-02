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
REASON_ORDER = ("truncated", "extra-words", "repeated-word", "wer", "duration", "faded")
# judge-loop v2 audio QA (the-keeper s3, Nov 2026): the ASR heard "waiting for dawn" but it was
# rendered ~15 dB under the rest of the line, so the film lost it. A take whose later speech-length
# burst sits far below its loudest burst is rejected as "faded" and retaken.
FADED_RATIO = 0.25
FADED_MIN_SECONDS = 0.3
SILENCE_DBFS = -40.0


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


def speech_bursts(samples, rate: int, silence_dbfs: float = SILENCE_DBFS, min_gap: float = 0.25) -> list[tuple[float, float, float]]:
    """Non-silent bursts as (start, end, rms), split at silences of at least ``min_gap`` seconds."""
    import numpy as np

    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    if x.size == 0 or not rate:
        return []
    hop = max(1, int(rate * 0.02))
    frames = x[: x.size // hop * hop].reshape(-1, hop)
    if frames.size == 0:
        return []
    level = 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9)
    loud = level > silence_dbfs
    bursts: list[tuple[float, float, float]] = []
    start = None
    quiet_run = 0
    gap_frames = max(1, int(min_gap / 0.02))
    for index, on in enumerate(loud):
        if on:
            if start is None:
                start = index
            quiet_run = 0
        elif start is not None:
            quiet_run += 1
            if quiet_run >= gap_frames:
                end = index - quiet_run + 1
                bursts.append((start, end))
                start = None
                quiet_run = 0
    if start is not None:
        bursts.append((start, len(loud) - quiet_run))
    out = []
    for begin, end in bursts:
        chunk = frames[begin:end].reshape(-1)
        out.append((begin * 0.02, end * 0.02, float(np.sqrt((chunk ** 2).mean())) if chunk.size else 0.0))
    return out


def faded(samples, rate: int) -> bool:
    """True when a speech-length burst after the first is far quieter than the loudest burst."""
    bursts = speech_bursts(samples, rate)
    if len(bursts) < 2:
        return False
    loudest = max(rms for _, _, rms in bursts)
    return any(end - start >= FADED_MIN_SECONDS and rms < loudest * FADED_RATIO for start, end, rms in bursts[1:])


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
    samples = take.get("_samples")
    rate = take.get("_rate")
    if samples is not None and rate:
        try:
            if faded(samples, int(rate)):
                reasons.append("faded")
        except Exception:  # audio QA is advisory; a bad buffer never breaks take selection
            pass
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
