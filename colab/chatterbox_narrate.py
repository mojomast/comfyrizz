#!/usr/bin/env python3
"""Chatterbox Multilingual voiceover through a local ComfyUI server (SPW06).

This is the VM-side worker, shaped like ``colab/qwen_narrate.py`` but without
the Google Colab packaging. It sends one prompt per narration line per take,
downloads each ``SaveAudio`` result, transcribes it in the existing qwen-asr
environment, and delegates take selection to ``packages/tts/py/chatterbox.py``.

    python colab/chatterbox_narrate.py --package package.json --out run

The node pack ``filliptm/ComfyUI_Fill-ChatterBox`` is MIT, and the Chatterbox
Multilingual weights are MIT (Resemble AI). No GPL/AGPL/LGPL node pack is used.
"""
from __future__ import annotations

import argparse
from collections.abc import Mapping
import functools
import importlib
import inspect
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import wave

import numpy as np

TTS_PY = Path(__file__).resolve().parents[1] / "packages" / "tts" / "py"
if str(TTS_PY) not in sys.path:
    sys.path.insert(0, str(TTS_PY))

from chatterbox import DEFAULT_GRAPH, DEFAULT_LANGUAGE, DEFAULT_TAKES_PER_LINE, synth_lines  # noqa: E402
from qwen import to_sample_rate  # noqa: E402
from synth import SAMPLE_RATE, split_sentences, write_wav  # noqa: E402
from take_select import select_take  # noqa: E402

DEFAULT_COMFY = "http://127.0.0.1:8188"
DEFAULT_TIMEOUT = 600.0
DEFAULT_POLL_INTERVAL = 0.5
AUDIO_SUFFIXES = {".wav", ".flac", ".mp3", ".ogg", ".m4a"}

_ASR_CODE = """
import json
import sys

import soundfile as sf

from qwen import Qwen3Asr

path, language = sys.argv[1], sys.argv[2]
samples, rate = sf.read(path, dtype="float32")
if getattr(samples, "ndim", 1) > 1:
    samples = samples.mean(axis=1)
transcript = Qwen3Asr().transcribe(samples, rate, language)
print(json.dumps({"transcript": transcript}))
"""


def collect_lines(package: Mapping) -> list[dict]:
    """One narration line per sentence, tagged with its scene."""
    lines: list[dict] = []
    for scene in package.get("scenes", []):
        text = (scene.get("narration") or "").strip()
        if not text:
            continue
        scene_id = scene.get("id")
        if not isinstance(scene_id, str) or not scene_id.strip():
            raise ValueError("a scene with narration has no id")
        for index, sentence in enumerate(split_sentences(text)):
            lines.append(
                {
                    "id": f"{scene_id}_line_{index + 1:03d}",
                    "text": sentence,
                    "spoken": sentence,
                    "scene": scene_id,
                }
            )
    return lines


def _post_json(url: str, payload: dict, timeout: float = DEFAULT_TIMEOUT) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _get_json(url: str, timeout: float = DEFAULT_TIMEOUT) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _audio_item(outputs: Mapping) -> dict | None:
    for node_output in outputs.values():
        if not isinstance(node_output, Mapping):
            continue
        for key, value in node_output.items():
            if not isinstance(value, list):
                continue
            for item in value:
                if not isinstance(item, Mapping) or not item.get("filename"):
                    continue
                suffix = Path(str(item["filename"])).suffix.lower()
                if key in {"audio", "audios"} or suffix in AUDIO_SUFFIXES:
                    return {
                        "filename": str(item["filename"]),
                        "subfolder": str(item.get("subfolder", "")),
                        "type": str(item.get("type", "output")),
                    }
    return None


def _download_audio(comfy: str, item: Mapping, timeout: float = DEFAULT_TIMEOUT) -> Path:
    query = urllib.parse.urlencode(
        {
            "filename": item.get("filename", ""),
            "subfolder": item.get("subfolder", ""),
            "type": item.get("type", "output"),
        }
    )
    url = f"{comfy}/view?{query}"
    descriptor, temporary = tempfile.mkstemp(prefix="chatterbox-", suffix=".wav")
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response, os.fdopen(descriptor, "wb") as handle:
            shutil.copyfileobj(response, handle)
    except BaseException:
        os.close(descriptor)
        Path(temporary).unlink(missing_ok=True)
        raise
    return Path(temporary)


