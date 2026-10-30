import json, wave, numpy as np
from kokoro_onnx import Kokoro
k=Kokoro('/home/box/.cache/comfyrizz/kokoro/kokoro-v1.0.onnx','/home/box/.cache/comfyrizz/kokoro/voices-v1.0.bin')
L=[("vo01","Comfyrizz turns one sentence into a finished film, running ComfyUI with open-weights models."),
("vo02","This is Super Easy mode. I describe Mira, a young lighthouse keeper in a yellow raincoat, pick twenty-four seconds, and choose the L T X motion route. That's the whole setup."),
("vo03","The agent writes a short creative proposal: a title, a look, four shots, a soundtrack, and a credit cap. Nothing runs on a GPU until I approve it."),
("vo04","I click Make this film. Comfyrizz starts ComfyUI on Google Colab. FLUX 3 Image Klein paints the keyframes, L T X brings each shot to life, and the gallery fills in as real outputs arrive."),
("vo05","About fifteen minutes and about two Google Colab credits later, the film is finished, scored, and ready to download."),
("vo06","Now the fun part. I just tell it what to change: make it a stormy night, and give Mira a red raincoat."),
("vo07","The agent turns that into clip corrections and shows me the cost. I approve, and Google Colab regenerates the shot as a new take, without starting over."),
("vo08","Same project, a fresh take, from one sentence."),
("vo09","Comfyrizz. Imagine it. Make it.")]
meta=[]
for n,t in L:
    s,sr=k.create(t,voice='am_michael',speed=1.0,lang='en-us')
    w=wave.open(f"/workspace/submission-demo/assets/vo/{n}.wav","wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((np.clip(s,-1,1)*32767).astype(np.int16).tobytes()); w.close(); meta.append((n,len(s)/sr,t)); print(n,round(len(s)/sr,2))
json.dump(meta,open('/workspace/submission-demo/assets/vo/durations.json','w'),indent=1)
