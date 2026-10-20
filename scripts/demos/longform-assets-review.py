"""Contact sheets and three temporal samples of every generated long-form plate."""
import argparse
import json
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageDraw, ImageFont

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',type=Path,required=True)
args=parser.parse_args()
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',14)
report=[]
for directory in sorted((args.root/'packages').iterdir()):
    pkg=json.loads((directory/'package.json').read_text())
    key=pkg['id'].removeprefix('pkg_long_').removesuffix('20261020')
    out=args.root/'asset-review'/key
    out.mkdir(parents=True,exist_ok=True)
    used={s.get('background',{}).get('asset') for s in pkg['scenes']}
    plates=[(k,a) for k,a in pkg['assets'].items() if a.get('gen',{}).get('generator')=='ltx25' and k in used]
    sheet=Image.new('RGB',(1440,((len(plates)+2)//3)*300),'#101922')
    draw=ImageDraw.Draw(sheet)
    temporal=[]
    for index,(name,asset) in enumerate(plates):
        video=directory/asset['file']
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(video)]))
        duration=float(probe['format']['duration'])
        times=[.15,duration*.5,duration-.2]
        strip=Image.new('RGB',(1440,300),'#101922');sd=ImageDraw.Draw(strip)
        arrays=[]
        for column,seconds in enumerate(times):
            raw=subprocess.check_output(['ffmpeg','-v','error','-ss',str(seconds),'-i',str(video),'-frames:v','1','-vf','scale=480:270','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])
            im=Image.frombytes('RGB',(480,270),raw);arrays.append(np.array(im).astype(float))
            strip.paste(im,(column*480,0));sd.text((column*480+8,275),f'{name} / {seconds:.2f}s',font=font,fill='white')
            if column==1:sheet.paste(im,(index%3*480,index//3*300))
        scene=next(s for s in pkg['scenes'] if s.get('background',{}).get('asset')==name)
        draw.text((index%3*480+8,index//3*300+275),f"{scene['id']} / {scene['copy']['headline'][:43]}",font=font,fill='white')
        strip.save(out/f'{name}.jpg',quality=92)
        temporal.append(strip)
        report.append({'film':key,'asset':name,'seconds':duration,'changes':[float(abs(a-b).mean()) for a,b in zip(arrays,arrays[1:])]})
    sheet.save(out/'contact-sheet.jpg',quality=93)
    for group in range((len(temporal)+3)//4):
        collage=Image.new('RGB',(1440,1200),'#101922')
        for row,im in enumerate(temporal[group*4:group*4+4]):collage.paste(im,(0,row*300))
        collage.save(out/f'temporal-{group+1}.jpg',quality=92)
    print(json.dumps({'film':key,'plates':len(plates),'directory':str(out)}),flush=True)
(args.root/'asset-review'/'metrics.json').write_text(json.dumps(report,indent=2)+'\n')
