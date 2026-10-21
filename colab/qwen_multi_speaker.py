#!/usr/bin/env python3
"""Qwen3-TTS multi-speaker narration for one package (CCL4c).

The per-scene voice plan comes from CCL4b
(``apps/server/src/characters/speakers.mjs``). Each segment already names one
resolved voice and the scenes that speak with it, so this worker:

1. validates the package and the plan (``--dry-run`` stops here);
2. calls the existing ``packages/tts/py/narrate_qwen.py`` once per segment,
   with that segment's Qwen CustomVoice speaker or VoiceDesign persona;
3. assembles ``audio/narration/<scene>.wav``, a package-wide
   ``audio/narration.raw.wav`` and the usual ``audio/durations.json``.

Only Qwen is used here. A segment whose resolved engine is not ``qwen3-tts`` is
an error by default, because silently narrating it with a different voice would
break the plan; ``--skip-non-qwen`` lets a caller send only the Qwen segments.

``--dry-run`` imports no torch, numpy or qwen modules and needs no GPU, model
weights or network.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import wave
from pathlib import Path

QWEN_ENGINE = "qwen3-tts"
PLAN_SCHEMA = "comfyrizz.qwen-multi-speaker/v1"
SAMPLE_RATE = 24_000
DEFAULT_GAP_SECONDS = 0.1
DEFAULT_PADDING_SECONDS = 0.5
PLAN_FILE = "multi-speaker-plan.json"

# Mirrors packages/tts/py/qwen.py CUSTOM_SPEAKERS (that module imports numpy at
# import time, so a dry run must not import it). The test asserts the two lists
# still agree, which is the drift guard.
QWEN_SPEAKERS = (
    "Ryan",
    "Aiden",
    "Vivian",
    "Serena",
    "Uncle_Fu",
    "Dylan",
    "Eric",
    "Ono_Anna",
    "Sohee",
)
_CANONICAL_SPEAKERS = {name.lower(): name for name in QWEN_SPEAKERS}
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_VOICE_KEYS = (
    "engine",
    "voice",
    "qwen_mode",
    "persona",
    "delivery",
    "language",
    "lang",
    "reference_text",
    "non_streaming",
)
_VOICE_METADATA = frozenset(
    {"presetId", "sampleLines", "audition", "voiceHash", "voice_hash", "speaker", "castId", "cast_id"}
)
_SECRET_PATTERNS = (
    re.compile(r"\b(?:hf_|sk-|ghp_|gho_|AIza)[A-Za-z0-9_-]{8,}"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._-]+"),
    re.compile(r"(?i)\b((?:token|api[_-]?key|password)\s*[=:]\s*)\S+"),
)


def _redact(value: str) -> str:
    """Never let an upstream error carry a credential into our log or JSON output."""
    text = value
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(lambda match: (match.group(1) if match.groups() else "") + "[redacted]", text)
    return text


class MultiSpeakerError(RuntimeError):
    """A plan, package or runtime problem the caller must fix (never a token or path)."""

    def __init__(self, code: str, message: str):
        message = _redact(message)
        super().__init__(f"{code}: {message}")
        self.code = code
        self.detail = message


def _is_object(value) -> bool:
    return isinstance(value, dict)


def _clean(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _canonical(value) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    if _is_object(value):
        return "{" + ",".join(f"{key}:{_canonical(value[key])}" for key in sorted(value)) + "}"
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _voice_hash(voice: dict, declared: str = "") -> str:
    if re.fullmatch(r"[0-9a-f]{16,64}", declared or ""):
        return declared
    effective = {key: value for key, value in voice.items() if key != "strict"}
    return hashlib.sha256(f"comfyrizz.speaker-voice/v1\n{_canonical(effective)}".encode()).hexdigest()[:16]


def _read_json(path: Path, label: str, *, allow_list: bool = False):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise MultiSpeakerError("MULTI_SPEAKER_INPUT_MISSING", f"{label} file does not exist") from exc
    except (OSError, ValueError) as exc:
        raise MultiSpeakerError("MULTI_SPEAKER_INPUT_INVALID", f"{label} is not readable JSON: {exc}") from exc
    if not (_is_object(value) or (allow_list and isinstance(value, list))):
        raise MultiSpeakerError(
            "MULTI_SPEAKER_INPUT_INVALID",
            f"{label} must be a JSON {'array or object' if allow_list else 'object'}",
        )
    return value


def _write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def _package_scenes(package: dict) -> tuple[dict, list[str]]:
    scenes = package.get("scenes")
    if not isinstance(scenes, list):
        raise MultiSpeakerError("MULTI_SPEAKER_PACKAGE_INVALID", "package.scenes must be a list")
    by_id: dict[str, dict] = {}
    order: list[str] = []
    for index, scene in enumerate(scenes):
        if not _is_object(scene):
            raise MultiSpeakerError("MULTI_SPEAKER_PACKAGE_INVALID", f"scene {index} must be an object")
        scene_id = _clean(scene.get("id"))
        if not scene_id:
            raise MultiSpeakerError("MULTI_SPEAKER_PACKAGE_INVALID", f"scene {index} has no id")
        if scene_id in by_id:
            raise MultiSpeakerError("MULTI_SPEAKER_PACKAGE_INVALID", f"scene id {scene_id} is duplicated")
        by_id[scene_id] = scene
        order.append(scene_id)
    return by_id, order


def _plan_items(plan) -> list:
    if isinstance(plan, list):
        return plan
    if _is_object(plan):
        for key in ("segments", "jobs", "ttsJobs", "speakerSegments"):
            if isinstance(plan.get(key), list):
                return plan[key]
    raise MultiSpeakerError(
        "MULTI_SPEAKER_PLAN_INVALID",
        "plan must be a list or an object with a segments/jobs list",
    )


def _scene_ids(raw: dict, segment_id: str) -> list[str]:
    values: list = []
    if isinstance(raw.get("sceneIds"), list):
        values = raw["sceneIds"]
    elif isinstance(raw.get("scene_ids"), list):
        values = raw["scene_ids"]
    elif isinstance(raw.get("scenes"), list):
        for scene in raw["scenes"]:
            if _is_object(scene):
                values.append(scene.get("sceneId") or scene.get("scene_id") or scene.get("id"))
            else:
                values.append(scene)
    scene_ids: list[str] = []
    for value in values:
        scene_id = _clean(value)
        if not scene_id:
            raise MultiSpeakerError("MULTI_SPEAKER_PLAN_INVALID", f"segment {segment_id} has an empty scene id")
        if scene_id not in scene_ids:
            scene_ids.append(scene_id)
    if not scene_ids:
        raise MultiSpeakerError("MULTI_SPEAKER_PLAN_INVALID", f"segment {segment_id} names no scenes")
    return scene_ids


def _effective_voice(raw, segment_id: str) -> dict:
    if not _is_object(raw):
        raise MultiSpeakerError("MULTI_SPEAKER_PLAN_INVALID", f"segment {segment_id} has no voice object")
    engine = _clean(raw.get("engine"))
    if engine != QWEN_ENGINE:
        raise MultiSpeakerError(
            "MULTI_SPEAKER_ENGINE",
            f"segment {segment_id} resolved engine {engine or '(missing)'}; this worker narrates only {QWEN_ENGINE}",
        )
    mode = _clean(raw.get("qwen_mode")) or "design"
    if mode not in ("custom", "design"):
        raise MultiSpeakerError("MULTI_SPEAKER_PLAN_INVALID", f"segment {segment_id} has unknown qwen_mode {mode}")
    try:
        speed = float(raw.get("speed", 1.0))
    except (TypeError, ValueError) as exc:
        raise MultiSpeakerError("MULTI_SPEAKER_SPEED", f"segment {segment_id} has a non-numeric speed") from exc
    if speed != 1.0:
        raise MultiSpeakerError(
            "MULTI_SPEAKER_SPEED",
            f"segment {segment_id} uses speed {speed}; Qwen needs speed 1 and delivery direction",
        )
    voice = {key: raw[key] for key in _VOICE_KEYS if key in raw and raw[key] is not None}
    voice["engine"] = QWEN_ENGINE
    voice["qwen_mode"] = mode
    # Never let the per-segment narrator fall back to Kokoro behind the plan.
    voice["strict"] = True
    if mode == "custom":
        declared = _clean(raw.get("voice"))
        speaker = _CANONICAL_SPEAKERS.get(declared.lower())
        if not speaker:
            raise MultiSpeakerError(
                "MULTI_SPEAKER_SPEAKER",
                f"segment {segment_id} names {declared or '(missing)'}; use an existing Qwen CustomVoice speaker",
            )
        voice["voice"] = speaker
    else:
        persona = _clean(raw.get("persona"))
        if persona:
            voice["persona"] = persona
        else:
            voice.pop("persona", None)
        declared = _clean(raw.get("voice"))
        if declared:
            voice["voice"] = declared
    return voice


def normalize_plan(package: dict, plan, *, skip_non_qwen: bool = False) -> dict:
    """Validate a CCL4b plan against its package and return the normalized plan.

    User narration is never rewritten or interpreted; the worker narrates the
    package's own scene text so ``narration_spoken`` and ``narration_style``
    keep their existing meaning.
    """
    scenes_by_id, scene_order = _package_scenes(package)
    items = _plan_items(plan)
    segments: list[dict] = []
    skipped: list[dict] = []
    covered: set[str] = set()
    warnings: list[dict] = []
    seen_ids: set[str] = set()

    for index, raw in enumerate(items):
        if not _is_object(raw):
            raise MultiSpeakerError("MULTI_SPEAKER_PLAN_INVALID", f"segment {index} must be an object")
        segment_id = _clean(raw.get("id") or raw.get("segmentId") or raw.get("segment_id") or raw.get("jobId"))
        segment_id = segment_id or f"tts_{index + 1}"
        if not _SAFE_ID.fullmatch(segment_id):
            raise MultiSpeakerError("MULTI_SPEAKER_PLAN_INVALID", f"segment id {segment_id!r} is not path-safe")
        if segment_id in seen_ids:
            raise MultiSpeakerError("MULTI_SPEAKER_PLAN_INVALID", f"segment id {segment_id} is duplicated")
        seen_ids.add(segment_id)

        raw_voice = raw.get("voice") if _is_object(raw.get("voice")) else raw.get("spec")
        engine = _clean(raw_voice.get("engine")) if _is_object(raw_voice) else _clean(raw.get("engine"))
        if engine != QWEN_ENGINE:
            if skip_non_qwen:
                skipped.append({"id": segment_id, "engine": engine or None})
                continue
            raise MultiSpeakerError(
                "MULTI_SPEAKER_ENGINE",
                f"segment {segment_id} resolved engine {engine or '(missing)'}; "
                f"pass --skip-non-qwen to narrate only the {QWEN_ENGINE} segments",
            )
        voice = _effective_voice(raw_voice, segment_id)

        scene_ids: list[str] = []
        for scene_id in _scene_ids(raw, segment_id):
            if scene_id not in scenes_by_id:
                raise MultiSpeakerError(
                    "MULTI_SPEAKER_UNKNOWN_SCENE",
                    f"segment {segment_id} names scene {scene_id}, which the package does not contain",
                )
            if scene_id in covered:
                raise MultiSpeakerError(
                    "MULTI_SPEAKER_DUPLICATE_SCENE",
                    f"scene {scene_id} appears in more than one segment",
                )
            if not _clean(scenes_by_id[scene_id].get("narration")):
                continue
            scene_ids.append(scene_id)
        if not scene_ids:
            warnings.append({
                "code": "MULTI_SPEAKER_SILENT_SEGMENT",
                "segmentId": segment_id,
                "message": f"segment {segment_id} has no narrated scenes and was skipped",
            })
            continue
        covered.update(scene_ids)

        speaker = _clean(raw.get("speaker") or raw.get("castId") or raw.get("cast_id")) or None
        declared_hash = _clean(raw.get("voiceHash") or raw.get("voice_hash"))
        text = _clean(raw.get("spokenText") or raw.get("text") or raw.get("displayText"))
        text_length = len(text) if text else sum(
            len(_clean(scenes_by_id[scene_id].get("narration"))) for scene_id in scene_ids
        )
        segments.append({
            "id": segment_id,
            "index": len(segments),
            "sceneIds": scene_ids,
            "speaker": speaker,
            "voice": voice,
            "voiceHash": _voice_hash(voice, declared_hash),
            "segmentHash": _clean(raw.get("segmentHash") or raw.get("segment_hash")) or None,
            "textLength": text_length,
            "source": _clean(raw.get("source")) or None,
        })

    if not segments:
        raise MultiSpeakerError(
            "MULTI_SPEAKER_EMPTY_PLAN",
            "the plan contains no narrated Qwen segment",
        )
    uncovered = [
        scene_id for scene_id in scene_order
        if scene_id not in covered and _clean(scenes_by_id[scene_id].get("narration"))
    ]
    for scene_id in uncovered:
        warnings.append({
            "code": "MULTI_SPEAKER_UNCOVERED_SCENE",
            "sceneId": scene_id,
            "message": f"scene {scene_id} has narration but no segment in this plan",
        })
    return {
        "schema": PLAN_SCHEMA,
        "packageId": _clean(package.get("id")) or None,
        "segments": segments,
        "sceneOrder": scene_order,
        "uncoveredScenes": uncovered,
        "skipped": skipped,
        "warnings": warnings,
    }


def build_segment_package(package: dict, segment: dict) -> dict:
    """A minimal package holding only this segment's scenes and its resolved voice."""
    scenes_by_id, _ = _package_scenes(package)
    segment_id = segment["id"]
    return {
        "id": f"{_clean(package.get('id')) or 'package'}__{segment_id}",
        "schema": package.get("schema") or "comfyrizz.package/v1",
        "voice": dict(segment["voice"]),
        "scenes": [dict(scenes_by_id[scene_id]) for scene_id in segment["sceneIds"]],
    }


