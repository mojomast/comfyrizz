/** Publish a verified demo without changing any other player or rebuilding the app. */
import {copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const [input,destination]=process.argv.slice(2);
if(!input||!destination)throw Error('Usage: node scripts/demos/publish.mjs <completed-pipeline-run> <static-directory>');
const run=resolve(input), target=resolve(destination), marker='.comfyrizz-rich-demo.json';
const json=file=>JSON.parse(readFileSync(file,'utf8'));
const verification=json(join(run,'verification.json'));
const state=json(join(run,'state.json'));
if(state.status!=='completed')throw Error('Pipeline must be completed before publication');
if(!verification.checks||!Object.keys(verification.checks).length||!Object.values(verification.checks).every(value=>value===true))throw Error('All pipeline verification checks must pass before publication');
const pkg=json(join(run,'work/package.json'));
const timeline=json(join(run,'work/timeline.json'));
if(pkg.id!==state.packageId||state.result?.frames!==timeline.durationInFrames||state.result?.fps!==timeline.fps)throw Error('Completed result and timeline do not match');
const exports=join(run,'exports',pkg.id);
for(const file of ['video.mp4','package.zip','captions.srt','captions.vtt','CREDITS.md'])if(!existsSync(join(exports,file)))throw Error(`Missing verified export ${file}`);
if(existsSync(target)&&(lstatSync(target).isSymbolicLink()||!existsSync(join(target,marker))))throw Error('Refusing to replace an unmanaged publication');
mkdirSync(dirname(target),{recursive:true});
const out=mkdtempSync(join(dirname(target),`.${basename(target)}-publish-`));
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scenes=new Map(pkg.scenes.map(scene=>[scene.id,scene]));
const chapters=timeline.scenes.map(scene=>({seconds:scene.from/timeline.fps,title:scenes.get(scene.id)?.copy?.headline??scene.id,recipe:scenes.get(scene.id)?.motion?.recipe??null}));
try{
  for(const file of ['video.mp4','package.zip','captions.srt','captions.vtt','CREDITS.md'])copyFileSync(join(exports,file),join(out,file));
  copyFileSync(join(run,'verification.json'),join(out,'verification.json'));
  copyFileSync(join(run,'work/package.json'),join(out,'package.json'));
  writeFileSync(join(out,'chapters.json'),JSON.stringify(chapters,null,2));
  writeFileSync(join(out,'script.md'),`# ${pkg.title}\n\n`+pkg.scenes.map(s=>`## ${s.copy?.headline??s.id}\n\n${s.narration??''}\n`).join('\n'));
  const frame=Math.min(timeline.durationInFrames-1,Math.floor(timeline.fps*4));
  execFileSync('ffmpeg',['-v','error','-ss',String(frame/timeline.fps),'-i',join(out,'video.mp4'),'-frames:v','1','-vf','scale=960:-2','-q:v','3',join(out,'poster.jpg')]);
  const generated=Object.values(pkg.assets).filter(a=>a.origin==='generated');
  const stills=generated.filter(a=>a.kind==='image').length, plates=generated.filter(a=>a.kind==='video').length;
  writeFileSync(join(out,'index.html'),`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(pkg.title)} · Comfyrizz</title><style>
  *{box-sizing:border-box}body{margin:0;background:#101922;color:#f3eee3;font:17px/1.65 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:36px 22px 64px}.eyebrow{font-size:12px;letter-spacing:.22em;color:#e3b980}h1{font-size:clamp(32px,5vw,64px);line-height:1.1;max-width:1000px;margin:22px 0}video{width:100%;max-height:76vh;background:#070c12;border:1px solid #354552;border-radius:10px}.meta{color:#b9c7ce}nav{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}a{color:#e3b980}button,.download{background:#1c2b38;border:1px solid #52606c;border-radius:6px;padding:10px 14px;color:#f3eee3;font:inherit;text-decoration:none;cursor:pointer}button:hover,button:focus-visible,.download:hover{border-color:#e3b980}.chapters{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px}.chapters button{text-align:left}.chapters small{display:block;color:#bacad6}footer{border-top:1px solid #354552;margin-top:30px;padding-top:16px}
  </style></head><body><main><div class="eyebrow">COMFYRIZZ / RICH STORYTELLING COLLECTION</div><h1>${esc(pkg.title)}</h1><p class="meta">${timeline.scenes.length} scenes · ${stills} generated stills · ${plates} motion plates · original score · narrated in ${Math.round(timeline.durationInFrames/timeline.fps)} seconds</p>
  <video id="player" controls playsinline preload="metadata" poster="poster.jpg" src="video.mp4"><track kind="captions" label="English" srclang="en" src="captions.vtt"></video>
  <nav aria-label="Downloads"><a class="download" href="video.mp4" download>Download MP4</a><a class="download" href="package.zip" download>Editable project</a><a class="download" href="script.md">Read the script</a><a class="download" href="CREDITS.md">Sources & credits</a><a class="download" href="verification.json">Technical verification</a></nav>
  <h2>Chapters</h2><div class="chapters">${chapters.map((c,i)=>`<button data-seek="${c.seconds}"><small>${String(i+1).padStart(2,'0')} / ${Math.floor(c.seconds/60)}:${String(Math.floor(c.seconds%60)).padStart(2,'0')}${c.recipe?' · '+esc(c.recipe):''}</small>${esc(c.title)}</button>`).join('')}</div>
  <footer><p>Original generated illustrations and motion plates, editable typography, measured narration timing, and frame-driven animation. ${pkg.id.includes('ministry')?'The Ministry of Mandatory Spontaneity is a fictional satire.':''}</p><nav><a href="/rich-ussy/index.html">ussy.host</a><a href="/rich-hermes/index.html">Hermes Agent</a><a href="/rich-ministry/index.html">Mandatory Spontaneity</a><a href="/">Open the editor</a></nav></footer>
  <script>const player=document.querySelector('#player');document.querySelectorAll('[data-seek]').forEach(button=>button.onclick=()=>{player.currentTime=Number(button.dataset.seek);player.play().catch(()=>{})});</script></main></body></html>`);
  writeFileSync(join(out,marker),JSON.stringify({packageId:pkg.id,revision:pkg.revision,frames:timeline.durationInFrames}));
  const backup=`${out}-previous`;
  if(existsSync(target))renameSync(target,backup);
  try{renameSync(out,target);}catch(error){if(existsSync(backup))renameSync(backup,target);throw error;}
  if(existsSync(backup))rmSync(backup,{recursive:true});
  console.log(JSON.stringify({directory:target,frames:timeline.durationInFrames,stills,plates}));
}catch(error){rmSync(out,{recursive:true,force:true});throw error;}
