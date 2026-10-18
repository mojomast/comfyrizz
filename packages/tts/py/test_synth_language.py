"""N-fix: synth.py phonemises with the package's voice.language (not always en-us).

ff_siwis (French) and the en-gb voices were read as US English because
``kokoro.create`` was hard-coded to ``lang="en-us"``. `resolve_language` is the
pure mapping the synthesis loop now calls; it needs no model weights.
"""
from synth import DEFAULT_LANGUAGE, resolve_language


def test_voice_language_is_used_for_phonemisation():
    assert resolve_language({"language": "fr-fr"}) == "fr-fr"
    assert resolve_language({"language": "en-gb"}) == "en-gb"
    assert resolve_language({"language": " fr-fr "}) == "fr-fr"


def test_missing_or_blank_language_falls_back_to_us_english():
    assert DEFAULT_LANGUAGE == "en-us"
    assert resolve_language({}) == DEFAULT_LANGUAGE
    assert resolve_language({"language": ""}) == DEFAULT_LANGUAGE
    assert resolve_language({"language": "   "}) == DEFAULT_LANGUAGE
    assert resolve_language({"language": None}) == DEFAULT_LANGUAGE
