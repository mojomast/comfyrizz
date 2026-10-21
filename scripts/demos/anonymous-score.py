"""Original scene-aware chamber score and tactile effects (CC0, no samples).

Usage: python anonymous-score.py PACKAGE_DIRECTORY [TIMELINE_JSON]
Generate after measured timing. Re-run if the edit changes.
"""
import hashlib
import json
from pathlib import Path
import sys
import wave

import numpy as np

root = Path(sys.argv[1])
timeline = json.loads(Path(sys.argv[2] if len(sys.argv) > 2 else root / "timeline.json").read_text())
package = json.loads((root / "package.json").read_text())
rate = 24000
duration = timeline["durationInFrames"] / timeline["fps"]
mix = np.zeros((int((duration + 1) * rate), 2), dtype=np.float64)
rng = np.random.default_rng(1042)
starts = {s["id"]: s["from"] / timeline["fps"] for s in timeline["scenes"]}
ends = {s["id"]: (s["from"] + s["durationInFrames"]) / timeline["fps"] for s in timeline["scenes"]}


def note(at, midi, length, gain=.15, pan=0, bell=False):
    t = np.arange(int(length * rate)) / rate
    hz = 440 * 2 ** ((midi - 69) / 12)
    tone = np.sin(2 * np.pi * hz * t)
    tone += (.2 if bell else .12) * np.sin(2 * np.pi * hz * (2.003 if bell else 2) * t)
    tone *= np.minimum(t / .008, 1) * np.exp(-t * (5 if bell else 7)) * gain
    tone *= np.clip((length - t) / .04, 0, 1)
    i = int(at * rate)
    end = min(i + len(tone), len(mix))
    mix[i:end] += tone[:end-i, None] * np.array([np.sqrt((1-pan)/2), np.sqrt((1+pan)/2)])


# Dry chamber waltz; the rejection interrupts it rather than looping through the gag.
beat = 60 / 114
bar = 0
while bar * 3 * beat < duration:
    at = bar * 3 * beat
    if starts["s_a09"] - .35 <= at < ends["s_a10"]:
        bar += 1
        continue
    root_note = [50, 57, 53, 45][(bar // 2) % 4]
    note(at, root_note - 12, .65, .27, -.18)
    for off in [1, 2]:
        for pitch in [root_note + 12, root_note + 15, root_note + 19]:
            note(at + off * beat, pitch, .36, .09, .15)
    if bar % 2 == 0:
        for j, pitch in enumerate([74, 77, 81, 76]):
            note(at + j * beat / 2, pitch, .6, .14, -.3, True)
    bar += 1

# A hard musical stop lets the rejection land; a short silence follows.
for scene in ["s_a09", "s_a10"]:
    mix[int(starts[scene] * rate):int(ends[scene] * rate)] = 0
# Optimistic approval fanfare, then a sour public-display interval.
for j, pitch in enumerate([62, 66, 69, 74]):
    note(starts["s_a13"] + j * .12, pitch, .85, .18, .2, True)
for pitch in [62, 63]:
    note(starts["s_a15"], pitch, 1.1, .12, 0, True)
fade = int(.7 * rate)
mix[:fade] *= np.linspace(0, 1, fade)[:, None]
mix[-int(1.5 * rate):] *= np.linspace(1, 0, int(1.5 * rate))[:, None]


def asset(key, samples, title):
    path = root / "assets" / f"{key}.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    if samples.ndim == 1:
        samples = np.column_stack([samples, samples])
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(np.int16(np.clip(samples, -1, 1) * 32767).tobytes())
    data = path.read_bytes()
    package["assets"][key] = {
        "kind": "audio", "origin": "upload", "status": "ready",
        "file": f"assets/{key}.wav", "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(), "redistributable": True,
        "license": {"id": "CC0-1.0"},
        "source": {"provider": "repo", "title": title, "creator": "Comfyrizz original synthesis"},
    }


asset("a_original_score", mix * (.8 / max(.01, abs(mix).max())), "Anonymous: scene-aware chamber waltz")
t = np.arange(int(.34 * rate)) / rate
stamp = .42 * rng.normal(0, 1, len(t)) * np.exp(-t * 42)
stamp += .32 * np.sin(2 * np.pi * 92 * t) * np.exp(-t * 23)
asset("a_stamp", stamp, "Original wooden stamp impact")
t = np.arange(int(.7 * rate)) / rate
paper = .1 * rng.normal(0, 1, len(t)) * np.sin(np.pi * t / .7) ** 2
paper = np.convolve(paper, [1, -.8], mode="same")
asset("a_paper", paper, "Original paper rustle")
package["audio"] = {
    "music": {"asset": "a_original_score", "gain_db": -19, "loop": False,
              "fade_in_seconds": .4, "fade_out_seconds": .8,
              "duck": {"enabled": True, "reduction_db": -7, "attack_ms": 30, "release_ms": 250}},
    "ambience": {"enabled": False},
    "sfx": [
        {"asset": "a_stamp", "scene": "s_a09", "at": "scene-start", "gain_db": -12},
        {"asset": "a_stamp", "scene": "s_a13", "at": "scene-start", "gain_db": -16},
        {"asset": "a_paper", "scene": "s_a04", "at": "scene-start", "offset_seconds": .8, "gain_db": -18},
        {"asset": "a_paper", "scene": "s_a12", "at": "scene-start", "offset_seconds": .5, "gain_db": -20},
    ],
}
(root / "package.json").write_text(json.dumps(package, indent=2) + "\n")
(root / "sound-direction.json").write_text(json.dumps({
    "durationSeconds": duration,
    "silenceForRejection": [starts["s_a09"], ends["s_a10"]],
    "approvalFanfare": starts["s_a13"], "publicDisplayDiscord": starts["s_a15"],
}, indent=2) + "\n")
print(json.dumps({"scoreSeconds": duration + 1, "soundEffects": 4, "package": str(root)}))