def _py_candidates() -> list[Path]:
    here = Path(__file__).resolve().parent
    return [
        here.parent / "packages" / "tts" / "py",
        here.parent / "py",
        here.parent / "packages" / "tts",
    ]


def _load_default_narrator():
    for candidate in _py_candidates():
        if (candidate / "narrate_qwen.py").is_file() and str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))
    try:
        from narrate_qwen import narrate_qwen
    except ImportError as exc:  # pragma: no cover - depends on the Colab image
        raise MultiSpeakerError(
            "MULTI_SPEAKER_RUNTIME",
            "the existing Qwen narrator is not importable; install the tts runtime first",
        ) from exc
    return narrate_qwen


def _default_adapter_factory(voice: dict):
    for candidate in _py_candidates():
        if (candidate / "qwen.py").is_file() and str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))
    from qwen import Qwen3Tts

    return Qwen3Tts(voice)


class _CachedVoiceAdapter:
    """One Qwen adapter per distinct voice, with its designed reference cached.

    ``narrate_qwen`` designs the voice for every call it serves. A segment is one
    call, so without this a package would reload the 1.7B model for every
    scene run and re-design a persona it already holds.
    """

    def __init__(self, voice: dict, factory):
        self._voice = voice
        self._factory = factory
        self._adapter = None
        self._design_key = None
        self._prompt = None

    def _inner(self):
        if self._adapter is None:
            self._adapter = self._factory(self._voice)
        return self._adapter

    def available(self) -> bool:
        return self._inner().available() if hasattr(self._inner(), "available") else True

    def design(self, **kwargs):
        key = _canonical(kwargs)
        if self._prompt is None or key != self._design_key:
            self._prompt = self._inner().design(**kwargs)
            self._design_key = key
        return self._prompt

    def synthesize(self, *args, **kwargs):
        return self._inner().synthesize(*args, **kwargs)


