"""Run prepared film shots through native ComfyUI on a Google Colab GPU, retaining synchronized audio.

python fasth3_run.py /content/fasth3/film --shots s04 [s01 ...]
Records submission before polling; interrupted/uncertain attempts are never
automatically resubmitted. Receipt includes source graph, input hashes and output
probe. Intended for the isolated experiment, not the server's v2 SDK transport.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request


def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request('http://127.0.0.1:8188' + path, data=data,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'ComfyUI HTTP {exc.code}: {exc.read().decode()[:16000]}') from exc


def write(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2))
    tmp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--shots', nargs='+', required=True)
    parser.add_argument('--timeout', type=float, default=900)
    parser.add_argument('--max-seconds', type=float, default=3600, help='Wall-time admission cap for this invocation')
    args = parser.parse_args()
    root = args.directory.resolve()
    film = json.loads((root / 'film.json').read_text())
    runtime = json.loads((root.parent / 'fasth3-models.lock.json').read_text())
    comfy = root.parent / 'ComfyUI'
    out = root / 'outputs'
    out.mkdir(exist_ok=True)
    run_deadline = time.monotonic() + args.max_seconds
    for shot_id in args.shots:
        if time.monotonic() >= run_deadline:
            raise TimeoutError('Batch wall-time budget reached before ' + shot_id)
        shot = next(s for s in film['shots'] if s['id'] == shot_id)
        graph = json.loads((root / 'workflow.json').read_text())
        hashes = {}
        for param, node, field in [('image','5','image'), ('reference','6','image'), ('audio','7','audio')]:
            src = (root / shot[param]).resolve()
            if not src.is_relative_to(root):
                raise ValueError('Reference escapes input directory')
            digest = hashlib.sha256(src.read_bytes()).hexdigest()
            name = digest + src.suffix
            shutil.copy2(src, comfy / 'input' / name)
            graph[node]['inputs'][field] = name
            hashes[param] = digest
        for key, field in [('prompt','prompt'), ('width','width'), ('height','height'), ('frames','length')]:
            graph['8']['inputs'][field] = shot[key]
        graph['13']['inputs']['noise_seed'] = shot['seed']
        graph['20']['inputs']['filename_prefix'] = f'video/{shot_id}'
        key = hashlib.sha256(json.dumps({'graph': graph, 'refs': hashes, 'runtime': runtime}, sort_keys=True).encode()).hexdigest()
        receipt_path = out / f'{shot_id}.json'
        if receipt_path.exists():
            old = json.loads(receipt_path.read_text())
            if old.get('key') == key and old.get('status') == 'succeeded':
                movie = out / f'{shot_id}.mp4'
                if movie.exists() and hashlib.sha256(movie.read_bytes()).hexdigest() == old['sha256']:
                    print('CACHED', shot_id, flush=True)
                    continue
            raise RuntimeError(f'{shot_id}: prior attempt exists; inspect it before an explicit new take')
        receipt = {'shot': shot_id, 'key': key, 'graph': graph, 'references': hashes, 'runtime': runtime,
                   'status': 'submission_unknown', 'started': time.time()}
        write(receipt_path, receipt)
        result = request('/prompt', {'prompt': graph, 'client_id': 'comfyrizz-fasth3'})
        if result.get('node_errors') or not result.get('prompt_id'):
            receipt.update(status='validation_failed', response=result)
            write(receipt_path, receipt)
            raise RuntimeError(result)
        pid = result['prompt_id']
        receipt.update(status='running', promptId=pid)
        write(receipt_path, receipt)
        print('SUBMITTED', shot_id, pid, flush=True)
        deadline = min(run_deadline, time.monotonic() + args.timeout)
        while time.monotonic() < deadline:
            history = request('/history/' + pid).get(pid)
            if history:
                receipt['history'] = history
                if history.get('status', {}).get('status_str') == 'error':
                    receipt.update(status='failed', seconds=time.time()-receipt['started'])
                    write(receipt_path, receipt)
                    raise RuntimeError(json.dumps(history.get('status'))[-12000:])
                files = [v for output in history.get('outputs', {}).values() for values in output.values()
                         if isinstance(values, list) for v in values if isinstance(v, dict) and str(v.get('filename','')).endswith('.mp4')]
                if not files:
                    raise RuntimeError('Completed graph has no MP4: ' + json.dumps(history))
                item = files[0]
                src = (comfy / 'output' / item.get('subfolder','') / item['filename']).resolve()
                if not src.is_relative_to(comfy / 'output'):
                    raise ValueError('Output escapes ComfyUI output directory')
                movie = out / f'{shot_id}.mp4'
                shutil.copy2(src, movie)
                probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(movie)]))
                if not any(s['codec_type'] == 'audio' for s in probe['streams']):
                    raise RuntimeError('Generated MP4 has no audio')
                receipt.update(status='succeeded', seconds=time.time()-receipt['started'], probe=probe,
                               sha256=hashlib.sha256(movie.read_bytes()).hexdigest(), bytes=movie.stat().st_size)
                write(receipt_path, receipt)
                print('SUCCEEDED', shot_id, round(receipt['seconds'],2), movie.stat().st_size, flush=True)
                break
            time.sleep(3)
        else:
            request('/interrupt', {})
            receipt.update(status='timed_out', seconds=time.time()-receipt['started'])
            write(receipt_path, receipt)
            raise TimeoutError(shot_id)


if __name__ == '__main__':
    main()
