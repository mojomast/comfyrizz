"""Chatterbox Multilingual voiceover engine (SP05).

One line per graph call: a scene is never sent as a whole. Every take gets a
new seed; an injected ASR transcribes the returned audio and ``select_take``
picks a usable take. A line that has no usable take after the first attempt is
regenerated up to two more times, then flagged.

The default graph is ``workflows/chatterbox_multilingual_tts.api.json``, which
uses the model's built-in voice and core ``SaveAudio``. ``audio_prompt`` is
added only when the caller passes an explicit ``voice_reference``; cloning is
opt-in and off by default.

Node pack: ``filliptm/ComfyUI_Fill-ChatterBox`` (MIT per its README; the
pinned tree's licence file was not verifiable, recorded by SP04). The
Chatterbox Multilingual weights are MIT (Resemble AI).
"""
from __future__ import annotations

import copy
import inspect
import json
import shutil
import wave
from pathlib import Path
from typing import Mapping

import numpy as np

from qwen import to_sample_rate
from synth import SAMPLE_RATE, write_wav
from take_select import expected_seconds, select_take
from words import word_timings

ENGINE = "chatterbox"
DEFAULT_LANGUAGE = "English (en)"
DEFAULT_TAKES_PER_LINE = 3
MAX_REGENERATIONS = 2
DEFAULT_GRAPH = Path(__file__).resolve().parents[3] / "workflows" / "chatterbox_multilingual_tts.api.json"
WORD_SPLIT_GAP = 0.1


def _line_record(value, index: int) -> dict:
    if isinstance(value, str):
        text = value
        return {"id": f"line_{index + 1:03d}", "text": text, "spoken": text}
    if not isinstance(value, Mapping):
        raise TypeError("each line must be a string or an object with text")
    text = value.get("text")
    if not (isinstance(text, str) and text.strip()):
        text = value.get("narration")
    if not (isinstance(text, str) and text.strip()):
        raise ValueError(f"line {index + 1} has no text")
    spoken = value.get("spoken")
    spoken = spoken if isinstance(spoken, str) and spoken.strip() else text
    ident = value.get("id")
    ident = ident if isinstance(ident, str) and ident.strip() else f"line_{index + 1:03d}"
    return {**value, "id": ident, "text": text, "spoken": spoken}


def _graph_template(options: dict) -> dict:
    if "graph" in options:
        return copy.deepcopy(options["graph"])
    path = Path(options.get("workflow", DEFAULT_GRAPH))
    return json.loads(path.read_text())


def _build_graph(template: dict, *, text: str, seed: int, language: str, voice_reference) -> dict:
    graph = copy.deepcopy(template)
    node = graph.get("1")
    if not isinstance(node, dict):
        raise ValueError("chatterbox graph has no node 1")
    inputs = node.setdefault("inputs", {})
    inputs["text"] = text
    inputs["seed"] = int(seed)
    inputs["language"] = language
    if voice_reference:
        ref_id = "2" if "2" not in graph else str(max(int(key) for key in graph if str(key).isdigit()) + 1)
        graph[ref_id] = {"class_type": "LoadAudio", "inputs": {"audio": str(voice_reference)}}
        inputs["audio_prompt"] = [ref_id, 0]
    else:
        inputs.pop("audio_prompt", None)
    return graph


def _call_submit(submit_graph, graph: dict, *, text: str, seed: int, language: str, voice_reference):
    try:
        parameters = inspect.signature(submit_graph).parameters
    except (TypeError, ValueError):
        return submit_graph(graph)
    names = set(parameters)
    if names & {"graph", "workflow"}:
        return submit_graph(graph)
    if "text" in names:
        values = {
            "text": text,
            "seed": seed,
            "language": language,
            "voice_reference": voice_reference,
            "audio_prompt": voice_reference,
        }
        return submit_graph(**{key: value for key, value in values.items() if key in names})
    return submit_graph(graph)


