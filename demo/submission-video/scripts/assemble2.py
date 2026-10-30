import subprocess, json, os
A='/workspace/submission-demo/assets'; O='/workspace/submission-demo/out'; S=f'{O}/seg'
UI=f'{A}/ui-raw/SESSION_FULL.webm'; C=f'{A}/cards'
V='fps=30,format=yuv420p'
def ff(args):
    if os.path.exists(args[-1]) and not os.environ.get('REBUILD'): return
    subprocess.run(['nice','-n','10','ffmpeg','-v','error','-y',*args,'-an','-c:v','libx264','-preset','veryfast','-crf','20','-threads','2'],check=True)
BG='0x0a0a12'
def fixes(fx):
    # fx: list of ('box',x,y,w,h) paint page background, or ('move',sx,sy,w,h,dx,dy) reposition a real tile
    out=''
    for i,f in enumerate(fx):
        if f[0]=='box': out+=f',drawbox=x={f[1]}:y={f[2]}:w={f[3]}:h={f[4]}:color={BG}:t=fill'
    return out
def movechain(lbl,fx,tag):
    fl=[];cur=lbl
    for i,f in enumerate(fx):
        if f[0]=='move':
            _,sx,sy,w,h,dx,dy=f
            fl.append(f'{cur}split[m{tag}a{i}][m{tag}b{i}];[m{tag}b{i}]crop={w}:{h}:{sx}:{sy}[m{tag}c{i}];[m{tag}a{i}][m{tag}c{i}]overlay={dx}:{dy}[m{tag}d{i}]'); cur=f'[m{tag}d{i}]'
    return fl,cur
def ui(name, parts, cap=None, fx=()):
    # parts: list of (start, srcdur, speed)
    ins=[]; fl=[]
    for i,(st,d,sp) in enumerate(parts):
        ins+=['-ss',str(st),'-t',str(d),'-i',UI]
        mf,cur=movechain(f'[{i}:v]',fx,i); fl+=mf
        fl.append(f'{cur}crop=1600:900:0:0{fixes(fx)},scale=1920:1080,setpts=PTS/{sp}-STARTPTS,{V}[p{i}]')
    n=len(parts); fl.append(''.join(f'[p{i}]' for i in range(n))+f'concat=n={n}:v=1[c]')
    last='[c]'
    if cap: ins+=['-i',f'{C}/{cap}.png']; fl.append(f'[c][{n}:v]overlay=0:0[o]'); last='[o]'
    ff([*ins,'-filter_complex',';'.join(fl),'-map',last,f'{S}/{name}.mp4'])
OV='/workspace/submission-demo/assets/chat-overlay'
def ui2(name, parts, cap=None, tail=None, fx=None):
    ins=[]; fl=[]; k=0; labels=[]
    for pi,(st,d,sp,ovs) in enumerate(parts):
        ins+=['-ss',str(st),'-t',str(d),'-i',UI]; src=k; k+=1
        cur=f'[{src}:v]crop=1600:900:0:0{fixes(fx[pi] if fx else [])}[c{src}]'; fl.append(cur); last=f'[c{src}]'
        for j,(png,t0,t1,x,y) in enumerate(ovs):
            ins+=['-i',f'{OV}/{png}.png']; oi=k; k+=1
            fl.append(f"{last}[{oi}:v]overlay={x}:{y}:enable='between(t,{t0},{t1})'[o{oi}]"); last=f'[o{oi}]'
        fl.append(f'{last}scale=1920:1080,setpts=PTS/{sp}-STARTPTS,{V}[p{src}]'); labels.append(f'[p{src}]')
    if tail:
        ins+=['-i',tail]; ti=k; k+=1
        fl.append(f'[{ti}:v]scale=1920:1080,setpts=PTS/0.8,{V}[p{ti}]'); labels.append(f'[p{ti}]')
    fl.append(''.join(labels)+f'concat=n={len(labels)}:v=1[c]'); last='[c]'
    if cap: ins+=['-i',f'{C}/{cap}.png']; fl.append(f'[c][{k}:v]overlay=0:0[o]'); last='[o]'
    ff([*ins,'-filter_complex',';'.join(fl),'-map',last,f'{S}/{name}.mp4'])
def still(name, img, d):
    ff(['-loop','1','-framerate','30','-t',str(d),'-i',img,'-vf',f'scale=1920:1080,{V}',f'{S}/{name}.mp4'])
def film(name, src, st, d, cap=None):
    a=['-ss',str(st),'-t',str(d),'-i',src]; fl=f'[0:v]scale=1920:1080,{V}[c]'
    if cap: a+=['-i',f'{C}/{cap}.png']; fl+=f';[c][1:v]overlay=0:0[c2]'; m='[c2]'
    else: m='[c]'
    ff([*a,'-filter_complex',fl,'-map',m,f'{S}/{name}.mp4'])
