/** Narration-first follow-up: Anonymous, in Triplicate. Runtime output is external. */
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {compileTimeline} from '../../packages/planner/dist/src/index.js';
import {validatePackage} from '../../packages/schema/src/index.mjs';
import {planJobs,checkJobsDoc} from '../../packages/jobs/src/index.mjs';
import {sanitizeSvg,renderCheck,SANITIZER_VERSION} from '../../packages/vector/dist/src/index.js';
import {narrationOptions} from '../../apps/renderer/scripts/render-package-lib.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const [stage,rootArg]=process.argv.slice(2);
if(!['build','time','finish','coverage'].includes(stage)||!rootArg)throw Error('Usage: anonymous.mjs build|time|finish|coverage <external-package-directory>');
const root=resolve(rootArg), file=join(root,'package.json');
const hash=b=>createHash('sha256').update(b).digest('hex');
const palette=['#102C2D','#218B86','#F2E8D5','#BC493C','#B78C48'];
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const style='Cinematic photographed miniature, tactile handmade bureaucratic diorama, cream limestone and dark walnut, institutional teal, warm brass lamps, deep forest green shadows, subtle 35mm grain, realistic paper and wood textures, restrained absurdist comedy. The recurring object is one solid teal rectangular paper form with a small clipped upper-right corner and cream horizontal rules. No readable lettering, no logos. Main action in the central upper two thirds; bottom edge calm and dark for captions. Landscape 16:9.';
const shots=[
  {id:'01',title:'The invitation',n:'The Ministry welcomes anonymous suggestions.',min:3.4,still:'A monumental cream government building seen straight on at dusk. A tiny teal envelope sits on the wide entrance steps. Warm light inside tall windows, symmetrical entrance, no people.',action:'The camera slowly pushes toward the entrance. A gentle breeze moves the corner of the teal envelope; the building remains rigid.'},
  {id:'02',title:'One modest proposal',n:'One citizen had a modest proposal.',min:3.2,still:'Overhead close view of a dark walnut desk. A single teal paper form with clipped upper-right corner and cream horizontal rules lies in the middle. A cream-sleeved hand rests beside a short brass pencil. Blank cream card at top.',action:'The cream-sleeved hand nudges the teal form neatly into the centre of the desk. The fingers release the paper. Locked overhead camera.'},
  {id:'03',title:'Fewer forms',n:'Fewer forms. A radical idea.',min:3.4,card:'proposal'},
  {id:'04',title:'No name, no signature',n:'She used the teal form. No name. No signature.',min:4.8,still:'Close-up of a brass anonymous suggestion box fixed to a cream wall. A cream-sleeved hand holds the clipped-corner teal form just above its horizontal slot. The box has an empty dark label plate. No face visible.',action:'The cream-sleeved hand slowly feeds the single teal paper into the brass slot. The paper slides down until only its top edge remains. The hand withdraws. Locked camera.'},
  {id:'05',title:'Into the system',n:'Her suggestion entered the system.',min:3.2,still:'Low close tracking perspective of a miniature industrial conveyor inside a cream government office. One clipped-corner teal form lies flat on the black belt, brass guides on each side. Warm lamp and dark green background.',action:'The conveyor carries the single teal form smoothly from left to right past brass guides. The camera tracks alongside at the same speed. Paper keeps its rectangular shape.'},
  {id:'06',title:'The Department of Listening',n:'First, the Department of Listening.',min:3.4,still:'A miniature brass listening apparatus on a dark wooden desk, enormous ear-shaped acoustic horns pointing toward a single clipped-corner teal form on a cream tray. Cream walls, tiny empty wooden chair, no humans.',action:'The brass acoustic horn slowly tilts down toward the teal form. The paper stays still while the horn pauses above it. A single deliberate mechanical movement; camera locked.'},
  {id:'07',title:'Internal Silence',n:'Then, two copies for Internal Silence.',min:3.8,still:'Close view of an old cream photocopier in a miniature office. A clipped-corner teal form lies on its glass under a raised lid. A clean teal sheet is visible in the output tray. Dark walnut floor and brass controls, no lettering.',action:'The cream photocopier lid slowly lowers. A warm scanning light sweeps beneath the glass and one teal sheet advances into the output tray. Locked camera; restrained mechanical motion.'},
  {id:'08',title:'Inspection',n:'Finally, the anonymity inspector checked every detail.',min:4.4,reuse:'02',action:'A brass magnifying glass enters from the right, held by a cream-sleeved hand. It travels slowly over the lower part of the teal form and pauses above an empty rule. Locked overhead view.'},
  {id:'09',title:'Rejected',n:'Rejected.',min:2.2,card:'rejected'},
  {id:'10',title:'The missing requirement',n:'Anonymous submissions must be signed.',min:3.5,card:'signature'},
  {id:'11',title:'A simple appeal',n:'Fortunately, the Ministry offers a simple appeals process.',min:4.4,still:'Wide miniature office interior. An absurdly tall tower of cream filing drawers stands on a dark walnut desk. A tiny clipped-corner teal form sits at its base. Brass handles, cream wall, deep green shadows, no people.',action:'One cream filing drawer slowly opens, revealing a thick stack of teal paper. The camera gently tilts upward to reveal more drawers. The tower remains solid and orderly.'},
  {id:'12',title:'This time, a name',n:'She filled out another form. This time, with her name.',min:5.0,reuse:'02',action:'The cream-sleeved hand lowers the brass pencil to the bottom of the teal form and writes a short flowing squiggle. The pencil lifts and the hand retreats. Locked overhead shot; no legible words are required.'},
  {id:'13',title:'Completely confidential',n:'Approved. Completely confidential.',min:3.2,card:'approved'},
  {id:'14',title:'Public display',n:'By lunchtime, her suggestion was on public display.',min:4.5,still:'Symmetrical grand miniature government gallery. One teal paper with clipped upper-right corner is displayed in an ornate brass frame on a cream wall, with a small empty cream plaque beneath. Warm spotlights, dark walnut floor, red velvet rope. No people or text.',action:'The camera slowly pulls back from the framed teal form, revealing the ornate brass frame and red velvet barrier. Warm spotlights remain steady.'},
  {id:'15',title:'For transparency',n:'With her name. For transparency.',min:3.4,card:'public'},
  {id:'16',title:'Use the teal form',n:'Complaints may be submitted anonymously. Use the teal form.',min:5.0,reuse:'04',action:'The cream-sleeved hand holds a new teal form just above the brass suggestion slot, hesitates, then moves the paper a little closer. The camera slowly pulls back. End with the paper still outside the slot.'},
];

