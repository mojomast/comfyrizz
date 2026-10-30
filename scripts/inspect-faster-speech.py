"""Opt-in faster-whisper CPU adapter using only a complete existing local model."""
import argparse
from dataclasses import asdict
import hashlib
import importlib.util
import json
import math
from pathlib import Path

# The existing script filename contains hyphens, so load its shared helpers by
# an explicit sibling path rather than adding a second installable module.
spec = importlib.util.spec_from_file_location("comfyrizz_source_speech", Path(__file__).with_name("inspect-source-speech.py"))
source_speech = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source_speech)
decode_media = source_speech.decode_media
observed_segments = source_speech.observed_segments
offline_cpu = source_speech.offline_cpu


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--media", required=True)
    parser.add_argument("--duration-seconds", required=True, type=float)
    parser.add_argument("--vad-filter", choices=("true", "false"), default="false")
    args = parser.parse_args()
    vad_filter = args.vad_filter == "true"
    model_dir = Path(args.model_dir)
    if not model_dir.is_absolute() or not model_dir.is_dir():
        parser.error("model-dir must be an existing absolute local directory")
    # tokenizer.json is essential: without it the library has a Hub fallback
    # even when model loading uses local_files_only=True.
    required = ["config.json", "model.bin", "tokenizer.json"]
    if any(not (model_dir / name).is_file() for name in required):
        parser.error("local model requires config.json, model.bin and tokenizer.json; no downloads")
    offline_cpu()
    pcm, coverage = decode_media(args.media, args.duration_seconds)

    import numpy as np
    import faster_whisper

    digest = hashlib.sha256()
    for name in sorted(required + (["preprocessor_config.json"] if (model_dir / "preprocessor_config.json").is_file() else [])):
        with (model_dir / name).open("rb") as source:
            digest.update(name.encode() + b"\0" + hashlib.file_digest(source, "sha256").digest())
    model = faster_whisper.WhisperModel(str(model_dir), device="cpu", compute_type="int8",
                                       cpu_threads=2, num_workers=1, local_files_only=True)
    audio = np.frombuffer(pcm, dtype=np.float32).copy()
    segments, info = model.transcribe(audio, temperature=0, word_timestamps=True,
                                  condition_on_previous_text=False, initial_prompt=None,
                                  vad_filter=vad_filter, task="transcribe")
    # WhisperModel.transcribe wraps its generator in restore_speech_timestamps
    # when VAD retains speech chunks. Its words/segments already use ORIGINAL
    # audio time, not concatenated VAD time. Do not restore a second time.
    # No fallback/retry: alignment failures remain failed evidence in this mode.
    # Iteration executes inference; consume it before returning coverage/evidence.
    observed = observed_segments([
        {"text": segment.text,
         "words": [{"start": word.start, "end": word.end, "word": word.word,
                    "probability": word.probability} for word in (segment.words or [])],
         "avg_logprob": segment.avg_logprob, "no_speech_prob": segment.no_speech_prob,
         "compression_ratio": segment.compression_ratio}
        for segment in segments
    ])
    print(json.dumps({"provider": f"faster-whisper/{str(faster_whisper.__version__)[:32]}/{digest.hexdigest()}",
                      "uncertaintySeconds": 0.1, "segments": observed, "coverage": coverage,
                      "analyzer": {"vadFilter": vad_filter, "conditionOnPreviousText": False,
                                   "wordTimestamps": True, "downmix": "mono", "timestampCoordinates": "original_media"},
                      "analyzerSettings": {
                          "device": "cpu", "computeType": "int8", "cpuThreads": 2, "numWorkers": 1,
                          "wordTimestamps": True, "conditionOnPreviousText": False, "initialPrompt": None,
                          "temperature": 0, "task": "transcribe", "vadFilter": vad_filter,
                          # The library's default maximum speech duration is
                          # positive infinity. Encode that SETTINGS sentinel
                          # explicitly; nonfinite observations still fail JSON.
                          "vadParameters": {key: "unbounded" if value == math.inf else value
                                            for key, value in asdict(info.vad_options).items()} if vad_filter else None,
                          "durationAfterVadSeconds": info.duration_after_vad,
                          "timestampMapping": "faster-whisper.restore_speech_timestamps" if vad_filter else "zero-origin-decoded-audio",
                      }}, allow_nan=False))


if __name__ == "__main__":
    main()
