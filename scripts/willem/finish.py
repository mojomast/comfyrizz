import os, subprocess, shutil
shutil.rmtree('/content/.hf', ignore_errors=True)
print("token dir present:", os.path.exists('/content/.hf'), "| HF_TOKEN in env:", 'HF_TOKEN' in os.environ, "| hf cache token:", os.path.exists(os.path.expanduser('~/.cache/huggingface/token')))