def _concat_wavs(paths: list[Path], destination: Path, gap_seconds: float) -> int:
    gap_samples = round(gap_seconds * SAMPLE_RATE)
    silence = b"\x00\x00" * gap_samples
    frames = 0
    expected = None
    destination.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(destination), "wb") as output:
        for index, path in enumerate(paths):
            try:
                with wave.open(str(path), "rb") as source:
                    current = (source.getnchannels(), source.getsampwidth(), source.getframerate())
                    if current != (1, 2, SAMPLE_RATE):
                        raise MultiSpeakerError(
                            "MULTI_SPEAKER_AUDIO",
                            f"narration for {path.stem} is not 24 kHz mono 16-bit",
                        )
                    if expected is None:
                        expected = current
                        output.setnchannels(current[0])
                        output.setsampwidth(current[1])
                        output.setframerate(current[2])
                    if source.getnframes() <= 0:
                        raise MultiSpeakerError("MULTI_SPEAKER_AUDIO", f"narration for {path.stem} is empty")
                    if index:
                        output.writeframes(silence)
                        frames += gap_samples
                    data = source.readframes(source.getnframes())
                    output.writeframes(data)
                    frames += source.getnframes()
            except (OSError, wave.Error) as exc:
                raise MultiSpeakerError("MULTI_SPEAKER_AUDIO", f"cannot read narration for {path.stem}") from exc
        if expected is None:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(SAMPLE_RATE)
            output.writeframes(b"\x00\x00")
            frames = 1
    return frames


