// Publish a lightweight live production view inside the existing private app.
// Usage: node nrcu-live.mjs <web-dist/nrcu-pilot> (status.json is owner-updated).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const out = resolve(process.argv[2]);
mkdirSync(join(out, 'clips'), { recursive: true });
mkdirSync(join(out, 'images'), { recursive: true });
writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermes pilot · Live production</title><style>
:root{color-scheme:dark}body{margin:0;background:#0b141b;color:#e8edf0;font:16px/1.55 system-ui,sans-serif}main{max-width:1160px;margin:32px auto;padding:0 24px}a{color:#ffca79}.eyebrow{color:#88c9cf;letter-spacing:2px;font-size:12px}h1{font-size:clamp(30px,5vw,52px);line-height:1.1;margin:12px 0}h2{font-size:22px}p{color:#bbc6d1}.status{border:1px solid #33515e;background:#13232d;border-radius:12px;padding:20px;margin:24px 0}.pill{display:inline-block;background:#284551;color:#aee6e4;border-radius:20px;padding:4px 12px;font-size:13px}progress{width:100%;height:16px;accent-color:#efb55c}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:18px}.card{background:#15232b;padding:14px;border-radius:10px;min-width:0}.card h3{font-size:16px;margin:4px 0 12px}.card video,.card img,video.feature{width:100%;border-radius:6px;background:#05090c}small{color:#91a7b3}ol{padding-left:22px}.facts{display:flex;flex-wrap:wrap;gap:8px 28px}#connection{font-size:13px}#final{margin:24px 0}button{background:#f4bb69;border:0;border-radius:7px;padding:10px 16px;color:#101820;cursor:pointer}</style></head>
<body><main><a href="/">← ComfyRizz</a><p class="eyebrow">NOUS RESEARCH CINEMATIC UNIVERSE / LIVE PRODUCTION</p>
<h1>Hermes: The Unfinished Dawn</h1><p><b id="episode-title">The Lower Road</b> · <span id="runtime">Pilot</span> · FastH3 Omni video · Don Piedro speaks broken English</p>
<section class="status"><span class="pill" id="phase">Connecting</span><h2 id="message">Loading production status…</h2><progress id="progress" max="20" value="0"></progress><div class="facts"><p id="count">0 / 20 video shots</p><p id="gpu"></p><p id="budget"></p></div><small id="updated"></small><p id="connection"></p></section>
<section id="final" hidden></section><section><h2>Latest events</h2><ol id="events"></ol></section>
<section><h2>Generated shots</h2><p>Clips appear as each take is downloaded and hash-verified. These are working takes; the final edit follows review.</p><div id="clips" class="grid"></div></section>
<section><h2>Character and scene references</h2><div id="images" class="grid"></div></section>
</main><script>
const seenClips=new Map(),seenImages=new Map();
const el=id=>document.getElementById(id);
function card(item,kind){const d=document.createElement('article');d.className='card';const h=document.createElement('h3');h.textContent=item.title||item.id;d.append(h);const media=document.createElement(kind==='clip'?'video':'img');media.src=item.url;if(kind==='clip'){media.controls=true;media.playsInline=true;media.preload='metadata'}else{media.loading='lazy';media.alt=item.title||item.id}d.append(media);if(item.note){const p=document.createElement('p');p.textContent=item.note;d.append(p)}return d}
function updateCards(items,seen,container,kind){for(const item of items||[]){const key=JSON.stringify(item),old=seen.get(item.id);if(old?.key===key)continue;const node=card(item,kind);if(old)old.node.replaceWith(node);else el(container).append(node);seen.set(item.id,{key,node})}}
async function update(){try{
  const r=await fetch('status.json?t='+Date.now(),{cache:'no-store'});if(!r.ok)throw Error(r.status);const s=await r.json();
  el('episode-title').textContent=s.episodeTitle||'The Lower Road';
  el('runtime').textContent=s.durationSeconds?s.durationSeconds+' seconds':'Pilot';
  el('phase').textContent=s.phase;el('message').textContent=s.message;
  el('progress').max=s.totalShots||20;el('progress').value=s.completedShots||0;
  el('count').textContent=(s.completedShots||0)+' / '+(s.totalShots||20)+' video shots';
  el('gpu').textContent=s.gpu||'';el('budget').textContent=s.budget||'';
  el('updated').textContent='Updated '+new Date(s.updatedAt).toLocaleString();
  el('connection').textContent='Live page refreshes every 5 seconds.';
  el('events').replaceChildren(...(s.events||[]).slice(-8).reverse().map(e=>{const li=document.createElement('li');li.textContent=e;return li}));
  updateCards(s.clips,seenClips,'clips','clip');updateCards(s.images,seenImages,'images','image');
  if(s.final&&el('final').dataset.url!==s.final.url){
    el('final').hidden=false;el('final').dataset.url=s.final.url;
    const h=document.createElement('h2');h.textContent=s.final.title||'Pilot cut';
    const v=document.createElement('video');v.className='feature';v.controls=true;v.playsInline=true;v.preload='metadata';v.src=s.final.url;
    const track=document.createElement('track');track.kind='captions';track.src=s.final.captions||'captions.vtt';track.srclang='en';track.label='English';v.append(track);
    const a=document.createElement('a');a.href=s.final.url;a.textContent='Download the pilot';a.download='';
    const p=document.createElement('p');const player=document.createElement('a');player.href=s.final.player||'https://mail.tailec998.ts.net:8455/';player.textContent='Open the pilot player and 1080p download';p.append(player);
    el('final').replaceChildren(h,v,a,p);
  }
}catch(e){el('connection').textContent='Status connection interrupted; retrying automatically.'}}
update();setInterval(update,5000);
</script></body></html>`);
console.log('Published live pilot page:', out);
