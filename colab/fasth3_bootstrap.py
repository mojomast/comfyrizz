"""Isolated FastH3 experiment. Upload with fasth3-models.lock.json to /content/fasth3.

No credentials required: the pinned models are public. Keeps the production
LTX/FLUX environment untouched. A host-side owner must stop the billed runtime.
"""
import hashlib
import importlib.metadata
import json
import re
from pathlib import Path
import subprocess
import sys
import time
import urllib.request


def run(argv, **kwargs):
    print('RUN', argv, flush=True)
    subprocess.run(argv, check=True, **kwargs)


def main():
    root = Path('/content/fasth3')
    root.mkdir(exist_ok=True)
    lock = json.loads((root / 'fasth3-models.lock.json').read_text())
    started = time.time()
    run(['nvidia-smi'])
    import torch
    print(json.dumps({'torch': torch.__version__, 'cuda': torch.version.cuda,
                      'gpu': torch.cuda.get_device_name(), 'capability': torch.cuda.get_device_capability()}), flush=True)
    comfy = root / 'ComfyUI'
    if not comfy.exists():
        run(['git', 'clone', '--filter=blob:none', 'https://github.com/Comfy-Org/ComfyUI.git', str(comfy)])
    run(['git', 'checkout', lock['comfyuiRevision']], cwd=comfy)
    # Retain the Colab CUDA-enabled torch unless the pinned runtime proves incompatible.
    req = root / 'requirements.txt'
    req.write_text('\n'.join(l for l in (comfy / 'requirements.txt').read_text().splitlines()
                             if not re.match(r'^(torch|torchvision|torchaudio)([<>=~\s]|$)', l)))
    run([sys.executable, '-m', 'pip', 'install', '-q', '-r', str(req), 'huggingface_hub'])
    from huggingface_hub import hf_hub_download
    for entry in lock['files']:
        host = lock['hosts'][entry['host']]
        print('DOWNLOAD', entry['path'], entry['bytes'], flush=True)
        file = Path(hf_hub_download(host['repo'], entry['path'], revision=host['revision'], local_dir=root / 'models'))
        if file.stat().st_size != entry['bytes']:
            raise ValueError('Model size mismatch: ' + entry['path'])
        h = hashlib.sha256()
        with file.open('rb') as f:
            for chunk in iter(lambda: f.read(16 * 1024 * 1024), b''):
                h.update(chunk)
        if h.hexdigest() != entry['sha256']:
            raise ValueError('Model hash mismatch: ' + entry['path'])
        target = comfy / 'models' / entry['target']
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.symlink_to(file)
        print('VERIFIED', entry['path'], flush=True)
    log = (root / 'comfy.log').open('w')
    proc = subprocess.Popen([sys.executable, 'main.py', '--listen', '127.0.0.1', '--port', '8188', '--disable-auto-launch'],
                            cwd=comfy, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError('ComfyUI exited: ' + (root / 'comfy.log').read_text()[-12000:])
        try:
            with urllib.request.urlopen('http://127.0.0.1:8188/object_info', timeout=5) as response:
                info = json.load(response)
            required = ['MiniMaxH3ReferenceToVideo', 'MiniMaxH3SigmaShift', 'BlockSparseAttention', 'VAEDecodeAudio', 'CreateVideo', 'SaveVideo']
            missing = [name for name in required if name not in info]
            if missing:
                raise RuntimeError('Missing native nodes: ' + repr(missing))
            (root / 'object-info.json').write_text(json.dumps(info))
            receipt = {'comfyuiRevision': lock['comfyuiRevision'], 'seconds': time.time()-started,
                       'pid': proc.pid, 'torch': torch.__version__, 'gpu': torch.cuda.get_device_name(), 'ready': True,
                       'packages': {p: importlib.metadata.version(p) for p in ['torch','torchsde','comfy-kitchen','huggingface-hub']}}
            (root / 'bootstrap-receipt.json').write_text(json.dumps(receipt, indent=2))
            print(json.dumps(receipt), flush=True)
            return
        except (OSError, TimeoutError):
            time.sleep(3)
    raise TimeoutError('ComfyUI did not become ready')


if __name__ == '__main__':
    main()
