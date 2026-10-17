"""Generate a soft music-box 'Joyeux anniversaire' (Happy Birthday melody, public domain) as a WAV.
Synthesised from scratch with numpy (no samples, no third-party recordings).
usage: python music.py OUT.wav"""
import sys, wave
import numpy as np
SR = 44100; BEAT = 0.36
N = {"C4": 261.63, "D4": 293.66, "E4": 329.63, "F4": 349.23, "G4": 392.0, "A4": 440.0, "B4": 493.88, "C5": 523.25, "D5": 587.33, "E5": 659.25, "F5": 698.46, "G5": 783.99, "A5": 880.0, "B5": 987.77, "C6": 1046.5}
MEL = [("G4", .75), ("G4", .25), ("A4", 1), ("G4", 1), ("C5", 1), ("B4", 2),
       ("G4", .75), ("G4", .25), ("A4", 1), ("G4", 1), ("D5", 1), ("C5", 2),
       ("G4", .75), ("G4", .25), ("G5", 1), ("E5", 1), ("C5", 1), ("B4", 1), ("A4", 2),
       ("F5", .75), ("F5", .25), ("E5", 1), ("C5", 1), ("D5", 1), ("C5", 3)]
# soft chords on bar downbeats (3/4, after the one-beat pickup)
CH = [(1, ["C4", "E4", "G4"]), (4, ["G4", "B4", "D5"]), (7, ["G4", "B4", "D5"]), (10, ["C4", "E4", "G4"]),
      (13, ["C4", "E4", "G4"]), (16, ["F4", "A4", "C5"]), (19, ["F4", "A4", "C5"]), (22, ["C4", "E4", "G4"]), (23, ["G4", "B4", "D5"]), (24, ["C4", "E4", "G4"])]
def tone(f, dur, amp, decay):
    t = np.arange(int(SR * dur)) / SR
    env = np.exp(-t * decay) * np.minimum(1, t / 0.005)
    return amp * env * (np.sin(2 * np.pi * f * 2 * t) + 0.35 * np.sin(2 * np.pi * f * 4 * t) + 0.12 * np.sin(2 * np.pi * f * 6 * t))
total = sum(d for _, d in MEL) * BEAT + 1.6
out = np.zeros(int(SR * total))
t0 = 0.0
for n, d in MEL:
    s = tone(N[n], d * BEAT + 1.2, 0.30, 3.2); i = int(t0 * SR); out[i:i + len(s)] += s[:len(out) - i]; t0 += d * BEAT
for beat, notes in CH:
    for n in notes:
        s = tone(N[n] / 2, 3 * BEAT + 0.8, 0.07, 2.0); i = int(beat * BEAT * SR); out[i:i + len(s)] += s[:len(out) - i]
fade = int(SR * 1.5); out[-fade:] *= np.linspace(1, 0, fade)
out = out / np.max(np.abs(out)) * 0.8
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((out * 32767).astype(np.int16).tobytes())
print(sys.argv[1], round(total, 2), "s")
