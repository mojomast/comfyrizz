import subprocess, json, os
A='/workspace/submission-demo/assets'; O='/workspace/submission-demo/out'; S=f'{O}/seg'
UI=f'{A}/ui-raw/SESSION_FULL.webm'; C=f'{A}/cards'
V='fps=30,format=yuv420p'
def ff(args):
    if os.path.exists(args[-1]) and not os.environ.get('REBUILD'): return
    subprocess.run(['nice','-n','10','ffmpeg','-v','error','-y',*args,'-an','-c:v','libx264','-preset','veryfast','-crf','20','-threads','2'],check=True)
def ui(name, parts, cap=None):
    # parts: list of (start, srcdur, speed)
    ins=[]; fl=[]
    for i,(st,d,sp) in enumerate(parts):
        ins+=['-ss',str(st),'-t',str(d),'-i',UI]
        fl.append(f'[{i}:v]crop=1600:900:0:0,scale=1920:1080,setpts=PTS/{sp}-STARTPTS,{V}[p{i}]')
    n=len(parts); fl.append(''.join(f'[p{i}]' for i in range(n))+f'concat=n={n}:v=1[c]')
    last='[c]'
    if cap: ins+=['-i',f'{C}/{cap}.png']; fl.append(f'[c][{n}:v]overlay=0:0[o]'); last='[o]'
    ff([*ins,'-filter_complex',';'.join(fl),'-map',last,f'{S}/{name}.mp4'])
def still(name, img, d):
    ff(['-i',img,'-vf',f"scale=1920:1080,zoompan=z='1+0.0006*on':d={int(d*30)}:s=1920x1080:fps=30,{V}",f'{S}/{name}.mp4'])
def film(name, src, st, d, cap=None):
    a=['-ss',str(st),'-t',str(d),'-i',src]; fl=f'[0:v]scale=1920:1080,{V}[c]'
    if cap: a+=['-i',f'{C}/{cap}.png']; fl+=f';[c][1:v]overlay=0:0[c2]'; m='[c2]'
    else: m='[c]'
    ff([*a,'-filter_complex',fl,'-map',m,f'{S}/{name}.mp4'])
def split(name):
    fb=f'{A}/film-before/FILM_BEFORE.mp4'; fa=f'{A}/film-after/FILM_AFTER.mp4'
    ff(['-ss','18','-t','6','-i',fb,'-ss','18','-t','6','-i',fa,'-i',f'{C}/cap07.png','-filter_complex',
      f"[0:v]scale=960:540[l];[1:v]scale=960:540[r];color=c=0x0b0b10:s=1920x1080:d=6[bg];[bg][l]overlay=0:270[t];[t][r]overlay=960:270,drawtext=fontfile=/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz\\,wght.ttf:text='Take 1':x=40:y=220:fontsize=40:fontcolor=white,drawtext=fontfile=/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz\\,wght.ttf:text='Take 2 (chat edit)':x=1000:y=220:fontsize=40:fontcolor=white[s];[s][2:v]overlay=0:0,{V}[o]",
      '-map','[o]','-t','6',f'{S}/{name}.mp4'])
# timeline
segs=[]
def add(n,d,vo=None): segs.append((n,d,vo))
still('01_title',f'{C}/title.png',7); add('01_title',7,'vo01')
ui('02_prompt',[(2789,13,1)],'cap01'); add('02_prompt',13,'vo02')
ui('03_proposal',[(2991,12,1)],'cap02'); add('03_proposal',12,'vo03')
ui('04_gallery',[(3003,4,1),(3010,812,812/14)],'cap03'); add('04_gallery',18,'vo04')
ui('05_result',[(3908,6,1)],'cap04'); add('05_result',6,'vo05')
film('06_film',f'{A}/film-before/FILM_BEFORE.mp4',0,12); add('06_film',12,None)
ui('07_chat',[(4119,8,1),(4127,70,10)],'cap05'); add('07_chat',15,'vo06')
ui('08_regen',[(4408,252,28),(4927,342,38)],'cap06'); add('08_regen',18,'vo07')
split('09_split'); add('09_split',6,'vo08')
still('10_end',f'{C}/end.png',6); add('10_end',6,'vo09')
with open(f'{S}/list.txt','w') as f:
    for n,_,_ in segs: f.write(f"file '{S}/{n}.mp4'\n")
subprocess.run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',f'{S}/list.txt','-c','copy',f'{S}/picture.mp4'],check=True)
# audio: VO at segment start+0.4s, film audio under 06_film and 09_split
t=0; ins=[]; fl=[]; k=1
for n,d,vo in segs:
    if vo:
        ins+=['-i',f'{A}/vo/{vo}.wav']; fl.append(f'[{k}:a]aresample=48000,adelay={int((t+0.4)*1000)}:all=1[a{k}]'); k+=1
    if n=='06_film':
        ins+=['-ss','0','-t','12','-i',f'{A}/film-before/FILM_BEFORE.mp4']; fl.append(f'[{k}:a]aresample=48000,volume=0.9,afade=t=out:st=11:d=1,adelay={int(t*1000)}:all=1[a{k}]'); k+=1
    if n=='09_split':
        ins+=['-ss','18','-t','6','-i',f'{A}/film-after/FILM_AFTER.mp4']; fl.append(f'[{k}:a]aresample=48000,volume=0.35,adelay={int(t*1000)}:all=1[a{k}]'); k+=1
    t+=d
fl.append(''.join(f'[a{i}]' for i in range(1,k))+f'amix=inputs={k-1}:normalize=0,apad,atrim=0:{t}[mix]')
subprocess.run(['nice','ffmpeg','-v','error','-y','-i',f'{S}/picture.mp4',*ins,'-filter_complex',';'.join(fl),'-map','0:v','-map','[mix]','-c:v','copy','-c:a','aac','-b:a','192k','-shortest',f'{O}/DEMO_DRAFT.mp4'],check=True)
json.dump([{'seg':n,'dur':d,'vo':vo} for n,d,vo in segs],open(f'{O}/edl.json','w'),indent=1)
print('total',t)
