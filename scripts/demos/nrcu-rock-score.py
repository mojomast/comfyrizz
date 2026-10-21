"""Original instrumental rock score fitted to the pilot's measured edit.

Usage: python nrcu-rock-score.py PRODUCTION_DIR
Synthesized double-tracked distorted power chords, electric bass, kick/snare,
hats and cymbals. No third-party samples. Speech windows come from ASR receipts.
"""
from pathlib import Path
import hashlib
import json
import sys
import wave

import numpy as np

RATE = 48000
BPM = 144
BEAT = 60 / BPM
SEED = 2026102102


def save(path, audio):
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(2); f.setsampwidth(2); f.setframerate(RATE)
        f.writeframes((np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes())


def main():
    root = Path(sys.argv[1]); out = root / 'audio'; out.mkdir(exist_ok=True)
    film = json.loads((root / 'film.json').read_text())
    overrides = json.loads((root / 'review-overrides.json').read_text())
    duration = film['seconds']; n = round(duration * RATE)
    rng = np.random.default_rng(SEED)
    guitar = np.zeros((n, 2), np.float32)
    bass = np.zeros_like(guitar); drums = np.zeros_like(guitar)
    ambience = np.zeros_like(guitar)
    shots = {}; windows = []; cursor = 0
    for shot in film['shots']:
        shots[shot['id']] = (cursor, shot['seconds'])
        if shot['line']:
            review = json.loads((root / 'review' / (shot['id'] + '.json')).read_text())
            source_start = round(overrides.get(shot['id'], {}).get('sourceStart', 0) * 24) / 24
            words = [w for w in review['usableWords'] if w['start'] >= source_start]
            windows.append((cursor + words[0]['start'] - source_start,
                            cursor + words[-1]['end'] - source_start))
        cursor += shot['seconds']
    assert abs(cursor - duration) < 1e-5

    def add(stem, start, sound, gain=1, pan=0):
        start = max(0, round(start * RATE)); count = min(len(sound), n - start)
        if count <= 0: return
        stem[start:start + count, 0] += sound[:count] * gain * np.sqrt((1-pan)/2)
        stem[start:start + count, 1] += sound[:count] * gain * np.sqrt((1+pan)/2)

    def electric(freq, length, detune=1, muted=True):
        t = np.arange(round(length * RATE)) / RATE
        signal = np.zeros(len(t))
        # Picked-string harmonic decay, then amplifier saturation and cabinet rolloff.
        for ratio in [1, 1.5, 2]:
            for harmonic in range(1, 19):
                f = freq * ratio * harmonic * detune
                if f > 7500: break
                signal += np.sin(2*np.pi*f*t + harmonic*.07) / harmonic**1.15 * np.exp(-t*(1.7 + harmonic*.65))
        attack = np.minimum(t/.003, 1)
        gate = np.minimum((length-t)/.018, 1)
        decay = np.exp(-t*(11 if muted else 1.8))
        signal = np.tanh(signal * 3.2) * attack * gate * decay
        signal = np.convolve(signal, np.ones(9)/9, mode='same')
        return signal.astype(np.float32)

    def bass_note(freq, length):
        t = np.arange(round(length*RATE))/RATE
        y = np.sin(2*np.pi*freq*t) + .28*np.sin(4*np.pi*freq*t) + .1*np.sin(6*np.pi*freq*t)
        return np.tanh(y*1.4)*np.minimum(t/.006,1)*np.exp(-t*2.8)*np.minimum((length-t)/.03,1)

    def percussion(kind, length):
        t = np.arange(round(length*RATE))/RATE
        noise = rng.standard_normal(len(t))
        high = noise - np.convolve(noise, np.ones(17)/17, mode='same')
        if kind == 'kick':
            phase = 2*np.pi*(47*t + 65*.025*(1-np.exp(-t/.025)))
            y = np.sin(phase)*np.exp(-t*11) + .12*high*np.exp(-t*150)
        elif kind == 'snare':
            y = .52*high*np.exp(-t*24) + .45*np.sin(2*np.pi*185*t)*np.exp(-t*30)
            y += .15*np.sin(2*np.pi*330*t)*np.exp(-t*35)
        else:
            metallic = sum(np.sin(2*np.pi*f*t) for f in [3449, 4913, 6281, 7517]) / 4
            y = (.16*high + .13*metallic)*np.exp(-t*(55 if kind == 'hat' else 4.5))
        return np.tanh(y*1.3)*np.minimum((length-t)/.012,1)

    # A four-bar D–C–Bb–C riff, original syncopation with double-tracked guitars.
    roots = [73.416, 65.406, 58.270, 65.406]
    last_action = shots['s17'][0]
    choice_start = shots['s08'][0]
    choice_end = shots['s12'][0]
    for bar_start in np.arange(0, duration, 4*BEAT):
        bar = round(bar_start/(4*BEAT)); freq = roots[bar % 4]
        quiet = choice_start <= bar_start < choice_end or last_action <= bar_start < shots['s20'][0]
        pattern = [(0, .85), (.5, .38), (1.5, .38), (2, .7), (2.75, .25), (3.5, .4)]
        if quiet: pattern = [(0, 1.8), (2, 1.3)]
        for beat, length_beats in pattern:
            at = bar_start + beat*BEAT; length = length_beats*BEAT
            for pan, detune, lag in [(-.88, .998, 0), (.88, 1.0023, .008)]:
                add(guitar, at+lag, electric(freq, length, detune, not quiet), .14 if not quiet else .075, pan)
            add(bass, at, bass_note(freq/2, length), .22 if not quiet else .13)
        for beat in range(4):
            at = bar_start + beat*BEAT
            if quiet:
                if beat == 0: add(drums, at, percussion('kick', .4), .23)
                if beat == 2: add(drums, at, percussion('snare', .24), .13)
            else:
                if beat in [0, 2]: add(drums, at, percussion('kick', .4), .48)
                if beat in [1, 3]: add(drums, at, percussion('snare', .24), .43, -.07)
                if beat == 2: add(drums, at+.5*BEAT, percussion('kick', .35), .28)
            for off in [0, .5]:
                add(drums, at+off*BEAT, percussion('hat', .11), .24 if not quiet else .10, .35)
        if bar % 4 == 0 and not quiet:
            add(drums, bar_start, percussion('crash', 1.8), .36, -.4)
        if bar % 4 == 3 and not quiet:
            for offset, pan in [(3.25,-.4),(3.5,0),(3.75,.4)]:
                add(drums, bar_start+offset*BEAT, percussion('snare', .18), .2, pan)

    # Picture-synced accents: cable failure, descent, boarding, final reassuring beat.
    for sid, offset in [('s06', .6), ('s12', 0), ('s14', 2.8), ('s20', .15)]:
        at = shots[sid][0]+offset
        add(drums, at, percussion('crash', 1.3), .23, -.2)
        add(drums, at, percussion('kick', .4), .30)
    # Short stereo room reflections, not a long atmospheric pad.
    for stem in [guitar, drums]:
        direct = stem.copy()
        for delay, gain in [(.031, .13), (.073, .08)]:
            shift = round(delay*RATE); stem[shift:] += direct[:-shift, ::-1]*gain

    duck = np.ones(n, np.float32)
    for start, end in windows:
        a = max(0, round((start-.12)*RATE)); b = min(n, round((end+.18)*RATE))
        if b <= a: continue
        env = np.full(b-a, .17, np.float32)
        attack = min(round(.12*RATE),len(env)//2); release = min(round(.18*RATE),len(env)//2)
        env[:attack] = np.linspace(1,.17,attack); env[-release:] = np.linspace(.17,1,release)
        duck[a:b] = np.minimum(duck[a:b],env)
    score = (guitar + bass + drums) * duck[:,None]
    # One brief music stop makes Don's decision land rather than racing over it.
    a = round(choice_start*RATE); b = min(n,a+round(.20*RATE))
    score[a:b] *= np.linspace(.08,1,b-a)[:,None]
    score[:round(.04*RATE)] *= np.linspace(0,1,round(.04*RATE))[:,None]
    fade = min(round(.65*RATE),n); score[-fade:] *= np.linspace(1,0,fade)[:,None]
    peak = float(np.abs(score).max()); score *= min(1,.82/max(peak,.001))
    wind = np.convolve(rng.standard_normal(n),np.ones(93)/93,mode='same')*.009
    ambience[:,0] = wind; ambience[:,1] = np.roll(wind,700)
    # Original nonvocal Foley bridges muted source takes.
    for sid in ['s05','s09','s12','s16']:
        at,length = shots[sid]; t = np.arange(round(length*RATE))/RATE
        motor = (.008*np.sin(2*np.pi*(58*t+3*t*t)) + .003*np.sin(2*np.pi*137*t))
        motor *= np.minimum(t/.08,1)*np.minimum((length-t)/.12,1)
        add(ambience,at,motor)
    at = shots['s06'][0]+.6; t=np.arange(round(.6*RATE))/RATE
    snap=(rng.standard_normal(len(t))*.05+np.sin(2*np.pi*690*t)*.07)*np.exp(-t*15)
    add(ambience,at,snap)
    ambience[-fade:] *= np.linspace(1,0,fade)[:,None]
    save(out/'music.wav',score); save(out/'ambience.wav',ambience)
    receipt={'style':'Original instrumental hard-rock action cue','bpm':BPM,'seconds':duration,
             'seed':SEED,'instruments':['double-tracked distorted power-chord guitars','electric bass','kick/snare kit','hats/cymbals'],
             'dialogueDuckingDB':round(20*np.log10(.17),2),'speechWindows':windows,
             'thirdPartySamples':False,'listeningReviewed':False,
             'sha256':hashlib.sha256((out/'music.wav').read_bytes()).hexdigest()}
    (out/'score-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))


if __name__=='__main__': main()
