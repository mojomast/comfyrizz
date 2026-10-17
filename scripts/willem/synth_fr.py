"""French Kokoro narration for Willem's video, reusing Pi's packages/tts/py/synth.py unchanged.
Pi's synth hardcodes lang="en-us" and an English pronunciation pass, so this wrapper swaps in
lang="fr-fr" and a tiny French respelling pass (espeak-ng fr switches "Willem" to English
/ˈwɪləm/; "Ouilème" gives French /wilɛm/). Captions keep the real text; only the spoken string changes.
usage: .venv/bin/python scripts/willem/synth_fr.py --package <pkg> --out <dir> [--padding 0.5]"""
import os, re, sys
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
sys.path.insert(0, f"{REPO}/packages/tts/py")
import synth  # noqa: E402
import kokoro_onnx  # noqa: E402

RESPELL = [(r"\bWillem\b", "Ouilème"), (r"\b3e\b", "troisième"), (r"…", ",")]

def fr_pronounce(text: str) -> str:
    for pat, rep in RESPELL:
        text = re.sub(pat, rep, text)
    return text

_create = kokoro_onnx.Kokoro.create
def create_fr(self, text, voice, speed=1.0, lang="fr-fr", **kw):
    return _create(self, text, voice=voice, speed=speed, lang="fr-fr", **kw)

synth.pronounce = fr_pronounce
kokoro_onnx.Kokoro.create = create_fr
if __name__ == "__main__":
    sys.exit(synth.main())
