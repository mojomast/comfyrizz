# GPU test 2 copy of g1_run.py (+ per-job 'copy' of a prior output into ComfyUI/input).
# Usage on VM: sys.argv=[_, jobs.json]; runs ComfyUI API jobs sequentially, records wall time + peak nvidia-smi VRAM.
import sys, json, time, uuid, urllib.request, subprocess, threading, os, glob, shutil
U='http://127.0.0.1:8188'; OUT='/content/out'
def post(path, obj):
    r=urllib.request.Request(U+path, data=json.dumps(obj).encode(), headers={'Content-Type':'application/json'})
    try: return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e: return {'http_error': e.code, 'body': e.read().decode()[:3000]}
def get(path): return json.load(urllib.request.urlopen(U+path))
def smi():
    return int(subprocess.run("nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits", shell=True, capture_output=True, text=True).stdout.split()[0])
class Peak:
    def __init__(s): s.peak=smi(); s.start=s.peak; s.run=True; s.t=threading.Thread(target=s.loop,daemon=True); s.t.start()
    def loop(s):
        while s.run:
            try: s.peak=max(s.peak, smi())
            except Exception: pass
            time.sleep(0.25)
    def stop(s): s.run=False; s.t.join(); return s.peak
jobs=json.load(open(sys.argv[1])); results=[]
rp=f'{OUT}/results.json'; allres=json.load(open(rp)) if os.path.exists(rp) else []
for job in jobs:
    name=job['name']; logpos=os.path.getsize('/content/comfy.log')
    if job.get('copy'):
        cands=sorted(glob.glob(f"{OUT}/{job['copy'][0]}*.png"))
        if not cands: print("COPY MISSING", job['copy'], flush=True); results.append(dict(name=name, ok=False, error='missing source '+job['copy'][0])); continue
        shutil.copy(cands[-1], f"/content/ComfyUI/input/{job['copy'][1]}")
    pk=Peak(); t=time.time()
    r=post('/prompt', {'prompt': job['workflow'], 'client_id': 'gpu1'})
    if 'prompt_id' not in r:
        pk.stop(); print("SUBMIT FAIL", name, json.dumps(r)[:2500], flush=True)
        results.append(dict(name=name, ok=False, error=json.dumps(r)[:2500])); continue
    pid=r['prompt_id']; h=None; last=time.time()
    while True:
        time.sleep(0.5)
        hh=get(f'/history/{pid}')
        if pid in hh and hh[pid].get('status',{}).get('completed') is not None and (hh[pid]['status'].get('completed') or hh[pid]['status'].get('status_str')=='error'):
            h=hh[pid]; break
        if time.time()-last>15: print(f"  ... {name} {time.time()-t:.0f}s vram_peak {pk.peak} MiB", flush=True); last=time.time()
        if time.time()-t>job.get('timeout',900): print("TIMEOUT", name, flush=True); break
    wall=time.time()-t; peak=pk.stop(); idle=smi()
    log=open('/content/comfy.log').read()[logpos:]
    loadlines=[l for l in log.splitlines() if any(k in l for k in ('Requested to load','loaded completely','loaded partially','Unload','unload','Prompt executed','model weight dtype','model_type','Error','error'))]
    status=h['status'] if h else {}
    ok=bool(h) and status.get('status_str')=='success'
    files=[]
    if h:
        for nid,o in h.get('outputs',{}).items():
            for im in o.get('images',[]): files.append(os.path.join(OUT, im.get('subfolder',''), im['filename']))
    files.sort()
    if ok and job.get('mp4') and files:
        mp4=f"{OUT}/{name}.mp4"; lst=f"/tmp/{name}.txt"
        open(lst,'w').write(''.join(f"file '{f}'\nduration {1/24:.6f}\n" for f in files))
        subprocess.run(f"ffmpeg -y -loglevel error -r 24 -f concat -safe 0 -i {lst} -r 24 -c:v libx264 -crf 16 -pix_fmt yuv420p {mp4}", shell=True)
        os.makedirs(f"{OUT}/frames_{name}", exist_ok=True)
        shutil.copy(files[0], f"{OUT}/frames_{name}/first.png"); shutil.copy(files[-1], f"{OUT}/frames_{name}/last.png")
        for f in files: os.remove(f)
        files=[mp4, f"{OUT}/frames_{name}/first.png", f"{OUT}/frames_{name}/last.png"]
    msgs=[m for m in status.get('messages',[]) if m[0] in ('execution_error',)]
    times=[m[1].get('timestamp') for m in status.get('messages',[]) if m[0] in ('execution_start','execution_success','execution_error')]
    exec_s=(times[-1]-times[0])/1000 if len(times)>=2 and all(times) else None
    res=dict(name=name, ok=ok, wall_s=round(wall,1), exec_s=exec_s, vram_before_mib=pk.start, vram_peak_mib=peak, vram_after_mib=idle, files=files, load_log=loadlines[-25:], error=json.dumps(msgs)[:2500] if msgs else "")
    results.append(res)
    print("RESULT", json.dumps({k:v for k,v in res.items() if k!='load_log'}), flush=True)
    for l in loadlines[-12:]: print("   log:", l[:220], flush=True)
    if not ok: print(log[-2500:], flush=True)
allres+=results; json.dump(allres, open(rp,'w'), indent=1)
print("DONE", sum(r['ok'] for r in results), "/", len(results), flush=True)
