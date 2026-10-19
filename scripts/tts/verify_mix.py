"""Compare the narration inside the final mix.

The mix may run longer than the narration (trailing silence, outro) and may
carry a ducked music bed. This is a missing/misaligned-narration diagnostic:
it checks the narration span only, not that the mix is narration-only.
"""
import argparse
import json
from pathlib import Path
import subprocess

import numpy as np

SAMPLE_RATE = 16000
WINDOW = 3200  # 200 ms
MIN_WINDOWS = 2
CORRELATION_THRESHOLD = 0.85
MAX_LAG_MS = 500
MAX_LAG = SAMPLE_RATE * MAX_LAG_MS // 1000
SPAN_FRACTION = 0.1
METHOD = (
    "200ms RMS envelope over the cross-correlated narration span; "
    f"lag bound {MAX_LAG_MS}ms; ducked music under the voice tolerated; "
    f"threshold {CORRELATION_THRESHOLD}"
)


def samples(path):
    data = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ar", str(SAMPLE_RATE),
        "-ac", "1", "-f", "f32le", "-",
    ])
    return np.frombuffer(data, dtype="<f4").astype(np.float64)


def _best_lag(actual, reference, max_lag):
    """Lag, in samples, that best aligns reference inside actual.

    Positive lag means the narration matches a later stretch of the mix.
    Only lags inside ``max_lag`` are eligible.
    """
    actual = np.asarray(actual, dtype=np.float64)
    reference = np.asarray(reference, dtype=np.float64)
    if len(actual) < WINDOW * MIN_WINDOWS or len(reference) < WINDOW * MIN_WINDOWS:
        return 0
    centered_actual = actual - actual.mean()
    centered_reference = reference - reference.mean()
    if np.allclose(centered_actual, 0) or np.allclose(centered_reference, 0):
        return 0
    size = 1
    while size < len(centered_actual) + len(centered_reference):
        size *= 2
    correlation = np.fft.irfft(
        np.fft.rfft(centered_actual, size) * np.conj(np.fft.rfft(centered_reference, size)),
        size,
    )
    actual_energy = np.empty(len(centered_actual) + 1, dtype=np.float64)
    actual_energy[0] = 0.0
    np.cumsum(centered_actual * centered_actual, out=actual_energy[1:])
    reference_energy = np.empty(len(centered_reference) + 1, dtype=np.float64)
    reference_energy[0] = 0.0
    np.cumsum(centered_reference * centered_reference, out=reference_energy[1:])
    best_lag, best_score = 0, -np.inf
    limit = min(max_lag, len(centered_actual) - 1, len(centered_reference) - 1)
    for lag in range(-limit, limit + 1):
        if lag >= 0:
            length = min(len(centered_reference), len(centered_actual) - lag)
            if length < WINDOW * MIN_WINDOWS:
                continue
            numerator = correlation[lag]
            denominator = np.sqrt(
                (actual_energy[lag + length] - actual_energy[lag])
                * (reference_energy[length] - reference_energy[0])
            )
        else:
            length = min(len(centered_actual), len(centered_reference) + lag)
            if length < WINDOW * MIN_WINDOWS:
                continue
            numerator = correlation[lag]
            denominator = np.sqrt(
                (actual_energy[length] - actual_energy[0])
                * (reference_energy[-lag + length] - reference_energy[-lag])
            )
        score = float(numerator / denominator) if denominator > 0 else -np.inf
        if score > best_score:
            best_score = score
            best_lag = lag
    return int(best_lag)


def _aligned(actual, reference, lag):
    if lag >= 0:
        length = min(len(reference), max(0, len(actual) - lag))
        return actual[lag:lag + length], reference[:length]
    length = min(len(actual), max(0, len(reference) + lag))
    return actual[:length], reference[-lag:-lag + length]


def _envelope(values):
    usable = len(values) // WINDOW * WINDOW
    if usable < WINDOW * MIN_WINDOWS:
        return None
    return np.sqrt(np.mean(values[:usable].reshape(-1, WINDOW) ** 2, axis=1))


def _narration_span(reference_envelope):
    peak = float(np.max(reference_envelope))
    if peak < 1e-8:
        return None
    active = np.flatnonzero(reference_envelope >= max(peak * SPAN_FRACTION, 1e-4))
    if len(active) == 0:
        return None
    start, end = int(active[0]), int(active[-1]) + 1
    if end - start < MIN_WINDOWS:
        return None
    return start, end


def compare(actual, reference):
    actual = np.asarray(actual, dtype=np.float64)
    reference = np.asarray(reference, dtype=np.float64)
    duration_difference_ms = round((len(actual) - len(reference)) / (SAMPLE_RATE / 1000), 2)
    base = {
        "durationDifferenceMs": duration_difference_ms,
        "lagMs": 0.0,
        "windows": 0,
        "envelopeCorrelation": None,
        "method": METHOD,
    }
    if len(reference) < WINDOW * MIN_WINDOWS or len(actual) < WINDOW * MIN_WINDOWS:
        return {**base, "passed": False, "reason": "Not enough audio for envelope comparison"}
    lag = _best_lag(actual, reference, MAX_LAG)
    aligned_actual, aligned_reference = _aligned(actual, reference, lag)
    actual_envelope = _envelope(aligned_actual)
    reference_envelope = _envelope(aligned_reference)
    if actual_envelope is None or reference_envelope is None:
        return {**base, "passed": False, "lagMs": round(lag / (SAMPLE_RATE / 1000), 2), "reason": "Not enough audio for envelope comparison"}
    span = _narration_span(reference_envelope)
    if span is None:
        return {
            **base,
            "passed": False,
            "lagMs": round(lag / (SAMPLE_RATE / 1000), 2),
            "reason": "Narration span is missing or too short",
        }
    start, end = span
    mix_span = actual_envelope[start:end]
    narration_span = reference_envelope[start:end]
    correlation = (
        float(np.corrcoef(mix_span, narration_span)[0, 1])
        if np.std(mix_span) > 0 and np.std(narration_span) > 0
        else 0.0
    )
    finite = bool(np.isfinite(correlation))
    return {
        "passed": bool(finite and correlation > CORRELATION_THRESHOLD),
        "envelopeCorrelation": correlation if finite else None,
        "durationDifferenceMs": duration_difference_ms,
        "lagMs": round(lag / (SAMPLE_RATE / 1000), 2),
        "narrationSpanMs": round((end - start) * WINDOW / (SAMPLE_RATE / 1000), 2),
        "windows": int(end - start),
        "method": METHOD,
        **({} if finite and correlation > CORRELATION_THRESHOLD else {"reason": "Narration envelope does not match the mix"}),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--narration", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = compare(samples(args.video), samples(args.narration))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))
    print(json.dumps({"event": "mix_verified", **report}), flush=True)
    raise SystemExit(0 if report["passed"] else 2)