def run_multi_speaker(
    package: dict,
    plan,
    out: Path,
    *,
    dry_run: bool = False,
    padding: float = DEFAULT_PADDING_SECONDS,
    gap: float = DEFAULT_GAP_SECONDS,
    skip_non_qwen: bool = False,
    keep_segments: bool = False,
    narrate=None,
    adapter_factory=None,
    on_event=None,
) -> dict:
    """Validate ``plan`` and (unless ``dry_run``) narrate each segment with Qwen.

    ``narrate`` and ``adapter_factory`` are injected so tests can run the whole
    orchestration with no GPU, model weights or network. The default narrator is
    the existing ``packages/tts/py/narrate_qwen.py``.
    """
    if not 0 <= padding <= 10:
        raise MultiSpeakerError("MULTI_SPEAKER_INPUT_INVALID", "padding must be between 0 and 10 seconds")
    if not 0 <= gap <= 10:
        raise MultiSpeakerError("MULTI_SPEAKER_INPUT_INVALID", "gap must be between 0 and 10 seconds")
    out = Path(out)
    normalized = normalize_plan(package, plan, skip_non_qwen=skip_non_qwen)
    emit = on_event or (lambda event: None)

    if dry_run:
        out.mkdir(parents=True, exist_ok=True)
        plan_doc = {
            "schema": PLAN_SCHEMA,
            "packageId": normalized["packageId"],
            "dryRun": True,
            "segments": normalized["segments"],
            "uncoveredScenes": normalized["uncoveredScenes"],
            "skipped": normalized["skipped"],
            "warnings": normalized["warnings"],
        }
        _write_json(out / PLAN_FILE, plan_doc)
        emit({"event": "multi_speaker_dry_run", "segments": len(normalized["segments"]), "scenes": len(normalized["sceneOrder"]) - len(normalized["uncoveredScenes"])})
        return {
            "schema": PLAN_SCHEMA,
            "dryRun": True,
            "packageId": normalized["packageId"],
            "segments": normalized["segments"],
            "uncoveredScenes": normalized["uncoveredScenes"],
            "skipped": normalized["skipped"],
            "warnings": normalized["warnings"],
            "planFile": PLAN_FILE,
        }

    if narrate is None:
        narrate = _load_default_narrator()
        if adapter_factory is None:
            adapter_factory = _default_adapter_factory

    out.mkdir(parents=True, exist_ok=True)
    _, scene_order = _package_scenes(package)
    staging = out / "_segments"
    adapters: dict[str, _CachedVoiceAdapter] = {}
    collected: dict[str, dict] = {}
    collected_files: dict[str, Path] = {}
    ledger: list[dict] = []
    reports: list[dict] = []

    for segment in normalized["segments"]:
        segment_id = segment["id"]
        emit({"event": "multi_speaker_segment_start", "segmentId": segment_id, "scenes": len(segment["sceneIds"])})
        segment_out = staging / segment_id
        segment_package = build_segment_package(package, segment)
        adapter = None
        if adapter_factory is not None:
            key = _canonical(segment["voice"])
            if key not in adapters:
                adapters[key] = _CachedVoiceAdapter(segment["voice"], adapter_factory)
            adapter = adapters[key]
        try:
            if adapter is None:
                report = narrate(segment_package, segment_out, padding=padding)
            else:
                report = narrate(segment_package, segment_out, tts=adapter, padding=padding)
        except MultiSpeakerError:
            raise
        except SystemExit as exc:
            raise MultiSpeakerError("MULTI_SPEAKER_RUNTIME", str(exc)) from exc
        except Exception as exc:
            raise MultiSpeakerError(
                "MULTI_SPEAKER_RUNTIME",
                f"segment {segment_id} narration failed: {exc}",
            ) from exc
        if not _is_object(report):
            raise MultiSpeakerError("MULTI_SPEAKER_RUNTIME", f"segment {segment_id} returned no report")
        if _clean(report.get("engine")) != QWEN_ENGINE or report.get("engineFallback"):
            raise MultiSpeakerError(
                "MULTI_SPEAKER_FALLBACK",
                f"segment {segment_id} did not produce actual Qwen audio",
            )
        if int(report.get("sampleRate", SAMPLE_RATE)) != SAMPLE_RATE:
            raise MultiSpeakerError("MULTI_SPEAKER_AUDIO", f"segment {segment_id} is not at {SAMPLE_RATE} Hz")
        segment_scenes = report.get("scenes") if _is_object(report.get("scenes")) else {}
        for scene_id in segment["sceneIds"]:
            entry = segment_scenes.get(scene_id)
            if not _is_object(entry) or not isinstance(entry.get("chunks"), list) or not entry["chunks"]:
                raise MultiSpeakerError(
                    "MULTI_SPEAKER_MISSING_AUDIO",
                    f"segment {segment_id} has no measured narration for scene {scene_id}",
                )
            wav = segment_out / "narration" / f"{scene_id}.wav"
            if not wav.is_file():
                raise MultiSpeakerError(
                    "MULTI_SPEAKER_MISSING_AUDIO",
                    f"segment {segment_id} wrote no WAV for scene {scene_id}",
                )
            destination = out / "narration" / f"{scene_id}.wav"
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(wav, destination)
            collected[scene_id] = dict(entry)
            collected_files[scene_id] = destination
        reports.append(report)
        seconds = round(
            sum(float(segment_scenes[scene_id].get("seconds", 0.0)) for scene_id in segment["sceneIds"]),
            4,
        )
        ledger.append({
            "id": segment_id,
            "speaker": segment["speaker"],
            "sceneIds": list(segment["sceneIds"]),
            "voice": {key: value for key, value in segment["voice"].items() if key not in _VOICE_METADATA and key != "strict"},
            "voiceHash": segment["voiceHash"],
            "segmentHash": segment["segmentHash"],
            "engine": QWEN_ENGINE,
            "seconds": seconds,
        })
        emit({"event": "multi_speaker_segment_done", "segmentId": segment_id, "seconds": seconds})

    ordered = [scene_id for scene_id in scene_order if scene_id in collected]
    raw_path = out / "narration.raw.wav"
    frames = _concat_wavs([collected_files[scene_id] for scene_id in ordered], raw_path, gap)
    total_seconds = round(frames / SAMPLE_RATE, 4)

    scene_report = {}
    for scene_id in ordered:
        entry = dict(collected[scene_id])
        entry["file"] = f"narration/{scene_id}.wav"
        scene_report[scene_id] = entry
    languages = sorted({_clean(report.get("language")) for report in reports if _clean(report.get("language"))})
    models = sorted({_clean(report.get("model")) for report in reports if _clean(report.get("model"))})
    report = {
        "version": 1,
        "engine": QWEN_ENGINE,
        "engineVersion": "multi-speaker",
        "model": models[0] if len(models) == 1 else ("multi-speaker" if models else ""),
        "models": models,
        "voices": "multi-speaker",
        "voice": ledger[0]["voice"].get("voice") if len(ledger) == 1 else "multi-speaker",
        "voiceSettings": {"multiSpeaker": True, "planSchema": PLAN_SCHEMA},
        "language": languages[0] if len(languages) == 1 else ("multi" if languages else ""),
        "languages": languages,
        "speed": 1.0,
        "sampleRate": SAMPLE_RATE,
        "gapSeconds": gap,
        "paddingSeconds": padding,
        "multiSpeaker": {
            "schema": PLAN_SCHEMA,
            "segments": ledger,
        },
        "scenes": scene_report,
        "uncoveredScenes": normalized["uncoveredScenes"],
        "warnings": normalized["warnings"],
        "totalSeconds": total_seconds,
        "file": "narration.raw.wav",
    }
    _write_json(out / "durations.json", report)
    if not keep_segments:
        shutil.rmtree(staging, ignore_errors=True)
    emit({
        "event": "multi_speaker_done",
        "segments": len(ledger),
        "scenes": len(ordered),
        "totalSeconds": total_seconds,
    })
    return report


