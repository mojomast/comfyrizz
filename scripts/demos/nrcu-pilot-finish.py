"""Review and finish a frame-exact native FastH3 NRCU pilot edit.

review ROOT [--shots s03 ...] uses CPU ASR and temporal samples.
finish ROOT requires current source hashes and speech review reports. A review
override may specify muteAudio or an explicitly recorded caption correction.
Neither ASR nor frame samples constitute a normal-speed listening review.
"""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import subprocess
import textwrap


def run(args):subprocess.run(list(map(str,args)),check=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def probe(p):return json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(p)]))
def stamp(t):
    ms=round(t*1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'


def finish(root,film):
    duration=float(film['seconds']);target_frames=round(duration*24)
    if abs(target_frames/24-duration)>1e-6:raise ValueError('Duration must land on a 24 fps frame')
    out=root/'final';parts=out/'parts';parts.mkdir(exist_ok=True,parents=True)
    overrides=json.loads((root/'review-overrides.json').read_text()) if (root/'review-overrides.json').exists() else {}
    edits=[]
    for shot in film['shots']:
        movie=root/'outputs'/f'{shot["id"]}.mp4'
        receipt=json.loads(movie.with_suffix('.json').read_text())
        reviewed=json.loads((root/'review'/f'{shot["id"]}.json').read_text())
        if receipt['status']!='succeeded' or sha(movie)!=receipt['sha256'] or reviewed['fileHash']!=receipt['sha256']:
            raise ValueError('Unverified or stale take: '+shot['id'])
        if reviewed['expected']!=shot['line']:raise ValueError('Stale script review: '+shot['id'])
        override=overrides.get(shot['id'],{})
        if override and (override.get('fileHash')!=receipt['sha256'] or not override.get('reason')):
            raise ValueError('Override requires matching take hash and reason')
        if not shot['line'] and reviewed['transcript'].strip() and not (override.get('muteAudio') or override.get('nonSpeechAccepted')):
            raise ValueError('Possible speech in action shot requires review: '+shot['id'])
        source_start_frames=round(float(override.get('sourceStart',0))*24)
        if source_start_frames<0:raise ValueError('Negative source start')
        source_start=source_start_frames/24
        available=int(next(s for s in reviewed['probe']['streams'] if s['codec_type']=='video')['nb_frames'])-source_start_frames
        maximum=available;minimum=max(24,round((shot['seconds']-.75)*24))
        if shot['line']:
            if not reviewed['scriptPrefixComplete'] and not override.get('speechAccepted'):
                raise ValueError('Speech mismatch requires review: '+shot['id'])
            line_end=override.get('intendedLineEnd',reviewed['intendedLineEnd'])-source_start
            if line_end>available/24+1/24:raise ValueError('Speech exceeds source: '+shot['id'])
            minimum=math.ceil((line_end+.12)*24)
            minimum=min(minimum,available)
            extra=override.get('extraSpeechStart',reviewed.get('extraSpeechStart'))
            if extra is not None:maximum=min(maximum,math.floor((extra-source_start-.06)*24))
        if minimum>maximum:raise ValueError('No clean dialogue cut: '+shot['id'])
        edits.append({**shot,'editFrames':max(minimum,min(maximum,shot['seconds']*24)),
                      'minimumFrames':minimum,'maximumFrames':maximum,'sourceHash':receipt['sha256'],
                      'sourceStart':source_start,
                      'crop':override.get('crop'),
                      'muteAudio':bool(override.get('muteAudio',False))})
    excess=sum(s['editFrames'] for s in edits)-target_frames
    for shot in sorted(edits,key=lambda s:(bool(s['line']),-(s['editFrames']-s['minimumFrames']))):
        take=min(max(excess,0),shot['editFrames']-shot['minimumFrames']);shot['editFrames']-=take;excess-=take
    for shot in sorted(edits,key=lambda s:(bool(s['line']),-(s['maximumFrames']-s['editFrames']))):
        add=min(max(-excess,0),shot['maximumFrames']-shot['editFrames']);shot['editFrames']+=add;excess+=add
    if excess:raise ValueError('Cannot fit protected performances into target duration')
    cursor=0;cues=[]
    for shot in edits:
        shot['start']=cursor/24;shot['seconds']=shot['editFrames']/24;cursor+=shot['editFrames']
        sid=shot['id'];reviewed=json.loads((root/'review'/f'{sid}.json').read_text())
        if shot['line']:
            words=[{**w,'start':w['start']-shot['sourceStart'],'end':w['end']-shot['sourceStart']}
                   for w in reviewed['usableWords'] if w['start']>=shot['sourceStart']];chunk=[]
            for w in words:
                if w['start']>=shot['seconds']:continue
                if chunk and (len(' '.join(x['text'] for x in chunk+[w]))>64 or w['end']-chunk[0]['start']>3.5):
                    cues.append((shot['start']+chunk[0]['start'],shot['start']+min(shot['seconds'],chunk[-1]['end']),' '.join(x['text'] for x in chunk)));chunk=[]
                chunk.append(w)
            if chunk:cues.append((shot['start']+chunk[0]['start'],shot['start']+min(shot['seconds'],chunk[-1]['end']),' '.join(x['text'] for x in chunk)))
        movie=root/'outputs'/f'{sid}.mp4';dest=parts/f'{sid}.mkv'
        vf=f'fps=24,trim=end_frame={shot["editFrames"]},setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1'
        if shot['crop']:
            if len(shot['crop'])!=4 or any(not isinstance(n,int) or n<0 for n in shot['crop']):
                raise ValueError('Crop must be four nonnegative integers: width, height, x, y')
            vf='crop='+':'.join(map(str,shot['crop']))+','+vf
        gain='volume=0' if shot['muteAudio'] else f'loudnorm=I={-18 if shot["line"] else -27}:TP=-2:LRA=7'
        af=f'atrim=duration={shot["seconds"]},asetpts=PTS-STARTPTS,{gain},aresample=48000,apad,atrim=duration={shot["seconds"]},afade=t=in:d=0.015,afade=t=out:st={max(0,shot["seconds"]-.025)}:d=0.025'
        key=hashlib.sha256(json.dumps([shot['sourceHash'],shot['sourceStart'],vf,af]).encode()).hexdigest();cache=dest.with_suffix('.json')
        if not (dest.exists() and cache.exists() and json.loads(cache.read_text()).get('key')==key):
            run(['ffmpeg','-v','error','-y','-ss',shot['sourceStart'],'-i',movie,'-map','0:v:0','-map','0:a:0','-vf',vf,'-af',af,
                 '-c:v','libx264','-crf','19','-preset','fast','-pix_fmt','yuv420p','-c:a','pcm_s16le',dest])
            cache.write_text(json.dumps({'key':key,'sha256':sha(dest)}))
    (out/'edit.json').write_text(json.dumps(edits,indent=2))
    srt=out/'captions.srt';srt.write_text('\n\n'.join(f'{i}\n{stamp(a)} --> {stamp(b)}\n'+ '\n'.join(textwrap.wrap(t,width=42)) for i,(a,b,t) in enumerate(cues,1))+'\n')
    (out/'captions.vtt').write_text('WEBVTT\n\n'+re.sub(r'(\d{2}:\d{2}:\d{2}),(\d{3})',r'\1.\2',srt.read_text()))
    listing=out/'parts.txt';listing.write_text(''.join(f"file 'parts/{s['id']}.mkv'\n" for s in edits))
    feature=out/'hermes-the-lower-road-1080p.mp4'
    run(['ffmpeg','-v','error','-y','-f','concat','-safe','1','-i',listing,'-i',root/'audio/music.wav','-i',root/'audio/ambience.wav','-i',srt,
         '-filter_complex',f'[0:v]setpts=N/(24*TB)[v];[0:a]asetpts=N/SR/TB[d];[d][1:a][2:a]amix=inputs=3:normalize=0,loudnorm=I=-18:TP=-1.5:LRA=9,aresample=48000,atrim=duration={duration}[a]',
         '-map','[v]','-map','[a]','-map','3:0','-r','24','-fps_mode','cfr','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-c:s','mov_text',
         '-metadata:s:s:0','language=eng','-metadata','title='+film['title'],'-t',duration,'-movflags','+faststart',feature])
    metadata=probe(feature);video=next(s for s in metadata['streams'] if s['codec_type']=='video')
    assert int(video['nb_frames'])==target_frames and abs(float(video['duration'])-duration)<.01
    compact=out/'hermes-the-lower-road-small.mp4'
    run(['ffmpeg','-v','error','-y','-i',feature,'-map','0:v:0','-map','0:a:0','-map','0:s?',
         '-vf','fps=24,scale=1280:720','-r','24','-c:v','libx264','-preset','fast','-crf','23','-c:a','aac','-b:a','128k',
         '-c:s','copy','-t',duration,'-movflags','+faststart',compact])
    for export in [feature,compact]:
        checked=probe(export);stream=next(s for s in checked['streams'] if s['codec_type']=='video')
        assert int(stream['nb_frames'])==target_frames and stream['avg_frame_rate']=='24/1'
        assert abs(float(stream['duration'])-duration)<.01
        decoded=subprocess.run(['ffmpeg','-v','error','-xerror','-i',str(export),'-map','0:v:0','-map','0:a:0','-f','null','-'],capture_output=True,text=True,check=True)
        if decoded.stderr.strip():raise ValueError('Decode diagnostics: '+decoded.stderr)
    report={'title':film['title'],'videoModel':'fasth3-omni','bytes':feature.stat().st_size,'sha256':sha(feature),
            'probe':metadata,'captions':len(cues),'sourceShots':len(edits),'listeningReviewed':False,
            'fullDecodePassed':True,'compact':{'bytes':compact.stat().st_size,'sha256':sha(compact),'probe':probe(compact)},
            'reviewMethod':'CPU ASR, temporal samples and recorded editorial decisions; normal-speed listening pending'}
    (out/'verification.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='probe'}))


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('mode',choices=['review','finish']);p.add_argument('root',type=Path);p.add_argument('--shots',nargs='+');a=p.parse_args()
    film=json.loads((a.root/'film.json').read_text())
    if a.mode=='finish':finish(a.root,film)
    else:
        path=Path(__file__).with_name('gpu-artists-finish.py');spec=importlib.util.spec_from_file_location('review_helpers',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        m.review(a.root,[s for s in film['shots'] if not a.shots or s['id'] in a.shots])


if __name__=='__main__':main()
