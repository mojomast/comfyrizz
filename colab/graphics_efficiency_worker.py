import shutil
import subprocess
import sys
import zipfile
from pathlib import Path


def main():
    root = Path('/content/comfyrizz-benchmark')
    root.mkdir(exist_ok=True)
    with zipfile.ZipFile('/content/comfyrizz-benchmark-input.zip') as archive:
        archive.extractall(root)
    (root / 'out').mkdir(exist_ok=True)
    try:
        with (root / 'out/worker.log').open('w') as log:
            process = subprocess.Popen([sys.executable, str(root / 'graphics_efficiency.py')], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in process.stdout:
                log.write(line)
                log.flush()
                print(line, end='', flush=True)
            if process.wait():
                raise subprocess.CalledProcessError(process.returncode, process.args)
    finally:
        shutil.make_archive('/content/comfyrizz-benchmark-output', 'zip', root, 'out')
    print('COMFYRIZZ_OK benchmark', flush=True)


if __name__ == '__main__':
    main()
