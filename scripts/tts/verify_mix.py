"""Compare the narration inside the final mix.

The mix may run longer than the narration (trailing silence, outro) and may
carry a ducked music bed. This is a missing/misaligned-narration diagnostic:
it checks the narration span only, not that the mix is narration-only.

The mix must contain the complete active narration span. Spans shorter than
five 200-ms envelopes are corroborated with a sample-level waveform
correlation instead of Pearson over too few points; a heavily masked short
span is therefore rejected conservatively rather than accepted on noise.
"""
import argparse
import json
from pathlib import Path
import subprocess

import numpy as np

SAMPLE_RATE = 16000
WINDOW = 3200  # 200 ms
MIN_OVERLAP_WINDOWS = 1
MIN_SPAN_WINDOWS = 1
MIN_ENVELOPE_WINDOWS = 5
CORRELATION_THRESHOLD = 0.85
WAVEFORM_THRESHOLD = 0.6
COVERAGE_TOLERANCE = WINDOW // 10  # 20 ms of codec/trim slack at a span edge
MAX_LAG_MS = 500
MAX_LAG = SAMPLE_RATE * MAX_LAG_MS // 1000
SPAN_FRACTION = 0.1
METHOD = (
    "200ms RMS envelope over the fully covered narration span; "
    f"lag bound {MAX_LAG_MS}ms; ducked music under the voice tolerated; "
    f"threshold {CORRELATION_THRESHOLD}; spans shorter than "
    f"{MIN_ENVELOPE_WINDOWS} windows require normalized waveform "
    f"correlation {WAVEFORM_THRESHOLD}"
)


def samples(path):
    data = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ar", str(SAMPLE_RATE),
        "-ac", "1", "-f", "f32le", "-",
    ])
    return np.frombuffer(data, dtype="<f4").astype(np.float64)


def _best_lag(actual, reference, max_lag, min_overlap=WINDOW * MIN_OVERLAP_WINDOWS):
    """Lag, in samples, that best aligns reference inside actual.

    Positive lag means the narration matches a later stretch of the mix.
    Only lags inside ``max_lag`` are eligible, and the overlap must be large
    enough to carry the active narration rather than a few samples of silence.
    """
    actual = np.asarray(actual, dtype=np.float64)
    reference = np.asarray(reference, dtype=np.float64)
    required = max(WINDOW * MIN_OVERLAP_WINDOWS, int(min_overlap))
    if len(actual) < required or len(reference) < required:
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
    energy_floor = 1e-4 * np.sqrt(actual_energy[-1] * reference_energy[-1])
    best_lag, best_score = 0, -np.inf
    limit = min(max_lag, len(centered_actual) - 1, len(centered_reference) - 1)
    for lag in range(-limit, limit + 1):
        if lag >= 0:
            length = min(len(centered_reference), len(centered_actual) - lag)
            if length < required:
                continue
            numerator = correlation[lag]
            denominator = np.sqrt(
                (actual_energy[lag + length] - actual_energy[lag])
                * (reference_energy[length] - reference_energy[0])
            )
        else:
            length = min(len(centered_actual), len(centered_reference) + lag)
            if length < required:
                continue
            numerator = correlation[lag]
            denominator = np.sqrt(
                (actual_energy[length] - actual_energy[0])
                * (reference_energy[-lag + length] - reference_energy[-lag])
            )
        score = float(numerator / denominator) if denominator > energy_floor else -np.inf
        if score > best_score:
            best_score = score
            best_lag = lag
    return int(best_lag)


def _envelope(values):
    usable = len(values) // WINDOW * WINDOW
    if usable < WINDOW * MIN_OVERLAP_WINDOWS:
        return None
    envelope = np.sqrt(np.mean(values[:usable].reshape(-1, WINDOW) ** 2, axis=1))
    # The last fraction of a window can contain a final syllable. Keep it in
    # the active span rather than silently discarding up to 199 ms of speech.
    if usable < len(values):
        envelope = np.append(envelope, np.sqrt(np.mean(values[usable:] ** 2)))
    return envelope


def _narration_span(reference_envelope):
    peak = float(np.max(reference_envelope))
    if peak < 1e-8:
        return None
    active = np.flatnonzero(reference_envelope >= max(peak * SPAN_FRACTION, 1e-4))
    if len(active) == 0:
        return None
    start, end = int(active[0]), int(active[-1]) + 1
    if end - start < MIN_SPAN_WINDOWS:
        return None
    return start, end


