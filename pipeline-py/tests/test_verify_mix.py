"""Narration-span mix check.

Good videos keep their narration when the mix is longer than the voice (trailing
silence, outro) or a ducked music bed sits underneath it. A missing narration
and a different recording still fail. No GPU and no network.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

from conftest import REPO_ROOT

SAMPLE_RATE = 16000
SCRIPT = REPO_ROOT / "scripts" / "tts" / "verify_mix.py"


def load_verify_mix():
    spec = importlib.util.spec_from_file_location("verify_mix", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


verify_mix = load_verify_mix()


def speech(seconds=3.0, seed=1, rate=0.34, burst=0.16, amplitude=0.45, lead=0.12):
    """Amplitude-modulated noise with a speech-like on/off envelope."""
    rng = np.random.default_rng(seed)
    count = int(SAMPLE_RATE * seconds)
    time = np.arange(count) / SAMPLE_RATE
    envelope = np.zeros(count)
    start = lead
    while start + burst < seconds - 0.05:
        window = (time >= start) & (time < start + burst)
        envelope[window] = np.hanning(int(window.sum()))
        start += rate
    return rng.normal(0, 1, count) * envelope * amplitude


def music(count, amplitude, seed=3):
    rng = np.random.default_rng(seed)
    time = np.arange(count) / SAMPLE_RATE
    tone = (
        0.5 * np.sin(2 * np.pi * 174.61 * time)
        + 0.35 * np.sin(2 * np.pi * 220.00 * time)
        + 0.25 * np.sin(2 * np.pi * 261.63 * time)
    )
    tremolo = 0.65 + 0.35 * np.sin(2 * np.pi * 0.7 * time)
    return (tone * tremolo + rng.normal(0, 0.12, count)) * amplitude


def whole_file_correlation(actual, reference):
    window = verify_mix.WINDOW
    length = min(len(actual), len(reference)) // window * window
    def envelope(values):
        return np.sqrt(np.mean(values[:length].reshape(-1, window) ** 2, axis=1))
    mix, narration = envelope(actual), envelope(reference)
    if np.std(mix) == 0 or np.std(narration) == 0:
        return 0.0
    return float(np.corrcoef(mix, narration)[0, 1])


def test_identical_narration_passes():
    voice = speech()
    report = verify_mix.compare(voice, voice)
    assert report["passed"] is True
    assert report["envelopeCorrelation"] > 0.98
    assert report["lagMs"] == 0
    assert report["durationDifferenceMs"] == 0


def test_trailing_silence_stays_within_the_narration_span():
    voice = speech()
    mix = np.concatenate([voice, np.zeros(SAMPLE_RATE)])
    report = verify_mix.compare(mix, voice)
    assert report["passed"] is True
    assert report["envelopeCorrelation"] > 0.98
    assert report["durationDifferenceMs"] == 1000
    assert report["lagMs"] == 0


def test_ducked_music_bed_under_the_voice_passes():
    voice = np.concatenate([speech(seconds=2.2, seed=1), np.zeros(SAMPLE_RATE * 4)])
    shift = int(0.08 * SAMPLE_RATE)
    placed = np.concatenate([np.zeros(shift), voice])
    bed = music(len(placed), amplitude=10 ** (-8 / 20))
    voice_envelope = np.convolve(np.abs(placed), np.ones(800) / 800, mode="same")
    peak = float(voice_envelope.max())
    duck = np.where(voice_envelope > peak * 0.05, 10 ** (-12 / 20), 1.0)
    mix = placed + bed * duck
    report = verify_mix.compare(mix, voice)
    # The bed fills the narration's silence and the voice is slightly late, so a
    # whole-file compare from sample zero falls through the old 0.85 gate.
    assert whole_file_correlation(mix, voice) < 0.85
    assert report["passed"] is True
    assert report["envelopeCorrelation"] > 0.85
    assert abs(report["lagMs"] - 80) <= 20


def test_outro_after_the_narration_passes():
    voice = speech(seconds=3.0, seed=5)
    reference = np.concatenate([voice, np.zeros(SAMPLE_RATE * 2)])
    outro = music(SAMPLE_RATE * 2, amplitude=0.4, seed=8)
    mix = np.concatenate([voice, outro])
    report = verify_mix.compare(mix, reference)
    assert whole_file_correlation(mix, reference) < 0.85
    assert report["passed"] is True
    assert report["envelopeCorrelation"] > 0.95
    assert report["windows"] < len(reference) // verify_mix.WINDOW


def test_missing_narration_fails():
    voice = speech()
    mix = music(len(voice), amplitude=0.2, seed=11)
    report = verify_mix.compare(mix, voice)
    assert report["passed"] is False
    if report["envelopeCorrelation"] is None:
        assert report["reason"] == "Narration span is not fully present in the mix"
    else:
        assert report["envelopeCorrelation"] < 0.85


def test_wrong_narration_fails():
    voice = speech(seed=1, rate=0.34, burst=0.16)
    other = speech(seed=2, rate=0.51, burst=0.08, lead=0.05)
    count = min(len(voice), len(other))
    report = verify_mix.compare(other[:count], voice[:count])
    assert report["passed"] is False
    if report["envelopeCorrelation"] is None:
        assert report["reason"] == "Narration span is not fully present in the mix"
    else:
        assert report["envelopeCorrelation"] < 0.85


def test_shorter_trailing_silence_still_passes():
    voice = speech()
    reference = np.concatenate([voice, np.zeros(SAMPLE_RATE)])
    mix = np.concatenate([voice, np.zeros(SAMPLE_RATE // 4)])
    report = verify_mix.compare(mix, reference)
    assert report["passed"] is True
    assert report["durationDifferenceMs"] < 0


def test_dropping_leading_silence_still_passes():
    voice = speech()
    reference = np.concatenate([np.zeros(SAMPLE_RATE // 2), voice])
    report = verify_mix.compare(voice, reference)
    assert report["passed"] is True
    assert abs(report["lagMs"] + 500) <= 20


def test_truncated_prefix_fails():
    voice = speech()
    report = verify_mix.compare(voice[:SAMPLE_RATE], voice)
    assert report["passed"] is False
    assert "not fully present" in report["reason"]
    assert report["durationDifferenceMs"] < 0


def test_late_start_fails():
    voice = speech()
    report = verify_mix.compare(voice[4000:], voice)
    assert report["passed"] is False
    assert "not fully present" in report["reason"]


def test_final_partial_window_is_not_dropped_from_coverage():
    tail = np.random.default_rng(9).normal(0, 0.2, SAMPLE_RATE // 10)
    voice = np.concatenate([speech(), tail])
    assert verify_mix.compare(voice, voice)["passed"] is True
    report = verify_mix.compare(voice[:-len(tail)], voice)
    assert report["passed"] is False
    assert "not fully present" in report["reason"]


def test_silent_mix_fails():
    voice = speech()
    report = verify_mix.compare(np.zeros(len(voice)), voice)
    assert report["passed"] is False
    assert report["envelopeCorrelation"] == 0.0


def test_short_narration_uses_waveform_corroboration():
    voice = speech(seconds=0.5, seed=4)
    report = verify_mix.compare(voice, voice)
    assert report["windows"] < verify_mix.MIN_ENVELOPE_WINDOWS
    assert report["envelopeCorrelation"] is None
    assert report["passed"] is True
    assert report["waveformCorrelation"] > 0.99


def test_short_narration_tolerates_a_small_lag():
    voice = speech(seconds=0.5, seed=4)
    shift = int(0.1 * SAMPLE_RATE)
    mix = np.concatenate([np.zeros(shift), voice])
    report = verify_mix.compare(mix, voice)
    assert report["windows"] < verify_mix.MIN_ENVELOPE_WINDOWS
    assert report["passed"] is True
    assert abs(report["lagMs"] - 100) <= 20


def test_short_wrong_narration_fails(monkeypatch):
    voice = speech(seconds=0.5, seed=4)
    other = speech(seconds=0.5, seed=9, rate=0.57, burst=0.07, lead=0.05)
    monkeypatch.setattr(verify_mix, "_best_lag", lambda *args: 0)
    report = verify_mix.compare(other, voice)
    assert report["windows"] < verify_mix.MIN_ENVELOPE_WINDOWS
    assert report["passed"] is False
    assert "waveform" in report["reason"]


def write_wav(path: Path, samples: np.ndarray):
    clipped = np.clip(samples, -1, 1)
    frames = (clipped * 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(frames.tobytes())


def run_script(video: Path, narration: Path, out: Path):
    completed = subprocess.run(
        [sys.executable, str(SCRIPT), "--video", str(video), "--narration", str(narration), "--out", str(out)],
        check=False,
        capture_output=True,
        text=True,
    )
    return completed


def test_cli_writes_a_verdict_for_pass_and_failure(tmp_path: Path):
    voice = speech()
    narration = tmp_path / "narration.wav"
    same = tmp_path / "same.wav"
    trailing = tmp_path / "trailing.wav"
    wrong = tmp_path / "wrong.wav"
    write_wav(narration, voice)
    write_wav(same, voice)
    write_wav(trailing, np.concatenate([voice, np.zeros(SAMPLE_RATE)]))
    write_wav(wrong, speech(seed=9, rate=0.57, burst=0.07))

    passed_out = tmp_path / "nested" / "passed.json"
    passed = run_script(same, narration, passed_out)
    assert passed.returncode == 0, passed.stderr
    assert json.loads(passed_out.read_text())["passed"] is True

    silence_out = tmp_path / "silence.json"
    silence = run_script(trailing, narration, silence_out)
    assert silence.returncode == 0, silence.stderr
    silence_report = json.loads(silence_out.read_text())
    assert silence_report["passed"] is True
    assert silence_report["durationDifferenceMs"] >= 900

    failed_out = tmp_path / "failed.json"
    failed = run_script(wrong, narration, failed_out)
    assert failed.returncode == 2, failed.stderr
    assert json.loads(failed_out.read_text())["passed"] is False