function svgCard(kind){
 const base=`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#102C2D"/><rect x="80" y="70" width="1760" height="770" rx="12" fill="#102C2D" stroke="#B78C48" stroke-width="3"/>`;
 const text=(x,y,size,s,color='#F2E8D5')=>`<text x="${x}" y="${y}" font-family="sans-serif" font-size="${size}" font-weight="700" fill="${color}">${esc(s)}</text>`;
 const form=`<path d="M650 180 H1200 L1260 240 V750 H650 Z" fill="#218B86"/><path d="M1200 180 V240 H1260" fill="none" stroke="#F2E8D5" stroke-width="4"/><path d="M710 490 H1190 M710 540 H1190 M710 590 H1190" stroke="#F2E8D5" stroke-width="3" opacity="0.4"/>`;
 if(kind==='proposal')return base+text(150,155,26,'CITIZEN SUGGESTION / 0042', '#B78C48')+form+text(710,340,57,'FEWER')+text(710,410,57,'FORMS.')+'</svg>';
 if(kind==='rejected')return base+form+`<g transform="rotate(-8 960 420)"><rect x="430" y="320" width="1060" height="210" rx="8" fill="#102C2D" stroke="#BC493C" stroke-width="14"/>`+text(510,467,132,'REJECTED','#BC493C')+'</g></svg>';
 if(kind==='signature')return base+text(150,165,26,'ANONYMOUS SUGGESTION / VALIDATION', '#B78C48')+text(150,350,78,'SIGNATURE REQUIRED')+text(150,465,39,'Anonymous submissions must be signed.')+`<path d="M155 650 H1510" stroke="#F2E8D5" stroke-width="3"/>`+text(155,705,27,'SIGN HERE', '#B78C48')+text(1540,665,82,'×','#BC493C')+'</svg>';
 if(kind==='approved')return base+text(150,165,26,'APPEAL / 0042', '#B78C48')+text(150,370,130,'APPROVED','#218B86')+text(155,505,58,'COMPLETELY CONFIDENTIAL')+text(155,640,30,'Citizen: Ada Quill · Fictional case file', '#B78C48')+'</svg>';
 return base+text(150,165,26,'PUBLIC NOTICE / FOR TRANSPARENCY', '#B78C48')+text(150,340,74,'ADA QUILL SUGGESTS:')+text(150,460,100,'“FEWER FORMS.”')+text(155,650,31,'Anonymous Suggestion of the Month', '#B78C48')+'</svg>';
}
function validate(pkg){const v=validatePackage(pkg);if(!v.valid)throw Error(JSON.stringify(v.errors));const j=planJobs(pkg),e=checkJobsDoc(j);if(e.length)throw Error(e.join('\n'));return j;}
function save(pkg){writeFileSync(file,JSON.stringify(pkg,null,2)+'\n');}
function assetGen(generator,workflow,inputs,seed){return {generator,workflow:`workflows/${workflow}.api.json`,workflow_sha256:hash(readFileSync(join(repo,`workflows/${workflow}.api.json`))),model:generator==='ltx25'?'ltx-2.5-22b-distilled':'flux-3-image-klein',quantization:generator==='ltx25'?'int8':'bf16',seed,created_at:'2026-10-20T12:00:00.000Z',caption:inputs.prompt,inputs};}
function pending(kind,gen){return {kind,origin:'generated',status:'pending',redistributable:true,license:{id:'CC0-1.0'},model_license:{id:kind==='video'?'LicenseRef-LTX-2.5':'LicenseRef-FLUX.3-Image-Klein',url:kind==='video'?'https://huggingface.co/Lightricks/LTX-2.5':'https://huggingface.co/black-forest-labs/flux-3-image-klein'},gen};}

