# Kokoro v1.0 (open weights, local CPU), voice af_heart; sentence-level synthesis with natural pauses.
import json, wave, re, numpy as np
from kokoro_onnx import Kokoro
k=Kokoro('/home/box/.cache/comfyrizz/kokoro/kokoro-v1.0.onnx','/home/box/.cache/comfyrizz/kokoro/voices-v1.0.bin')
L=[("vo01","Hey! This is Comfyrizz. You type one sentence, and it makes you a real film, with open models running in ComfyUI."),
("vo02","Here's Super Easy mode. I'm describing Mira, a young lighthouse keeper in a yellow raincoat. I'll pick twenty-four seconds, choose the L T X motion route... and that's it."),
("vo03","First, the agent pitches the film: a title, the look, four shots, and the music. Nothing touches a GPU until I say yes."),
("vo04","So I hit Make this film. ComfyUI spins up on Google Colab. Flux Klein paints the keyframes, L T X animates every shot, and you can watch the real results land."),
("vo05","About fifteen minutes later, it's done. Scored, rendered, and ready to download."),
("vo06","Now let's change something, just by chatting. I'd like a bigger ending: send the paper boat way out to sea, and have Mira turn toward us."),
("vo07","The agent turns that into a fix for shot four, and shows me the cost. I approve, and Google Colab re-shoots just that one shot. The other three stay exactly as they were."),
("vo08","Before... and after. The boat sails off toward the horizon, and Mira looks back at us."),
("vo09","That's Comfyrizz. Imagine it... make it.")]
meta=[]
for n,t in L:
    parts=re.split(r'(?<=[.!?])\s+|(?<=\.\.\.)\s*',t); parts=[p for p in parts if p.strip()]
    chunks=[]; sr=24000
    for p in parts:
        a,sr=k.create(p.replace('...',','),voice='af_heart',speed=0.96,lang='en-us')
        chunks.append(a); chunks.append(np.zeros(int(sr*(0.45 if p.endswith('...') else 0.28)),dtype=a.dtype))
    a=np.concatenate(chunks[:-1])
    w=wave.open(f'/workspace/submission-demo/assets/vo/{n}.wav','wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((np.clip(a,-1,1)*32767).astype(np.int16).tobytes()); w.close()
    meta.append((n,round(len(a)/sr,2),t)); print(n,round(len(a)/sr,2))
json.dump(meta,open('/workspace/submission-demo/assets/vo/durations.json','w'),indent=1)