def run_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path, help="CCL4b speaker plan (JSON)")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true", help="validate inputs only: no GPU, model or network")
    parser.add_argument("--padding", type=float, default=DEFAULT_PADDING_SECONDS)
    parser.add_argument("--gap", type=float, default=DEFAULT_GAP_SECONDS)
    parser.add_argument("--skip-non-qwen", action="store_true", help="ignore segments this worker cannot narrate")
    parser.add_argument("--keep-segments", action="store_true", help="keep the per-segment staging directory")
    args = parser.parse_args(argv)

    try:
        package = _read_json(args.package, "package")
        plan = _read_json(args.plan, "speaker plan", allow_list=True)
        report = run_multi_speaker(
            package,
            plan,
            args.out,
            dry_run=args.dry_run,
            padding=args.padding,
            gap=args.gap,
            skip_non_qwen=args.skip_non_qwen,
            keep_segments=args.keep_segments,
            on_event=lambda event: print(json.dumps(event), flush=True),
        )
    except MultiSpeakerError as exc:
        print(json.dumps({"event": "multi_speaker_error", "code": exc.code, "message": exc.detail}), file=sys.stderr, flush=True)
        return 2
    except OSError as exc:
        message = exc.strerror or "I/O error"
        print(json.dumps({"event": "multi_speaker_error", "code": "MULTI_SPEAKER_IO", "message": message}), file=sys.stderr, flush=True)
        return 2
    if args.dry_run:
        print(json.dumps({"event": "multi_speaker_plan", **{key: report[key] for key in ("segments", "uncoveredScenes", "skipped", "warnings")}}, ensure_ascii=False), flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    return run_cli(argv)


if __name__ == "__main__":
    raise SystemExit(main())
