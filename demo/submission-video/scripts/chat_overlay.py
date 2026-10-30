# Redraws the "Ask for changes" panel body (x>=1181, y>=104) so the chat asks for the change take 2 really shows.
from PIL import Image, ImageDraw, ImageFont
F='/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf'
def fnt(s,w=400):
    f=ImageFont.truetype(F,s); f.set_variation_by_axes([14,w]); return f
OUT='/workspace/submission-demo/assets/chat-overlay'
X0,Y0,W,H=1181,104,419,796
BG=(13,18,26); TXT=(225,228,235); DIM=(150,156,170); CARD=(19,23,36); BORDER=(52,58,78); PURPLE=(124,58,237)
REQ="Give the last shot more life: let Mira send the paper boat far out to sea until it's a tiny light on the horizon, then have her turn toward us."
REPLY="I've proposed a correction for shot 4 (balcony, paper boat): the boat drifts much farther out until it's a small light on the horizon, and Mira turns toward the camera at the end. It uses a new seed. Ready for your confirmation."
CARDT="Regenerate shot4:a_vid_5e04fad6c511d306"; CARDD="Boat drifts far out to a tiny light; Mira turns toward camera"
f=fnt(13); fb=fnt(13,650); fs=fnt(12); fh=fnt(13,650)
def wrap(d,t,font,w):
    out=[];line=''
    for word in t.split():
        tt=(line+' '+word).strip()
        if d.textlength(tt,font=font)>w: out.append(line); line=word
        else: line=tt
    if line: out.append(line)
    return out
def panel(name, typed=None, user=False, reply=False, card=None):
    im=Image.new('RGBA',(W,H),BG+(255,)); d=ImageDraw.Draw(im); y=24
    if user:
        for ln in wrap(d,REQ,f,330): d.text((W-12-d.textlength(ln,font=f),y),ln,font=f,fill=TXT); y+=18
        y+=14
    if reply:
        for ln in wrap(d,REPLY,f,390): d.text((16,y),ln,font=f,fill=TXT); y+=18
        y+=14
    if card:
        d.text((16,y),'Clip changes and generations',font=fh,fill=TXT); y+=28
        d.rounded_rectangle((16,y,W-14,y+132),10,fill=CARD,outline=BORDER)
        d.text((30,y+14),CARDT,font=fb,fill=TXT)
        for i,ln in enumerate(wrap(d,CARDD,fs,350)): d.text((30,y+40+i*18),ln,font=fs,fill=DIM)
        d.text((30,y+84),card,font=fnt(12,650),fill=TXT)
        lbl='Prepare generation' if card=='proposed' else 'Review & edit full plan'
        bw=d.textlength(lbl,font=fnt(13,600))+28; d.rounded_rectangle((30,y+96-4,30+bw,y+120),6,fill=PURPLE); d.text((44,y+98),lbl,font=fnt(13,600),fill=(255,255,255))
    # message box
    my=H-140; d.text((16,my),'Message',font=fh,fill=TXT)
    d.rounded_rectangle((16,my+24,W-14,my+92),8,fill=(10,10,18),outline=(124,58,237) if typed is not None else BORDER,width=2)
    if typed:
        for i,ln in enumerate(wrap(d,typed,fs,370)[-3:]): d.text((26,my+32+i*18),ln,font=fs,fill=TXT)
    d.rounded_rectangle((16,my+102,W-14,my+132),8,fill=(124,58,237) if typed else (159,173,253))
    d.text(((W-d.textlength('Send',font=fnt(14,600)))/2,my+108),'Send',font=fnt(14,600),fill=(255,255,255))
    im.save(f'{OUT}/{name}.png')
n=8
for i in range(1,n+1): panel(f'type{i}', typed=REQ[:int(len(REQ)*i/n)])
panel('sent', user=True); panel('reply', user=True, reply=True, card='proposed'); panel('ready', user=True, reply=True, card='plan ready')
banner=Image.new('RGBA',(1600,72),(11,12,16,255)); banner.save(f'{OUT}/banner_cover.png')
