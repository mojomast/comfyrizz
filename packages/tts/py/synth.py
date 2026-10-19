#!/usr/bin/env python3
"""Sentence or connected-paragraph Kokoro narration on CPU (spec 6.8/6.9).

Writes one WAV per scene plus `narration.wav`, and a `durations.json` whose
sentence durations are *measured* (samples / sample rate), never estimated.
No network at run time: model files are passed in from a local cache.

    python packages/tts/py/synth.py \
      --package examples/narrated-demo/package.json \
      --out examples/narrated-demo/audio \
      --model-dir ~/.cache/comfyrizz/kokoro
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import wave
from pathlib import Path

import numpy as np

from pronounce import pronounce
from words import word_timings

SAMPLE_RATE = 24_000
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
DEFAULT_GAP = 0.15
DEFAULT_PADDING = 0.25
DEFAULT_LANGUAGE = "en-us"


def resolve_language(voice_cfg: dict) -> str:
    """Kokoro's language code for the phonemiser (N-fix).

    The package carries it in ``voice.language`` (for example ``fr-fr`` for
    ff_siwis or ``en-gb``); US English is the fallback, matching the voice
    default. Hard-coding ``en-us`` phonemised French and GB voices as US
    English, so a non-English narration sounded wrong.
    """
    value = voice_cfg.get("language")
    return value.strip() if isinstance(value, str) and value.strip() else DEFAULT_LANGUAGE


def split_sentences(text: str) -> list[str]:
    chunks = [chunk.strip() for chunk in SENTENCE_SPLIT.split(text.strip()) if chunk.strip()]
    return chunks or [text.strip()]


def resolve_kokoro_style(kokoro, voice_cfg: dict, voice: str):
    """Resolve a preset or a normalized weighted blend; never ignore invalid choices."""
    blend = voice_cfg.get("blend")
    if not blend:
        kokoro.get_voice_style(voice)  # Fail early for an unavailable preset.
        return voice
    if not isinstance(blend, list) or not 2 <= len(blend) <= 4:
        raise ValueError("Kokoro blend needs two to four weighted voices")
    weights = np.asarray([part['weight'] for part in blend], dtype=np.float32)
    if not np.isfinite(weights).all() or not (weights > 0).all() or not (weights <= 1).all():
        raise ValueError("Kokoro blend weights must be finite and in (0, 1]")
    # Language code is the first preset character (a=US, b=GB, f=French, etc.).
    if len({part['voice'][0] for part in blend}) != 1:
        raise ValueError("Kokoro blend voices must use the same language/accent")
    return sum(kokoro.get_voice_style(part['voice']) * (weight / weights.sum()) for part, weight in zip(blend, weights))


def write_wav(path: Path, samples: np.ndarray, sample_rate: int = SAMPLE_RATE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())


def read_wav_seconds(path: Path, sample_rate: int = SAMPLE_RATE) -> float:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / sample_rate


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--model-dir", type=Path, default=Path.home() / ".cache/comfyrizz/kokoro")
    parser.add_argument("--voice", default=None)
    parser.add_argument("--speed", type=float, default=None)
    parser.add_argument("--gap", type=float, default=DEFAULT_GAP)
    parser.add_argument("--padding", type=float, default=DEFAULT_PADDING)
    args = parser.parse_args()

    package = json.loads(args.package.read_text())
    voice_cfg = package.get("voice", {})
    voice = args.voice or voice_cfg.get("voice") or "af_heart"
    speed = float(args.speed if args.speed is not None else voice_cfg.get("speed", 1.0))
    language = resolve_language(voice_cfg)
    if not 0.5 <= speed <= 2.0:
        raise SystemExit(f"speed {speed} outside Kokoro's 0.5-2.0 range")

    # R3: Qwen3-TTS is optional. A package that does not select it never imports
    # that backend, so Kokoro's outputs stay what they are today. A missing
    # Qwen runtime falls through to the Kokoro block below unless voice.strict.
    fallback_reason = None
    if voice_cfg.get("engine") == "qwen3-tts":
        from narrate_qwen import FallbackToKokoro, narrate_qwen
        from qwen import Qwen3Aligner, Qwen3Asr

        try:
            narrate_qwen(package, args.out, gap=args.gap, padding=args.padding, aligner=Qwen3Aligner(), asr=Qwen3Asr())
            return 0
        except FallbackToKokoro as exc:
            fallback_reason = str(exc)
            print(f"qwen3-tts unavailable ({exc}); using Kokoro")
            voice = "ff_siwis" if language.startswith("fr") else "af_heart"
            voice_cfg = {**voice_cfg, "blend": None, "chunking": "sentence"}

    model = args.model_dir / "kokoro-v1.0.onnx"
    voices = args.model_dir / "voices-v1.0.bin"
    for path in (model, voices):
        if not path.exists():
            raise SystemExit(
                f"missing {path}; run packages/tts/scripts/fetch-models.sh "
                "(weights are not committed)"
            )

    from kokoro_onnx import Kokoro

    started = time.time()
    kokoro = Kokoro(str(model), str(voices))
    style = resolve_kokoro_style(kokoro, {**voice_cfg, "blend": None} if args.voice else voice_cfg, voice)
    paragraph = voice_cfg.get("chunking", "sentence") == "paragraph"
    gap_seconds = 0.0 if paragraph else args.gap
    load_seconds = time.time() - started

    args.out.mkdir(parents=True, exist_ok=True)
    gap = np.zeros(int(round(args.gap * SAMPLE_RATE)), dtype=np.float32)
    pad = np.zeros(int(round(args.padding * SAMPLE_RATE)), dtype=np.float32)

    report: dict = {
        "version": 1,
        "engine": "kokoro-onnx",
        "engineVersion": "0.4.9",
        "model": "kokoro-v1.0.onnx",
        "voices": "voices-v1.0.bin",
        "voice": voice,
        "language": language,
        "speed": speed,
        "sampleRate": SAMPLE_RATE,
        "gapSeconds": gap_seconds,
        "voiceSettings": {**voice_cfg, "voice": voice, "speed": speed},
        "paddingSeconds": args.padding,
        "loadSeconds": round(load_seconds, 3),
        "scenes": {},
        "totalSeconds": 0.0,
    }

    full: list[np.ndarray] = []
    scenes = [s for s in package.get("scenes", []) if (s.get("narration") or "").strip()]
    for scene_index, scene in enumerate(scenes):
        print(json.dumps({"event": "voice_scene_start", "sceneId": scene["id"], "completed": scene_index, "total": len(scenes)}), flush=True)
        text = (scene.get("narration") or "").strip()
        if not text:
            continue
        sentence_samples: list[np.ndarray] = []
        chunks: list[dict] = []
        for sentence in ([text] if paragraph else split_sentences(text)):
            spoken = pronounce(sentence)
            audio, sample_rate = kokoro.create(spoken, voice=style, speed=speed, lang=language)
            if sample_rate != SAMPLE_RATE:
                raise SystemExit(f"unexpected sample rate {sample_rate}")
            audio = np.asarray(audio, dtype=np.float32)
            sentence_samples.append(audio)
            seconds = round(len(audio) / SAMPLE_RATE, 4)
            chunks.append(
                {
                    "text": sentence,
                    "spoken": spoken,
                    "seconds": seconds,
                    "samples": int(len(audio)),
                    # K1: word timings inside the measured sentence. The syllable
                    # fallback needs no model; a real aligner can pass `tokens` later.
                    "words": word_timings(sentence, seconds),
                }
            )
        if paragraph:
            # Preserve sentence captions while clearly marking estimated boundaries.
            # Measured duration is from the whole take, not an invented sentence call.
            from narrate_qwen import build_chunks
            sentences = split_sentences(text)
            chunks = build_chunks(sentences, [pronounce(s) for s in sentences], len(sentence_samples[0]) / SAMPLE_RATE, None)
        parts: list[np.ndarray] = []
        for index, part in enumerate(sentence_samples):
            if index:
                parts.append(gap)
            parts.append(part)
        parts.append(pad)
        scene_audio = np.concatenate(parts).astype(np.float32)
        scene_path = args.out / "narration" / f"{scene['id']}.wav"
        write_wav(scene_path, scene_audio)
        report["scenes"][scene["id"]] = {
            "chunks": chunks,
            "gapSeconds": gap_seconds,
            "paddingSeconds": args.padding,
            "seconds": round(read_wav_seconds(scene_path), 4),
            "file": str(scene_path.relative_to(args.out.parent)),
        }
        print(json.dumps({"event": "voice_scene_done", "sceneId": scene["id"], "completed": scene_index + 1, "total": len(scenes)}), flush=True)
        full.append(scene_audio)
        full.append(np.zeros(int(round(0.1 * SAMPLE_RATE)), dtype=np.float32))

    narration_path = args.out / "narration.raw.wav"
    write_wav(narration_path, np.concatenate(full) if full else np.zeros(1, dtype=np.float32))
    report["totalSeconds"] = round(read_wav_seconds(narration_path), 4)
    report["synthesisSeconds"] = round(time.time() - started, 2)
    report["file"] = "narration.raw.wav"
    if fallback_reason:
        report["requestedEngine"] = "qwen3-tts"
        report["engineFallback"] = "kokoro"
        report["engineFallbackReason"] = fallback_reason
    (args.out / "durations.json").write_text(json.dumps(report, indent=2) + "\n")

    print(
        f"narration ok: scenes={report['scenes'] and round(sum(item['seconds'] for item in report['scenes'].values()),3)}s, {len(report['scenes'])} scenes, "
        f"voice={voice} speed={speed}, synth={report['synthesisSeconds']}s"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