def _read_audio(path: Path) -> tuple[np.ndarray, int]:
    try:
        with wave.open(str(path), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            raw = handle.readframes(handle.getnframes())
    except (wave.Error, OSError):
        import soundfile as sf

        samples, rate = sf.read(str(path), dtype="float32")
        samples = np.asarray(samples, dtype=np.float32)
        return (samples.mean(axis=1) if samples.ndim > 1 else samples), int(rate)
    if width != 2:
        raise ValueError(f"unsupported WAV sample width {width}")
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, int(rate)


def _take_result(result, default_rate: int) -> tuple[Path | None, float, np.ndarray | None, int]:
    path = None
    seconds = None
    samples = None
    rate = default_rate
    if isinstance(result, Mapping):
        value = result.get("path", result.get("file"))
        path = Path(value) if value is not None else None
        seconds = result.get("seconds", result.get("duration"))
        samples = result.get("samples")
        if samples is None and isinstance(result.get("audio"), np.ndarray):
            samples = result["audio"]
        rate = int(result.get("sampleRate", default_rate))
    elif isinstance(result, (str, Path)):
        path = Path(result)
    elif isinstance(result, np.ndarray):
        samples = result
    elif isinstance(result, (tuple, list)) and len(result) == 2:
        first, second = result
        if isinstance(first, (str, Path)):
            path = Path(first)
            seconds = second
        else:
            samples = np.asarray(first, dtype=np.float32)
            rate = int(second)
    else:
        raise TypeError("submit_graph must return a path, an audio array, or a take record")

    samples = np.asarray(samples, dtype=np.float32) if samples is not None else None
    if seconds is None and samples is not None:
        seconds = len(samples) / rate
    if seconds is None and path is not None:
        try:
            samples, rate = _read_audio(path)
            seconds = len(samples) / rate
        except (OSError, ValueError, wave.Error, ImportError):
            seconds = None
    if seconds is None:
        raise ValueError("submit_graph returned no measured duration")
    return path, round(float(seconds), 4), samples, rate


def _call_transcribe(transcribe, path: Path, seconds: float, samples, rate: int, language: str) -> str:
    try:
        parameters = list(inspect.signature(transcribe).parameters.values())
    except (TypeError, ValueError):
        return str(transcribe(str(path)))
    names = {parameter.name for parameter in parameters}
    positional = [
        parameter
        for parameter in parameters
        if parameter.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    audio = samples
    if audio is None and (names & {"samples", "audio", "waveform", "wave"} or len(positional) >= 2):
        try:
            audio, rate = _read_audio(path)
        except (OSError, ValueError, wave.Error, ImportError):
            audio = np.zeros(max(1, int(round(seconds * rate))), dtype=np.float32)
    if names & {"samples", "audio", "waveform", "wave"} or len(positional) >= 3:
        return str(transcribe(audio, rate, language))
    if len(positional) == 2:
        if positional[1].name in {"lang", "language"}:
            return str(transcribe(str(path), language))
        return str(transcribe(audio, rate))
    if "language" in names or "lang" in names:
        key = "language" if "language" in names else "lang"
        return str(transcribe(str(path), **{key: language}))
    return str(transcribe(str(path)))


def _write_line_audio(out: Path, ident: str, path, samples, rate: int, seconds: float) -> tuple[Path, np.ndarray | None]:
    destination = out / "narration" / f"{ident}.wav"
    if samples is not None:
        audio = to_sample_rate(samples, rate, SAMPLE_RATE) if rate != SAMPLE_RATE else np.asarray(samples, dtype=np.float32)
        write_wav(destination, audio)
        return destination, audio
    if path is not None and path.exists():
        try:
            audio, source_rate = _read_audio(path)
            if source_rate != SAMPLE_RATE:
                audio = to_sample_rate(audio, source_rate, SAMPLE_RATE)
            write_wav(destination, audio)
            return destination, audio
        except (OSError, ValueError, wave.Error, ImportError):
            destination = out / "narration" / f"{ident}{path.suffix or '.wav'}"
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
            return destination, None
    silence = np.zeros(max(1, int(round(seconds * SAMPLE_RATE))), dtype=np.float32)
    write_wav(destination, silence)
    return destination, silence


def _best_rejected(takes: list[dict], result: dict) -> dict:
    expected = result["expectedSeconds"]

    def score(take: dict) -> tuple[float, float]:
        return result["wer"].get(str(take.get("path")), 1.0), abs(float(take["seconds"]) - expected)

    return min(takes, key=score)


def synth_lines(lines: list, options: dict | None = None, **dependencies) -> dict:
    """Synthesise one voiceover line at a time and write ``audio/durations.json``."""
    config = dict(options or {})
    config.update(dependencies)
    submit_graph = config.get("submit_graph")
    transcribe = config.get("transcribe")
    if not callable(submit_graph):
        raise TypeError("synth_lines needs an injected submit_graph")
    if not callable(transcribe):
        raise TypeError("synth_lines needs an injected transcribe")

    out = Path(config.get("out", "audio"))
    out.mkdir(parents=True, exist_ok=True)
    language = config.get("language", DEFAULT_LANGUAGE)
    seed_base = int(config.get("seed_base", 0))
    voice_reference = config.get("voice_reference")
    requested = max(1, int(config.get("takes_per_line", DEFAULT_TAKES_PER_LINE)))
    max_takes = min(requested, 1 + MAX_REGENERATIONS)
    template = _graph_template(config)

    report: dict = {
        "version": 1,
        "engine": ENGINE,
        "engineVersion": "multilingual",
        "model": "chatterbox_multilingual",
        "voices": "built-in" if not voice_reference else "voice-reference",
        "voice": str(voice_reference) if voice_reference else "built-in",
        "language": language,
        "speed": 1.0,
        "sampleRate": SAMPLE_RATE,
        "gapSeconds": 0.0,
        "paddingSeconds": 0.0,
        "voiceSettings": {
            "language": language,
            "voice_reference": str(voice_reference) if voice_reference else None,
        },
        "scenes": {},
        "totalSeconds": 0.0,
        "file": "narration.raw.wav",
    }

    full: list[np.ndarray] = []
    for index, value in enumerate(lines):
        record = _line_record(value, index)
        ident = record["id"]
        text = record["text"].strip()
        spoken = record["spoken"].strip()
        line_language = record.get("language") if isinstance(record.get("language"), str) else language
        takes: list[dict] = []
        seeds: list[int] = []
        selected = None
        result = None
        for attempt in range(max_takes):
            seed = seed_base + index * max_takes + attempt
            seeds.append(seed)
            graph = _build_graph(
                template,
                text=spoken,
                seed=seed,
                language=line_language,
                voice_reference=voice_reference,
            )
            submitted = _call_submit(
                submit_graph,
                graph,
                text=spoken,
                seed=seed,
                language=line_language,
                voice_reference=voice_reference,
            )
            path, seconds, samples, rate = _take_result(submitted, SAMPLE_RATE)
            transcript = _call_transcribe(transcribe, path, seconds, samples, rate, line_language)
            takes.append(
                {
                    "path": str(path) if path is not None else None,
                    "transcript": transcript,
                    "seconds": seconds,
                    "_samples": samples,
                    "_rate": rate,
                }
            )
            result = select_take(spoken, takes)
            if result["take"] is not None:
                selected = takes[attempt]
                break

        flagged = selected is None
        result = result or select_take(spoken, takes)
        chosen = selected if selected is not None else _best_rejected(takes, result)
        path, seconds, samples, rate = _take_result(
            {"path": chosen.get("path"), "seconds": chosen["seconds"], "samples": chosen.get("_samples"), "sampleRate": chosen.get("_rate", SAMPLE_RATE)},
            SAMPLE_RATE,
        )
        destination, audio = _write_line_audio(out, ident, path, samples, rate, seconds)
        chunk = {
            "text": text,
            "spoken": spoken,
            "seconds": seconds,
            "samples": int(round(seconds * SAMPLE_RATE)),
            "words": word_timings(text, seconds),
            "take": str(path) if path is not None else None,
        }
        report["scenes"][ident] = {
            "chunks": [chunk],
            "gapSeconds": 0.0,
            "paddingSeconds": 0.0,
            "seconds": seconds,
            "file": destination.relative_to(out.parent).as_posix(),
            "take": chunk["take"],
            "seed": seeds[-1],
            "qa": {
                "transcript": chosen["transcript"],
                "wer": result["wer"].get(str(chosen.get("path")), 1.0),
                "flagged": flagged,
                "attempts": len(takes),
                "seeds": seeds,
                "reasons": [str(reason) for reason in result["reasons"]],
            },
        }
        if audio is not None:
            full.append(audio)
            full.append(np.zeros(int(round(WORD_SPLIT_GAP * SAMPLE_RATE)), dtype=np.float32))

    narration = np.concatenate(full) if full else np.zeros(1, dtype=np.float32)
    write_wav(out / "narration.raw.wav", narration)
    report["totalSeconds"] = round(len(narration) / SAMPLE_RATE, 4)
    (out / "durations.json").write_text(json.dumps(report, indent=2) + "\n")
    return report