def _correlation(actual, reference):
    if len(actual) == 0 or len(reference) == 0:
        return 0.0
    if np.std(actual) == 0 or np.std(reference) == 0:
        return 0.0
    value = float(np.corrcoef(actual, reference)[0, 1])
    return value if np.isfinite(value) else 0.0


def _waveform_correlation(actual, reference):
    """Sample-level normalized correlation for spans too short for an envelope."""
    if len(actual) < WINDOW or len(actual) != len(reference):
        return 0.0
    centered_actual = actual - actual.mean()
    centered_reference = reference - reference.mean()
    denominator = np.sqrt(
        np.dot(centered_actual, centered_actual)
        * np.dot(centered_reference, centered_reference)
    )
    if denominator <= 0:
        return 0.0
    value = float(np.dot(centered_actual, centered_reference) / denominator)
    return value if np.isfinite(value) else 0.0


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
    if len(reference) < WINDOW or len(actual) < WINDOW:
        return {**base, "passed": False, "reason": "Not enough audio for envelope comparison"}
    reference_envelope = _envelope(reference)
    if reference_envelope is None:
        return {**base, "passed": False, "reason": "Not enough audio for envelope comparison"}
    span = _narration_span(reference_envelope)
    if span is None:
        return {**base, "passed": False, "reason": "Narration span is missing or too short"}
    start, end = span
    span_start = start * WINDOW
    span_end = min(end * WINDOW, len(reference))
    lag = _best_lag(actual, reference, MAX_LAG, span_end - span_start)
    lag_ms = round(lag / (SAMPLE_RATE / 1000), 2)
    mix_start = span_start + lag
    mix_end = span_end + lag
    span_windows = int(end - start)
    span_report = {
        "lagMs": lag_ms,
        "narrationSpanMs": round((span_end - span_start) / (SAMPLE_RATE / 1000), 2),
        "windows": span_windows,
    }
    # The reference envelope is computed before alignment; require the mix to
    # contain that whole active span. This stops a prefix or a late start from
    # passing simply because the reference was truncated to the mix length.
    if mix_start < -COVERAGE_TOLERANCE or mix_end > len(actual) + COVERAGE_TOLERANCE:
        return {
            **base,
            **span_report,
            "passed": False,
            "reason": "Narration span is not fully present in the mix",
        }
    # Clamp only the small codec/trim slack allowed above; the compared windows
    # still come from the same active narration span, not from a truncated ref.
    clamped_start = max(0, mix_start)
    clamped_end = min(len(actual), mix_end)
    narration_start = clamped_start - lag
    narration_end = clamped_end - lag
    if clamped_end <= clamped_start or narration_start < 0 or narration_end > len(reference):
        return {
            **base,
            **span_report,
            "passed": False,
            "reason": "Not enough audio for envelope comparison",
        }
    mix_span = actual[clamped_start:clamped_end]
    narration_span = reference[narration_start:narration_end]
    mix_envelope = _envelope(mix_span)
    narration_envelope = _envelope(narration_span)
    if mix_envelope is None or narration_envelope is None or len(mix_envelope) != len(narration_envelope):
        return {
            **base,
            **span_report,
            "passed": False,
            "reason": "Not enough audio for envelope comparison",
        }
    windows = int(len(narration_envelope))
    correlation = _correlation(mix_envelope, narration_envelope)
    finite = bool(np.isfinite(correlation))
    result = {
        "durationDifferenceMs": duration_difference_ms,
        "envelopeCorrelation": correlation if finite else None,
        "lagMs": lag_ms,
        "narrationSpanMs": round(len(narration_span) / (SAMPLE_RATE / 1000), 2),
        "windows": windows,
        "method": METHOD,
    }
    if windows < MIN_ENVELOPE_WINDOWS:
        # Pearson over fewer than five points is not a meaningful gate: two
        # unequal points always produce +/-1. Corroborate with the raw waveform
        # instead, which is strict enough for a short but normal narration take.
        waveform = _waveform_correlation(mix_span, narration_span)
        waveform_finite = bool(np.isfinite(waveform))
        passed = bool(waveform_finite and abs(waveform) >= WAVEFORM_THRESHOLD)
        return {
            **result,
            "passed": passed,
            "envelopeCorrelation": None,
            "waveformCorrelation": waveform if waveform_finite else None,
            **({} if passed else {"reason": "Short narration span does not match the mix waveform"}),
        }
    passed = bool(finite and correlation > CORRELATION_THRESHOLD)
    return {
        **result,
        "passed": passed,
        **({} if passed else {"reason": "Narration envelope does not match the mix"}),
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
