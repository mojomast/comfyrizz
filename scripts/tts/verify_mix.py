"""Compare final audio with the exact narration using 200-ms RMS envelopes.

This is a missing/misaligned-narration diagnostic, not a perceptual audio rating.
"""
import argparse
import json
from pathlib import Path
import subprocess

import numpy as np


def samples(path):
    data = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ar", "16000",
        "-ac", "1", "-f", "f32le", "-",
    ])
    return np.frombuffer(data, dtype="<f4").astype(np.float64)


def compare(actual, reference):
    length = min(len(actual), len(reference)) // 3200 * 3200
    if length < 6400:
        return {"passed": False, "reason": "Not enough audio for envelope comparison"}
    rms = lambda values: np.sqrt(np.mean(values[:length].reshape(-1, 3200) ** 2, axis=1))
    a, b = rms(actual), rms(reference)
    correlation = float(np.corrcoef(a, b)[0, 1]) if np.std(a) > 0 and np.std(b) > 0 else 0.0
    finite = np.isfinite(correlation)
    return {
        "passed": bool(finite and correlation > 0.85 and abs(len(actual) - len(reference)) < 1600),
        "envelopeCorrelation": correlation if finite else None,
        "durationDifferenceMs": round((len(actual) - len(reference)) / 16, 2),
        "windows": len(a),
        "method": "200ms RMS envelope against original narration; threshold 0.85",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--narration", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = compare(samples(args.video), samples(args.narration))
    args.out.write_text(json.dumps(report, indent=2))
    print(json.dumps({"event": "mix_verified", **report}), flush=True)
    raise SystemExit(0 if report["passed"] else 2)