def split(name):
    fb=f'{A}/film-before/FILM_BEFORE.mp4'; fa=f'{A}/film-after/FILM_AFTER.mp4'
    ff(['-i',f'{A}/film-after/shot4_take1_original.mp4','-i',f'{A}/film-after/shot4_take2_storm.mp4','-i',f'{C}/cap07.png','-filter_complex',
      f"[0:v]scale=960:540,setpts=PTS/0.8[l];[1:v]scale=960:540,setpts=PTS/0.8[r];color=c=0x0b0b10:s=1920x1080:d=8[bg];[bg][l]overlay=0:270[t];[t][r]overlay=960:270,drawtext=fontfile=/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz\\,wght.ttf:text='Before (take 1)':x=40:y=220:fontsize=40:fontcolor=white,drawtext=fontfile=/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz\\,wght.ttf:text='After chat edit (take 2)':x=1000:y=220:fontsize=40:fontcolor=white[s];[s][2:v]overlay=0:0,{V}[o]",
      '-map','[o]','-t','8',f'{S}/{name}.mp4'])
# timeline
segs=[]
def add(n,d,vo=None): segs.append((n,d,vo))
still('01_title',f'{C}/title.png',9); add('01_title',9,'vo01')
ui('02_prompt',[(2789,13,1)],'cap01'); add('02_prompt',13,'vo02')
ui('03_proposal',[(2991,12,1)],'cap02'); add('03_proposal',12,'vo03')
GAL=[('move',579,335,144,114,431,335),('box',577,333,745,118),('box',280,215,148,117)]
ui('04_gallery',[(3499,323,323/18)],'cap03',fx=GAL); add('04_gallery',18,'vo04')
ui('05_result',[(3908,6,1)],'cap04',fx=[('box',0,830,1600,70)]); add('05_result',6,'vo05')
FB=f'{A}/film-before/FILM_BEFORE.mp4'
FILMCUTS=[(0,6),(7.7,12),(12,13.7)]  # skip shot 2 opening (6.0-7.7s): a second Mira stands behind her
ff([*sum([['-ss',str(a),'-t',str(b-a),'-i',FB] for a,b in FILMCUTS],[]),'-filter_complex',''.join(f'[{i}:v]scale=1920:1080,setpts=PTS-STARTPTS,{V}[f{i}];' for i in range(3))+'[f0][f1][f2]concat=n=3:v=1[c]','-map','[c]',f'{S}/06_film.mp4']); add('06_film',12,None)
ui2('07_chat',[(4119,8,1,[('type1', 0.9, 1.52, 1181, 104), ('type2', 1.52, 2.15, 1181, 104), ('type3', 2.15, 2.77, 1181, 104), ('type4', 2.77, 3.4, 1181, 104), ('type5', 3.4, 4.03, 1181, 104), ('type6', 4.03, 4.65, 1181, 104), ('type7', 4.65, 5.28, 1181, 104), ('type8', 5.28, 5.9, 1181, 104), ('sent', 5.9, 9, 1181, 104)]),(4127,70,10,[('sent',0,64,1181,104),('reply',64,99,1181,104)])],'cap05',fx=[[('box',255,800,925,100)],[('box',255,800,925,100)]]); add('07_chat',15,'vo06')
ui2('08_regen',[(4408,244,40,[('reply',0,60,1181,104),('ready',60,999,1181,104)]),(4676,4,1,[])],'cap06',fx=[[('box',255,215,505,135)],[('box',975,355,370,250)]],tail=f'{A}/film-after/shot4_take2_storm.mp4'); add('08_regen',18,'vo07')
split('09_split'); add('09_split',8,'vo08')
still('10_end',f'{C}/end.png',6); add('10_end',6,'vo09')
with open(f'{S}/list.txt','w') as f:
    for n,_,_ in segs: f.write(f"file '{S}/{n}.mp4'\n")
subprocess.run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',f'{S}/list.txt','-c','copy',f'{S}/picture.mp4'],check=True)
# audio v3: VO + film audio only during the full-screen film (0:58-1:10); no music bed; loudnorm -16 LUFS
t=0; ins=[]; vo=[]; fx=[]; k=1; film_t=None
for n,d,v in segs:
    if v:
        ins+=['-i',f'{A}/vo/{v}.wav']; vo.append(f'[{k}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={int((t+0.4)*1000)}:all=1[v{k}]'); k+=1
    if n=='06_film': film_t=t
    if n=='09_split': split_t=t
    t+=d
ins+=['-i',f'{A}/film-before/FILM_BEFORE.mp4']; fi=k; k+=1

fl=vo[:]
fl.append(''.join('[v'+l.split('[v')[1] for l in vo)+f'amix=inputs={len(vo)}:normalize=0,apad,atrim=0:{t}[vob]')
fl.append('[vob]anull[vo1]')
fl.append(f"[{fi}:a]asplit=3[fa0][fa1][fa2];"+''.join(f'[fa{i}]atrim={a}:{b},asetpts=PTS-STARTPTS[fb{i}];' for i,(a,b) in enumerate(FILMCUTS))+"[fb0][fb1][fb2]concat=n=3:v=0:a=1,"+f"aresample=48000,afade=t=out:st=11:d=1,adelay={int(film_t*1000)}:all=1,apad,atrim=0:{t}[film]")
pass
pass
fl.append(f'[vo1][film]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[mix]')
subprocess.run(['nice','ffmpeg','-v','error','-y','-i',f'{S}/picture.mp4',*ins,'-filter_complex',';'.join(fl),'-map','0:v','-map','[mix]','-c:v','copy','-c:a','aac','-b:a','192k','-t',str(t),f'{O}/DEMO_DRAFT.mp4'],check=True)
json.dump([{'seg':n,'dur':d,'vo':vo} for n,d,vo in segs],open(f'{O}/edl.json','w'),indent=1)
print('total',t)
