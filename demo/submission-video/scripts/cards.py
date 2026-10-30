from PIL import Image, ImageDraw, ImageFont, ImageFilter
import sys
F='/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf'
def font(sz, w=700):
    f=ImageFont.truetype(F, sz)
    try: f.set_variation_by_axes([14 if sz<40 else 32, w])
    except Exception: pass
    return f
W,H=1920,1080
logo=Image.open('/workspace/submission-demo/assets/brand/comfyrizz-logo-dark-1024.png').convert('RGBA')
sym=Image.open('/workspace/submission-demo/assets/brand/comfyrizz-symbol-512.png').convert('RGBA')
def bg(hero=None):
    if hero:
        im=Image.open(hero).convert('RGB').resize((W,H)).filter(ImageFilter.GaussianBlur(18))
        im=Image.blend(im, Image.new('RGB',(W,H),(10,10,16)), 0.62)
    else: im=Image.new('RGB',(W,H),(11,11,16))
    return im
def center(d,y,t,f,fill):
    w=d.textlength(t,font=f); d.text(((W-w)/2,y),t,font=f,fill=fill)
def title(out, hero):
    im=bg(hero); s=sym.resize((180,180)); im.paste(s,((W-180)//2,250),s); d=ImageDraw.Draw(im)
    center(d,470,'Comfyrizz',font(120,800),(245,245,250))
    center(d,620,'One sentence → a finished film. Change it by chatting.',font(44,500),(200,200,215))
    center(d,700,'Super Easy mode · ComfyUI · open-weights FLUX 3 Image Klein + LTX-2.5',font(30,500),(150,140,255))
    im.save(out)
def end(out, hero):
    im=bg(hero); s=sym.resize((140,140)); im.paste(s,((W-140)//2,230),s); d=ImageDraw.Draw(im)
    center(d,410,'Imagine it. Make it.',font(96,800),(245,245,250))
    center(d,545,'Built with ComfyUI · FLUX 3 Image Klein · LTX-2.5 · open weights',font(36,500),(200,200,215))
    center(d,605,'Generated live on Google Colab GPUs',font(32,500),(150,140,255))
    center(d,700,'github.com/mojomast/comfyrizz',font(34,600),(230,230,240))
    im.save(out)
def lower(out, text, sub=''):
    im=Image.new('RGBA',(W,H),(0,0,0,0)); d=ImageDraw.Draw(im)
    f=font(46,700); fs=font(28,500); tw=max(d.textlength(text,font=f), d.textlength(sub,font=fs) if sub else 0)
    x,y=90,H-200; d.rounded_rectangle((x-30,y-24,x+tw+30,y+(110 if sub else 70)),18,fill=(14,12,28,215),outline=(130,110,255,255),width=3)
    d.text((x,y),text,font=f,fill=(250,250,255,255))
    if sub: d.text((x,y+62),sub,font=fs,fill=(185,175,255,255))
    im.save(out)
if __name__=='__main__':
    hero=sys.argv[1]
    title('title.png',hero); end('end.png',hero)
    caps=[('cap01','Super Easy: one sentence','Pick a length and the LTX motion route'),
          ('cap02','Review the plan before any GPU spend','Title · look · 4 shots · soundtrack · credit cap'),
          ('cap03','Live on ComfyUI · Google Colab','FLUX 3 Image Klein keyframes → LTX-2.5 motion'),
          ('cap04','Finished film, ready to download','24 s · 1080p · scored'),
          ('cap05','Change it by chatting','“Send the boat far out to sea, have Mira turn to us”'),
          ('cap06','Only shot 4 is re-shot','Same project · new LTX take on Google Colab'),
          ('cap07','Before → After','Shot 4: the boat sails to the horizon, Mira turns to us')]
    for n,t,s in caps: lower(n+'.png',t,s)
