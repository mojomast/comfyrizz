"""Generate pinned FLUX still references for a native FastH3 video production.

Usage: python nrcu_reference_run.py ROOT PLAN OUTPUT_SUBDIR [--ids ID ...]
All videos are produced separately by fasth3_run.py. Saves submitted graphs,
input hashes, prompt IDs and output hashes; refuses uncertain prior attempts.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import time

from PIL import Image, ImageOps

from fasth3_run import request, write


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('root',type=Path);p.add_argument('plan');p.add_argument('output')
    p.add_argument('--ids',nargs='+');p.add_argument('--max-seconds',type=float,default=900)
    a=p.parse_args();root=a.root.resolve();out=root/a.output;out.mkdir(parents=True,exist_ok=True)
    comfy=root.parent/'ComfyUI';deadline=time.monotonic()+a.max_seconds
    for spec in json.loads((root/a.plan).read_text())['images']:
        if a.ids and spec['id'] not in a.ids:continue
        if time.monotonic()>deadline:raise TimeoutError('Reference batch budget exceeded')
        template='flux3_klein_ref_edit.api.json' if spec['refs'] else 'flux3_klein_t2i.api.json'
        g=json.loads((root/template).read_text());hashes={}
        for i,rel in enumerate(spec['refs']):
            src=(root/rel).resolve()
            if not src.is_relative_to(root):raise ValueError('Input escapes root')
            digest=hashlib.sha256(src.read_bytes()).hexdigest();name=digest+'-landscape.png'
            # ReferenceMultiLatent follows its first image's aspect ratio. Keep
            # character portraits intact while authoring landscape film frames.
            ImageOps.pad(Image.open(src).convert('RGB'),(1344,768),color=(10,20,30)).save(comfy/'input'/name)
            hashes[rel]={'source':digest,'prepared':hashlib.sha256((comfy/'input'/name).read_bytes()).hexdigest()}
            node='10' if i==0 else str(30+i)
            g[node]={'class_type':'LoadImage','inputs':{'image':name}}
            g['12']['inputs'][f'images.image{i}']=[node,0]
        g['4']['inputs']['text']=spec['prompt'];g['7']['inputs']['steps']=12
        g['7']['inputs']['seed']=int(hashlib.sha256(spec['id'].encode()).hexdigest()[:8],16)
        g['9']['inputs']['filename_prefix']='nrcu/'+spec['id']
        if '6' in g:g['6']['inputs'].update(width=1344,height=768)
        else:g['12']['inputs']['resolution.megapixels']=1.0
        key=hashlib.sha256(json.dumps({'graph':g,'refs':hashes},sort_keys=True).encode()).hexdigest()
        receipt=out/(spec['id']+'.json');png=receipt.with_suffix('.png')
        if receipt.exists():
            old=json.loads(receipt.read_text())
            if old.get('key')==key and old.get('status')=='succeeded' and png.exists() and hashlib.sha256(png.read_bytes()).hexdigest()==old['sha256']:
                print('CACHED',spec['id'],flush=True);continue
            raise RuntimeError('Prior attempt needs review: '+spec['id'])
        d={'id':spec['id'],'key':key,'graph':g,'refs':hashes,'status':'submission_unknown','started':time.time()};write(receipt,d)
        result=request('/prompt',{'prompt':g,'client_id':'nrcu-references'})
        if result.get('node_errors') or not result.get('prompt_id'):raise RuntimeError(result)
        pid=result['prompt_id'];d.update(status='running',promptId=pid);write(receipt,d)
        print('SUBMITTED',spec['id'],pid,flush=True)
        while time.monotonic()<deadline:
            h=request('/history/'+pid).get(pid)
            if h:
                if h.get('status',{}).get('status_str')=='error':
                    d.update(status='failed',history=h);write(receipt,d);raise RuntimeError(json.dumps(h)[-6000:])
                images=[im for n in h['outputs'].values() for im in n.get('images',[]) if im.get('type')=='output']
                if not images:raise RuntimeError('No saved image')
                item=images[0];src=(comfy/'output'/item.get('subfolder','')/item['filename']).resolve()
                if not src.is_relative_to(comfy/'output'):raise ValueError('Output escapes root')
                shutil.copy2(src,png);d.update(status='succeeded',seconds=time.time()-d['started'],sha256=hashlib.sha256(png.read_bytes()).hexdigest())
                write(receipt,d);print('SUCCEEDED',spec['id'],round(d['seconds'],2),flush=True);break
            time.sleep(2)
        else:
            request('/interrupt',{});d.update(status='timed_out');write(receipt,d);raise TimeoutError(spec['id'])


if __name__=='__main__':main()