def submit_graph(
    graph: dict,
    *,
    comfy: str = DEFAULT_COMFY,
    post=None,
    get=None,
    download=None,
    sleep=time.sleep,
    clock=time.monotonic,
    timeout: float = DEFAULT_TIMEOUT,
    poll_interval: float = DEFAULT_POLL_INTERVAL,
) -> str:
    """POST one prompt, poll its history, and return the downloaded WAV path."""
    post = post or _post_json
    get = get or _get_json
    download = download or _download_audio
    base = comfy.rstrip("/")
    response = post(f"{base}/prompt", {"prompt": graph})
    prompt_id = response.get("prompt_id") if isinstance(response, Mapping) else None
    if not prompt_id:
        raise RuntimeError("ComfyUI /prompt returned no prompt_id")

    deadline = clock() + timeout
    history_url = f"{base}/history/{urllib.parse.quote(str(prompt_id), safe='')}"
    while True:
        history = get(history_url)
        entry = history.get(prompt_id) if isinstance(history, Mapping) else None
        if isinstance(entry, Mapping):
            item = _audio_item(entry.get("outputs") or {})
            if item is None:
                raise RuntimeError(f"ComfyUI prompt {prompt_id} produced no SaveAudio output")
            return str(download(base, item))
        if clock() >= deadline:
            raise TimeoutError(f"ComfyUI prompt {prompt_id} did not finish within {timeout} seconds")
        sleep(poll_interval)


def _qa_qwen_transcriber():
    try:
        module = importlib.import_module("qa_qwen")
    except ImportError:
        return None
    helper = getattr(module, "transcribe", None)
    return helper if callable(helper) else None


def _helper_transcript(helper, path: Path, language: str) -> str:
    try:
        parameters = inspect.signature(helper).parameters
    except (TypeError, ValueError):
        parameters = {}
    names = set(parameters)
    if "language" in names:
        value = helper(str(path), language=language)
    elif "lang" in names:
        value = helper(str(path), lang=language)
    else:
        value = helper(str(path))
    if isinstance(value, Mapping):
        return str(value.get("text", value.get("transcript", "")))
    return str(value)


def transcribe(path, *, asr_python=None, language: str = DEFAULT_LANGUAGE) -> str:
    """Transcribe a take in the separate qwen-asr environment."""
    helper = _qa_qwen_transcriber()
    if helper is not None:
        return _helper_transcript(helper, Path(path), language)

    python = asr_python or os.environ.get("COMFYRIZZ_QWEN_ASR_PYTHON") or sys.executable
    environment = {**os.environ, "PYTHONPATH": str(TTS_PY) + os.pathsep + os.environ.get("PYTHONPATH", "")}
    process = subprocess.run(
        [str(python), "-c", _ASR_CODE, str(path), language],
        cwd=TTS_PY,
        env=environment,
        capture_output=True,
        text=True,
    )
    if process.returncode:
        raise RuntimeError("qwen-asr transcription failed: " + (process.stderr.strip() or process.stdout.strip()))
    lines = [line for line in process.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("qwen-asr transcription produced no output")
    return str(json.loads(lines[-1])["transcript"])


def _call_transcriber(callback, path, language: str) -> str:
    try:
        parameters = inspect.signature(callback).parameters
    except (TypeError, ValueError):
        return str(callback(str(path)))
    names = set(parameters)
    if "language" in names:
        return str(callback(str(path), language=language))
    if "lang" in names:
        return str(callback(str(path), lang=language))
    return str(callback(str(path)))


def _result_path(result) -> Path | None:
    if isinstance(result, Mapping):
        value = result.get("path", result.get("file"))
        return Path(value) if value is not None else None
    if isinstance(result, (str, Path)):
        return Path(result)
    if isinstance(result, (tuple, list)) and result and isinstance(result[0], (str, Path)):
        return Path(result[0])
    return None


def _wav_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / handle.getframerate()


def _result_seconds(result, path: Path | None) -> float:
    if isinstance(result, Mapping):
        value = result.get("seconds", result.get("duration"))
        if value is not None:
            return round(float(value), 4)
    if path is not None and path.exists():
        return round(_wav_seconds(path), 4)
    raise ValueError("a Chatterbox take has no measured duration")


def _read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        raw = handle.readframes(handle.getnframes())
    if width != 2:
        raise ValueError(f"unsupported WAV sample width {width} in {path}")
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE:
        samples = to_sample_rate(samples, rate, SAMPLE_RATE)
    return samples


def _line_takes(line: Mapping, measure: Mapping, recorded: Mapping, transcripts: Mapping) -> list[dict]:
    takes: list[dict] = []
    seeds = measure.get("qa", {}).get("seeds", [])
    for index, seed in enumerate(seeds):
        results = recorded.get(int(seed), [])
        result = results[0] if results else None
        path = _result_path(result)
        transcript = transcripts.get(str(path), "") if path is not None else ""
        takes.append(
            {
                "line": line["id"],
                "scene": line["scene"],
                "index": index,
                "seed": int(seed),
                "path": str(path) if path is not None else None,
                "transcript": transcript,
                "seconds": _result_seconds(result, path) if result is not None else None,
            }
        )
    return takes


def _take_report(
    lines: list[dict],
    report: Mapping,
    recorded: Mapping,
    transcripts: Mapping,
    takes_per_line: int,
) -> dict:
    takes: list[dict] = []
    summaries: dict[str, dict] = {}
    flagged: list[str] = []
    for line in lines:
        measure = report["scenes"].get(line["id"])
        if measure is None:
            continue
        line_takes = _line_takes(line, measure, recorded, transcripts)
        selection = select_take(line["spoken"], line_takes)
        selected = selection["take"]
        selected_path = str(_result_path(selected)) if selected is not None else None
        for take in line_takes:
            key = str(take["path"])
            accepted = take["path"] == selected_path
            take["wer"] = selection["wer"].get(key, 1.0)
            take["status"] = "accepted" if accepted else "rejected"
            take["reasons"] = [] if accepted else list(selection["rejections"].get(key, []))
        is_flagged = selected is None
        if is_flagged:
            flagged.append(line["id"])
        summaries[line["id"]] = {
            "scene": line["scene"],
            "text": line["text"],
            "spoken": line["spoken"],
            "selected": selected_path,
            "flagged": is_flagged,
            "attempts": len(line_takes),
            "seeds": [take["seed"] for take in line_takes],
        }
        takes.extend(line_takes)
    return {
        "version": 1,
        "engine": "chatterbox",
        "takesPerLine": int(takes_per_line),
        "takes": takes,
        "lines": summaries,
        "flagged": flagged,
    }


def _write_scene_audio(lines: list[dict], audio: Path, report: Mapping) -> None:
    scene_order: list[str] = []
    for line in lines:
        if line["scene"] not in scene_order:
            scene_order.append(line["scene"])
    for scene_id in scene_order:
        chunks: list[np.ndarray] = []
        for line in (candidate for candidate in lines if candidate["scene"] == scene_id):
            path = audio / "narration" / f"{line['id']}.wav"
            if path.exists():
                chunks.append(_read_wav(path))
            else:
                seconds = float(report["scenes"][line["id"]]["seconds"])
                chunks.append(np.zeros(max(1, int(round(seconds * SAMPLE_RATE))), dtype=np.float32))
        write_wav(audio / f"{scene_id}.wav", np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32))


