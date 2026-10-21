"""Add the pinned FLUX reference-image model to the isolated FastH3 runtime.

Upload models.lock.json beside this script and provide a temporary 0600 token
file at /content/fasth3/hf-token. The token is deleted even on download failure.
The existing FastH3 bootstrap owns ComfyUI and the audiovisual model profile.
"""
import hashlib
import json
from pathlib import Path
import time


def main():
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file, save_file
    root = Path('/content/fasth3')
    token_path = root / 'hf-token'
    token = token_path.read_text().strip()
    lock = json.loads((root / 'models.lock.json').read_text())
    host = lock['hosts']['klein']
    started = time.time()
    receipts = []
    try:
        for entry in [f for f in lock['files'] if f['host'] == 'klein']:
            print('DOWNLOAD', entry['path'], flush=True)
            file = Path(hf_hub_download(host['repo'], entry['path'], revision=host['revision'],
                                       token=token, local_dir=root / 'klein'))
            if file.stat().st_size != entry['bytes']:
                raise ValueError('Model size mismatch: ' + entry['path'])
            digest = hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
            receipts.append({**entry, 'sha256': digest})
            if 'target' in entry:
                target = root / 'ComfyUI/models' / entry['target']
                target.parent.mkdir(exist_ok=True, parents=True)
                if not target.exists():
                    target.symlink_to(file)
        spec = next(m for m in lock['merge'] if m['id'] == 'klein-text-encoder')
        target = root / 'ComfyUI/models' / spec['target']
        if not target.exists():
            weights = {}
            for shard in spec['shards']:
                weights.update(load_file(str(root / 'klein' / shard)))
            save_file(weights, str(target))
            del weights
        receipt = {'host': host, 'files': receipts, 'seconds': time.time()-started,
                   'mergedBytes': target.stat().st_size}
        (root / 'reference-bootstrap-receipt.json').write_text(json.dumps(receipt, indent=2))
        print('REFERENCE_MODELS_READY', round(receipt['seconds'], 2), flush=True)
    finally:
        token_path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
