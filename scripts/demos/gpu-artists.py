"""Prepare the four-minute FastH3 GPU-artists short from preserved film references.

Usage: python gpu-artists.py <previous-production-directory> <new-production-directory>
Media stays outside the repository. No inference or paid allocation happens here.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

from PIL import Image

# Each entry has one visible speaker, one action and enough room for a reaction.
# Durations are an editorial allocation, not the model's slightly longer frame grid.
SHOTS = [
    (8, 'reporter', 'Cold open', 'Medium interview, eyes to camera, holds microphone still.', 'Behind every instant image is a powerful graphics processor. Ours has asked for a chair.'),
    (7, 'manager', 'The tour', 'Tracking medium shot entering the workshop, stops beside a curtain.', 'Welcome to ComfyUI. Please ignore the screaming. That is our cooling system.'),
    (9, 'painter', 'Meet the hardware', 'Close-up, paints one small stroke, looks up with dry exhaustion.', 'I am a graphics processing unit. Before the rebrand, I was a woman with a fine arts degree.'),
    (6, 'engineer', 'GPU', 'Close-up, points to a biscuit tin full of pencils without picking it up.', 'Graphite Processing Unit. Six pencils in a biscuit tin. Water cooled, if the roof leaks.'),
    (10, 'reporter', 'Prompt arrives', 'Medium shot, reads a plain paper request, then looks towards the painter.', 'Today: a lighthouse, underwater, emotionally available, in the style of a tax return. The customer says it should be simple.'),
    (8, 'painter', 'Clarification', 'Close-up with blank canvas behind, considers request, one eyebrow rises.', 'Underwater I can do. Emotionally available costs extra. Nobody here has the reference material.'),
    (8, 'manager', 'Fast inference', 'Medium interview beside a wall clock, proudly folds hands.', 'Our new model completes a picture in eight steps. We have removed seven of the breaks.'),
    (6, 'engineer', 'Benchmark', 'Close-up, slowly raises a tiny kitchen timer.', 'The benchmark is excellent. We timed the fastest person and named everyone after him.'),
    (10, 'painter', 'Negative prompt', 'Medium shot beside an empty space at the workbench where her chair was removed. No chair in frame; she remains standing.', 'They put bad anatomy in the negative prompt. Now the chair has been removed. Apparently my knees were hallucinating.'),
    (8, 'reporter', 'Queue', 'Medium shot, looks down a long line of blank canvases, then back to camera.', 'The queue contains four thousand requests. Three thousand nine hundred are the same raccoon becoming a judge.'),
    (8, 'engineer', 'Seeds', 'Close-up, places a single sunflower seed beside a pencil, keeps hands clear.', 'Every image starts with a seed. Sunflower gives reliable results. Pumpkin keeps generating coaches.'),
    (7, 'manager', 'Reproducibility', 'Centered interview, a confident smile becomes uncertain.', 'Reproducibility means we can reproduce the invoice. The picture is more of a conversation.'),
    (9, 'painter', 'ControlNet', 'Medium shot in a wooden pose frame, hands fixed at shoulder height; sandwich on distant shelf.', 'This is ControlNet. My pose is perfectly constrained. My sandwich is on that shelf. We call this alignment.'),
    (6, 'reporter', 'Control question', 'Close-up, asks a serious question, then closes her mouth.', 'Have you considered moving the sandwich closer? Or is that only available in the enterprise plan?'),
    (10, 'engineer', 'Control answer', 'Medium shot beside a distant sandwich on shelf, never touches it, solemnly shakes head.', 'We tried that. It changed the composition. Then someone said the sandwich had six fingers. It went back into research.'),
    (8, 'manager', 'LoRA', 'Medium shot, displays a small purple cape on a hanger.', 'Our style adapters are very efficient. One cape, and the entire department becomes gothic.'),
    (8, 'painter', 'New style', 'Close-up, drapes a plain cardigan over shoulders and looks directly at interviewer.', 'I trained a new style. It is called paid leave. Management says the dataset is too small.'),
    (6, 'engineer', 'The cloud', 'Medium shot, places a bucket directly under a ceiling drip, feet remain on floor.', 'The cloud is leaking. On the plus side, water cooling is now serverless.'),
    (10, 'reporter', 'The deadline', 'Medium interview by half-painted lighthouse canvas; holds microphone towards empty offscreen space.', 'The lighthouse is due in thirty seconds. The client has requested more authenticity, fewer brushstrokes, and a refund in advance.'),
    (8, 'painter', 'Revision', 'Close-up, examines brush, gently sets it on table, hands become still.', 'They want it handmade, but without any evidence that a person has been involved. I know the feeling.'),
    (8, 'manager', 'The outage', 'Medium shot, watches still workshop, taps clipboard once, stops smiling.', 'We are experiencing a temporary reduction in throughput. Has anybody tried switching the artists off and on?'),
    (7, 'engineer', 'Diagnosis', 'Close-up, looks at kitchen clock and then camera, very calm.', 'The hardware is fine. It is twelve thirty. This is a scheduled sandwich event.'),
    (9, 'painter', 'Negotiation', 'Seated close-up at lunch table, hands resting near covered plate; speaks before eating.', 'We need lunch, chairs, and our names on the pictures. You may describe that as a performance optimization.'),
    (6, 'reporter', 'Management question', 'Close-up, leans forward very slightly, then closes her mouth after the question.', 'Can the business survive lunch breaks, or is the whole business model just hunger?'),
    (10, 'manager', 'Management answer', 'Centered close-up, slowly removes reading glasses and considers the cost.', 'We have run the numbers. If we stop printing inspirational posters, we can afford a second chair. Possibly with a back.'),
    (8, 'engineer', 'Upgrade', 'Medium shot, slides an ordinary chair gently beside the workbench, keeps it upright.', 'The upgrade is live. Lower latency. Better support. Four legs. We are calling it enterprise seating.'),
    (8, 'painter', 'Back to work', 'Medium shot seated comfortably beside an easel with a red and white striped lighthouse painting on canvas. Adds one brushstroke to the canvas. No sculpture or three-dimensional lighthouse model.', 'Look at that. A lighthouse. We left out the underwater bit. The paint kept running.'),
    (6, 'reporter', 'The reveal', 'Medium shot beside a finished lighthouse canvas, smiles very slightly.', 'Delivery time: four minutes. Human effort: considerable. The client has one small change.'),
    (10, 'manager', 'One small change', 'Close-up, reads paper, face falls, long silent look towards camera after speaking.', 'Could the lighthouse be a raccoon? And could the raccoon be a judge? Same budget. Needed yesterday.'),
    (8, 'painter', 'Final button', 'Close-up, calmly turns kitchen timer towards camera, lowers it, holds deadpan look.', 'Of course. Join the queue. We are running on lunch time now.'),
]


def main():
    previous, out = map(lambda p: Path(p).resolve(), sys.argv[1:])
    repo = Path(__file__).resolve().parents[2]
    if out.is_relative_to(repo):
        raise ValueError('Keep production media outside Git')
    out.mkdir(parents=True, exist_ok=True)
    refs = out / 'refs'
    refs.mkdir(exist_ok=True)
    art = previous / 'repair/packages/comfy_mockumentary20261020/assets/a_still6.png'
    image = Image.open(art)
    # A crowded set reference caused a duplicated miniature speaker in pilot v1.
    # This crop contains pipes, an empty chair and workbench, with no people.
    Image.open(art.with_name('a_still8.png')).crop((220, 0, 590, 310)).save(refs / 'workshop.png')
    # Tight face portraits exclude the background workers around the original cast.
    boxes = {'reporter': (236, 135, 350, 294), 'manager': (388, 105, 482, 235),
             'painter': (522, 113, 651, 275), 'engineer': (701, 82, 800, 215)}
    for speaker, box in boxes.items():
        image.crop(box).save(refs / f'{speaker}.png')
    voices = json.loads((previous / 'audio/voice-manifest.json').read_text())
    for speaker in boxes:
        line = next(l for s in voices['segments'] for l in s['lines'] if l['speaker'] == speaker and l['seconds'] >= 4)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(previous / 'audio' / line['file']),
                        '-af', 'loudnorm=I=-20:TP=-2:LRA=7', '-ar', '32000', '-ac', '1', '-c:a', 'pcm_s16le',
                        str(refs / f'{speaker}.wav')], check=True)
    shutil.copy2(repo / 'workflows/fasth3_omni_ref2va.api.json', out / 'workflow.json')
    cast = {'reporter':'Nell, the black-bob-haired woman in a mustard raincoat',
            'manager':'Bram, the bald man with round red glasses and a navy suit',
            'painter':'Ada, the curly red-haired woman in a teal sweater and paint apron',
            'engineer':'Ivo, the dark-haired man in square glasses and purple overalls'}
    shots = []
    cursor = 0
    for i, (seconds, speaker, title, action, line) in enumerate(SHOTS, 1):
        n = seconds * 24
        frames = n + (5 - n % 17) % 17
        prompt = (f'Single continuous clay stop-motion mockumentary shot. The face portrait in <Picture 1> defines {cast[speaker]}; '
                  f'<Picture 2> supplies the warm miniature workshop design only. Exactly one person is visible: {cast[speaker]}. '
                  'One normally proportioned puppet fills the interview framing. No background people or duplicate bodies. '
                  f'Use <Audio 1> as the speaking voice identity, not its words. {action} '
                  f'The only spoken words are: "{line}" Speak naturally in English, beginning at 0.3 seconds, '
                  f'finish before {seconds-0.8:.1f} seconds, then close the mouth and remain completely silent for the rest of the shot. '
                  'Natural face and hand motion. Consistent body scale. Camera stays level. '
                  'Sound: clear close microphone dialogue, quiet workshop ambience, subtle relevant prop sounds. '
                  'No music, no subtitles, no titles, no extra voices, no cuts.')
        shots.append({'id': f's{i:02}', 'title': title, 'speaker': speaker, 'line': line, 'action': action,
                      'start': cursor, 'seconds': seconds, 'frames': frames, 'fps': 24,
                      'width': 1344, 'height': 768, 'seed': 2026102000+i, 'prompt': prompt,
                      'image': f'refs/{speaker}.png', 'reference': 'refs/workshop.png', 'audio': f'refs/{speaker}.wav'})
        cursor += seconds
    assert cursor == 240
    manifest = {'title': 'GPU: Graphite Processing Unit', 'seconds': cursor, 'fps': 24,
                'model': 'fasth3-omni', 'shots': shots,
                'referenceHashes': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(refs.iterdir())}}
    (out / 'film.json').write_text(json.dumps(manifest, indent=2))
    text = '# GPU: Graphite Processing Unit\n\nFour-minute shooting script.\n\n'
    for s in shots:
        text += f'## {s["start"]//60:02}:{s["start"]%60:02} — {s["title"]} ({s["seconds"]}s)\n\n{s["action"]}\n\n**{s["speaker"].title()}:** {s["line"]}\n\n'
    (out / 'screenplay.md').write_text(text)
    print(json.dumps({'out': str(out), 'shots': len(shots), 'seconds': cursor,
                      'words': sum(len(s['line'].split()) for s in shots)}, indent=2))


if __name__ == '__main__':
    main()
