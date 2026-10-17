"""Small pronunciation map for product names and acronyms (SPEC 6.9).

Only the synthesised text changes; captions keep the original sentence so the
viewer reads the real product spelling.
"""
from __future__ import annotations

import re

PRONUNCIATIONS = {
    "comfyrizz": "Comfy rizz",
    "kokoro": "Koh koh roh",
    "svg": "S V G",
    "cpu": "C P U",
    "gpu": "G P U",
    "llm": "L L M",
    "lufs": "loofs",
    "dbtp": "D B T P",
    "ltx": "L T X",
}

_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(key) for key in sorted(PRONUNCIATIONS, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)


def pronounce(text: str) -> str:
    """Replace known tokens with a speakable spelling (case-insensitive)."""
    return _PATTERN.sub(lambda match: PRONUNCIATIONS[match.group(0).lower()], text)
