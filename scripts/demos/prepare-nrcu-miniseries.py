"""Prepare a fresh, measured dialogue revision; never edit live projects or run a GPU.

Usage: python prepare-nrcu-miniseries.py PRODUCTION_ROOT NEW_REVISION_DIRECTORY
Writes revision-plan.json, screenplay.md and exact-line conditioning WAVs.
The plan is not a runnable package: rejected visual references still need repair.
"""
import importlib.util
import html
import json
import math
from pathlib import Path
import sys

from nrcu_miniseries_dialogue import DIALOGUE, SCENES, SILENT_SECONDS, direction_for
from nrcu_shot_conditioning import write_conditioning, compile_prompts


def main():
    from kokoro_onnx import Kokoro
    source, output = map(lambda p: Path(p).resolve(), sys.argv[1:3])
    if output.exists():
        raise ValueError('Use a fresh revision directory')
    output.mkdir(parents=True)
    film = json.loads((source / 'film.json').read_text())
    voices = json.loads((source / 'voice-registry.json').read_text())
    cache = Path.home() / '.cache/comfyrizz/kokoro'
    engine = Kokoro(str(cache/'kokoro-v1.0.onnx'), str(cache/'voices-v1.0.bin'))
    spec = importlib.util.spec_from_file_location('episode', Path(__file__).with_name('nrcu-episode2.py'))
    episode = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(episode)
    authored = {row[1]: row for row in episode.OPENING + episode.REPAIR + episode.ENDING}
    rows = []
    for shot in film['shots']:
        sid = shot['id']
        row = {'id': sid, 'speaker': shot['speaker'], 'originalLine': shot['line'],
               'line': DIALOGUE.get(sid, shot['line']), 'originalSeconds': shot['seconds'],
               'reusedPilot': bool(shot.get('reusedFrom')), 'action': authored[sid][5] if sid in authored else shot['action']}
        if row['reusedPilot']:
            row['frames'] = round(shot['seconds'] * 24)
        elif row['line']:
            voice = voices[row['speaker']]
            speech, padded = write_conditioning(engine, voice, row['line'], output / 'conditioning' / f'{sid}.wav')
            # Reserve time for the response to land, beyond the .35s WAV padding.
            reaction = .7 if sid.startswith(('c','d')) else .35
            row.update(conditioningSeconds=padded, speechSeconds=speech, reactionSeconds=reaction,
                       voice={k: voice[k] for k in ['id','preset','speed','language']})
            row['frames'] = math.ceil((padded + reaction) * 24)
        else:
            row['frames'] = round(SILENT_SECONDS.get(sid, shot['seconds']) * 24)
        rows.append(row)
    target = round(film['seconds'] * 24)
    minimum = sum(row['frames'] for row in rows)
    if minimum > target:
        raise ValueError(f'Natural-speed dialogue/reactions require {minimum/24:.2f}s; target is {target/24}s. Revise the script, never accelerate voices.')
    # Explicit editorial breathing room, rather than identical lengths per line.
    holds = [row for row in rows if row['id'] in ['a08','a11','b07','b09','b18','c01','c04','c05','c06','d03','d06']]
    spare = target - minimum
    for i in range(spare):
        holds[i % len(holds)]['frames'] += 1
    cursor = 0
    requests = []
    for row in rows:
        row['startFrame'] = cursor
        row['seconds'] = row['frames'] / 24
        cursor += row['frames']
        if row['reusedPilot']:
            continue
        source_frames = max(124, row['frames'] + 12)
        source_frames += (5 - source_frames % 17) % 17
        row['sourceFrames'] = source_frames
        ref = authored[row['id']]
        direction = direction_for((row['seconds'], *ref[1:7], row['line']), episode.DESIGN)
        row['direction'] = direction
        requests.append({'direction': direction, 'slotSeconds': row['seconds'], 'sourceSeconds': source_frames/24,
                         'conditioningSeconds': row.get('conditioningSeconds')})
    prompts = iter(compile_prompts(requests))
    for row in rows:
        if not row['reusedPilot']:
            row['prompt'] = next(prompts)
    plan = {'status': 'script-revision-not-generated', 'sourceProduction': str(source), 'fps': 24,
            'frames': cursor, 'minimumMeasuredFrames': minimum, 'scenes': SCENES, 'shots': rows,
            'pending': ['correct rejected composition references', 'normal-speed table read', 'small FastH3 validation set',
                        'reconcile with current owner-edited timeline before applying', 'replan within remaining credits']}
    (output/'revision-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
    script = '# The Road Beneath the World — miniseries dialogue revision\n\nScript and conditioning only; no new finished footage.\n\n'
    for scene in SCENES:
        script += f'## {scene["id"].title()}\n\n**Want:** {scene["want"]}\n\n**Turn:** {scene["turn"]}\n\n**Subtext:** {scene["subtext"]}\n\n'
        for row in rows:
            if row['id'] not in scene['shots']:
                continue
            script += f'### {row["startFrame"]/24:.2f}s · {row["id"]} · {row["seconds"]:.2f}s\n\n{row["action"]}\n\n'
            if row['line']:
                script += f'**{row["speaker"]}:** {row["line"]}\n\n'
        if scene['id'] == 'rivalry':
            script += '**Race:** retain all 20 verified pilot shots and their native dialogue (65 seconds).\n\n'
    (output/'screenplay.md').write_text(script)
    cards = []
    for scene in SCENES:
        turns = []
        for row in rows:
            if row['id'] not in scene['shots']:
                continue
            spoken = (f'<p><b>{html.escape(row["speaker"])}:</b> {html.escape(row["line"])}</p>'
                      f'<audio controls preload="none" src="conditioning/{row["id"]}.wav"></audio>') if row['line'] else '<p><em>Action / reaction coverage</em></p>'
            turns.append(f'<article><h3>{row["id"]} · {row["startFrame"]/24:.2f}s · slot {row["seconds"]:.2f}s</h3>'
                         f'<p>{html.escape(row["action"])}</p>{spoken}</article>')
        cards.append(f'<section><h2>{scene["id"].title()}</h2><p><b>Want:</b> {html.escape(scene["want"])}</p>'
                     f'<p><b>Turn:</b> {html.escape(scene["turn"])}</p><p><b>Subtext:</b> {html.escape(scene["subtext"])}</p>' + ''.join(turns) + '</section>')
        if scene['id'] == 'rivalry':
            cards.append('<section><h2>Race — 65 seconds</h2><p>Retain all 20 verified pilot shots with their native dialogue.</p></section>')
    page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermes — miniseries script revision</title><style>body{max-width:960px;margin:auto;padding:24px;background:#101820;color:#edf1f7;font:16px/1.6 system-ui}section{margin:32px 0}article{padding:16px;margin:16px 0;border:1px solid #536174;border-radius:10px}audio{width:100%}a{color:#9cceff}.notice{padding:18px;background:#493423;border-radius:10px}</style>
<h1>The Road Beneath the World</h1><h2>Miniseries dialogue revision</h2>
<div class="notice">Script and conditioning review only. These audio samples are voice inputs, not finished FastH3 performances. Generation remains paused.</div>
<p>240 seconds · 68 shots · 33 revised speaking turns · measured voices plus reaction holds. The original pilot and live owner-edited timeline are preserved.</p>
<p><a href="screenplay.md">Screenplay</a> · <a href="revision-plan.json">Timing and direction plan</a> · <a href="../review-paused/index.html">Original take review</a></p>''' + ''.join(cards) + '</html>'
    (output/'index.html').write_text(page)
    print(json.dumps({'frames':cursor,'seconds':cursor/24,'minimumMeasuredSeconds':minimum/24,'speakingShots':len(DIALOGUE), 'status':plan['status']}))


if __name__ == '__main__':
    main()