if(stage==='build'){
 if(existsSync(file))throw Error('Source already exists; use a fresh output directory');
 mkdirSync(join(root,'assets'),{recursive:true});mkdirSync(join(root,'workflows'),{recursive:true});
 for(const w of ['flux3_klein_t2i','ltx25_i2v_2stage'])for(const ext of ['api.json','api.params.json'])copyFileSync(join(repo,`workflows/${w}.${ext}`),join(root,`workflows/${w}.${ext}`));
 const assets={},scenes=[];
 for(const s of shots){
  let background;
  const seed=20261020+Number(s.id)*37;
  if(s.card){
   const clean=sanitizeSvg(svgCard(s.card));if(!clean.ok)throw Error(JSON.stringify(clean.errors));
   const check=renderCheck(clean.svg,{width:960,palette});if(!check.ok)throw Error(JSON.stringify(check.errors));
   const bytes=Buffer.from(clean.svg),path=`assets/card-${s.id}.svg`;writeFileSync(join(root,path),bytes);
   assets[`a_card${s.id}`]={kind:'svg',origin:'generated',status:'ready',file:path,sha256:hash(bytes),bytes:bytes.length,redistributable:true,license:{id:'CC0-1.0'},gen:{generator:'llm-svg',sanitizer_version:SANITIZER_VERSION,render_check:{ok:true,version:'1',rasterizer:'resvg',width:check.width,height:check.height,blank:false,palette_ok:true,at:'2026-10-20T12:00:00.000Z'}}};
   background={asset:`a_card${s.id}`,fit:'contain',scrim:0};
  }else{
   const still=`a_still${s.reuse??s.id}`;
   if(!s.reuse)assets[still]=pending('image',assetGen('flux3-klein','flux3_klein_t2i',{prompt:`${s.still} ${style}`,width:1024,height:576,seed,steps:16},seed));
   const action=s.action.replace('The camera slowly pushes toward the entrance.','The camera holds a symmetrical wide shot.').replace('The camera tracks alongside at the same speed.','The camera remains locked.').replace('The camera gently tilts upward to reveal more drawers.','Several higher drawers open a few centimetres in succession.').replace('The camera slowly pulls back from the framed teal form, revealing the ornate brass frame and red velvet barrier.','Locked wide shot of the framed teal form, ornate brass frame and red velvet barrier; the velvet curtain beside the frame sways gently.').replace('The camera slowly pulls back.','The camera remains locked.');
   assets[`a_plate${s.id}`]=pending('video',assetGen('ltx25','ltx25_i2v_2stage',{prompt:`${action} Preserve the reference's teal clipped-corner form, materials, lighting and object identity. Natural restrained motion, no cuts, no text.`,image:still,width:1024,height:576,frames:121,fps:24,seed,stage2_seed:seed+1,role:'background',strength:1},seed));
   background={asset:`a_plate${s.id}`,fit:'cover',muted:true,scrim:0,loop:false,speed:1};
  }
  scenes.push({id:`s_a${s.id}`,layout:'hero',media_only:true,preferredFrames:Math.ceil(s.min*30),copy:{headline:s.title},narration:s.n,...(s.card?{background:{procedural:{pattern:'gradient',palette:['#102C2D','#102C2D']}},foreground:[{asset:`a_card${s.id}`,x:0.5,y:0.5,w:1,anim:'none'}]}:{background}),...(s.id!=='16'?{transitionOut:{type:'cut',frames:0}}:{})});
 }
 const pkg={$schema:'https://comfyrizz.example/schema/package-v1.json',schemaVersion:1,revision:1,id:'pkg_ministry_anonymous20261020',title:'Anonymous, in Triplicate — The Ministry of Mandatory Spontaneity',createdAt:'2026-10-20T12:00:00.000Z',format:{width:1920,height:1080,fps:30},duration:{mode:'flexible'},theme:{font:'Inter',palette,text:'#F2E8D5',text_muted:'#B78C48',text_on_accent:'#102C2D'},voice:{enabled:true,engine:'kokoro',voice:'bm_george',speed:1.03,language:'en-gb',chunking:'sentence'},captions:{style:'sentence'},scenes,assets,datasets:{},compliance:{open_weights_only:true,closed_apis_used:[],warnings:['Fictional satire: Ada Quill, the Ministry and every institution depicted are invented. Original synthetic imagery; not documentary footage. Word timings use syllable estimates within measured sentence audio.']}};
 validate(pkg);save(pkg);
 writeFileSync(join(root,'STORYBOARD.md'),'# Anonymous, in Triplicate\n\nOne teal clipped-corner form travels through the Ministry. Scratch narration precedes all GPU duration decisions. Exact text is authored as editable SVG; generated shots supply physical actions.\n\n'+shots.map(s=>`## ${s.id} · ${s.title}\n\n${s.n}\n\n${s.card?'Editable evidence insert: '+s.card:s.action}\n`).join('\n'));
 console.log(JSON.stringify({stage,scenes:scenes.length,jobs:planJobs(pkg).jobs.length,root}));
}else{
 const pkg=JSON.parse(readFileSync(file));
 if(stage==='time'){
  const report=JSON.parse(readFileSync(join(root,'audio/durations.json')));
  for(const s of shots){const scene=pkg.scenes.find(x=>x.id===`s_a${s.id}`);scene.preferredFrames=Math.ceil(Math.max(s.min,report.scenes[scene.id].seconds+(s.card?0.25:0.1))*30);}
  pkg.duration={mode:'target',targetFrames:pkg.scenes.reduce((n,s)=>n+s.preferredFrames,0)};
  const timeline=compileTimeline(pkg,narrationOptions(root));
  for(const s of timeline.scenes){const scene=pkg.scenes.find(x=>x.id===s.id),a=pkg.assets[scene.background?.asset??scene.foreground[0].asset];if(a.kind==='video')a.gen.inputs.frames=Math.ceil(((s.durationInFrames/30+0.4)*24-1)/8)*8+1;}
  validate(pkg);save(pkg);writeFileSync(join(root,'timeline.json'),JSON.stringify(timeline,null,2));
 }
 if(stage==='finish'){
  const opening=pkg.assets.a_plate01;
  if(opening.status==='ready'&&opening.file!=='assets/opening-clean.mp4'){
   // The first generated plate contains a spurious footer. Crop it, preserving
   // aspect ratio, frame count and playback speed; retain the raw take externally.
   const clean=join(root,'assets/opening-clean.mp4');
   execFileSync('ffmpeg',['-v','error','-y','-i',join(root,opening.file),'-vf','crop=960:540:32:0,scale=1024:576','-an','-c:v','libx264','-crf','16','-pix_fmt','yuv420p',clean]);
   const bytes=readFileSync(clean);opening.file='assets/opening-clean.mp4';opening.bytes=bytes.length;opening.sha256=hash(bytes);
   opening.notes='Generated footer removed with a 16:9 crop; original frame count and normal-speed motion retained.';
  }
  for(const scene of pkg.scenes)if(pkg.assets[scene.background?.asset]?.kind==='svg'){
   scene.foreground=[{asset:scene.background.asset,x:0.5,y:0.5,w:1,anim:'none'}];
   scene.background={procedural:{pattern:'gradient',palette:['#102C2D','#102C2D']}};
  }
  validate(pkg);save(pkg);
 }
 const timeline=compileTimeline(pkg,narrationOptions(root));
 const coverage=timeline.scenes.map(s=>{const scene=pkg.scenes.find(x=>x.id===s.id),a=pkg.assets[scene.background?.asset??scene.foreground[0].asset];const sourceSeconds=a.kind==='video'?(a.media?.durationSeconds??a.gen.inputs.frames/a.gen.inputs.fps):null;return {scene:s.id,seconds:s.durationInFrames/timeline.fps,kind:a.kind,sourceSeconds,speed:scene.background.speed??1,uncoveredSeconds:sourceSeconds===null?0:Math.max(0,s.durationInFrames/timeline.fps-sourceSeconds/(scene.background.speed??1))};});
 writeFileSync(join(root,'coverage.json'),JSON.stringify({seconds:timeline.durationInFrames/timeline.fps,scenes:coverage},null,2));
 if(coverage.some(c=>c.uncoveredSeconds>1/30))throw Error('Unintended plate shortfall');
 console.log(JSON.stringify({stage,seconds:timeline.durationInFrames/timeline.fps,jobs:planJobs(pkg).jobs.length,coverage},null,2));
}
