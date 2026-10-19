"""Auditable Qwen naturalness candidates, using the bounded Colab experiment worker.

Bundled as qwen_efficiency.py to reuse its install/download/synth/qa entry points.
Every condition/take is retained; quality checks do not rank naturalness.
"""
import gc
import json
from pathlib import Path
import shutil
import sys
import time

ROOT = Path.cwd()
OUT = ROOT / 'out'
BASE = 'Qwen3-TTS-12Hz-1.7B-Base'
DESIGN = 'Qwen3-TTS-12Hz-1.7B-VoiceDesign'
CUSTOM = 'Qwen3-TTS-12Hz-1.7B-CustomVoice'


def emit(record):
    with (OUT / 'events.jsonl').open('a') as f:
        f.write(json.dumps({'at': time.time(), **record}) + '\n')
    print('BENCH ' + json.dumps(record), flush=True)


def download():
    from huggingface_hub import snapshot_download
    lock = json.loads((ROOT / 'models.lock.json').read_text())
    for repo, revision in lock['models'].items():
        start = time.perf_counter()
        snapshot_download(repo, revision=revision, local_dir=ROOT / 'models' / repo.split('/')[-1], max_workers=4)
        emit({'phase': 'download', 'model': repo, 'seconds': time.perf_counter() - start})


def synth():
    import inspect
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel
    task = json.loads((ROOT / 'task.json').read_text())
    records = []
    options = {'device_map': 'cuda:0', 'dtype': torch.bfloat16, 'attn_implementation': 'sdpa'}
    (OUT / 'hardware.json').write_text(json.dumps({'gpu': torch.cuda.get_device_name(), 'torch': torch.__version__,
        'cuda': torch.version.cuda, 'api': {name: str(inspect.signature(getattr(Qwen3TTSModel, name))) for name in ['generate_custom_voice', 'generate_voice_clone', 'generate_voice_design']}}, indent=2))

    def save(name, wav, sr, text, **metadata):
        audio = np.asarray(wav, dtype=np.float32)
        assert audio.size and np.isfinite(audio).all()
        sf.write(OUT / (name + '.wav'), audio, sr, subtype='FLOAT')
        record = {'id': name, 'file': name + '.wav', 'text': text, 'engine': 'qwen3-tts', 'sampleRate': sr,
                  'seconds': len(audio) / sr, 'finite': True, 'peak': float(np.max(np.abs(audio))), **metadata}
        records.append(record)
        (OUT / 'samples.json').write_text(json.dumps(records, indent=2))
        emit({'phase': 'sample', 'id': name, 'seconds': record['seconds']})

    model = Qwen3TTSModel.from_pretrained(str(ROOT / 'models' / CUSTOM), **options)
    (OUT / 'custom-defaults.json').write_text(json.dumps(model.generate_defaults, indent=2))
    for seed in task['seeds']:
        for directed in [False, True]:
            torch.manual_seed(seed)
            wavs, sr = model.generate_custom_voice(text=[s['text'] for s in task['scripts']], language=['English'] * 3,
                speaker=[task['customVoice']] * 3, instruct=[s['direction'] if directed else '' for s in task['scripts']],
                non_streaming_mode=True, max_new_tokens=2048)
            assert len(wavs) == len(task['scripts'])
            for script, wav in zip(task['scripts'], wavs):
                save(f"custom-{script['id']}-{'after' if directed else 'before'}-{seed}", wav, sr, script['text'],
                     model=CUSTOM, seed=seed, speaker=task['customVoice'], instruct=script['direction'] if directed else '',
                     nonStreamingMode=True, batchSize=3)
    del model
    gc.collect()
    torch.cuda.empty_cache()

    model = Qwen3TTSModel.from_pretrained(str(ROOT / 'models' / DESIGN), **options)
    for ref_seed in task['referenceSeeds']:
        torch.manual_seed(ref_seed)
        wavs, sr = model.generate_voice_design(text=task['referenceText'], language='English',
            instruct=task['referenceDirection'], max_new_tokens=2048)
        save(f'reference-after-{ref_seed}', wavs[0], sr, task['referenceText'], model=DESIGN, seed=ref_seed,
             instruct=task['referenceDirection'], role='reference')
    del model
    gc.collect()
    torch.cuda.empty_cache()

    model = Qwen3TTSModel.from_pretrained(str(ROOT / 'models' / BASE), **options)
    (OUT / 'base-defaults.json').write_text(json.dumps(model.generate_defaults, indent=2))
    prompt = model.create_voice_clone_prompt(ref_audio=str(ROOT / 'reference.wav'), ref_text=task['referenceText'], x_vector_only_mode=False)
    source = task['scripts'][1]['text']
    for seed, ref_seed in zip(task['seeds'], task['referenceSeeds']):
        expressive = model.create_voice_clone_prompt(ref_audio=str(OUT / f'reference-after-{ref_seed}.wav'), ref_text=task['referenceText'], x_vector_only_mode=False)
        variants = [('before', source, prompt, False, 'reference-before'),
                    ('phrasing', task['phrasedText'], prompt, False, 'reference-before'),
                    ('fulltext', source, prompt, True, 'reference-before'),
                    ('reference', source, expressive, False, f'reference-after-{ref_seed}')]
        for variant, text, voice_prompt, full, reference in variants:
            torch.manual_seed(seed)
            wavs, sr = model.generate_voice_clone(text=text, language='English', voice_clone_prompt=voice_prompt,
                                                 non_streaming_mode=full, max_new_tokens=2048)
            save(f'base-{variant}-{seed}', wavs[0], sr, text, model=BASE, seed=seed,
                 reference=reference, nonStreamingMode=full, xVectorOnly=False, batchSize=1)
    del model
    gc.collect()
    torch.cuda.empty_cache()
    reference, sr = sf.read(ROOT / 'reference.wav', dtype='float32')
    save('reference-before', reference, sr, task['referenceText'], model=DESIGN, role='reference', seed=42,
         source='Archived Hermes synthetic reference; original persona stored in reference-before.json')
    shutil.copy2(ROOT / 'reference-before.json', OUT / 'reference-before.json')
    extra = json.loads((ROOT / 'extras/kokoro.json').read_text())
    for record in extra['samples']:
        shutil.copy2(ROOT / 'extras' / record['file'], OUT / record['file'])
        records.append(record)
    (OUT / 'samples.json').write_text(json.dumps(records, indent=2))
    shutil.copy2(ROOT / 'extras/kokoro.json', OUT / 'kokoro.json')
    shutil.copy2(ROOT / 'models.lock.json', OUT / 'models.lock.json')
    shutil.copy2(ROOT / 'task.json', OUT / 'task.json')


