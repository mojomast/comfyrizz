"""Pinned ComfyUI workload: warm single-worker vs two-worker throughput and GPU trace."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path('/content/comfyrizz-benchmark')
OUT = ROOT / 'out'
COMFY = Path('/content/ComfyUI')


def emit(data):
    record = {'at': time.time(), **data}
    with (OUT / 'events.jsonl').open('a') as f:
        f.write(json.dumps(record) + '\n')
    print('BENCH ' + json.dumps(record), flush=True)


def api(port, path, data=None):
    request = urllib.request.Request(f'http://127.0.0.1:{port}/{path}',
                                     data=None if data is None else json.dumps(data).encode(),
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def job(index, port, label, seed):
    graph = json.loads((ROOT / f'graph{index}.json').read_text())
    for node in graph.values():
        if node['class_type'] == 'RandomNoise':
            node['inputs']['noise_seed'] += seed
        if node['class_type'] == 'SaveVideo':
            node['inputs']['filename_prefix'] = label
    start = time.perf_counter()
    response = api(port, 'prompt', {'prompt': graph, 'client_id': 'efficiency-' + label})
    prompt = response['prompt_id']
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        history = api(port, 'history/' + prompt).get(prompt)
        if history:
            if history.get('status', {}).get('status_str') == 'error':
                raise RuntimeError(str(history['status'])[-2500:])
            files = []
            for outputs in history.get('outputs', {}).values():
                for items in outputs.values():
                    if isinstance(items, list):
                        for item in items:
                            if isinstance(item, dict) and item.get('filename'):
                                path = COMFY / item.get('type', 'output') / item.get('subfolder', '') / item['filename']
                                if path.is_file() and path.suffix == '.mp4':
                                    target = OUT / (label + '-' + path.name)
                                    shutil.copy2(path, target)
                                    files.append(target.name)
            if not files:
                raise RuntimeError('Missing video output: ' + str(history)[:1000])
            result = {'phase': 'job', 'label': label, 'port': port, 'seconds': time.perf_counter() - start,
                      'files': files, 'prompt': prompt, 'seedOffset': seed}
            emit(result)
            (OUT / (label + '.graph.json')).write_text(json.dumps(graph))
            return result
        time.sleep(0.25)
    raise TimeoutError('Comfy prompt timeout')


def pair(workers, label, seed):
    start = time.perf_counter()
    if workers == 2:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(job, i, [8188, 8190][i], label + f'-{i}', seed) for i in range(2)]
            results = [future.result() for future in futures]
    else:
        results = [job(i, 8188, label + f'-{i}', seed) for i in range(2)]
    record = {'phase': 'pair', 'label': label, 'workers': workers, 'seconds': time.perf_counter() - start, 'jobs': results}
    emit(record)
    return record


def main():
    OUT.mkdir(exist_ok=True)
    task = json.loads((ROOT / 'task.json').read_text())
    for name in task['images']:
        shutil.copy2(ROOT / name, COMFY / 'input' / name)
    hardware = {'stats': api(8188, 'system_stats'), 'smi': subprocess.getoutput('nvidia-smi'),
                'cpu': subprocess.getoutput('lscpu'), 'memory': subprocess.getoutput('free -b')}
    (OUT / 'hardware.json').write_text(json.dumps(hardware, indent=2))
    monitor_file = (OUT / 'gpu.csv').open('w')
    monitor = subprocess.Popen(['nvidia-smi', '--query-gpu=timestamp,utilization.gpu,utilization.memory,memory.used,power.draw,clocks.sm', '--format=csv', '-l', '1'], stdout=monitor_file)
    second = None
    second_log = None
    results = []
    try:
        results.append(pair(1, 'single-cold', 0))
        results.append(pair(1, 'single-warm-a', 100))
        # Gate duplicated workers on observed peak, including resident weights and decoder allocations.
        used = []
        for line in (OUT / 'gpu.csv').read_text().splitlines()[1:]:
            try:
                used.append(float(line.split(',')[3].strip().split()[0]))
            except (ValueError, IndexError):
                pass
        peak_mib = max(used) if used else float('inf')
        total_mib = float(subprocess.check_output(['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'], text=True).strip())
        emit({'phase': 'concurrency_admission', 'peakMiB': peak_mib, 'totalMiB': total_mib, 'allowed': peak_mib * 2 + 6144 < total_mib})
        if peak_mib * 2 + 6144 < total_mib:
            second_log = (OUT / 'comfy-second.log').open('w')
            second = subprocess.Popen([sys.executable, 'main.py', '--listen', '127.0.0.1', '--port', '8190', '--reserve-vram', '6'], cwd=COMFY, stdout=second_log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                try:
                    api(8190, 'system_stats')
                    break
                except Exception:
                    time.sleep(1)
            for i in range(2):
                job(i, 8190, f'second-warmup-{i}', 150)
            results.append(pair(2, 'dual-warm-a', 200))
            results.append(pair(2, 'dual-warm-b', 300))
            second.terminate()
            second.wait(timeout=30)
            second = None
        results.append(pair(1, 'single-warm-b', 400))
        (OUT / 'trials.json').write_text(json.dumps(results, indent=2))
        # An immutable mixed-media checkpoint to compare transfer strategies on identical bytes.
        transfer = ROOT / 'transfer'
        transfer.mkdir(exist_ok=True)
        candidates = sorted(OUT.glob('*.mp4'))[:6] + sorted(OUT.glob('*.graph.json'))[:6]
        candidates += [ROOT / name for name in task['images']]
        manifest = []
        for source in candidates:
            dest = transfer / source.name
            shutil.copy2(source, dest)
            manifest.append({'name': dest.name, 'bytes': dest.stat().st_size, 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest()})
        (ROOT / 'transfer-manifest.json').write_text(json.dumps(manifest))
        shutil.make_archive(str(ROOT / 'transfer'), 'zip', transfer)
    finally:
        if second is not None:
            second.terminate()
            second.wait(timeout=30)
        if second_log:
            second_log.close()
        monitor.terminate()
        monitor.wait()
        monitor_file.close()
        shutil.copy2('/content/comfyui.log', OUT / 'comfy-primary.log')


if __name__ == '__main__':
    main()
