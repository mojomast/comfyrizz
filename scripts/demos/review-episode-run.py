"""Audit locally preserved episode takes without generating media or editing a project.

Requires Pillow; --whisper-model additionally requires faster-whisper. Speech
recognition is evidence for review, not an automatic creative approval.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
from difflib import SequenceMatcher

from PIL import Image, ImageDraw, ImageFont


def command(*args):
    return subprocess.run(args, check=True, capture_output=True).stdout


def words(text):
    return re.findall(r"[a-z0-9']+", text.lower())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('runtime', type=pathlib.Path)
    parser.add_argument('package')
    parser.add_argument('run')
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--whisper-model')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    root = args.runtime / 'runs' / args.run
    pkg_path = args.runtime / 'packages' / f'{args.package}.json'
    pkg = json.loads(pkg_path.read_text())
    staged = json.loads((root / 'work/package.json').read_text())
    jobs = json.loads((root / 'work/jobs.json').read_text())
    takes = json.loads((args.runtime / 'takes' / f'{args.package}.json').read_text())
    (args.output / 'package-snapshot.json').write_text(json.dumps(pkg, indent=2))
    rows = []
    model = None
    if args.whisper_model:
        from faster_whisper import WhisperModel
        model = WhisperModel(args.whisper_model, device='cpu', compute_type='int8', cpu_threads=4)
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
    for scene in pkg['scenes']:
        asset_id = scene.get('background', {}).get('asset')
        clip = takes.get('clips', {}).get(asset_id, {})
        take = next((t for t in clip.get('takes', []) if t.get('runId') == args.run and not t.get('purged')), None)
        if not take or pkg['assets'][asset_id]['kind'] != 'video':
            continue
        file = args.runtime / 'packages' / args.package / take['file']
        probe = json.loads(command('ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(file)))
        video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
        audio = next((s for s in probe['streams'] if s['codec_type'] == 'audio'), None)
        duration = float(video.get('duration', probe['format']['duration']))
        decode = subprocess.run(['ffmpeg', '-v', 'error', '-threads', '2', '-i', str(file), '-f', 'null', '-'], capture_output=True)
        row = {'scene': scene['id'], 'asset': asset_id, 'file': str(file), 'expected': scene.get('narration', ''),
               'speaker': scene.get('speaker'), 'notes': scene.get('notes'), 'sourceSeconds': duration,
               'timelineSeconds': scene['preferredFrames'] / pkg['format']['fps'],
               'stagedTimelineSeconds': next(s['preferredFrames'] for s in staged['scenes'] if s['id'] == scene['id']) / pkg['format']['fps'],
               'sha256Matches': hashlib.sha256(file.read_bytes()).hexdigest() == take['sha256'],
               'width': video['width'], 'height': video['height'], 'fps': video['avg_frame_rate'], 'audio': audio is not None,
               'decodeOk': decode.returncode == 0 and not decode.stderr.strip(), 'decodeErrors': decode.stderr.decode()}
        background = scene.get('background', {})
        row['trimStartSeconds'] = background.get('trim', {}).get('startSeconds', 0)
        row['speed'] = background.get('speed', 1)
        row['sourceNeededSeconds'] = row['trimStartSeconds'] + row['timelineSeconds'] * row['speed']
        row['overrunsSource'] = row['sourceNeededSeconds'] > duration + 1 / pkg['format']['fps']
        tiles = []
        job = next((j for j in jobs['jobs'] if j['id'].split('.')[0] == asset_id), {})
        reference = staged['assets'][asset_id].get('gen', {}).get('inputs', {}).get('image')
        ref_file = root / 'out/assets' / f'{reference}.png'
        if ref_file.exists():
            tiles.append(('Input keyframe', Image.open(ref_file).convert('RGB')))
        for label, seconds in [('Start', .25), ('Middle', duration / 2), ('End', max(.25, duration - .25))]:
            target = args.output / f'{scene["id"]}-{label.lower()}.jpg'
            command('ffmpeg', '-v', 'error', '-y', '-threads', '2', '-ss', str(seconds), '-i', str(file), '-frames:v', '1', '-vf', 'scale=448:-1', str(target))
            tiles.append((f'{label} {seconds:.2f}s', Image.open(target).convert('RGB')))
        sheet = Image.new('RGB', (448 * 4, 330), '#101820')
        draw = ImageDraw.Draw(sheet)
        draw.text((8, 5), f'{scene["id"]}: {scene.get("copy", {}).get("headline", "")} | timeline {row["timelineSeconds"]:.2f}s / source {duration:.2f}s', font=font, fill='white')
        draw.text((8, 26), (row['expected'] or '[No speech]')[:190], font=font, fill='#ffdc99')
        for index, (label, image) in enumerate(tiles):
            image.thumbnail((448, 252))
            sheet.paste(image, (448 * index, 52))
            draw.text((448 * index + 5, 308), label, font=font, fill='white')
        sheet.save(args.output / f'{scene["id"]}-strip.jpg', quality=90)
        if model and audio:
            import numpy as np
            pcm = command('ffmpeg', '-v', 'error', '-i', str(file), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-')
            samples = np.frombuffer(pcm, dtype=np.float32).copy()
            row['audioPeak'] = float(np.max(np.abs(samples))) if samples.size else 0
            segments, _ = model.transcribe(samples, beam_size=5, language='en', word_timestamps=True, vad_filter=True,
                                           condition_on_previous_text=False)
            segments = list(segments)
            row['transcript'] = ' '.join(s.text.strip() for s in segments)
            row['words'] = [{'word': w.word, 'start': float(w.start), 'end': float(w.end), 'probability': float(w.probability)} for s in segments for w in (s.words or [])]
            row['transcriptSimilarity'] = SequenceMatcher(None, words(row['expected']), words(row['transcript'])).ratio()
            row['speechEnd'] = max((w['end'] for w in row['words']), default=0)
            row['speechPastCut'] = bool(row['expected']) and row['speechEnd'] > row['sourceNeededSeconds'] + .05
        rows.append(row)
        (args.output / 'audit.json').write_text(json.dumps({'packageRevision': pkg['revision'], 'run': args.run, 'shots': rows}, indent=2))
        print(json.dumps({k: v for k, v in row.items() if k not in ('words', 'notes', 'file')}), flush=True)
    for start in range(0, len(rows), 6):
        sheet = Image.new('RGB', (1792, 330 * min(6, len(rows) - start)))
        for index, row in enumerate(rows[start:start + 6]):
            sheet.paste(Image.open(args.output / f'{row["scene"]}-strip.jpg'), (0, index * 330))
        sheet.save(args.output / f'contact-{start // 6 + 1:02d}.jpg', quality=88)


if __name__ == '__main__':
    main()
