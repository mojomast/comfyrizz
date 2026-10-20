"""Install pinned environments and run reproducible, quality-checked TTS trials."""
import json
from collections import deque
import os
from pathlib import Path
import shutil
import subprocess
import time
import zipfile


def main():
    root = Path('/content/comfyrizz-benchmark')
    root.mkdir(exist_ok=True)
    with zipfile.ZipFile('/content/comfyrizz-benchmark-input.zip') as archive:
        archive.extractall(root)
    out = root / 'out'
    out.mkdir(exist_ok=True)
    lock = json.loads((root / 'models.lock.json').read_text())
    task = json.loads((root / 'task.json').read_text())
    def run(args, **kwargs):
        start = time.perf_counter()
        tail = deque(maxlen=30)
        with (out / 'worker.log').open('a') as log:
            log.write('\nCOMMAND ' + ' '.join(map(str, args)) + '\n')
            process = subprocess.Popen(list(map(str, args)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, **kwargs)
            for line in process.stdout:
                log.write(line)
                log.flush()
                tail.append(line)
                if line.startswith('BENCH '):
                    print(line, end='', flush=True)
            if process.wait():
                print(''.join(tail), flush=True)
                raise subprocess.CalledProcessError(process.returncode, args)
        with (out / 'setup-events.jsonl').open('a') as f:
            f.write(json.dumps({'at': time.time(), 'command': list(map(str, args)), 'seconds': time.perf_counter() - start,
                                'diskFreeBytes': shutil.disk_usage(root).free}) + '\n')
    try:
        run(['apt-get', 'update', '-qq'])
        run(['apt-get', 'install', '-y', '-qq', 'sox', 'ffmpeg', 'python3.12-venv'])
        if task.get('earlyDownload'):
            download_env = root / 'venv-download'
            run(['/usr/bin/python3.12', '-m', 'venv', download_env])
            run([download_env / 'bin/python', '-m', 'pip', 'install', '-q', 'huggingface_hub==0.36.2', 'hf-xet==1.7.0'])
            run([download_env / 'bin/python', root / 'qwen_efficiency.py', 'download'], cwd=root)
        shared = root / 'venv-torch' if task.get('sharedTorch') else None
        if shared:
            run(['/usr/bin/python3.12', '-m', 'venv', shared])
            run([shared / 'bin/python', '-m', 'pip', 'install', '-q', 'torch==2.9.1', 'torchaudio==2.9.1', '--index-url', 'https://download.pytorch.org/whl/cu128'])
        for name, package in [('tts', lock['ttsPackage']), ('asr', lock['asrPackage'])]:
            env = root / ('venv-' + name)
            run(['/usr/bin/python3.12', '-m', 'venv', env])
            if shared:
                (env / 'lib/python3.12/site-packages/shared-torch.pth').write_text(str(shared / 'lib/python3.12/site-packages') + '\n')
            else:
                run([env / 'bin/python', '-m', 'pip', 'install', '-q', 'torch==2.9.1', 'torchaudio==2.9.1', '--index-url', 'https://download.pytorch.org/whl/cu128'])
            run([env / 'bin/python', '-m', 'pip', 'install', '-q', package])
        if not task.get('earlyDownload'):
            run([root / 'venv-tts/bin/python', root / 'qwen_efficiency.py', 'download'], cwd=root)
        environment = dict(os.environ)
        if task.get('allocator'):
            environment['PYTORCH_CUDA_ALLOC_CONF'] = task['allocator']
        run([root / 'venv-tts/bin/python', root / 'qwen_efficiency.py', 'synth'], cwd=root, env=environment)
        run([root / 'venv-asr/bin/python', root / 'qwen_efficiency.py', 'qa'], cwd=root)
        for name in ['tts', 'asr']:
            with (out / (name + '-environment.txt')).open('w') as f:
                subprocess.run([str(root / ('venv-' + name) / 'bin/python'), '-m', 'pip', 'freeze'], stdout=f, check=True)
    finally:
        shutil.make_archive('/content/comfyrizz-benchmark-output', 'zip', root, 'out')
    print('COMFYRIZZ_OK benchmark', flush=True)


if __name__ == '__main__':
    main()
