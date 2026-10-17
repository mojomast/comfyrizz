# GPU test 2 setup: ComfyUI + parallel model downloads (paths fixed after gpu1) + comfy-api-proxy + pipeline deps.
# HF token read from /content/.hf/token (0600), never printed, deleted right after the downloads.
import subprocess, time, os, json, threading, glob
os.chmod('/content/.hf', 0o700); os.chmod('/content/.hf/token', 0o600)
def run(cmd, tag):
    t=time.time(); print("$", tag, flush=True)
    p=subprocess.run(cmd, shell=True, capture_output=True, text=True)
    dt=time.time()-t; print(f"-> {tag} exit {p.returncode} in {dt:.1f}s", (p.stdout+p.stderr)[-400:] if p.returncode else "", flush=True); return dt
T=time.time(); R={}
R['clone']=run("cd /content && rm -rf ComfyUI && git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI.git && cd ComfyUI && git log -1 --format='%h %cd'", "clone")
env=dict(os.environ); env['HF_TOKEN']=open('/content/.hf/token').read().strip(); env['HF_XET_HIGH_PERFORMANCE']='1'; env['HF_HUB_DISABLE_PROGRESS_BARS']='1'
subprocess.run("pip install -q 'huggingface_hub[hf_xet]>=1.0'", shell=True)
D='/content/hf'
jobs={'klein': ("black-forest-labs/flux-3-image-klein", ["model.safetensors","ae.safetensors","text_encoder/model-00001-of-00002.safetensors","text_encoder/model-00002-of-00002.safetensors"]),
      'ltx': ("Lightricks/LTX-2.5", ["diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors","text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors","vae/ltx-2.5-video-vae-bf16.safetensors","vae/ltx-2.5-audio-vae-bf16.safetensors","latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"])}
res={}
def dl(name):
    repo, files = jobs[name]; t=time.time()
    r=subprocess.run(["hf","download",repo,*files,"--local-dir",f"{D}/{name}"], env=env, capture_output=True, text=True)
    miss=[f for f in files if not os.path.isfile(f"{D}/{name}/{f}")]
    res[name]=dict(rc=r.returncode, secs=round(time.time()-t,1), missing=miss, bytes=sum(os.path.getsize(f"{D}/{name}/{f}") for f in files if f not in miss), err=r.stderr[-400:] if r.returncode else "")
t0=time.time()
ths=[threading.Thread(target=dl,args=(n,)) for n in jobs]
for th in ths: th.start()
# install requirements while downloading
R['reqs']=run("cd /content/ComfyUI && grep -viE '^(torch|torchvision|torchaudio)([<>=~ ]|$)' requirements.txt > /tmp/req.txt && pip install -q -r /tmp/req.txt safetensors comfy-api-proxy comfy-sdk jsonschema==4.25.1", "reqs+proxy+sdk")
while any(th.is_alive() for th in ths):
    time.sleep(10); print(f"  downloading... {time.time()-t0:.0f}s", flush=True)
dlt=time.time()-t0
del env['HF_TOKEN']; os.remove('/content/.hf/token'); print("token file removed:", not os.path.exists('/content/.hf/token'), flush=True)
tot=sum(r['bytes'] for r in res.values())
print("DOWNLOAD", json.dumps(res), f"total {tot/1e9:.2f} GB in {dlt:.1f}s = {tot/1e6/dlt:.0f} MB/s (parallel)", flush=True)
t=time.time()
from safetensors.torch import load_file, save_file
M='/content/ComfyUI/models'; sd={}
for f in sorted(glob.glob(f"{D}/klein/text_encoder/model-*.safetensors")): sd.update(load_file(f))
save_file(sd, f"{M}/text_encoders/qwen3vl_4b_bf16.safetensors"); del sd
R['merge']=time.time()-t; print(f"merged TE in {R['merge']:.1f}s", flush=True)
def ln(src,dst):
    os.makedirs(os.path.dirname(dst),exist_ok=True)
    if os.path.lexists(dst): os.remove(dst)
    os.symlink(src,dst)
ln(f"{D}/klein/model.safetensors", f"{M}/diffusion_models/flux-3-image-klein-bf16.safetensors")
ln(f"{D}/klein/ae.safetensors", f"{M}/vae/flux2-vae.safetensors")
for f in jobs['ltx'][1]: ln(f"{D}/ltx/{f}", f"{M}/{f}")
print(subprocess.run(f"ls -laL {M}/diffusion_models {M}/text_encoders {M}/vae {M}/latent_upscale_models | grep safetensors", shell=True, capture_output=True, text=True).stdout)
R['download']=dlt; R['total']=time.time()-T
json.dump(dict(R=R,res=res), open('/content/setup_times.json','w'))
print("TIMES", json.dumps({k: round(v,1) for k,v in R.items()}), flush=True)
