import subprocess, time, urllib.request, json, os
os.makedirs('/content/out',exist_ok=True)
log=open('/content/comfy.log','w')
p=subprocess.Popen(['python','main.py','--listen','127.0.0.1','--port','8188','--output-directory','/content/out'], cwd='/content/ComfyUI', stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
t=time.time(); ok=False
while time.time()-t<240:
    try: s=json.load(urllib.request.urlopen('http://127.0.0.1:8188/system_stats',timeout=3)); ok=True; break
    except Exception: time.sleep(2)
print("comfy ready" if ok else "comfy NOT ready", f"after {time.time()-t:.1f}s", flush=True)
if not ok: print(open('/content/comfy.log').read()[-3000:])
plog=open('/content/proxy.log','w')
q=subprocess.Popen(['comfy-api-proxy','--comfyui','http://127.0.0.1:8188','--port','8189'], stdout=plog, stderr=subprocess.STDOUT, start_new_session=True)
time.sleep(6); print("proxy alive", q.poll() is None); print(open('/content/proxy.log').read()[-600:])
