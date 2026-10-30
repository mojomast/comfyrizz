"""Optional local ASR adapter; install whisper/numpy/torch in a separate environment.

Accepts only an existing weights file, never a model name that could download.
ffmpeg PCM decoding avoids relying on an optional PyAV API. No expected-dialogue
prompt is supplied. The 100ms timing margin is a heuristic, not calibrated certainty.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True)
    parser.add_argument("--media", required=True)
    args = parser.parse_args()
    weights = Path(args.weights)
    if not weights.is_absolute() or not weights.is_file():
        parser.error("weights must be an existing absolute file path")

    import numpy as np
    import torch
    import whisper

    torch.set_num_threads(2)
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-i", args.media, "-map", "0:a:0",
         "-t", "60", "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1"],
        check=True, capture_output=True, timeout=30,
    ).stdout
    audio = np.frombuffer(pcm, dtype=np.float32).copy()
    model = whisper.load_model(str(weights), device="cpu")
    result = model.transcribe(audio, fp16=False, temperature=0, word_timestamps=True,
                              condition_on_previous_text=False, initial_prompt=None)
    segments = []
    for segment in result["segments"]:
        words = segment.get("words", [])
        if not words or words[-1]["end"] <= words[0]["start"]:
            continue
        segments.append({"start": words[0]["start"], "end": words[-1]["end"],
                         "text": segment["text"].strip()})
    with weights.open("rb") as source:
        model_hash = hashlib.file_digest(source, "sha256").hexdigest()
    print(json.dumps({"provider": f"openai-whisper/{whisper.__version__}/{model_hash}",
                      "uncertaintySeconds": 0.1, "segments": segments}))


if __name__ == "__main__":
    main()