def qa():
    import re
    import torch
    from qwen_asr import Qwen3ASRModel
    model = Qwen3ASRModel.from_pretrained(str(ROOT / 'models/Qwen3-ASR-0.6B'), device_map='cuda:0', dtype=torch.bfloat16,
                                       attn_implementation='sdpa', max_inference_batch_size=4)
    records = json.loads((OUT / 'samples.json').read_text())
    def words(text):
        return re.findall(r"[a-z0-9]+", text.lower())
    def wer(expected, actual):
        a, b = words(expected), words(actual)
        row = list(range(len(b) + 1))
        for i, x in enumerate(a, 1):
            nxt = [i]
            for j, y in enumerate(b, 1):
                nxt.append(min(nxt[-1]+1, row[j]+1, row[j-1]+(x != y)))
            row = nxt
        return row[-1] / max(1, len(a))
    results = model.transcribe(audio=[str(OUT / r['file']) for r in records], language='English')
    assert len(results) == len(records)
    for record, result in zip(records, results):
        record['transcript'] = result.text
        record['wer'] = wer(record['text'], result.text)
        record['intelligibilityPass'] = record['wer'] <= 0.1 and record['finite'] and record['peak'] > 0.01
        emit({'phase': 'qa', 'id': record['id'], 'wer': record['wer'], 'passed': record['intelligibilityPass']})
    (OUT / 'quality.json').write_text(json.dumps(records, indent=2))


if __name__ == '__main__':
    {'download': download, 'synth': synth, 'qa': qa}[sys.argv[1]]()
