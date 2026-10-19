"""Prove kernel execution promptly before a long benchmark command."""
import json
import platform
import subprocess

print('BENCH ' + json.dumps({'phase': 'kernel_probe', 'python': platform.python_version(),
    'gpu': subprocess.check_output(['nvidia-smi', '--query-gpu=name,uuid,memory.total,driver_version', '--format=csv,noheader'], text=True).strip()}), flush=True)
print('COMFYRIZZ_OK probe', flush=True)
