"""Build ComfyUI API jobs for Willem's video. Stage 'stills': Klein reference edit (1024x576 + one 1024x1024 portrait),
N seeds per scene. Stage 'i2v': LTX-2.5 two-stage i2v (1024x576, 97 frames) from chosen stills (--pick scene=seed ...)."""
import json, os, sys, argparse, copy
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.abspath(f"{HERE}/../..")
sys.path[:0] = [f"{REPO}/workflows", HERE]
from build_gpu1 import klein_ref, ltx
import prompts as P
REF = "willem_ref.png"

def ref_still(prompt, seed, w, h, prefix):
    wf = klein_ref(prompt, REF, seed, prefix=prefix)
    wf["6"] = {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}}
    wf["7"]["inputs"]["latent_image"] = ["6", 0]
    return wf

ap = argparse.ArgumentParser(); ap.add_argument("stage"); ap.add_argument("--seeds", default="11,12")
ap.add_argument("--only", default=""); ap.add_argument("--pick", nargs="*", default=[]); ap.add_argument("--out")
a = ap.parse_args(); jobs = []
only = set(a.only.split(",")) if a.only else None
if a.stage == "stills":
    for sid, body, *_ in P.SCENES:
        if only and sid not in only: continue
        for s in map(int, a.seeds.split(",")):
            n = f"w_{sid}_s{s}"
            jobs.append(dict(name=n, workflow=ref_still(body + P.STYLE, s, 1024, 576, n)))
        if sid == "portrait":
            s = int(a.seeds.split(",")[0]); n = f"w_portrait_sq_s{s}"
            jobs.append(dict(name=n, workflow=ref_still(body + P.STYLE.replace("wide 16:9 shot", "square portrait"), s, 1024, 1024, n)))
elif a.stage == "redo":
    for sid, body in P.REDO:
        for s in map(int, a.seeds.split(",")):
            n = f"w_{sid}_s{s}"
            jobs.append(dict(name=n, workflow=ref_still(body + P.STYLE, s, 1024, 576, n)))
else:
    motion = {sid: m for sid, _, m, *_ in P.SCENES}
    motion.update(soccer2=motion["soccer"], cake2=motion["cake"])
    if a.stage == "i2v_redo": motion.update(P.I2V_REDO)
    for k, pk in enumerate(a.pick):
        sid, seed = pk.split("=")
        n = f"v_{sid}" + ("_r" if a.stage == "i2v_redo" else ""); src = f"w_{sid}_s{seed}_"
        p = (f"Use the provided start image as the first frame. Pixar-style 3D animation. {motion[sid]} "
             "Gentle, smooth motion, static camera, the girl's face, hair and coral bow headband stay consistent. No cuts, no text.")
        wf = ltx(p, 700 + k + (50 if a.stage == "i2v_redo" else 0), 1024, 576, 97, image=f"src_{n}.png", prefix=n)
        wf["6"]["inputs"]["text"] = "text, watermark, logo, subtitles, flicker, distorted face, deformed hands, extra limbs, scary"
        jobs.append(dict(name=n, workflow=wf, mp4=True, timeout=1200, copy=[src, f"src_{n}.png"]))
        continue
        jobs.append(dict(name=n, workflow=ltx(p, 700 + k, 1024, 576, 97, image=f"src_{n}.png", prefix=n), mp4=True, timeout=1200, copy=[src, f"src_{n}.png"]))
os.makedirs(f"{HERE}/jobs", exist_ok=True)
out = a.out or f"{HERE}/jobs/{a.stage}.json"; json.dump(jobs, open(out, "w")); print(out, len(jobs))
