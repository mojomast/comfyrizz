# NOTE: fixed after gpu1 (LTX files live in subfolders; the first run fetched nothing for LTX and g1_dl_ltx.py was used).
# Install ComfyUI + download model files with timing. Token read from a 0600 file, never printed.
import subprocess, time, os, json, threading, shutil, glob
os.chmod('/content/.hf', 0o700); os.chmod('/content/.hf/token', 0o600)
def run(cmd, env=None, tag=""):
    t=time.time(); print("$", tag or cmd[:120], flush=True)
    p=subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    n=0
    for line in p.stdout:
        n+=1
        if n%40==0 or 'rror' in line: print("  ", line.rstrip()[:200], flush=True)
    p.wait(); dt=time.time()-t
    print(f"-> {tag} exit {p.returncode} in {dt:.1f}s", flush=True); return dt, p.returncode
T=time.time(); R={}
R['clone'],_=run("cd /content && rm -rf ComfyUI && git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI.git && cd ComfyUI && git log -1 --format='%h %cd'", tag="clone")
R['reqs'],_=run("cd /content/ComfyUI && grep -viE '^(torch|torchvision|torchaudio)([<>=~ ]|$)' requirements.txt > /tmp/req.txt && pip install -q -r /tmp/req.txt 'huggingface_hub[hf_xet]>=1.0' safetensors", tag="reqs")
print(subprocess.run("nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader; df -h /content | tail -1; python -c 'import torch;print(torch.__version__, torch.version.cuda)'; pip show huggingface_hub hf_xet 2>/dev/null | grep -E '^(Name|Version)'", shell=True, capture_output=True, text=True).stdout, flush=True)
env=dict(os.environ); env['HF_TOKEN']=open('/content/.hf/token').read().strip(); env['HF_XET_HIGH_PERFORMANCE']='1'; env['HF_HUB_DISABLE_PROGRESS_BARS']='1'
D='/content/hf'
jobs={
 'klein': ("black-forest-labs/flux-3-image-klein", ["model.safetensors","ae.safetensors","text_encoder/model-00001-of-00002.safetensors","text_encoder/model-00002-of-00002.safetensors"]),
 'ltx': ("Lightricks/LTX-2.5", ["diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors","text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors","vae/ltx-2.5-video-vae-bf16.safetensors","vae/ltx-2.5-audio-vae-bf16.safetensors","latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"]),
}
def du(p): 
    return sum(os.path.getsize(f) for f in glob.glob(p+'/**', recursive=True) if os.path.isfile(f) and not os.path.islink(f))
res={}
def dl(name):
    repo, files = jobs[name]; t=time.time()
    r=subprocess.run(["hf","download",repo,*files,"--local-dir",f"{D}/{name}"], env=env, capture_output=True, text=True)
    res[name]=dict(rc=r.returncode, secs=round(time.time()-t,1), err=r.stderr[-600:] if r.returncode else "")
stop=False
def mon():
    last=0; lt=time.time()
    while not stop:
        time.sleep(10); b=du(D); now=time.time()
        print(f"  dl {b/1e9:.2f} GB  {(b-last)/1e6/(now-lt):.0f} MB/s", flush=True); last, lt = b, now
t0=time.time()
ths=[threading.Thread(target=dl,args=(n,)) for n in jobs]
m=threading.Thread(target=mon,daemon=True); m.start()
for th in ths: th.start()
for th in ths: th.join()
stop=True; dlt=time.time()-t0
del env['HF_TOKEN']
os.remove('/content/.hf/token'); print("token file removed:", not os.path.exists('/content/.hf/token'), flush=True)
sizes={n: du(f"{D}/{n}") for n in jobs}
print("DOWNLOAD", json.dumps(res), "sizes_GB", {k: round(v/1e9,2) for k,v in sizes.items()}, f"total {sum(sizes.values())/1e9:.2f} GB in {dlt:.1f}s = {sum(sizes.values())/1e6/dlt:.0f} MB/s", flush=True)
# merge Klein text encoder shards into one file
t=time.time()
from safetensors.torch import load_file, save_file
M='/content/ComfyUI/models'
sd={}
for f in sorted(glob.glob(f"{D}/klein/text_encoder/model-*.safetensors")): sd.update(load_file(f))
save_file(sd, f"{M}/text_encoders/qwen3vl_4b_bf16.safetensors"); n=len(sd); del sd
R['merge']=time.time()-t; print(f"merged TE {n} tensors in {R['merge']:.1f}s", flush=True)
for f in glob.glob(f"{D}/klein/text_encoder/model-*.safetensors"): os.remove(f)
def ln(src,dst):
    os.makedirs(os.path.dirname(dst),exist_ok=True)
    if os.path.lexists(dst): os.remove(dst)
    os.symlink(src,dst)
ln(f"{D}/klein/model.safetensors", f"{M}/diffusion_models/flux-3-image-klein-bf16.safetensors")
ln(f"{D}/klein/ae.safetensors", f"{M}/vae/flux2-vae.safetensors")
L=f"{D}/ltx"
ln(f"{L}/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", f"{M}/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors")
ln(f"{L}/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", f"{M}/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors")
ln(f"{L}/vae/ltx-2.5-video-vae-bf16.safetensors", f"{M}/vae/ltx-2.5-video-vae-bf16.safetensors")
ln(f"{L}/vae/ltx-2.5-audio-vae-bf16.safetensors", f"{M}/vae/ltx-2.5-audio-vae-bf16.safetensors")
ln(f"{L}/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", f"{M}/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors")
print(subprocess.run(f"ls -laL {M}/diffusion_models {M}/text_encoders {M}/vae {M}/latent_upscale_models | grep safetensors", shell=True, capture_output=True, text=True).stdout)
R['download']=dlt; R['total']=time.time()-T
json.dump(dict(R=R,res=res,sizes=sizes), open('/content/setup_times.json','w'))
print("TIMES", json.dumps({k: round(v,1) for k,v in R.items()}), flush=True)
