"""Synthesize an original 90-second pilot underscore, outside Git.

Usage: python nrcu-pilot-score.py OUTDIR
Deterministic original motif; separate stereo music and ambience WAV stems.
"""
from pathlib import Path
import json
import sys
import wave
import numpy as np

RATE=48000
SECONDS=90


def save(path,audio):
    with wave.open(str(path),'wb') as f:
        f.setnchannels(2);f.setsampwidth(2);f.setframerate(RATE)
        f.writeframes((np.clip(audio,-1,1)*32767).astype('<i2').tobytes())


def main():
    root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
    score=np.zeros((RATE*SECONDS,2),np.float32)
    rng=np.random.default_rng(20261021)
    def tone(start,duration,freq,amp,pan=0,kind='pad'):
        n=int(duration*RATE);t=np.arange(n)/RATE
        env=np.minimum(t/.12,1)*np.minimum((duration-t)/.5,1)
        if kind=='bell':
            y=(np.sin(2*np.pi*freq*t)+.3*np.sin(2*np.pi*freq*2.01*t))*np.exp(-t*2.8)
        elif kind=='bass':
            y=(np.sin(2*np.pi*freq*t)+.18*np.sin(2*np.pi*freq*2*t))*np.exp(-t*1.8)
        else:
            y=(np.sin(2*np.pi*freq*t)+.25*np.sin(2*np.pi*(freq*2+.3)*t)+.12*np.sin(2*np.pi*freq*3*t))
            env*=.85+.15*np.sin(2*np.pi*.7*t)
        y=y*env*amp;idx=int(start*RATE);n=min(n,len(score)-idx)
        score[idx:idx+n,0]+=y[:n]*(1-pan*.4);score[idx:idx+n,1]+=y[:n]*(1+pan*.4)
    # D minor / Bb / F / C; the motif returns slowly after the rescue.
    chords=[(146.83,174.61,220),(116.54,146.83,174.61),(130.81,174.61,220),(130.81,164.81,196)]
    for start in np.arange(0,70,8):
        if 39<=start<48:continue
        for j,f in enumerate(chords[int(start/8)%4]):tone(float(start),7.8,f,.018,(j-1)*.7)
    for start in np.arange(4,39,.625):
        tone(float(start),.55,73.416 if int(start/2.5)%2==0 else 58.27,.10,kind='bass')
    for start in np.arange(48,70,.75):tone(float(start),.65,73.416,.065,kind='bass')
    motif=[293.66,349.23,440,392]
    for base,step,amp in [(1,1.2,.024),(20,.65,.025),(52,.85,.03),(84,1.1,.035)]:
        for i,f in enumerate(motif):tone(base+i*step,2.3,f,amp,(i-1.5)/3,kind='bell')
    for j,f in enumerate([146.83,220,293.66]):tone(71,12,f,.015,(j-1)*.5)
    # Soft synthesized impacts and noise swells; no sampled third-party music.
    for start,amp in [(0,.10),(24,.18),(39,.13),(58,.10)]:
        n=RATE*2;t=np.arange(n)/RATE;y=np.sin(2*np.pi*(48*t+20*(1-np.exp(-t*3))))*np.exp(-t*3)*amp
        noise=rng.standard_normal(n)*np.exp(-t*6)*amp*.05
        idx=int(start*RATE);score[idx:idx+n]+=np.column_stack([y+noise,y-noise])
    envelope=np.ones(RATE*SECONDS)
    # Leave the choice room to breathe; pull the score down during dialogue.
    for a,b,gain in [(9,19,.36),(40,50,.25),(39,40,.05),(68,85,.32)]:
        envelope[int(a*RATE):int(b*RATE)]*=gain
    envelope[:RATE]*=np.linspace(0,1,RATE);envelope[-2*RATE:]*=np.linspace(1,0,2*RATE)
    score*=envelope[:,None]
    save(root/'music.wav',score)
    # A low wind bed bridges generated-shot ambience without carrying speech.
    n=SECONDS*RATE;white=rng.standard_normal(n)
    wind=np.convolve(white,np.ones(69)/69,mode='same')*.008
    wind*=np.minimum(np.arange(n)/(RATE*.5),1)*np.minimum((n-np.arange(n))/(RATE*2),1)
    save(root/'ambience.wav',np.column_stack([wind,np.roll(wind,800)]))
    (root/'score-receipt.json').write_text(json.dumps({'seconds':90,'sampleRate':RATE,'seed':20261021,
        'composition':'Original four-note motif and synthesized tonal/percussive score','thirdPartySamples':False,
        'motifHz':motif,'peak':float(np.abs(score).max()),'listeningReviewed':False},indent=2))
    print('Original music and ambience stems written.')


if __name__=='__main__':main()
