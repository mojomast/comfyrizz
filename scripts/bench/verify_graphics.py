"""Decode all benchmark videos and build a first/middle/last-frame review sheet."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile


def main():
    from PIL import Image, ImageDraw
    parser = argparse.ArgumentParser()
    parser.add_argument('folder', type=Path)
    args = parser.parse_args()
    target = args.folder / 'review'
    target.mkdir(exist_ok=True)
    with zipfile.ZipFile(args.folder / 'output.zip') as z:
        for name in z.namelist():
            if name.startswith('out/') and Path(name).suffix in ['.mp4', '.json']:
                (target / Path(name).name).write_bytes(z.read(name))
    videos = sorted(target.glob('*.mp4'))
    sheet = Image.new('RGB', (960, len(videos) * 204), '#15191f')
    draw = ImageDraw.Draw(sheet)
    reports = []
    for row, video in enumerate(videos):
        data = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-of', 'json', str(video)]))
        stream = next(s for s in data['streams'] if s['codec_type'] == 'video')
        frames = int(stream['nb_read_frames'])
        decode = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-f', 'null', '-'], capture_output=True, text=True)
        report = {'file': video.name, 'frames': frames, 'width': stream['width'], 'height': stream['height'],
                  'fps': stream['r_frame_rate'], 'decodeOk': decode.returncode == 0 and not decode.stderr.strip(),
                  'sha256': hashlib.sha256(video.read_bytes()).hexdigest()}
        report['technicalPass'] = report['decodeOk'] and frames == 289 and stream['width'] == 1024 and stream['height'] == 576 and stream['r_frame_rate'] == '24/1'
        reports.append(report)
        draw.text((8, row * 204 + 4), video.name, fill='white')
        for column, frame in enumerate([0, frames // 2, frames - 1]):
            png = target / f'{video.stem}-{frame}.png'
            subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-vf', f'select=eq(n\\,{frame}),scale=320:180', '-frames:v', '1', '-y', str(png)], check=True)
            sheet.paste(Image.open(png).convert('RGB'), (column * 320, row * 204 + 24))
    sheet.save(target / 'contact-sheet.jpg', quality=92)
    (target / 'verification.json').write_text(json.dumps(reports, indent=2))
    print(json.dumps({'videos': len(videos), 'passed': sum(r['technicalPass'] for r in reports), 'contactSheet': str(target / 'contact-sheet.jpg')}))
    if not videos or not all(r['technicalPass'] for r in reports):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
