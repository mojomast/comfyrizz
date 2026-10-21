"""Run one reviewed batch and publish each completed artifact to the live UI.

python nrcu-run.py ROOT WEB_DIR images --plan assets [--ids don molty]
python nrcu-run.py ROOT WEB_DIR video --ids s03 s12 s14

Uses the already allocated nrcu-pilot Colab session. No silent retries. Each
download is hash-checked against its receipt before publication. Progress is
event-driven: the UI changes on submission, collection and verification.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('root',type=Path);p.add_argument('web',type=Path)
    p.add_argument('mode',choices=['images','video']);p.add_argument('--plan',choices=['assets','keyframes'],default='assets')
    p.add_argument('--ids',nargs='+');a=p.parse_args()
    root=a.root.resolve();web=a.web.resolve();(root/'logs').mkdir(exist_ok=True)
    state_path=web/'status.json'
    def status(message,**fields):
        d=json.loads(state_path.read_text());d.update(fields,message=message,updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        d.setdefault('events',[]).append(message);d['events']=d['events'][-40:]
        tmp=state_path.with_suffix('.tmp');tmp.write_text(json.dumps(d,indent=2));tmp.replace(state_path)
    def command(argv,**kwargs):
        result=subprocess.run(argv,capture_output=True,text=True,**kwargs)
        if result.returncode:
            # Preserve diagnostics locally, without reflecting remote URLs or
            # runtime proxy credentials into the published status document.
            (root/'logs'/'last-command-error.log').write_text(result.stdout+result.stderr)
            raise RuntimeError(f'{argv[0:2]} failed; see local run log')
        return result.stdout+result.stderr
    film=json.loads((root/'film.json').read_text())
    if a.mode=='images':
        items=json.loads((root/f'{a.plan}-plan.json').read_text())['images']
        output=f'refs/{a.plan}';suffix='.png';phase='Reference images' if a.plan=='assets' else 'Shot keyframes'
    else:
        items=film['shots'];output='outputs';suffix='.mp4';phase='FastH3 video generation'
    if a.ids:items=[i for i in items if i['id'] in a.ids]
    for i,item in enumerate(items,1):
        sid=item['id'];label=item.get('title',sid)
        status(f'{phase}: {label} ({i}/{len(items)} in this batch)',phase=phase,gpu='Colab G4 · active')
        argv=(['python','/content/fasth3/nrcu_reference_run.py','/content/fasth3/film',f'{a.plan}-plan.json',output,'--ids',sid,'--max-seconds','240'] if a.mode=='images' else
              ['python','/content/fasth3/fasth3_run.py','/content/fasth3/film','--shots',sid,'--max-seconds','300'])
        code='import subprocess\nr=subprocess.run('+repr(argv)+')\nprint("NRCU_EXIT",r.returncode)\n'
        try:
            text=command(['colab','exec','-s','nrcu-pilot','--timeout','360'],input=code,timeout=400)
            (root/'logs'/f'{a.mode}-{a.plan}-{sid}.log').write_text(text)
            if not re.search(r'NRCU_EXIT\s+0\b',text):raise RuntimeError('Remote generation failed: '+sid)
            target=root/output;target.mkdir(parents=True,exist_ok=True)
            for ext in ['.json',suffix]:
                command(['colab','download',f'/content/fasth3/film/{output}/{sid}{ext}',str(target/f'{sid}{ext}'),'-s','nrcu-pilot'],timeout=90)
            receipt=json.loads((target/f'{sid}.json').read_text());media=target/f'{sid}{suffix}'
            digest=hashlib.sha256(media.read_bytes()).hexdigest()
            if receipt['status']!='succeeded' or receipt['sha256']!=digest:raise RuntimeError('Receipt verification failed: '+sid)
            d=json.loads(state_path.read_text())
            if a.mode=='images':
                dest=web/'images'/f'{a.plan}-{sid}-{digest[:8]}.png';shutil.copy2(media,dest)
                images=[v for v in d.get('images',[]) if v['id']!=a.plan+'-'+sid]
                images.append({'id':a.plan+'-'+sid,'title':label,'url':'images/'+dest.name})
                status(f'Ready: {a.plan} / {label}',images=images)
            else:
                dest=web/'clips'/f'{sid}-{digest[:8]}.mp4';shutil.copy2(media,dest)
                clips=[v for v in d.get('clips',[]) if v['id']!=sid]
                clips.append({'id':sid,'title':f'{sid} · {label}','url':'clips/'+dest.name,
                              'note':'Raw FastH3 take · review pending'})
                clips.sort(key=lambda c:c['id'])
                status(f'Generated and verified: {sid} · {label}',clips=clips,completedShots=len(clips))
            print('PUBLISHED',sid,digest[:12],flush=True)
        except Exception as exc:
            status(f'Batch paused at {sid}: {exc}',phase='Needs attention')
            raise
    status(f'{phase} batch complete; reviewing the results.',phase='Reviewing')


if __name__=='__main__':main()
