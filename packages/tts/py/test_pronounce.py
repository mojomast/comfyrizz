from pronounce import pronounce


def test_product_names_and_acronyms():
    assert pronounce("Comfyrizz runs on the CPU.") == "Comfy rizz runs on the C P U."
    assert pronounce("Kokoro and SVG") == "Koh koh roh and S V G"
    assert pronounce("No LUFS or dBTP surprises") == "No loofs or D B T P surprises"


def test_unknown_words_are_untouched():
    assert pronounce("Nothing to replace here") == "Nothing to replace here"
