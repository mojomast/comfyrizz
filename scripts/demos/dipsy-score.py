"""Original, locally synthesized adventure score; writes only to an external project."""
import hashlib
import json
import sys
import wave
from pathlib import Path

import numpy as np

root = Path(sys.argv[1]).resolve()
repo = Path(__file__).resolve().parents[2]
if root.is_relative_to(repo):
    raise SystemExit("Keep production audio outside the repository")
pkg = json.loads((root / "package.json").read_text())
timeline = json.loads((root / "timeline.json").read_text())
rate, bpm = 24000, 106
duration = timeline["durationInFrames"] / timeline["fps"]
mix = np.zeros((int((duration + 1) * rate), 2), dtype=np.float32)


def note(at, seconds, midi, gain, pan=0, bell=False):
    start = int(at * rate)
    count = min(int(seconds * rate), len(mix) - start)
    if count <= 0:
        return
    t = np.arange(count) / rate
    hz = 440 * 2 ** ((midi - 69) / 12)
    tone = np.sin(2 * np.pi * hz * t) + .23 * np.sin(2 * np.pi * hz * 2 * t)
    if bell:
        tone += .12 * np.sin(2 * np.pi * hz * 3.003 * t)
        env = np.minimum(t / .018, 1) * np.exp(-t * 3.1 / seconds)
    else:
        env = np.minimum(t / .18, 1) * np.minimum((count / rate - t) / .3, 1)
    sound = tone * env * gain
    mix[start:start + count, 0] += sound * (1 - pan * .4)
    mix[start:start + count, 1] += sound * (1 + pan * .4)


beat = 60 / bpm
chords = [[50, 57, 62, 65], [46, 53, 58, 62], [53, 60, 65, 69], [48, 55, 60, 64]]
motif = [74, 77, 81, 79, 77, 74, 72, 74]
for bar in range(int(duration / (4 * beat)) + 1):
    at = bar * 4 * beat
    tension = timeline['scenes'][11]['from'] / 30 <= at < timeline['scenes'][17]['from'] / 30
    triumphant = at >= timeline['scenes'][18]['from'] / 30
    chord = chords[bar % 4]
    if triumphant:
        chord = [50, 57, 62, 66] if bar % 2 == 0 else [55, 62, 67, 71]
    for j, midi in enumerate(chord):
        note(at, 4 * beat + .25, midi, .028 if not tension else .021, (j - 1.5) / 2)
    for step in range(8):
        note(at + step * beat / 2, beat * 1.1, chord[step % 4] + 12, .045, -.5 if step % 2 else .5, True)
    if bar % 2 == 0:
        for j in range(4):
            note(at + j * beat, beat * 1.35, motif[(bar + j) % 8] + (1 if triumphant and motif[(bar+j)%8] == 77 else 0), .04, .2, True)
    if tension:
        for j in range(4):
            note(at + j * beat, .22, 38, .06, 0, True)

# Leave the final connection suspended before the answer arrives.
scene = timeline['scenes'][16]
start = int((scene['from'] / 30 + 2) * rate)
end = int((scene['from'] + scene['durationInFrames']) / 30 * rate)
mix[start:end] *= np.linspace(.4, .06, end - start)[:, None]
mix[:rate] *= np.linspace(0, 1, rate)[:, None]
end = int(duration * rate)
mix = mix[:end]
mix[-rate * 3:] *= np.linspace(1, 0, rate * 3)[:, None]
mix *= .72 / max(.01, np.abs(mix).max())
path = root / 'assets/a_dipsy_score.wav'
with wave.open(str(path), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(np.int16(np.clip(mix, -1, 1) * 32767).tobytes())
raw = path.read_bytes()
pkg['assets']['a_dipsy_score'] = {'kind':'audio', 'origin':'upload', 'status':'ready', 'file':'assets/a_dipsy_score.wav',
    'bytes':len(raw), 'sha256':hashlib.sha256(raw).hexdigest(), 'redistributable':True, 'license':{'id':'CC0-1.0'},
    'source':{'provider':'repo', 'title':'A Thousand Little Lights — original adventure score', 'creator':'Comfyrizz original synthesis'}}
pkg['audio'] = {'music':{'asset':'a_dipsy_score','gain_db':-21,'loop':False,'fade_in_seconds':1,'fade_out_seconds':2,
    'duck':{'enabled':True,'reduction_db':-7,'attack_ms':30,'release_ms':300}},'ambience':{'enabled':False},'sfx':[]}
(root/'package.json').write_text(json.dumps(pkg,indent=2)+'\n')
(root/'sound-direction.json').write_text(json.dumps({'title':'A Thousand Little Lights','bpm':bpm,'seconds':duration,
    'direction':'Warm celesta-like motif, soft sustained harmony, low storm pulse, suspended connection and major-key homecoming'},indent=2)+'\n')
print(json.dumps({'score':str(path),'seconds':duration}))
