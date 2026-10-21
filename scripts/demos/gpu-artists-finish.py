"""Review or assemble the FastH3 short, preserving its generated dialogue.

review DIRECTORY [--shots s04 ...]: ASR timings + temporal contact sheets.
finish DIRECTORY: exact four-minute 1080p24 export with optional measured captions.
ASR is an inspection aid, not a listening or performance-quality verdict.
"""
import argparse
import difflib
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess


def run(argv):
    subprocess.run(list(map(str, argv)), check=True)


def probe(file):
    return json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(file)]))


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def timestamp(t):
    ms = round(t * 1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'


def review(root, shots):
    from faster_whisper import WhisperModel
    from PIL import Image, ImageDraw
    import numpy as np
    model = WhisperModel('small.en', device='cpu', compute_type='int8', cpu_threads=4)
    out = root / 'review'
    out.mkdir(exist_ok=True)
    for shot in shots:
        movie = root / 'outputs' / f'{shot["id"]}.mp4'
        raw_audio = subprocess.check_output(['ffmpeg','-v','error','-i',str(movie),'-vn','-ar','16000','-ac','1','-f','f32le','pipe:1'])
        segments, info = model.transcribe(np.frombuffer(raw_audio,dtype=np.float32).copy(), language='en', beam_size=5, word_timestamps=True, vad_filter=False)
        segments = list(segments)
        words = [{'text': w.word.strip(), 'start': w.start, 'end': w.end, 'probability': w.probability}
                 for s in segments for w in s.words]
        text = ' '.join(s.text.strip() for s in segments)
        tokens = lambda s: re.findall(r'[a-z0-9]+', s.lower())
        ratio = difflib.SequenceMatcher(None,tokens(shot['line']),tokens(text)).ratio()
        expected = tokens(shot['line'])
        observed = [(token,i) for i,w in enumerate(words) for token in tokens(w['text'])]
        prefix = bool(expected) and [t for t,i in observed[:len(expected)]] == expected
        end_index = observed[len(expected)-1][1] if prefix else len(words)-1
        usable = words[:end_index+1]
        extra = words[end_index+1:]
        result = {'shot': shot['id'], 'fileHash': sha(movie), 'method': 'faster-whisper small.en CPU int8',
                  'expected': shot['line'], 'transcript': text, 'wordSimilarity': ratio, 'words': words,
                  'lastWordEnd': max((w['end'] for w in words),default=0),
                  'scriptPrefixComplete': prefix, 'usableWords': usable,
                  'intendedLineEnd': max((w['end'] for w in usable),default=0),
                  'extraSpeechStart': extra[0]['start'] if extra else None,
                  'editorialSeconds': shot['seconds'], 'probe': probe(movie), 'listeningReviewed': False}
        (out / f'{shot["id"]}.json').write_text(json.dumps(result,indent=2))
        sheet = Image.new('RGB',(1600,210),'#172026')
        draw = ImageDraw.Draw(sheet)
        for i, t in enumerate([0.25 + n*(shot['seconds']-.5)/4 for n in range(5)]):
            raw = subprocess.check_output(['ffmpeg','-v','error','-ss',str(t),'-i',str(movie),'-frames:v','1',
                                           '-vf','scale=320:180','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])
            sheet.paste(Image.frombytes('RGB',(320,180),raw),(i*320,0))
            draw.text((i*320+6,190),f'{shot["id"]} / {t:.1f}s',fill='white')
        sheet.save(out / f'{shot["id"]}.jpg',quality=93)
        print(json.dumps({k:result[k] for k in ['shot','transcript','wordSimilarity','lastWordEnd','editorialSeconds','extraSpeechStart']}),flush=True)


def finish(root, film):
    out = root / 'final'
    parts = out / 'parts'
    parts.mkdir(parents=True,exist_ok=True)
    # Fit the overall runtime, not each utterance, to the brief. Protect the last
    # measured word and borrow from intentional reaction holds elsewhere.
    edits = []
    for shot in film['shots']:
        reviewed = json.loads((root / 'review' / f'{shot["id"]}.json').read_text())
        if reviewed['expected'] != shot['line']:
            raise ValueError('Review predates script revision: '+shot['id'])
        video = next(s for s in reviewed['probe']['streams'] if s['codec_type']=='video')
        available = int(video['nb_frames'])
        extra = reviewed.get('extraSpeechStart')
        maximum = min(available,math.floor((extra-.08)*24)) if extra is not None else available
        line_end = reviewed.get('intendedLineEnd',reviewed['lastWordEnd'])
        minimum = math.ceil((line_end + .16) * 24)
        if minimum > available:
            if line_end * 24 > available + 1:
                raise ValueError('Speech exceeds source: '+shot['id'])
            minimum = available
        if minimum > maximum:
            raise ValueError('No clean cut between intended and extra speech: '+shot['id'])
        edits.append({**shot, 'editFrames': max(minimum, min(maximum,shot['seconds']*24)),
                      'minimumFrames':minimum, 'maximumFrames':maximum})
    excess = sum(s['editFrames'] for s in edits) - 5760
    for shot in sorted(edits,key=lambda s:s['editFrames']-s['minimumFrames'],reverse=True):
        take = min(max(0,excess),shot['editFrames']-shot['minimumFrames'])
        shot['editFrames'] -= take
        excess -= take
    for shot in sorted(edits,key=lambda s:s['maximumFrames']-s['editFrames'],reverse=True):
        add = min(max(0,-excess),shot['maximumFrames']-shot['editFrames'])
        shot['editFrames'] += add
        excess += add
    if excess:
        raise ValueError('Cannot preserve all speech within four minutes; revise dialogue')
    cursor=0
    for shot in edits:
        shot['start']=cursor/24
        shot['seconds']=shot['editFrames']/24
        cursor+=shot['editFrames']
    (out/'edit.json').write_text(json.dumps(edits,indent=2))
    cues, receipts = [], []
    for shot in edits:
        movie = root / 'outputs' / f'{shot["id"]}.mp4'
        receipt = json.loads((root / 'outputs' / f'{shot["id"]}.json').read_text())
        if receipt['status'] != 'succeeded' or receipt['sha256'] != sha(movie):
            raise ValueError('Unverified source: '+shot['id'])
        review_file = root / 'review' / f'{shot["id"]}.json'
        reviewed = json.loads(review_file.read_text())
        if reviewed['fileHash'] != receipt['sha256']:
            raise ValueError('Stale review: '+shot['id'])
        if not reviewed.get('scriptPrefixComplete') and reviewed['wordSimilarity'] < .70:
            raise ValueError('Review transcript mismatch before finishing: '+shot['id'])
        # Use observed speech, not a fictional transcript copied from the prompt.
        chunk = []
        for word in reviewed.get('usableWords',reviewed['words']):
            if chunk and (len(' '.join(w['text'] for w in chunk+[word])) > 70 or word['end']-chunk[0]['start'] > 4):
                cues.append((shot['start']+chunk[0]['start'],shot['start']+chunk[-1]['end'],' '.join(w['text'] for w in chunk)))
                chunk=[]
            # These are homophone/number typography corrections, not rewritten
            # performances. Keep observed word boundaries and the raw ASR report.
            word = dict(word)
            if shot['id'] == 's07' and word['text'].lower().rstrip('.,') == 'brakes':
                word['text'] = word['text'].replace('brakes','breaks').replace('Brakes','Breaks')
            if shot['id'] == 's22' and word['text'] == '1230.':
                word['text'] = '12:30.'
            chunk.append(word)
        if chunk:
            cues.append((shot['start']+chunk[0]['start'],shot['start']+chunk[-1]['end'],' '.join(w['text'] for w in chunk)))
        dest = parts / f'{shot["id"]}.mkv'
        vf = f'fps=24,trim=duration={shot["seconds"]},setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1'
        af = f'atrim=duration={shot["seconds"]},asetpts=PTS-STARTPTS,loudnorm=I=-18:TP=-2:LRA=7,aresample=48000,apad,atrim=duration={shot["seconds"]}'
        effective = {'source':receipt['sha256'],'vf':vf,'af':af,'codec':'libx264-crf18-medium/pcm_s16le','version':1}
        key = hashlib.sha256(json.dumps(effective,sort_keys=True).encode()).hexdigest()
        cache = dest.with_suffix('.json')
        valid = False
        if dest.exists() and cache.exists():
            old = json.loads(cache.read_text())
            valid = old.get('key') == key and old.get('sha256') == sha(dest)
        if not valid:
            run(['ffmpeg','-v','error','-y','-i',movie,'-map','0:v:0','-map','0:a:0','-vf',vf,'-af',af,
                 '-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-c:a','pcm_s16le',dest])
            cache.write_text(json.dumps({'key':key,'sha256':sha(dest),'inputs':effective},indent=2))
        receipts.append({'shot':shot['id'],'sourceSha256':receipt['sha256'],'partKey':key})
    captions = out / 'captions.srt'
    import textwrap
    captions.write_text('\n\n'.join(f'{i}\n{timestamp(a)} --> {timestamp(b)}\n'+ '\n'.join(textwrap.wrap(t,width=42))
                                    for i,(a,b,t) in enumerate(cues,1))+'\n')
    (out/'captions.vtt').write_text('WEBVTT\n\n'+re.sub(r'(\d{2}:\d{2}:\d{2}),(\d{3})',r'\1.\2',captions.read_text()))
    listing = out / 'parts.txt'
    listing.write_text(''.join(f"file 'parts/{s['id']}.mkv'\n" for s in film['shots']))
    movie = out / 'gpu-artists-1080p.mp4'
    run(['ffmpeg','-v','error','-y','-f','concat','-safe','1','-i',listing,'-i',captions,
         '-map','0:v:0','-map','0:a:0','-map','1:0','-c:v','copy','-c:a','aac','-b:a','192k','-c:s','mov_text',
         '-metadata:s:s:0','language=eng','-metadata','title='+film['title'],'-movflags','+faststart',movie])
    metadata = probe(movie)
    video = next(s for s in metadata['streams'] if s['codec_type']=='video')
    if int(video['nb_frames']) != 5760 or abs(float(metadata['format']['duration'])-240)>.1:
        raise ValueError('Final duration/frame-count mismatch')
    report = {'title':film['title'],'sha256':sha(movie),'bytes':movie.stat().st_size,
              'probe':metadata,'sources':receipts,'captions':len(cues),'listeningReviewed':False}
    (out / 'verification.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({'movie':str(movie),'bytes':report['bytes'],'sha256':report['sha256'],'seconds':240}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['review','finish'])
    parser.add_argument('directory',type=Path)
    parser.add_argument('--shots',nargs='+')
    args=parser.parse_args()
    root=args.directory.resolve()
    film=json.loads((root/'film.json').read_text())
    if args.mode=='review':
        review(root,[s for s in film['shots'] if not args.shots or s['id'] in args.shots])
    else:
        finish(root,film)
