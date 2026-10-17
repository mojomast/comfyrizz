import subprocess, time, os, json, threading, glob
os.chmod('/content/.hf/token', 0o600)
env=dict(os.environ); env['HF_TOKEN']=open('/content/.hf/token').read().strip(); env['HF_XET_HIGH_PERFORMANCE']='1'; env['HF_HUB_DISABLE_PROGRESS_BARS']='1'
L='/content/hf/ltx'; M='/content/ComfyUI/models'
files=["diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors","text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
 "vae/ltx-2.5-video-vae-bf16.safetensors","vae/ltx-2.5-audio-vae-bf16.safetensors","latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"]
def du(p): return sum(os.path.getsize(f) for f in glob.glob(p+'/**', recursive=True) if os.path.isfile(f) and not os.path.islink(f))
stop=False
def mon():
    last=0; lt=time.time()
    while not stop:
        time.sleep(10); b=du(L); now=time.time(); print(f"  dl {b/1e9:.2f} GB  {(b-last)/1e6/(now-lt):.0f} MB/s", flush=True); last,lt=b,now
threading.Thread(target=mon,daemon=True).start()
t=time.time(); r=subprocess.run(["hf","download","Lightricks/LTX-2.5",*files,"--local-dir",L], env=env, capture_output=True, text=True); dt=time.time()-t; stop=True
del env['HF_TOKEN']; os.remove('/content/.hf/token'); print("token file removed:", not os.path.exists('/content/.hf/token'))
print("rc", r.returncode, r.stderr[-800:] if r.returncode else "")
missing=[f for f in files if not os.path.isfile(f"{L}/{f}")]
b=du(L); print(f"LTX DOWNLOAD {b/1e9:.2f} GB in {dt:.1f}s = {b/1e6/dt:.0f} MB/s; missing={missing}")
for f in files:
    dst=f"{M}/{f}"
    if os.path.lexists(dst): os.remove(dst)
    os.makedirs(os.path.dirname(dst),exist_ok=True); os.symlink(f"{L}/{f}", dst)
print(subprocess.run(f"ls -laL {M}/diffusion_models {M}/text_encoders {M}/vae {M}/latent_upscale_models | grep safetensors", shell=True, capture_output=True, text=True).stdout)
j=json.load(open('/content/setup_times.json')); j['ltx']=dict(secs=dt, bytes=b); json.dump(j, open('/content/setup_times.json','w'))
