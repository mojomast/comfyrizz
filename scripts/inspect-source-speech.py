"""Optional local ASR adapter; install whisper/numpy/torch in a separate environment.

Accepts only an existing weights file, never a model name that could download.
ffmpeg PCM decoding avoids relying on an optional PyAV API. No expected-dialogue
prompt is supplied. The 100ms timing margin is a heuristic, not calibrated certainty.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess

MAX_SECONDS = 120
SAMPLE_RATE = 16000


def offline_cpu():
    # Also enforce these when invoked directly rather than through the server.
    os.environ.update(CUDA_VISIBLE_DEVICES="", HF_HUB_OFFLINE="1",
                      TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1",
                      HF_HUB_DISABLE_TELEMETRY="1", OMP_NUM_THREADS="2",
                      MKL_NUM_THREADS="2", OPENBLAS_NUM_THREADS="2", NUMEXPR_NUM_THREADS="2")


def decode_media(media, expected_duration):
    """Probe before decoding; a bounded sentinel detects inconsistent long audio.

    Decode the entire <=120s presentation, retaining decoded-duration diagnostics.
    Samples beyond the probed presentation end are codec padding, not more film.
    A shorter audio track is incomplete evidence, never a speech-presence pass.
    """
    if not math.isfinite(expected_duration) or not 0 < expected_duration <= MAX_SECONDS:
        raise ValueError("observed duration must be greater than zero and at most 120 seconds")
    path = Path(media)
    if not path.is_absolute() or not path.is_file():
        raise ValueError("media must be an existing absolute local file")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration,start_time:stream=codec_type,duration,start_time,sample_rate",
         "-of", "json", str(path)], check=True, capture_output=True, timeout=15,
    )
    metadata = json.loads(probe.stdout)
    duration = float(metadata["format"]["duration"])
    if not math.isfinite(duration) or not 0 < duration <= MAX_SECONDS:
        raise ValueError("actual media duration exceeds the 120-second bound or is invalid")
    if abs(duration - expected_duration) > 0.1:
        raise ValueError("actual media duration differs from the observed duration")
    audio_streams = [stream for stream in metadata.get("streams", []) if stream.get("codec_type") == "audio"]
    if not audio_streams:
        raise ValueError("media has no audio stream")
    # Decoding to a bare PCM array loses stream PTS. Until offset mapping is
    # supported, require a zero-origin container and audio/video streams.
    # Use the stricter of one native audio sample and one analysis sample.
    native_sample_rate = float(audio_streams[0].get("sample_rate", "nan"))
    if not math.isfinite(native_sample_rate) or native_sample_rate <= 0:
        raise ValueError("audio sample rate is unavailable; cannot validate timestamp origin")
    offset_tolerance = 1 / max(native_sample_rate, SAMPLE_RATE)
    origins = [("format", metadata["format"])] + [
        (stream["codec_type"], stream) for stream in metadata.get("streams", [])
        if stream.get("codec_type") in ("audio", "video")
    ]
    for kind, entry in origins:
        try:
            start = float(entry.get("start_time", "nan"))
        except (TypeError, ValueError):
            start = float("nan")
        if not math.isfinite(start) or abs(start) > offset_tolerance:
            raise ValueError(f"unsupported {kind} start_time: requires zero origin within one audio sample")
    audio_duration = audio_streams[0].get("duration")
    if audio_duration is not None and audio_duration != "N/A":
        audio_duration = float(audio_duration)
        if not math.isfinite(audio_duration) or not 0 < audio_duration <= MAX_SECONDS:
            raise ValueError("actual audio duration exceeds the 120-second bound or is invalid")
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-map", "0:a:0",
         "-t", str(MAX_SECONDS + 1), "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "f32le", "pipe:1"],
        check=True, capture_output=True, timeout=30,
    ).stdout
    if len(pcm) % 4:
        raise ValueError("decoded PCM is truncated")
    decoded_seconds = len(pcm) / (4 * SAMPLE_RATE)
    # AAC may decode a final partial packet beyond the declared presentation end.
    # More than 100ms is not accepted as codec padding.
    if decoded_seconds > duration + 0.1:
        raise ValueError("decoded audio exceeds the probed presentation duration")
    if decoded_seconds < duration - 1 / SAMPLE_RATE:
        raise ValueError("decoded audio does not cover the complete media duration")
    samples = min(len(pcm) // 4, math.ceil(duration * SAMPLE_RATE))
    return pcm[:samples * 4], {
        "startSeconds": 0, "endSeconds": duration, "complete": True,
        "requestedDurationSeconds": expected_duration,
        "decodedDurationSeconds": decoded_seconds, "sampleRate": SAMPLE_RATE,
        "inspectedSamples": samples, "paddingSeconds": max(0, decoded_seconds - duration),
        "timestampOrigin": "zero-origin-media", "offsetToleranceSeconds": offset_tolerance,
    }


def observed_segments(segments):
    """Preserve word diagnostics without interpreting probabilities as certainty."""
    observed = []
    for segment in segments:
        words = segment.get("words", [])
        if not words or words[-1]["end"] <= words[0]["start"]:
            continue
        observed.append({"start": words[0]["start"], "end": words[-1]["end"],
                         "text": segment["text"].strip(), "words": words,
                         **{key: segment[key] for key in ("avg_logprob", "no_speech_prob", "compression_ratio") if key in segment}})
    return observed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True)
    parser.add_argument("--media", required=True)
    parser.add_argument("--duration-seconds", required=True, type=float)
    args = parser.parse_args()
    weights = Path(args.weights)
    if not weights.is_absolute() or not weights.is_file():
        parser.error("weights must be an existing absolute file path")

    offline_cpu()
    pcm, coverage = decode_media(args.media, args.duration_seconds)
    import numpy as np
    import torch
    import whisper

    torch.set_num_threads(2)
    torch.set_num_interop_threads(2)
    audio = np.frombuffer(pcm, dtype=np.float32).copy()
    model = whisper.load_model(str(weights), device="cpu")
    result = model.transcribe(audio, fp16=False, temperature=0, word_timestamps=True,
                              condition_on_previous_text=False, initial_prompt=None)
    segments = observed_segments(result["segments"])
    with weights.open("rb") as source:
        model_hash = hashlib.file_digest(source, "sha256").hexdigest()
    print(json.dumps({"provider": f"openai-whisper/{str(whisper.__version__)[:32]}/{model_hash}",
                      "uncertaintySeconds": 0.1, "segments": segments, "coverage": coverage,
                      "analyzer": {"vadFilter": False, "conditionOnPreviousText": False,
                                   "wordTimestamps": True, "downmix": "mono", "timestampCoordinates": "original_media"},
                      "analyzerSettings": {"device": "cpu", "cpuThreads": 2, "wordTimestamps": True,
                                           "conditionOnPreviousText": False, "initialPrompt": None,
                                           "timestampMapping": "zero-origin-decoded-audio"}}, allow_nan=False))


if __name__ == "__main__":
    main()
