"""Qwen3-TTS narration for one package (R3).

VoiceDesign runs once, from ``voice.persona``. Every scene is then one Base
clone of that cached prompt, so the narrator stays the same and the scene's
1–3 sentences share a single take. Kokoro remains the fallback when this
runtime is missing, unless ``voice.strict`` is set.

Word timings stay the K1 ``words[]`` list. Qwen3-ForcedAligner tokens are
passed through ``word_timings``; a list that does not fit the take is rejected
and the syllable fallback fills the same fields.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

from pronounce import pronounce
from qwen import (
    ALIGNER_MODEL,
    BASE_MODEL,
    DEFAULT_REFERENCE,
    DESIGN_MODEL,
    ENGINE_QWEN,
    MODEL_LICENSE,
    SAMPLE_RATE,
    Qwen3Tts,
    QwenRuntimeUnavailable,
    coerce_aligner_tokens,
    qwen_language_name,
    resolve_engine,
    strict_voice,
    to_sample_rate,
)
from synth import read_wav_seconds, resolve_language, split_sentences, write_wav
from words import count_syllables, word_timings

WORD_SPLIT_GAP = 0.1


class FallbackToKokoro(Exception):
    """Qwen3-TTS was requested and cannot run; the caller synthesises with Kokoro."""


def _proportional(weights: list[int], seconds: float) -> list[float]:
    seconds = round(float(seconds), 4)
    if not weights:
        return [0.0, seconds]
    total = sum(weights) or 1
    bounds = [0.0]
    running = 0
    for weight in weights[:-1]:
        running += weight
        bounds.append(round(seconds * running / total, 4))
    bounds.append(seconds)
    for index in range(1, len(bounds) - 1):
        if bounds[index] <= bounds[index - 1]:
            bounds[index] = round(min(seconds, bounds[index - 1] + 0.0001), 4)
    bounds[-1] = seconds
    return bounds


def scene_seed(scene_id: str, text: str) -> int:
    digest = hashlib.sha256(f"{scene_id}\n{text}".encode()).digest()
    return int.from_bytes(digest[:4], "big") % 1_000_000


def _syllable_weight(sentence: str) -> int:
    words = sentence.split()
    return sum(count_syllables(word) for word in words) or 1


def _collect_tokens(aligner, audio: np.ndarray, text: str, lang: str) -> list[dict] | None:
    """Ask the aligner for tokens. Any failure means the syllable fallback."""
    if aligner is None:
        return None
    if hasattr(aligner, "available") and not aligner.available():
        return None
    try:
        return coerce_aligner_tokens(aligner.align(audio, SAMPLE_RATE, text, lang))
    except Exception:
        return None


def build_chunks(sentences: list[str], spoken_sentences: list[str], speech_seconds: float, tokens: list[dict] | None) -> list[dict]:
    """Sentence chunks inside one scene take. Aligner tokens win when they fit.

    ``words[]`` is always the K1 shape (``text``, ``start``, ``end``, filling the
    chunk). A token list that ``word_timings`` rejects is dropped and the
    syllable fallback fills the same fields.
    """
    counts = [len(sentence.split()) for sentence in sentences]
    accepted = None
    if tokens and sum(counts) == len(tokens):
        try:
            accepted = word_timings(" ".join(sentences), speech_seconds, tokens)
        except ValueError:
            accepted = None
    groups = None
    if accepted is not None:
        groups = []
        cursor = 0
        for count in counts:
            groups.append(accepted[cursor : cursor + count])
            cursor += count
        bounds = [0.0]
        for index in range(len(groups) - 1):
            nxt = groups[index + 1][0]["start"] if groups[index + 1] else bounds[-1]
            bounds.append(round(max(bounds[-1], float(nxt)), 4))
        bounds.append(round(float(speech_seconds), 4))
    else:
        bounds = _proportional([_syllable_weight(sentence) for sentence in sentences], speech_seconds)

    chunks = []
    for index, sentence in enumerate(sentences):
        chunk_seconds = round(bounds[index + 1] - bounds[index], 4)
        if chunk_seconds <= 0:
            chunk_seconds = 0.0001
        local = None
        if groups is not None and groups[index]:
            origin = float(groups[index][0]["start"])
            local = [
                {
                    "text": token["text"],
                    "start": round(float(token["start"]) - origin, 4),
                    "end": round(float(token["end"]) - origin, 4),
                }
                for token in groups[index]
            ]
            local[0]["start"] = 0.0
            # Hold the last word through the pause before the next sentence so
            # the chunk still sums to its measured duration.
            local[-1]["end"] = round(chunk_seconds, 4)
        timing = "syllable-fallback"
        try:
            if local:
                words = word_timings(sentence, chunk_seconds, local)
                timing = "aligner"
            else:
                words = word_timings(sentence, chunk_seconds)
        except ValueError:
            words = word_timings(sentence, chunk_seconds)
        chunks.append(
            {
                "text": sentence,
                "spoken": spoken_sentences[index],
                "seconds": chunk_seconds,
                "samples": int(round(chunk_seconds * SAMPLE_RATE)),
                "words": words,
                "timing": timing,
            }
        )
    return chunks


def _adapter_call(label: str, fn):
    try:
        return fn()
    except QwenRuntimeUnavailable:
        raise
    except Exception as exc:
        raise QwenRuntimeUnavailable(f"{label} failed: {exc}") from exc


def _unavailable(voice_cfg: dict, reason: str, kokoro_runner):
    if strict_voice(voice_cfg):
        raise SystemExit(
            "Qwen3-TTS was selected with voice.strict set, and the runtime is unavailable "
            f"({reason}). Kokoro was not used."
        )
    if kokoro_runner is not None:
        report = kokoro_runner()
        if isinstance(report, dict):
            report["requestedEngine"] = ENGINE_QWEN
            report["engineFallback"] = "kokoro"
            report["engineFallbackReason"] = reason
        return report
    raise FallbackToKokoro(reason)


def narrate_qwen(
    package: dict,
    out: Path,
    *,
    tts=None,
    aligner=None,
    gap: float = 0.15,
    padding: float = 0.25,
    kokoro_runner=None,
) -> dict:
    """Synthesise ``package`` with Qwen3-TTS into ``out`` (a directory of wavs + durations.json).

    ``tts`` is the adapter. Tests pass a scripted fake. When it is omitted, the
    real adapter is used, and a missing install falls back to Kokoro.
    ``gap`` is accepted for CLI compatibility; a Qwen scene is one take, so the
    report records ``gapSeconds: 0`` and the sentence pauses live inside the chunks.
    """
    del gap  # one take per scene; see the docstring
    voice_cfg = package.get("voice") if isinstance(package.get("voice"), dict) else {}
    if resolve_engine(voice_cfg) != ENGINE_QWEN:
        return _unavailable(voice_cfg, "engine is not qwen3-tts", kokoro_runner)

    adapter = tts if tts is not None else Qwen3Tts()
    available = adapter.available() if hasattr(adapter, "available") else True
    if not available:
        return _unavailable(voice_cfg, "qwen3-tts runtime is unavailable", kokoro_runner)

    lang = qwen_language_name(voice_cfg)
    persona = voice_cfg.get("persona") if isinstance(voice_cfg.get("persona"), str) and voice_cfg.get("persona").strip() else "a clear neutral narrator"
    voice_id = voice_cfg.get("voice") if isinstance(voice_cfg.get("voice"), str) and voice_cfg.get("voice").strip() else "af_heart"
    try:
        speed = float(voice_cfg.get("speed", 1.0))
    except (TypeError, ValueError):
        speed = 1.0
    if not 0.5 <= speed <= 2.0:
        raise SystemExit(f"speed {speed} outside 0.5-2.0")

    try:
        prompt = _adapter_call(
            "voice design",
            lambda: adapter.design(persona=persona, lang=lang, reference_line=DEFAULT_REFERENCE),
        )
    except QwenRuntimeUnavailable as exc:
        return _unavailable(voice_cfg, str(exc), kokoro_runner)

    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    pad = np.zeros(int(round(padding * SAMPLE_RATE)), dtype=np.float32)
    report: dict = {
        "version": 1,
        "engine": ENGINE_QWEN,
        "engineVersion": "1.7B",
        "model": BASE_MODEL,
        "designModel": DESIGN_MODEL,
        "voices": "voice-design+base-clone",
        "voice": voice_id,
        "language": resolve_language(voice_cfg),
        "lang": lang,
        "persona": persona,
        "speed": speed,
        "sampleRate": SAMPLE_RATE,
        "gapSeconds": 0.0,
        "paddingSeconds": padding,
        "modelLicense": MODEL_LICENSE,
        "scenes": {},
        "totalSeconds": 0.0,
    }

    full: list[np.ndarray] = []
    for scene in package.get("scenes", []):
        display = (scene.get("narration") or "").strip()
        if not display:
            continue
        sentences = split_sentences(display)
        spoken_sentences = [pronounce(sentence) for sentence in sentences]
        spoken = " ".join(spoken_sentences)
        instruct = scene.get("narration_style") if isinstance(scene.get("narration_style"), str) and scene.get("narration_style").strip() else None
        seed = scene_seed(str(scene.get("id", "")), spoken)
        try:
            audio, sample_rate = _adapter_call(
                "scene synthesis",
                lambda: adapter.synthesize(spoken, prompt=prompt, instruct=instruct, lang=lang, seed=seed),
            )
        except QwenRuntimeUnavailable as exc:
            return _unavailable(voice_cfg, str(exc), kokoro_runner)
        audio = to_sample_rate(np.asarray(audio, dtype=np.float32), int(sample_rate), SAMPLE_RATE)
        if audio.size == 0:
            return _unavailable(voice_cfg, "Qwen3-TTS returned empty audio", kokoro_runner)
        speech_seconds = round(len(audio) / SAMPLE_RATE, 4)
        align_text = " ".join(sentences)
        tokens = _collect_tokens(aligner, audio, align_text, lang)
        chunks = build_chunks(sentences, spoken_sentences, speech_seconds, tokens)
        scene_audio = np.concatenate([audio, pad]).astype(np.float32)
        scene_path = out / "narration" / f"{scene['id']}.wav"
        write_wav(scene_path, scene_audio)
        report["scenes"][scene["id"]] = {
            "chunks": chunks,
            "gapSeconds": 0.0,
            "paddingSeconds": padding,
            "seconds": round(read_wav_seconds(scene_path), 4),
            "file": str(scene_path.relative_to(out.parent)),
            "instruct": instruct,
            "seed": seed,
        }
        full.append(scene_audio)
        full.append(np.zeros(int(round(WORD_SPLIT_GAP * SAMPLE_RATE)), dtype=np.float32))

    narration_path = out / "narration.raw.wav"
    write_wav(narration_path, np.concatenate(full) if full else np.zeros(1, dtype=np.float32))
    report["totalSeconds"] = round(read_wav_seconds(narration_path), 4)
    report["file"] = "narration.raw.wav"
    timings = {chunk["timing"] for scene in report["scenes"].values() for chunk in scene["chunks"]}
    if timings == {"aligner"}:
        report["aligner"] = ALIGNER_MODEL
    elif "aligner" in timings:
        report["aligner"] = "mixed"
    else:
        report["aligner"] = "syllable-fallback"
    (out / "durations.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        f"narration ok: engine=qwen3-tts scenes={len(report['scenes'])} "
        f"lang={lang} voice={voice_id}"
    )
    return report
