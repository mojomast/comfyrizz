"""CPU controls: existing sentence synthesis versus context, speed and voice blend.

All variants omit the production scene-end padding and inter-scene silence.
"""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import time
import wave

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'packages/tts/py'))
from synth import split_sentences
from pronounce import pronounce


def main():
    from kokoro_onnx import Kokoro
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', type=Path, default=REPO / 'scripts/bench/tts_expression_plan.json')
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    task = json.loads(args.plan.read_text())
    model_dir = Path.home() / '.cache/comfyrizz/kokoro'
    model = Kokoro(str(model_dir / 'kokoro-v1.0.onnx'), str(model_dir / 'voices-v1.0.bin'))
    text = task['kokoroText']
    blend = 0.7 * model.get_voice_style('am_michael') + 0.3 * model.get_voice_style('am_fenrir')
    variants = [
        ('kokoro-sentence', 'am_michael', 0.98, True, 'am_michael'),
        ('kokoro-context', 'am_michael', 0.98, False, 'am_michael'),
        ('kokoro-pace', 'am_michael', 0.93, False, 'am_michael'),
        ('kokoro-blend', blend, 0.98, False, '70% am_michael + 30% am_fenrir'),
    ]
    records = []
    for name, voice, speed, split, voice_name in variants:
        start = time.perf_counter()
        pieces = []
        chunks = split_sentences(text) if split else [text]
        chunk_info = []
        for chunk in chunks:
            audio, sr = model.create(pronounce(chunk), voice=voice, speed=speed, lang='en-us')
            assert sr == 24000
            if pieces:
                pieces.append(np.zeros(3600, dtype=np.float32))
            pieces.append(audio)
            chunk_info.append({'text': chunk, 'seconds': len(audio) / sr})
        audio = np.concatenate(pieces)
        assert np.isfinite(audio).all() and np.max(np.abs(audio)) < 1, 'Unexpected clipped/non-finite Kokoro output'
        with wave.open(str(args.out / (name + '.wav')), 'wb') as f:
            f.setnchannels(1)
            f.setsampwidth(2)
            f.setframerate(24000)
            f.writeframes((audio * 32767).astype('<i2').tobytes())
        record = {'id': name, 'file': name + '.wav', 'engine': 'kokoro-onnx', 'text': text, 'seed': None,
                  'voice': voice_name, 'speed': speed, 'chunks': chunk_info, 'gapSeconds': 0.15 if split else 0,
                  'seconds': len(audio) / 24000, 'synthesisSeconds': time.perf_counter() - start,
                  'finite': bool(np.isfinite(audio).all()), 'peak': float(np.max(np.abs(audio)))}
        records.append(record)
        print(json.dumps(record), flush=True)
    evidence = {'package': importlib.metadata.version('kokoro-onnx'), 'samples': records, 'models': {}}
    for p in model_dir.iterdir():
        if p.is_file():
            with p.open('rb') as f:
                evidence['models'][p.name] = hashlib.file_digest(f, 'sha256').hexdigest()
    (args.out / 'kokoro.json').write_text(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
