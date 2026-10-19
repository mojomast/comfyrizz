"""Optional Qwen3-TTS 1.7B adapter (R3).

Kokoro stays the default narrator. This module is imported only when a package
selects ``voice.engine = qwen3-tts``. ``qwen-tts`` and torch are imported inside
the real adapter methods, never at import time, so the default install and the
tests do not need them and no weights are downloaded here.

The call shape follows the public qwen-tts and qwen-asr APIs: VoiceDesign once,
then Base create_voice_clone_prompt / generate_voice_clone. Alignment and ASR
accept (waveform, sample_rate) tuples and return batches. Tests mock the model
classes to check this boundary without downloading weights.
"""
from __future__ import annotations

import importlib.util
import gc
import os

import numpy as np

ENGINE_KOKORO = "kokoro"
ENGINE_QWEN = "qwen3-tts"
SAMPLE_RATE = 24_000
BASE_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
DESIGN_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
MODEL_LICENSE = "Apache-2.0"
ALIGNER_MODEL = "Qwen/Qwen3-ForcedAligner-0.6B"
ASR_MODEL = "Qwen/Qwen3-ASR-0.6B"
DEFAULT_REFERENCE = "Here is what changed, why it matters, and how it works. We will walk through the details together, one clear step at a time."
# Qwen3-TTS language argument is the English name of the language.
_LANG_NAMES = {
    "en": "English",
    "fr": "French",
}


class QwenRuntimeUnavailable(RuntimeError):
    """The optional Qwen3 runtime cannot run (missing install, or the call failed)."""


def resolve_engine(voice_cfg: dict | None) -> str:
    """Package engine. Anything other than ``qwen3-tts`` stays on Kokoro.

    ``none`` and a missing engine are Kokoro at this layer: ``synth.py`` only
    branches when the value is exactly ``qwen3-tts``, so an unchanged package
    never enters this backend.
    """
    if not isinstance(voice_cfg, dict):
        return ENGINE_KOKORO
    raw = voice_cfg.get("engine")
    if isinstance(raw, str) and raw.strip() == ENGINE_QWEN:
        return ENGINE_QWEN
    return ENGINE_KOKORO


def strict_voice(voice_cfg: dict | None) -> bool:
    """True only when the package explicitly refuses the Kokoro fallback."""
    return isinstance(voice_cfg, dict) and voice_cfg.get("strict") is True


def qwen_language_name(voice_cfg: dict | None) -> str:
    """``English`` or ``French`` for the Qwen3-TTS call.

    ``voice.lang`` wins (``en`` / ``fr``). Otherwise ``voice.language``
    (``en-us``, ``fr-fr``, …) is mapped. Anything else stays English: this
    backend promises English and French, and does not guess a third language.
    """
    raw = ""
    if isinstance(voice_cfg, dict):
        candidate = voice_cfg.get("lang")
        if not (isinstance(candidate, str) and candidate.strip()):
            candidate = voice_cfg.get("language")
        if isinstance(candidate, str):
            raw = candidate
    key = raw.strip().lower().replace("_", "-")
    if key.startswith("fr"):
        return _LANG_NAMES["fr"]
    return _LANG_NAMES["en"]


