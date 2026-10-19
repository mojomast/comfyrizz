"""Gain-only loudness matching and publication of the controlled listening examples."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import wave
import zipfile


def loudness(path):
    result = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', str(path), '-af',
        'loudnorm=I=-19:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True, check=True)
    report = json.loads(result.stderr[result.stderr.rfind('{'):result.stderr.rfind('}') + 1])
    return {k: float(report[k]) for k in ['input_i', 'input_tp', 'input_lra', 'input_thresh']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--publish', required=True, type=Path)
    args = parser.parse_args()
    source = args.run / 'listening-source'
    source.mkdir(exist_ok=True)
    with zipfile.ZipFile(args.run / 'output.zip') as z:
        for name in z.namelist():
            if name.startswith('out/') and not name.endswith('/'):
                relative = Path(name).relative_to('out')
                assert len(relative.parts) == 1
                (source / relative).write_bytes(z.read(name))
    records = json.loads((source / 'quality.json').read_text())
    assert len(records) == 27, 'Missing expected experiment outputs'
    for record in records:
        record['rawLoudness'] = loudness(source / record['file'])
        assert math.isfinite(record['rawLoudness']['input_i'])
    # One common target, reduced if any sample's crest factor requires more peak headroom.
    target = math.floor(min(-19, *(r['rawLoudness']['input_i'] - r['rawLoudness']['input_tp'] - 1.5 for r in records)) * 10) / 10
    dest = args.publish
    for name in ['raw', 'audio', 'pairs']:
        (dest / name).mkdir(parents=True, exist_ok=True)
    for record in records:
        original = source / record['file']
        shutil.copy2(original, dest / 'raw' / record['file'])
        gain = target - record['rawLoudness']['input_i']
        normalized = dest / 'audio' / record['file']
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(original), '-af', f'volume={gain:.6f}dB',
                        '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', str(normalized)], check=True)
        record['normalizedLoudness'] = loudness(normalized)
        assert abs(record['normalizedLoudness']['input_i'] - target) < 0.25
        assert record['normalizedLoudness']['input_tp'] <= -1.4
        with wave.open(str(normalized)) as f:
            assert f.getframerate() == 24000 and f.getnchannels() == 1
            assert abs(f.getnframes() / 24000 - record['seconds']) < 0.001
        record['gainDb'] = gain
        record['audio'] = 'audio/' + record['file']
        record['raw'] = 'raw/' + record['file']
        record['wordsPerMinute'] = round(len(record['text'].split()) * 60 / record['seconds'], 1)
        record['sha256'] = hashlib.sha256(normalized.read_bytes()).hexdigest()
    groups = []
    task = json.loads((source / 'task.json').read_text())
    for script in task['scripts']:
        groups.append({'id': 'custom-' + script['id'], 'title': script['title'], 'family': 'Qwen',
            'change': 'Performance direction only', 'beforeLabel': 'Ryan · no delivery instruction',
            'afterLabel': 'Ryan · directed delivery', 'text': script['text'],
            'description': 'Same CustomVoice speaker, words, synthesis mode and paired seed. The candidate adds a concise delivery instruction.',
            'listenFor': 'Does the emphasis fit the meaning? Does it sound like someone talking to you, rather than reading at you?',
            'instruction': script['direction'],
            'takes': [{'label': f'Take {i+1} · seed {seed}', 'before': f"custom-{script['id']}-before-{seed}",
                       'after': f"custom-{script['id']}-after-{seed}"} for i, seed in enumerate(task['seeds'])]})
    definitions = [
        ('phrasing', 'Punctuation and thought groups', 'Punctuation only', 'Original punctuation', 'Thought-group punctuation',
         'Same words and archived synthetic voice reference. The candidate changes punctuation and sentence boundaries.',
         'Listen for the contrast after faster, the pause around room to breathe, and whether the shorter units feel choppy.'),
        ('fulltext', 'Full-text context for the clone', 'Text-input mode only', 'Default simulated-streaming text mode', 'Full-text input mode',
         'Same words, punctuation, reference and seed. The candidate sets non_streaming_mode=True. This changes text conditioning, not the audio file format.',
         'Does the sentence have a clearer overall arc? This mode is an experiment, not a guaranteed quality improvement.'),
        ('reference', 'Direct the reference performance', 'New designed reference', 'Existing documentary reference', 'Conversational reference',
         'Same output text and clone settings; the candidate uses a newly designed reference with the same reference transcript. VoiceDesign can also change timbre, so this is a reference-package comparison.',
         'Listen for warmth and variation, and also whether the speaker identity still suits the project. Audition the references below.'),
    ]
    for key, title, change, before, after, description, listen in definitions:
        groups.append({'id': 'base-' + key, 'title': title, 'family': 'Qwen', 'change': change,
            'beforeLabel': before, 'afterLabel': after, 'description': description, 'listenFor': listen,
            'text': task['scripts'][1]['text'], 'afterText': task['phrasedText'] if key == 'phrasing' else None,
            'instruction': task['referenceDirection'] if key == 'reference' else None,
            'takes': [{'label': f'Take {i+1} · seed {seed}', 'before': f'base-before-{seed}', 'after': f'base-{key}-{seed}'} for i, seed in enumerate(task['seeds'])]})
    for key, title, change, before_id, after_id, before, after, description in [
        ('context', 'Let short sentences share context', 'Chunking only', 'kokoro-sentence', 'kokoro-context',
         'Current sentence-by-sentence path', 'One coherent paragraph',
         'Same am_michael voice, words and 0.98 speed. Before uses the current 150 ms sentence gaps; the candidate lets the model phrase the whole paragraph.'),
        ('pace', 'A small pacing adjustment', 'Speed only', 'kokoro-context', 'kokoro-pace',
         'Paragraph · speed 0.98', 'Paragraph · speed 0.93',
         'Same voice, text and chunking. The candidate changes the model duration control, rather than stretching the rendered audio.'),
        ('blend', 'Audition a voice blend', 'Voice casting only', 'kokoro-context', 'kokoro-blend',
         'am_michael', '70% Michael + 30% Fenrir',
         'Same text, chunking and 0.98 speed. The candidate blends preset voice vectors. This changes the voice character and is a taste decision, not a universal upgrade.'),
    ]:
        groups.append({'id': 'kokoro-' + key, 'title': title, 'family': 'Kokoro', 'change': change,
            'beforeLabel': before, 'afterLabel': after, 'description': description, 'text': task['kokoroText'],
            'listenFor': 'Listen for smooth joins, comfortable pauses and a voice you would want to hear for a whole video.',
            'takes': [{'label': 'CPU sample', 'before': before_id, 'after': after_id}]})
    lookup = {r['id']: r for r in records}
    for group in groups:
        for i, take in enumerate(group['takes']):
            pair_name = f"{group['id']}-take{i+1}.wav"
            with wave.open(str(dest / 'pairs' / pair_name), 'wb') as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(24000)
                for index, member in enumerate(['before', 'after']):
                    if index:
                        output.writeframes(b'\0' * (24000 * 2 * 4 // 5))
                    with wave.open(str(dest / lookup[take[member]]['audio'])) as inp:
                        output.writeframes(inp.readframes(inp.getnframes()))
            take['pair'] = 'pairs/' + pair_name
    data = {'title': 'Hear the difference', 'date': task['date'], 'targetLufs': target,
            'normalization': 'One constant gain per clip; a common integrated loudness target; no compression, EQ, music or time stretching.',
            'samples': records, 'groups': groups, 'references': ['reference-before', 'reference-after-42', 'reference-after-73'],
            'checked': sum(r['intelligibilityPass'] for r in records), 'total': len(records),
            'perceptualReview': 'Candidate changes, not a claimed listening-test winner. ASR checks words, not naturalness. Two Qwen takes are included without selecting a favorite seed.'}
    (dest / 'comparison.json').write_text(json.dumps(data, indent=2))
    for name in ['models.lock.json', 'task.json', 'kokoro.json', 'reference-before.json']:
        shutil.copy2(source / name, dest / name)
    shutil.copy2(Path(__file__).with_name('tts-listening.html'), dest / 'index.html')
    (dest / 'README.txt').write_text('TTS expression listening lab\n\nBefore/after pairs contain BEFORE, 0.8 seconds silence, then CANDIDATE AFTER.\n'
        'All main comparisons preserve words; the punctuation test changes punctuation only. The reference and voice-blend comparisons can change timbre.\n'
        f'Common loudness target: {target} LUFS. Gain-only normalization; raw originals included.\n'
        'Naturalness is a listening preference; transcription correctness is not a naturalness score.\n'
        'Both Qwen seeds are retained. See comparison.json for every setting and transcript.\n')
    with zipfile.ZipFile(dest / 'examples.zip', 'w', zipfile.ZIP_DEFLATED) as z:
        for name in ['raw', 'audio', 'pairs']:
            for p in sorted((dest / name).glob('*.wav')):
                z.write(p, str(p.relative_to(dest)))
        for name in ['comparison.json', 'models.lock.json', 'task.json', 'kokoro.json', 'reference-before.json', 'README.txt']:
            z.write(dest / name, name)
    report = {'samples': len(records), 'intelligibilityPasses': data['checked'], 'comparisons': len(groups),
              'pairedTracks': sum(len(g['takes']) for g in groups), 'targetLufs': target,
              'maxLoudnessError': max(abs(r['normalizedLoudness']['input_i']-target) for r in records),
              'highestTruePeak': max(r['normalizedLoudness']['input_tp'] for r in records),
              'bundleBytes': (dest / 'examples.zip').stat().st_size}
    (dest / 'verification.json').write_text(json.dumps(report, indent=2))
    (args.run.parent / 'publication-verification.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
