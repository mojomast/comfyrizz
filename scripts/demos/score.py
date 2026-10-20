"""Original deterministic instrumental beds for the three showcase films (CC0 output).

Usage: python scripts/demos/score.py --root /external/demo/source
Writes stereo WAVs and adds their rights/provenance to each source package.
No samples, pretrained music models or external recordings are used.
"""
import argparse
import hashlib
import json
from pathlib import Path
import wave

import numpy as np

RATE = 24000


def score(style):
    bpm, beats, roots = {
        "ussy": (88, 4, [48, 53, 55, 50]),
        "hermes": (104, 4, [45, 48, 53, 52]),
        "ministry": (112, 3, [50, 57, 46, 45]),
    }[style]
    beat = 60 / bpm
    bars = 80
    duration = beat * beats * bars
    mix = np.zeros((int((duration + 2) * RATE), 2), dtype=np.float32)
    rng = np.random.default_rng({"ussy": 8721, "hermes": 412, "ministry": 77}[style])

    def note(at, midi, length, gain, pan=0, timbre="felt"):
        t = np.arange(int(length * RATE)) / RATE
        frequency = 440 * 2 ** ((midi - 69) / 12)
        if timbre == "bell":
            sound = np.sin(2 * np.pi * frequency * t) + .25 * np.sin(2 * np.pi * frequency * 2.01 * t) * np.exp(-t * 6)
            envelope = np.minimum(t / .008, 1) * np.exp(-t * 4 / length)
        elif timbre == "pad":
            sound = np.sin(2 * np.pi * frequency * t) + .15 * np.sin(2 * np.pi * frequency * 2 * t)
            envelope = np.sin(np.pi * t / length) ** 2
        else:
            sound = sum(np.sin(2 * np.pi * frequency * harmonic * t) / harmonic ** 2 for harmonic in range(1, 5))
            envelope = np.minimum(t / .012, 1) * np.exp(-t * 5 / length)
        sound *= envelope * gain * np.minimum((length - t) / .05, 1)
        start = int(at * RATE)
        end = min(start + len(sound), len(mix))
        mix[start:end, 0] += sound[:end-start] * np.sqrt((1-pan)/2)
        mix[start:end, 1] += sound[:end-start] * np.sqrt((1+pan)/2)

    for bar in range(bars):
        at = bar * beats * beat
        root = roots[(bar // 2) % 4]
        minor = style != "ussy" or (bar // 2) % 4 == 3
        chord = [root, root + (3 if minor else 4), root + 7, root + 14]
        note(at, root - 12, beat * 1.7, .15, timbre="felt")
        if style == "ministry":
            # A dry, officious chamber waltz; the last phrase resolves off-centre.
            for offset in (1, 2):
                for pitch in chord[:3]:
                    note(at + offset * beat, pitch + 12, beat * .65, .045, pan=.2, timbre="felt")
            if bar % 2 == 0:
                for i, step in enumerate([12, 16 if not minor else 15, 19, 14]):
                    note(at + i * .5 * beat, root + step, beat * .8, .07, pan=-.3, timbre="bell")
        else:
            for i, pitch in enumerate(chord):
                note(at, pitch, beat * beats, .035, pan=(i-1.5)/3, timbre="pad")
            sequence = [0, 2, 1, 3, 2, 1, 3, 2] if style == "hermes" else [0, 1, 2, 3]
            for i, index in enumerate(sequence):
                note(at + i * beats * beat / len(sequence), chord[index] + 12, beat * 1.2, .055, pan=.35 * (-1)**i, timbre="bell")
        # Soft brushed pulses, no synthetic speech or distracting loud transients.
        for offset in range(beats):
            start = int((at + (offset + .5) * beat) * RATE)
            count = int(.065 * RATE)
            noise = rng.normal(0, .012, count) * np.exp(-np.arange(count) / (RATE * .016))
            mix[start:start+count] += noise[:, None]
    mix *= .85 / max(.001, float(np.max(np.abs(mix))))
    # Complete the final note before a smooth fade; the package owns final-film fades.
    fade = int(2 * RATE)
    mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
    return np.int16(np.clip(mix, -1, 1) * 32767)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    for name in ("ussy", "hermes", "ministry"):
        directory = args.root / name
        package_path = directory / "package.json"
        package = json.loads(package_path.read_text())
        target = directory / "assets" / "original-score.wav"
        target.parent.mkdir(parents=True, exist_ok=True)
        samples = score(name)
        with wave.open(str(target), "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(RATE)
            handle.writeframes(samples.tobytes())
        data = target.read_bytes()
        package.setdefault("assets", {})["a_original_score"] = {
            "kind": "audio", "origin": "upload", "status": "ready",
            "file": "assets/original-score.wav", "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "redistributable": True,
            "license": {"id": "CC0-1.0"},
            "source": {"provider": "repo", "title": f"Original {name} instrumental score", "creator": "Comfyrizz showcase"},
        }
        package.setdefault("audio", {})["music"] = {
            "asset": "a_original_score", "gain_db": -16, "loop": True,
            "fade_in_seconds": 1.5, "fade_out_seconds": 2,
            "duck": {"enabled": True, "reduction_db": -8, "attack_ms": 80, "release_ms": 350},
        }
        package_path.write_text(json.dumps(package, indent=2) + "\n")
        print(json.dumps({"film": name, "scoreSeconds": len(samples) / RATE, "bytes": len(data)}))


if __name__ == "__main__":
    main()
