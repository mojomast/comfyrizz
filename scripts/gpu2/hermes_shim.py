# Retry Hermes's runner with ONE monkeypatch (in this wrapper only, his code untouched):
# metadata is dropped (None): the real comfy-api-proxy rejects the dict the SDK sends, and the SDK rejects a string.
import sys, os, json, runpy, subprocess, time
W='/content/comfyrizz/work'; sys.path.insert(0, f'{W}/pipeline-py'); os.chdir(W)
from comfyrizz_pipeline import client as C
orig=C.ComfyClient.submit
def submit(self, *a, metadata=None, **k):
    return orig(self, *a, metadata=None, **k)
C.ComfyClient.submit=submit
sys.argv=["runner","--jobs",f"{W}/jobs.json","--out","/content/comfyrizz/out3","--progress-log","/content/comfyrizz/out3/progress.jsonl","--base-url","http://127.0.0.1:8189"]
t=time.time()
try: runpy.run_module("comfyrizz_pipeline.runner", run_name="__main__")
except SystemExit as e: print("runner exit", e.code, f"in {time.time()-t:.1f}s", flush=True)
m='/content/comfyrizz/out3/manifest.json'
if os.path.exists(m):
    d=json.load(open(m)); print("complete", d.get('complete'), d.get('counts'))
    for j in d['jobs']: print(j['job'], j['status'], json.dumps(j.get('error') or j.get('reason') or j.get('outputs'))[:500])
print(subprocess.run("find /content/comfyrizz/out3 -type f -not -name '*.json*' | head; for f in $(find /content/comfyrizz/out3 -name '*.mp4' -o -name '*.png' | head -5); do echo $f; ffprobe -v error -select_streams v -show_entries stream=width,height,nb_frames -of csv=p=0 $f; done", shell=True, capture_output=True, text=True).stdout)
