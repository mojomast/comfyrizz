# Run Hermes's pipeline-py runner on the VM against comfy-api-proxy (8189), as colab/run_jobs.py would.
import subprocess, sys, time, json, os, glob
W='/content/comfyrizz/work'; t=time.time()
env=dict(os.environ); env['PYTHONPATH']=f'{W}/pipeline-py'
for args in (["--base-url","http://127.0.0.1:8189"],):
    cmd=[sys.executable,"-m","comfyrizz_pipeline.runner","--jobs",f"{W}/jobs.json","--out","/content/comfyrizz/out","--progress-log","/content/comfyrizz/out/progress.jsonl",*args]
    print("$", " ".join(cmd), flush=True)
    p=subprocess.Popen(cmd, cwd=W, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout: print(line.rstrip()[:400], flush=True)
    p.wait(); print("runner exit", p.returncode, f"in {time.time()-t:.1f}s", flush=True)
m='/content/comfyrizz/out/manifest.json'
if os.path.exists(m): print(open(m).read()[:3000])
print(subprocess.run("find /content/comfyrizz/out -type f | head -30; for f in $(find /content/comfyrizz/out -name '*.mp4' -o -name '*.png' | head -5); do echo $f; ffprobe -v error -select_streams v -show_entries stream=width,height,nb_frames -of csv=p=0 $f; done", shell=True, capture_output=True, text=True).stdout)
