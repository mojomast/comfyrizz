"""Prepare exact-line voice conditioning for review; never dispatch a GPU job.

Usage: python nrcu_shot_conditioning.py PRODUCTION_ROOT NEW_OUTPUT_DIRECTORY
The original voice presets remain unchanged. Each WAV contains only that shot's
line, so unrelated reference dialogue cannot bleed into a new performance.
"""
import hashlib
import json
from pathlib import Path
import sys
import wave
import subprocess

import numpy as np


def compile_prompts(requests):
    """Use the shared jobs planner's full-reference formatter for external plans too."""
    helper = Path(__file__).resolve().parents[2] / 'packages/jobs/src/fasth3-direction.mjs'
    code = f"import{{buildFastH3Prompt}}from {json.dumps(helper.as_uri())};import{{readFileSync}}from'node:fs';console.log(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(r=>buildFastH3Prompt(r.direction,r))));"
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', code], input=json.dumps(requests).encode()))


def speech_prompt(shot):
    line = shot.get('line', '')
    deadline = max(.5, float(shot['seconds']) - .25)
    if not line:
        return 'Location sound only. No speech, singing, narration or vocalizations. '
    direction = {
        'don': 'Preserve the written broken English exactly. ',
        'molty': 'Low gravelly bass; cold, mocking, menacing and never friendly. ',
        'hermes': 'Disembodied computer voice; the room remains unoccupied. ',
    }.get(shot.get('speaker'), '')
    return (f'<Audio 1> contains this shot\'s exact line in the intended voice. {direction}'
            f'Say exactly once: "{line}". Begin promptly and finish before {deadline:.2f} seconds. '
            'No other words, repetitions or additional speakers. Remain silent afterward. ')


def write_conditioning(kokoro, voice, text, path):
    if path.exists():
        raise ValueError(f'Refusing to overwrite conditioning: {path}')
    samples, rate = kokoro.create(text, voice=voice['preset'], lang=voice['language'], speed=voice['speed'])
    padded = np.concatenate((np.zeros(round(rate * .15)), samples, np.zeros(round(rate * .2))))
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes((np.clip(padded, -1, 1) * 32767).astype('<i2').tobytes())
    return len(samples) / rate, len(padded) / rate


def main():
    from kokoro_onnx import Kokoro
    root, output = map(Path, sys.argv[1:3])
    if output.exists():
        raise ValueError('Use a new conditioning directory; existing references are never overwritten')
    output.mkdir(parents=True)
    film = json.loads((root / 'film.json').read_text())
    voices = json.loads((root / 'voice-registry.json').read_text())
    cache = Path.home() / '.cache/comfyrizz/kokoro'
    kokoro = Kokoro(str(cache / 'kokoro-v1.0.onnx'), str(cache / 'voices-v1.0.bin'))
    entries = []
    for shot in film['shots']:
        if shot.get('reusedFrom') or not shot.get('line'):
            continue
        voice = voices[shot['speaker']]
        # Do not accelerate a performance to conceal an overfull editorial slot.
        path = output / f'{shot["id"]}.wav'
        speech_seconds, conditioning_seconds = write_conditioning(kokoro, voice, shot['line'], path)
        entries.append({'shot': shot['id'], 'speaker': shot['speaker'], 'voiceId': voice['id'],
                        'preset': voice['preset'], 'speed': voice['speed'], 'language': voice['language'],
                        'text': shot['line'], 'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                        'speechSeconds': speech_seconds, 'conditioningSeconds': conditioning_seconds,
                        'slotSeconds': shot['seconds'], 'fitsSlot': conditioning_seconds <= shot['seconds'],
                        'prompt': speech_prompt(shot), 'gpuValidated': False})
    (output / 'conditioning.json').write_text(json.dumps({'status': 'prepared-not-gpu-validated', 'shots': entries}, indent=2) + '\n')
    print(json.dumps({'prepared': len(entries), 'overfull': [e['shot'] for e in entries if not e['fitsSlot']],
                      'status': 'prepared-not-gpu-validated'}))


if __name__ == '__main__':
    main()
