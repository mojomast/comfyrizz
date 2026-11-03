"""Voiceover take cache and retake budget (Goat Getaway, 2026-11-02).

A Chatterbox voiceover took 19 min on Google Colab: 66 takes for 13 lines, because the first takes of
short colon fragments ("Top attitude: unlimited.") loop or add words and the speech check asked for
retakes. Two levers live here:

* reuse: a finished take is reused when its line id AND its text match the package word for word
  and it passed the speech check (not flagged). Changed or failed lines are voiced again.
* retake budget: lines likely to loop or hallucinate are pre-flagged (``line_risk``) and get their own
  per-line cap; every line keeps its best take when the cap runs out.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Mapping

DEFAULT_POLICY = {"cache": True, "maxTakesPerLine": None, "riskyMaxTakes": None}
_WORD = re.compile(r"[a-z0-9']+")
COMMON = {"nana", "mom", "dad", "grandma", "grandpa"}


def words(text: str) -> list[str]:
    return _WORD.findall(str(text or "").lower())


def same_text(a: str, b: str) -> bool:
    return words(a) == words(b)


def line_risk(text: str) -> list[str]:
    """Reasons a line is likely to loop or hallucinate in Chatterbox (empty list = low risk)."""
    raw = str(text or "")
    tokens = words(raw)
    reasons: list[str] = []
    if len(tokens) <= 4:
        reasons.append("short")
    if re.search(r":\s*\S", raw):
        reasons.append("colon-fragment")
    if len(tokens) != len(set(tokens)) and len(tokens) <= 8:
        reasons.append("repeated-word")
    names = [w for i, w in enumerate(re.findall(r"[A-Za-z][A-Za-z'-]*", raw)) if i > 0 and w[0].isupper() and w.lower() not in COMMON]
    if any(len(n) >= 3 and not re.search(r"[aeiouy]", n.lower()[1:]) for n in names) or any(re.search(r"[A-Z]{2,}\d|\d[A-Z]", n) for n in names):
        reasons.append("odd-name")
    if re.search(r"[A-Z]+-\d+|\d+[A-Za-z]", raw):
        reasons.append("alphanumeric")
    return reasons


def policy_for(package: Mapping) -> dict:
    voice = package.get("voice") if isinstance(package, Mapping) else None
    takes = voice.get("takes") if isinstance(voice, Mapping) and isinstance(voice.get("takes"), Mapping) else {}
    merged = dict(DEFAULT_POLICY)
    for key in DEFAULT_POLICY:
        if key in takes:
            merged[key] = takes[key]
    return merged


def load_cache(cache_dir) -> tuple[dict, Path] | None:
    if not cache_dir:
        return None
    root = Path(cache_dir)
    for candidate in (root / "audio" / "durations.json", root / "durations.json"):
        if candidate.exists():
            return json.loads(candidate.read_text()), candidate.parent
    return None


def plan_reuse(lines: list[Mapping], cache) -> dict:
    """Line id -> {"record", "wav"} for every cached take that can be reused as is."""
    if not cache:
        return {}
    report, audio_dir = cache
    scenes = report.get("scenes", {}) if isinstance(report, Mapping) else {}
    reuse: dict = {}
    for line in lines:
        record = scenes.get(line["id"])
        if not isinstance(record, Mapping):
            continue
        qa = record.get("qa") if isinstance(record.get("qa"), Mapping) else {}
        if qa.get("flagged") is not False:
            continue
        cached_text = " ".join(str(c.get("text", "")) for c in record.get("chunks", []))
        if not same_text(cached_text, line.get("text", "")):
            continue
        wav = audio_dir.parent / str(record.get("file", ""))
        if not wav.is_file():
            wav = audio_dir / "narration" / f"{line['id']}.wav"
        if wav.is_file():
            reuse[line["id"]] = {"record": json.loads(json.dumps(record)), "wav": wav}
    return reuse
