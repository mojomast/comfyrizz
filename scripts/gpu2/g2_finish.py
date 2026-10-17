import os, subprocess, shutil
shutil.rmtree('/content/.hf', ignore_errors=True)
print("token dir present:", os.path.exists('/content/.hf'), "| HF_TOKEN in kernel env:", 'HF_TOKEN' in os.environ, "| hf cache token:", os.path.exists(os.path.expanduser('~/.cache/huggingface/token')))
print(subprocess.run("cp /content/comfy.log /content/proxy.log /content/setup_times.json /content/out/ 2>/dev/null; cp -r /content/comfyrizz/out /content/out/hermes_runner 2>/dev/null; cd /content && tar czf out.tgz out && ls -la out.tgz", shell=True, capture_output=True, text=True).stdout)
