"""Same eight prompts/reference, counterbalanced batch-size trials, no paid retries."""
import json
import gc
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path.cwd()
OUT = ROOT / 'out'
BASE = 'Qwen3-TTS-12Hz-1.7B-Base'


def emit(record):
    record = {'at': time.time(), **record}
    with (OUT / 'events.jsonl').open('a') as f:
        f.write(json.dumps(record) + '\n')
    print('BENCH ' + json.dumps(record), flush=True)


def download():
    from huggingface_hub import snapshot_download
    lock = json.loads((ROOT / 'models.lock.json').read_text())
    def one(item):
        repo, rev = item
        if 'VoiceDesign' not in repo and 'ForcedAligner' not in repo:
            snapshot_download(repo, revision=rev, local_dir=ROOT / 'models' / repo.split('/')[-1], max_workers=4)
    start = time.perf_counter()
    # Nested concurrent snapshot_download calls race on tqdm's shared class lock.
    # Retain the Hub's four parallel file workers, but sequence repository calls.
    for item in lock['models'].items():
        one(item)
    emit({'phase': 'download', 'seconds': time.perf_counter() - start})


def synth():
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel
    task = json.loads((ROOT / 'task.json').read_text())
    texts = task['texts']
    hardware = {'gpu': torch.cuda.get_device_name(), 'capability': torch.cuda.get_device_capability(),
                'vram': torch.cuda.get_device_properties(0).total_memory, 'torch': torch.__version__, 'cuda': torch.version.cuda,
                'allocator': os.environ.get('PYTORCH_CUDA_ALLOC_CONF', 'default'), 'torchFile': torch.__file__,
                'cpu': subprocess.getoutput('lscpu'), 'memory': subprocess.getoutput('free -b')}
    (OUT / 'hardware.json').write_text(json.dumps(hardware, indent=2))
    monitor_file = (OUT / 'gpu.csv').open('w')
    monitor = subprocess.Popen(['nvidia-smi', '--query-gpu=timestamp,utilization.gpu,utilization.memory,memory.used,power.draw,clocks.sm', '--format=csv', '-l', '1'], stdout=monitor_file)
    try:
        start = time.perf_counter()
        model = Qwen3TTSModel.from_pretrained(str(ROOT / 'models' / BASE), device_map='cuda:0', dtype=torch.bfloat16, attn_implementation='sdpa')
        prompt = model.create_voice_clone_prompt(ref_audio=str(ROOT / 'reference.wav'), ref_text=task['referenceText'])
        torch.cuda.synchronize()
        emit({'phase': 'load_and_prompt', 'seconds': time.perf_counter() - start})
        torch.manual_seed(42)
        model.generate_voice_clone(text=texts[0], language='English', voice_clone_prompt=prompt, max_new_tokens=2048)
        records = []
        oom_batches = set()
        configurations = task.get('trials') or [{'batch': b} for b in task.get('batches', [1, 2, 4, 8, 8, 4, 2, 1])]
        for trial, config in enumerate(configurations):
            texts = task.get('datasets', {}).get(config.get('dataset'), task['texts'])
            batch = config['batch']
            capacity_key = (config.get('dataset', 'default'), batch)
            if capacity_key in oom_batches:
                emit({'phase': 'skipped_after_oom', 'trial': trial, 'dataset': capacity_key[0], 'batch': batch})
                continue
            indices = list(range(len(texts)))
            if config.get('order') == 'length':
                indices.sort(key=lambda i: len(texts[i].split()))
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.synchronize()
            started = time.perf_counter()
            outputs = []
            failed = False
            for offset in range(0, len(texts), batch):
                torch.manual_seed(1000 + offset)
                members = indices[offset:offset + batch]
                try:
                    wavs, sr = model.generate_voice_clone(text=[texts[i] for i in members], language=['English'] * len(members), voice_clone_prompt=prompt, max_new_tokens=2048)
                except torch.cuda.OutOfMemoryError:
                    oom_batches.add(capacity_key)
                    failed = True
                    emit({'phase': 'oom', 'trial': trial, 'dataset': capacity_key[0], 'batch': batch})
                if failed:
                    gc.collect()
                    torch.cuda.empty_cache()
                    break
                if len(wavs) != len(members):
                    raise RuntimeError('Batch output count does not match its inputs')
                for i, wav in enumerate(wavs):
                    scene = members[i]
                    path = f'trial{trial}-scene{scene}.wav'
                    sf.write(OUT / path, wav, sr)
                    outputs.append({'file': path, 'text': texts[scene], 'seconds': len(wav) / sr,
                                    'finite': bool(np.isfinite(wav).all()), 'peak': float(np.max(np.abs(wav)))})
            if failed:
                continue
            torch.cuda.synchronize()
            seconds = time.perf_counter() - started
            record = {'phase': 'trial', 'trial': trial, 'dataset': config.get('dataset', 'default'), 'batch': batch, 'order': config.get('order', 'original'), 'seconds': seconds, 'outputs': outputs,
                      'audioSeconds': sum(o['seconds'] for o in outputs), 'peakAllocated': torch.cuda.max_memory_allocated(),
                      'peakReserved': torch.cuda.max_memory_reserved()}
            record['audioSecondsPerSecond'] = record['audioSeconds'] / seconds
            records.append(record)
            (OUT / 'trials.json').write_text(json.dumps(records, indent=2))
            emit({k: v for k, v in record.items() if k != 'outputs'})
    finally:
        monitor.terminate()
        monitor.wait()
        monitor_file.close()


def qa():
    import re
    import torch
    from qwen_asr import Qwen3ASRModel
    model = Qwen3ASRModel.from_pretrained(str(ROOT / 'models/Qwen3-ASR-0.6B'), device_map='cuda:0', dtype=torch.bfloat16, attn_implementation='sdpa', max_inference_batch_size=8)
    records = json.loads((OUT / 'trials.json').read_text())
    def words(text):
        return re.findall(r"[a-z0-9]+", text.lower())
    def wer(reference, actual):
        a, b = words(reference), words(actual)
        row = list(range(len(b) + 1))
        for i, x in enumerate(a, 1):
            nxt = [i]
            for j, y in enumerate(b, 1):
                nxt.append(min(nxt[-1] + 1, row[j] + 1, row[j - 1] + (x != y)))
            row = nxt
        return row[-1] / max(1, len(a))
    start = time.perf_counter()
    for record in records:
        outputs = record['outputs']
        results = model.transcribe(audio=[str(OUT / o['file']) for o in outputs], language='English')
        if len(results) != len(outputs):
            raise RuntimeError('ASR result count does not match its inputs')
        for output, result in zip(outputs, results):
            output['transcript'] = result.text
            output['wer'] = wer(output['text'], result.text)
            output['accepted'] = output['finite'] and output['seconds'] > 1 and output['peak'] > 0.01 and output['wer'] <= 0.1
        record['accepted'] = sum(o.get('accepted', False) for o in outputs)
        record['meanWer'] = sum(o.get('wer', 1) for o in outputs) / len(outputs)
        record['acceptedAudioSeconds'] = sum(o['seconds'] for o in outputs if o.get('accepted'))
        (OUT / 'quality.json').write_text(json.dumps(records, indent=2))
        emit({'phase': 'qa', 'trial': record['trial'], 'batch': record['batch'], 'accepted': record['accepted'], 'meanWer': record['meanWer']})
    emit({'phase': 'qa_complete', 'seconds': time.perf_counter() - start})


if __name__ == '__main__':
    {'download': download, 'synth': synth, 'qa': qa}[sys.argv[1]]()
