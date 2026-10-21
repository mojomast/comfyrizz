"""Local technical, transcript and sampled-frame evidence for selected test shots.

Usage: python review-nrcu-validation.py VALIDATION_ROOT WHISPER_MODEL_DIRECTORY
This never approves acting/lip-sync and never calls a generation backend.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw
from faster_whisper import WhisperModel


def command(*args):
    return subprocess.check_output(args)


def words(text):
    return re.findall(r"[\w']+", text.lower())


def main():
    root, model_path = map(Path, sys.argv[1:3])
    out = root / 'review'
    out.mkdir(exist_ok=True)
    pkg = json.loads((root/'input/package.json').read_text())
    manifest = json.loads((root/'video-result.json').read_text())['manifest']
    model = WhisperModel(str(model_path), device='cpu', compute_type='int8', cpu_threads=4)
    shots = []
    for scene in pkg['scenes']:
        asset_id = scene['background']['asset']
        asset = pkg['assets'][asset_id]
        entry = next(j for j in manifest['jobs'] if j['job'] == asset_id+'.plate')
        if entry['status'] not in ['succeeded', 'cached']:
            shots.append({'scene':scene['id'], 'status':entry['status']})
            continue
        media = entry['outputs'][0]
        file = root / 'video-out' / media['relative']
        probe = json.loads(command('ffprobe','-v','error','-show_streams','-show_format','-of','json',str(file)))
        video = next(s for s in probe['streams'] if s['codec_type']=='video')
        audio = next((s for s in probe['streams'] if s['codec_type']=='audio'), None)
        duration = float(video.get('duration',probe['format']['duration']))
        decode = subprocess.run(['ffmpeg','-v','error','-threads','2','-i',str(file),'-f','null','-'],capture_output=True)
        pcm = command('ffmpeg','-v','error','-i',str(file),'-vn','-ac','1','-ar','16000','-f','f32le','-')
        samples = np.frombuffer(pcm,dtype=np.float32).copy()
        segments,_ = model.transcribe(samples,language='en',beam_size=5,word_timestamps=True,vad_filter=True,condition_on_previous_text=False)
        segments=list(segments)
        transcript=' '.join(s.text.strip() for s in segments)
        timings=[{'word':w.word,'start':float(w.start),'end':float(w.end),'probability':float(w.probability)} for s in segments for w in (s.words or [])]
        speech_end=max((w['end'] for w in timings),default=0)
        slot=scene['preferredFrames']/pkg['format']['fps']
        row={'scene':scene['id'],'expected':scene.get('narration',''),'transcript':transcript,'words':timings,
             'exactNormalizedTranscript':words(transcript)==words(scene.get('narration','')),
             'sourceSeconds':duration,'slotSeconds':slot,'speechEnd':speech_end,
             'speechPastCut':speech_end>slot,'remainingTailSeconds':slot-speech_end,
             'sha256Matches':hashlib.sha256(file.read_bytes()).hexdigest()==media['sha256'],
             'decodeOk':decode.returncode==0 and not decode.stderr.strip(),'decodeErrors':decode.stderr.decode(),
             'width':video['width'],'height':video['height'],'fps':video['avg_frame_rate'],'audioPresent':audio is not None,
             'audioPeak':float(np.max(np.abs(samples))), 'creativeApproval':'pending-normal-speed-listening-and-motion-review'}
        # Include the actual composition input; identity is a separate input.
        ref_asset=pkg['assets'][asset['gen']['inputs']['reference']]
        tiles=[('Composition',Image.open(root/'input'/ref_asset['file']).convert('RGB'))]
        for label,t in [('Start',.25),('Middle',duration/2),('End',duration-.25)]:
            frame=command('ffmpeg','-v','error','-threads','2','-ss',str(t),'-i',str(file),'-frames:v','1','-vf','scale=448:-1','-f','image2pipe','-vcodec','png','-')
            tiles.append((f'{label} {t:.2f}s',Image.open(io.BytesIO(frame)).convert('RGB')))
        sheet=Image.new('RGB',(1792,320),'#101820');draw=ImageDraw.Draw(sheet)
        draw.text((5,5),f"{scene['id']} | {row['expected']}",fill='white')
        for i,(label,image) in enumerate(tiles):
            image.thumbnail((448,252));sheet.paste(image,(448*i,30));draw.text((448*i+5,289),label,fill='white')
        sheet.save(out/f"{scene['id']}.jpg",quality=92)
        shots.append(row)
        (out/'audit.json').write_text(json.dumps({'shots':shots,'method':'decode, hash, probe, ASR and sampled frames; not creative approval'},indent=2))
        print(json.dumps({k:v for k,v in row.items() if k!='words'}),flush=True)


if __name__=='__main__':
    main()