def run(
    package_path,
    out_dir,
    *,
    comfy: str = DEFAULT_COMFY,
    graph_path=None,
    submit_graph_fn=None,
    transcribe_fn=None,
    takes_per_line: int = DEFAULT_TAKES_PER_LINE,
    seed_base: int = 0,
) -> dict:
    """Synthesise every narration line and write durations plus the take report."""
    package = json.loads(Path(package_path).read_text())
    lines = collect_lines(package)
    if not lines:
        raise ValueError("package has no narration lines")

    root = Path(out_dir)
    audio = root / "audio"
    audio.mkdir(parents=True, exist_ok=True)
    template = json.loads(Path(graph_path or DEFAULT_GRAPH).read_text())

    submit = submit_graph_fn or functools.partial(submit_graph, comfy=comfy)
    asr = transcribe_fn or functools.partial(
        transcribe,
        asr_python=os.environ.get("COMFYRIZZ_QWEN_ASR_PYTHON") or sys.executable,
    )
    recorded: dict[int, list] = {}
    transcripts: dict[str, str] = {}

    def record_submit(graph):
        result = submit(graph)
        seed = int(graph["1"]["inputs"]["seed"])
        recorded.setdefault(seed, []).append(result)
        return result

    def record_transcribe(path, language=None):
        text = _call_transcriber(asr, path, language or DEFAULT_LANGUAGE)
        transcripts[str(path)] = text
        return text

    report = synth_lines(
        lines,
        {
            "graph": template,
            "submit_graph": record_submit,
            "transcribe": record_transcribe,
            "out": audio,
            "takes_per_line": takes_per_line,
            "seed_base": seed_base,
        },
    )

    take_report = _take_report(lines, report, recorded, transcripts, takes_per_line)
    (audio / "take_report.json").write_text(json.dumps(take_report, indent=2) + "\n")
    _write_scene_audio(lines, audio, report)
    flagged = list(take_report["flagged"])
    return {
        "report": report,
        "takeReport": take_report,
        "flagged": flagged,
        "exitCode": 1 if flagged else 0,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--comfy", default=DEFAULT_COMFY)
    parser.add_argument("--graph", type=Path, default=DEFAULT_GRAPH)
    args = parser.parse_args(argv)
    result = run(args.package, args.out, comfy=args.comfy, graph_path=args.graph)
    print(
        json.dumps(
            {
                "event": "chatterbox_take_report",
                "takes": len(result["takeReport"]["takes"]),
                "flagged": result["flagged"],
            }
        ),
        flush=True,
    )
    return result["exitCode"]


if __name__ == "__main__":
    sys.exit(main())
