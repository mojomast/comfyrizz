"""Five original scene-aware scores, synthesized without external samples.

Usage: .venv/bin/python longform-score.py PACKAGE_PARENT [forest,clockwork,...]
Each film gets its own instrumentation, meter, motifs, transition cues and mix.
"""
import hashlib
import json
from pathlib import Path
import sys
import wave

import numpy as np

root = Path(sys.argv[1])
selected = sys.argv[2].split(',') if len(sys.argv) > 2 else ['forest', 'clockwork', 'coolcity', 'ferment', 'abyss']
rate = 24000
styles = {
    'forest': (72, 5, [50, 57, 53, 60], 'glass', 'Understory — irregular glass and breath'),
    'clockwork': (108, 3, [45, 52, 48, 47], 'musicbox', 'The Independent Watch — mechanical nocturne'),
    'coolcity': (104, 4, [53, 58, 55, 60], 'keys', 'Shade Route — bright electric-key miniature'),
    'ferment': (78, 3, [48, 53, 55, 50], 'plucked', 'The Waiting Bowl — warm plucked strings'),
    'abyss': (48, 4, [38, 45, 41, 36], 'sub', 'Beyond the Beam — deep ambient soundscape'),
}

for key in selected:
    path = root / f'long_{key}20261020'
    pkg = json.loads((path / 'package.json').read_text())
    timeline = json.loads((path / 'timeline.json').read_text())
    duration = timeline['durationInFrames'] / timeline['fps']
    bpm, meter, roots, timbre, title = styles[key]
    beat = 60 / bpm
    mix = np.zeros((int((duration + .5) * rate), 2), dtype=np.float32)
    rng = np.random.default_rng(20261020 + list(styles).index(key))

    def add(at, samples, pan=0):
        start = int(max(0, at) * rate)
        count = min(len(samples), len(mix) - start)
        if count > 0:
            mix[start:start+count] += samples[:count, None] * np.array([np.sqrt((1-pan)/2), np.sqrt((1+pan)/2)])

    def note(at, midi, length, gain=.12, pan=0, sound=None):
        sound = sound or timbre
        t = np.arange(int(length * rate), dtype=np.float32) / rate
        hz = 440 * 2 ** ((midi - 69) / 12)
        phase = 2 * np.pi * hz * t
        if sound in ('glass', 'musicbox'):
            tone = np.sin(phase) + .22 * np.sin(phase * 2.003) + .07 * np.sin(phase * 3.99)
            env = np.minimum(t/.012, 1) * np.exp(-t * (4 if sound == 'musicbox' else 1.7))
        elif sound == 'keys':
            tone = np.sin(phase + .5 * np.sin(phase*2) * np.exp(-t*4)) + .12*np.sin(phase*3)
            env = np.minimum(t/.008, 1) * np.exp(-t*3)
        elif sound == 'plucked':
            tone = sum(np.sin(phase*h)/(h*h) for h in range(1, 7))
            env = np.minimum(t/.006, 1) * np.exp(-t*4.5)
        else:
            tone = np.sin(phase) + .15*np.sin(phase*1.004) + .06*np.sin(phase*2)
            env = np.sin(np.pi*t/length)**2
        samples = tone * env * gain * np.clip((length-t)/.07, 0, 1)
        add(at, samples, pan)
        # Quiet stereo delay gives each synthetic voice a small acoustic space.
        if sound != 'sub':
            add(at+.19, samples*.17, -pan)
            add(at+.37, samples*.08, pan)

    bar = 0
    while bar*meter*beat < duration:
        at = bar*meter*beat
        chord = roots[(bar//4) % len(roots)]
        section = min(3, int(at / max(1, duration) * 4))
        gain = [.8, 1, .75, .9][section]
        if key == 'abyss':
            note(at, chord, meter*beat*2.5, .16*gain, -.2, 'sub')
            note(at+beat*2, chord+19, meter*beat*1.5, .045*gain, .4, 'sub')
            if bar % 3 == 0:
                note(at+beat, chord+36, 3.5, .07, .2, 'glass')
        elif key == 'forest':
            note(at, chord-12, meter*beat*1.8, .12, -.2, 'sub')
            for j, interval in enumerate([12, 19, 24, 14]):
                note(at+(j*1.1+.2)*beat, chord+interval, 2.4, .12*gain, (-1)**j*.45)
        elif key == 'clockwork':
            note(at, chord-12, .8, .19*gain, -.2, 'plucked')
            for j, interval in enumerate([12, 15, 19, 24, 19, 15]):
                note(at+j*.5*beat, chord+interval, .8, .095*gain, (-1)**j*.25)
            # Mechanical tick motif, synthesized rather than sampled.
            for j in range(3):
                t = np.arange(int(.035*rate))/rate
                tick = rng.normal(0, 1, len(t)) * np.exp(-t*180) * .045
                add(at+j*beat, tick, (-1)**j*.2)
        elif key == 'coolcity':
            note(at, chord-12, .7, .23*gain, -.15, 'plucked')
            for off in [.5, 2, 3.5]:
                for interval in [12, 16, 19, 23]:
                    note(at+off*beat, chord+interval, .8, .055*gain, .18)
            for off in [1, 3]:
                t = np.arange(int(.09*rate))/rate
                add(at+off*beat, rng.normal(0,1,len(t))*np.exp(-t*55)*.035, .3)
        else:
            note(at, chord-12, 1.2, .22*gain, -.25)
            for j, interval in enumerate([12, 19, 24, 16, 19]):
                note(at+(j*.5+.5)*beat, chord+interval, 1.3, .115*gain, (-1)**j*.25)
        bar += 1

    # Lower the score at major explanatory turns; no repeating all-film bed.
    for index in [7, 14, 21]:
        s = timeline['scenes'][index]
        start = int(s['from']/timeline['fps']*rate)
        end = min(len(mix), start+int(.7*rate))
        mix[start:end] *= np.linspace(.2, 1, end-start)[:, None]
    if key == 'clockwork':
        quiet = timeline['scenes'][18]
        start = int(quiet['from']/timeline['fps']*rate)
        end = int((quiet['from']+quiet['durationInFrames'])/timeline['fps']*rate)
        # Mechanical silence is a story beat, leaving only the narrator.
        mix[start:end] = 0
    mix[:rate] *= np.linspace(0, 1, rate)[:, None]
    fade_start = int((duration-2)*rate)
    mix[fade_start:] *= np.linspace(1, 0, len(mix)-fade_start)[:, None]

    def asset(name, samples, label):
        if samples.ndim == 1:
            samples = np.column_stack([samples, samples])
        out = path/'assets'/f'{name}.wav'
        with wave.open(str(out), 'wb') as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(rate)
            w.writeframes(np.int16(np.clip(samples, -1, 1)*32767).tobytes())
        raw = out.read_bytes()
        pkg['assets'][name] = {'kind':'audio','origin':'upload','status':'ready','file':f'assets/{name}.wav',
            'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'redistributable':True,
            'license':{'id':'CC0-1.0'},'source':{'provider':'repo','title':label,'creator':'Comfyrizz original synthesis'}}

    asset('a_original_score', mix*(.75/max(.01,abs(mix).max())), title)
    t = np.arange(int(1.2*rate))/rate
    if key == 'forest':
        cue = .16*np.sin(2*np.pi*(1300*t-350*t*t))*np.exp(-t*6)
        cue += rng.normal(0,1,len(t))*.035*np.exp(-t*4)
    elif key == 'clockwork':
        cue = sum(np.sin(2*np.pi*h*660*t)/h for h in [1,2.4,3.6])*np.exp(-t*4)*.18
    elif key == 'coolcity':
        cue = np.sin(2*np.pi*(420*t+200*t*t))*np.sin(np.pi*t/1.2)**2*.12
    elif key == 'ferment':
        cue = .12*np.sin(2*np.pi*(170*t+60*t*t))*np.exp(-t*6)
        cue += .06*np.sin(2*np.pi*1800*t)*np.exp(-t*22)
    else:
        cue = .2*np.sin(2*np.pi*880*t)*np.exp(-t*3)*np.minimum(t/.02,1)
    asset('a_chapter_cue', cue, f'{key}: original synthesized transition cue')
    pkg['audio']={'music':{'asset':'a_original_score','gain_db':-20 if key!='abyss' else -18,'loop':False,
        'fade_in_seconds':.8,'fade_out_seconds':1.2,'duck':{'enabled':True,'reduction_db':-7,'attack_ms':30,'release_ms':300}},
        'ambience':{'enabled':False},'sfx':[{'asset':'a_chapter_cue','scene':timeline['scenes'][i]['id'],
        'at':'scene-start','gain_db':-20} for i in [0,7,14,21]]}
    (path/'package.json').write_text(json.dumps(pkg,indent=2)+'\n')
    (path/'sound-direction.json').write_text(json.dumps({'title':title,'bpm':bpm,'beatsPerBar':meter,
        'instrument':timbre,'durationSeconds':duration,'cueScenes':[1,8,15,22]},indent=2)+'\n')
    print(json.dumps({'film':key,'score':title,'seconds':duration}),flush=True)