def to_sample_rate(audio: np.ndarray, src_rate: int, dst_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Linear resample to the pipeline rate (24 kHz, the same as Kokoro)."""
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if src_rate == dst_rate:
        return samples
    if src_rate <= 0 or dst_rate <= 0 or samples.size == 0:
        raise QwenRuntimeUnavailable(f"bad audio from the adapter (rate {src_rate}, samples {samples.size})")
    dst_len = max(1, int(round(samples.size * dst_rate / src_rate)))
    src_x = np.linspace(0.0, 1.0, num=samples.size, endpoint=False)
    dst_x = np.linspace(0.0, 1.0, num=dst_len, endpoint=False)
    return np.interp(dst_x, src_x, samples).astype(np.float32)


def _import_qwen_tts():
    try:
        import qwen_tts  # type: ignore  # optional extra; not imported unless this runs
    except ImportError as exc:
        raise QwenRuntimeUnavailable(
            "qwen-tts is not installed. It is an optional extra and is not part of the default install or the tests."
        ) from exc
    return qwen_tts


def coerce_aligner_tokens(result) -> list[dict]:
    """Normalise an aligner result into dicts. ``word_timings`` reads start/end or start_ts/end_ts."""
    if isinstance(result, dict):
        result = result.get("tokens") or result.get("words") or []
    out = []
    for token in result or []:
        if isinstance(token, dict):
            out.append(token)
            continue
        out.append(
            {
                "text": getattr(token, "text", ""),
                "start_ts": getattr(token, "start_time", getattr(token, "start_ts", getattr(token, "start", None))),
                "end_ts": getattr(token, "end_time", getattr(token, "end_ts", getattr(token, "end", None))),
            }
        )
    return out


def model_options() -> dict:
    import torch
    device = os.environ.get("COMFYRIZZ_QWEN_DEVICE", "cuda:0" if torch.cuda.is_available() else "cpu")
    return {
        "device_map": device,
        "dtype": torch.bfloat16 if device.startswith("cuda") else torch.float32,
        "attn_implementation": "sdpa",
    }


def model_path(model: str) -> str:
    """An optional local snapshot root lets deployment pin weights without editing the adapter."""
    root = os.environ.get("COMFYRIZZ_QWEN_MODELS")
    return os.path.join(root, model.split("/")[-1]) if root else model


class Qwen3Aligner:
    """Qwen3-ForcedAligner-0.6B as a token provider for ``word_timings``.

    The class is exported by qwen_asr, not qwen_tts. A missing install raises
    ``QwenRuntimeUnavailable``; the narrator then keeps the syllable fallback.
    """

    def available(self) -> bool:
        return importlib.util.find_spec("qwen_asr") is not None

    def align(self, samples: np.ndarray, sample_rate: int, text: str, lang: str) -> list[dict]:
        try:
            from qwen_asr import Qwen3ForcedAligner
        except ImportError as exc:
            raise QwenRuntimeUnavailable('qwen-asr is required for forced alignment') from exc
        if not hasattr(self, "_model"):
            self._model = Qwen3ForcedAligner.from_pretrained(model_path(ALIGNER_MODEL), **model_options())
        result = self._model.align(audio=(np.asarray(samples), sample_rate), text=text, language=lang)
        return coerce_aligner_tokens(result[0])


class Qwen3Asr:
    """Qwen3-ASR-0.6B transcript for the mispronunciation check.

    Reuses a loaded qwen_asr model across scenes. Tests substitute the model.
    """

    def available(self) -> bool:
        return importlib.util.find_spec("qwen_asr") is not None

    def transcribe(self, samples: np.ndarray, sample_rate: int, lang: str) -> str:
        try:
            import qwen_asr  # type: ignore  # optional extra
        except ImportError as exc:
            raise QwenRuntimeUnavailable(
                "qwen-asr is not installed. It is an optional extra and is not part of the default install or the tests."
            ) from exc
        model_cls = getattr(qwen_asr, "Qwen3ASRModel", None)
        if model_cls is None:
            raise QwenRuntimeUnavailable("qwen_asr.Qwen3ASRModel is missing")
        if not hasattr(self, "_model"):
            self._model = model_cls.from_pretrained(model_path(ASR_MODEL), **model_options(), max_new_tokens=512)
        result = self._model.transcribe(audio=(np.asarray(samples), sample_rate), language=lang)
        if isinstance(result, list):
            result = result[0]
        if isinstance(result, str):
            return result
        if isinstance(result, dict):
            return str(result.get("text", ""))
        return str(getattr(result, "text", result))


class Qwen3Tts:
    """Real VoiceDesign + Base-clone adapter. Tests never construct a successful call."""

    def available(self) -> bool:
        return importlib.util.find_spec("qwen_tts") is not None

    def design(self, *, persona: str, lang: str, reference_line: str) -> dict:
        """One VoiceDesign clip per package, cached as a ``voice_clone_prompt``."""
        qwen_tts = _import_qwen_tts()
        model_cls = getattr(qwen_tts, "Qwen3TTSModel", None)
        if model_cls is None:
            raise QwenRuntimeUnavailable("qwen_tts.Qwen3TTSModel is missing")
        self._seed(42)
        design = model_cls.from_pretrained(model_path(DESIGN_MODEL), **model_options())
        wavs, sr = design.generate_voice_design(text=reference_line, language=lang, instruct=persona, max_new_tokens=2048)
        audio = np.asarray(wavs[0], dtype=np.float32)
        del design
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        base = model_cls.from_pretrained(model_path(BASE_MODEL), **model_options())
        prompt = base.create_voice_clone_prompt(ref_audio=(audio, int(sr)), ref_text=reference_line)
        self._base = base
        return {
            "voice_clone_prompt": prompt,
            "ref_text": reference_line,
            "sample_rate": int(sr),
            "persona": persona,
            "lang": lang,
            "reference_audio": audio,
        }

    def synthesize(self, text: str, *, prompt: dict, instruct: str | None, lang: str, seed: int) -> tuple[np.ndarray, int]:
        """One Base-clone call for a whole scene. Returns 24 kHz mono float32."""
        qwen_tts = _import_qwen_tts()
        model_cls = getattr(qwen_tts, "Qwen3TTSModel", None)
        if model_cls is None:
            raise QwenRuntimeUnavailable("qwen_tts.Qwen3TTSModel is missing")
        base = getattr(self, "_base", None) or model_cls.from_pretrained(model_path(BASE_MODEL), **model_options())
        self._base = base
        self._seed(seed)
        kwargs = {
            "text": text,
            "language": lang,
            "voice_clone_prompt": prompt.get("voice_clone_prompt", prompt),
            "max_new_tokens": 2048,
        }
        # Base supports cloning, not instruction following. Persona is applied in VoiceDesign.
        wavs, sr = base.generate_voice_clone(**kwargs)
        audio = to_sample_rate(np.asarray(wavs[0], dtype=np.float32), int(sr), SAMPLE_RATE)
        return audio, SAMPLE_RATE

    @staticmethod
    def _seed(seed: int) -> None:
        try:
            import torch
        except ImportError:
            return
        torch.manual_seed(int(seed))
