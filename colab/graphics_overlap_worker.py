import sys
from pathlib import Path
import json


def main():
    root = Path('/content/comfyrizz-benchmark')
    sys.path.insert(0, str(root))
    from graphics_efficiency import pair
    counter = root / 'overlap-counter.json'
    n = json.loads(counter.read_text()) if counter.exists() else 0
    counter.write_text(json.dumps(n + 1))
    pair(1, f'overlap-{n}', 500 + n * 100)
    print('COMFYRIZZ_OK overlap', flush=True)


if __name__ == '__main__':
    main()
