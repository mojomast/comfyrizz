/** Five-film production authoring. Outputs and temporary frames must stay external. */
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {films} from './longform-stories.mjs';
import {compileTimeline} from '../../packages/planner/dist/src/index.js';
import {validatePackage} from '../../packages/schema/src/index.mjs';
import {planJobs,checkJobsDoc} from '../../packages/jobs/src/index.mjs';
import {sanitizeSvg,renderCheck,SANITIZER_VERSION} from '../../packages/vector/dist/src/index.js';
import {narrationOptions} from '../../apps/renderer/scripts/render-package-lib.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(new URL('../../packages/vector/package.json',import.meta.url));
const {Resvg}=require('@resvg/resvg-js');
const [stage,rootArg,selection]=process.argv.slice(2);
const graphicSelection=process.env.COMFYRIZZ_GRAPHIC_SCENES?.split(',').map(Number);
const repairGraphics={clockwork:{5:{variant:'watch',labels:['POCKET WATCH','11:00','INDEPENDENT REFERENCE']}},ferment:{21:{variant:'notebook',labels:['INGREDIENTS','CONDITIONS','OBSERVATIONS']},22:{variant:'bowls',labels:['REPEAT A PROCESS','COMPARE OBSERVATIONS']}}};
if(!['build','time','graphics','coverage'].includes(stage)||!rootArg)throw Error('Usage: longform.mjs build|time|graphics|coverage <package-parent-directory> [forest,clockwork,coolcity,ferment,abyss]');
const root=resolve(rootArg),chosen=selection?selection.split(','):films.map(f=>f.key);
const hash=b=>createHash('sha256').update(b).digest('hex');
const date='2026-10-20T12:00:00.000Z';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const idFor=(f)=>`long_${f.key}20261020`;
const sid=i=>`s_${String(i+1).padStart(2,'0')}`;
function save(path,p){writeFileSync(join(path,'package.json'),JSON.stringify(p,null,2)+'\n');}
function check(p){const v=validatePackage(p);if(!v.valid)throw Error(JSON.stringify(v.errors));const e=checkJobsDoc(planJobs(p));if(e.length)throw Error(e.join('\n'));}
function gen(generator,workflow,inputs,seed){return {generator,workflow:`workflows/${workflow}.api.json`,workflow_sha256:hash(readFileSync(join(repo,`workflows/${workflow}.api.json`))),model:generator==='ltx25'?'ltx-2.5-22b-distilled':'flux-3-image-klein',quantization:generator==='ltx25'?'int8':'bf16',seed,created_at:date,caption:inputs.prompt,inputs};}
function pending(kind,g){return {kind,origin:'generated',status:'pending',redistributable:true,license:{id:'CC0-1.0'},model_license:{id:kind==='video'?'LicenseRef-LTX-2.5':'LicenseRef-FLUX.3-Image-Klein',url:kind==='video'?'https://huggingface.co/Lightricks/LTX-2.5':'https://huggingface.co/black-forest-labs/flux-3-image-klein'},gen:g};}
function vector(path,name,svg,palette){
 const clean=sanitizeSvg(svg);if(!clean.ok)throw Error(JSON.stringify(clean.errors));
 const result=renderCheck(clean.svg,{width:960,palette});if(!result.ok)throw Error(JSON.stringify(result.errors));
 const bytes=Buffer.from(clean.svg),file=`assets/${name}.svg`;writeFileSync(join(path,file),bytes);
 return {kind:'svg',origin:'generated',status:'ready',file,bytes:bytes.length,sha256:hash(bytes),redistributable:true,license:{id:'CC0-1.0'},gen:{generator:'llm-svg',sanitizer_version:SANITIZER_VERSION,render_check:{ok:true,version:'1',rasterizer:'resvg',width:result.width,height:result.height,blank:false,palette_ok:true,at:date}}};
}
function text(x,y,size,value,color,anchor='start'){return `<text x="${x}" y="${y}" font-family="DejaVu Sans,sans-serif" font-size="${size}" font-weight="600" text-anchor="${anchor}" fill="${color}">${esc(value)}</text>`;}
function lines(x,y,label,color,size=28){const words=label.split(' ');let rows=[''];for(const w of words){if((rows.at(-1)+w).length>21)rows.push(w+' ');else rows[rows.length-1]+=w+' ';}return rows.map((line,i)=>text(x,y+i*38,size,line.trim(),color,'middle')).join('');}
function graphic(f,s,t=10){
 const [bg,accent,ink,alt,muted]=f.palette;
 const p=Math.min(1,t/2.2), phase=t*.18;
 let body=`<rect width="1920" height="1080" fill="${bg}"/>`;
 // Distinct native visual grammars: organic threads, engraved paper, urban grid,
 // kitchen ceramics, or expedition range lines. All drawing remains above captions.
 if(f.key==='forest')for(let i=0;i<12;i++)body+=`<path d="M${i*175} 840 Q${i*175+100} 600 ${i*155+50} 320" fill="none" stroke="${muted}" stroke-width="2" opacity=".3"/>`;
 if(f.key==='clockwork')for(let i=0;i<20;i++)body+=`<path d="M${i*110} 70 L${i*110+110} 840" stroke="${muted}" stroke-width="1" opacity=".25"/>`;
 if(f.key==='coolcity')for(let i=0;i<15;i++)body+=`<path d="M${i*140} 200 V830 M90 ${230+i*42} H1830" stroke="${muted}" stroke-width="1" opacity=".18"/>`;
 if(f.key==='ferment')body+=`<rect x="70" y="70" width="1780" height="770" rx="60" fill="none" stroke="${muted}" stroke-width="3"/><ellipse cx="960" cy="590" rx="730" ry="190" fill="${alt}" opacity=".08"/>`;
 if(f.key==='abyss')for(let i=0;i<10;i++)body+=`<path d="M95 ${220+i*60} H${i%2?135:165}" stroke="${accent}" stroke-width="2" opacity=".5"/>`;
 body+=text(120,130,23,f.key==='clockwork'?'BELLWEATHER / A FICTION':f.key==='abyss'?'EXPEDITION NOTES / CONCEPT VISUALIZATION':f.subtitle.toUpperCase(),accent);
 body+=text(120,220,56,s.title,ink);
 const variant=s.variant;
 if(variant==='forest'){
  body+=`<path d="M270 540 H1650" stroke="${alt}" stroke-width="8"/><rect x="270" y="545" width="1380" height="250" fill="${muted}" opacity=".18"/><path d="M920 510 V365 H1000 V510 Z" fill="${ink}"/><path d="M755 365 Q960 110 1165 365 Z" fill="${alt}"/>`;
  for(let i=0;i<15;i++){const x=400+i*80;body+=`<path d="M960 510 Q${x} 580 ${x} ${650+(i%3)*48}" fill="none" stroke="${accent}" stroke-width="4" stroke-dasharray="${p*1200} 1200"/>`;}
  body+=text(1260,390,32,'FRUITING BODY',ink)+text(1260,720,32,'MYCELIUM',accent)+text(280,485,25,'ABOVE GROUND',ink)+text(280,600,25,'IN THE SUBSTRATE',ink);
 }else if(variant==='exchange'&&f.key==='forest'){
  body+=`<path d="M500 370 V640 M1420 370 V640" stroke="${alt}" stroke-width="30"/><path d="M500 600 Q600 750 960 600 T1420 620 M500 640 Q750 470 1420 650" fill="none" stroke="${accent}" stroke-width="7" stroke-dasharray="${p*2000} 2000"/>`;
  for(let i=0;i<13;i++){const x=500+i*76;body+=`<circle cx="${x}" cy="${610+Math.sin(i+phase*5)*50}" r="${5+3*Math.sin(i+t)}" fill="${ink}"/>`;}
  body+=lines(470,330,s.labels[0],ink)+lines(1450,330,s.labels.at(-1),ink)+lines(960,770,s.labels[1],accent);
 }else if(variant==='clock'||variant==='watch'){
  body+=`<circle cx="600" cy="520" r="205" fill="${ink}"/><circle cx="600" cy="520" r="180" fill="none" stroke="${alt}" stroke-width="4"/>`;
  for(let i=0;i<12;i++){const a=i*Math.PI/6;body+=`<path d="M${600+Math.sin(a)*156} ${520-Math.cos(a)*156} L${600+Math.sin(a)*173} ${520-Math.cos(a)*173}" stroke="${bg}" stroke-width="5"/>`;}
  const minuteAngle=variant==='watch'?0:s.title==='The problem'?342:Math.min(t,8)*7;
  const hourAngle=variant==='watch'?330:s.title==='The problem'?328.5:110;
  body+=`<path d="M600 520 V380" transform="rotate(${minuteAngle} 600 520)" stroke="${bg}" stroke-width="9" stroke-linecap="round"/><path d="M600 520 V420" transform="rotate(${hourAngle} 600 520)" stroke="${bg}" stroke-width="13" stroke-linecap="round"/>`;
  s.labels.forEach((l,i)=>{body+=text(920,410+i*115,36,l,i===2?alt:ink);});
 }else if(['depth','pressure'].includes(variant)){
  body+=`<rect x="240" y="310" width="510" height="475" rx="15" fill="${muted}" opacity=".4"/><path d="M400 350 V740" stroke="${accent}" stroke-width="5"/>`;
  s.labels.forEach((l,i)=>{const y=370+i*165;body+=`<path d="M380 ${y} H770" stroke="${accent}" stroke-width="2"/>`+text(830,y+10,37,l,ink);});
  const y=350+((phase%1)*370);
  if(s.title==='The surface still matters')for(let i=0;i<12;i++)body+=`<circle cx="${490+i%4*45}" cy="${350+(y-350+i*35)%370}" r="${3+i%3}" fill="${ink}"/>`;
  else body+=`<path d="M530 ${y} l55 0 l25 25 l-25 25 l-55 0 Z" fill="${alt}"/><circle cx="565" cy="${y+25}" r="9" fill="${ink}"/>`;
 }else if(variant==='bowl'||variant==='cooling'||variant==='roof'){
  const base=variant==='roof'?`<path d="M600 490 L960 300 L1320 490 V730 H600 Z" fill="${muted}"/><path d="M560 490 L960 280 L1360 490" stroke="${ink}" stroke-width="24" fill="none"/>`:variant==='cooling'?`<rect x="450" y="690" width="1020" height="70" fill="${alt}"/><path d="M960 700 V440" stroke="${muted}" stroke-width="28"/><ellipse cx="960" cy="430" rx="270" ry="140" fill="${accent}"/><path d="M960 700 L820 745 M960 700 L1100 745" stroke="${muted}" stroke-width="12"/>`:`<path d="M620 470 H1300 Q1260 760 960 760 Q660 760 620 470 Z" fill="${alt}"/><ellipse cx="960" cy="470" rx="340" ry="75" fill="${ink}"/>`;
  body+=base;
  if(variant==='roof'){
   body+=`<path d="M1250 280 L1150 375 L1350 285" fill="none" stroke="${alt}" stroke-width="9"/><path d="M1320 284 L1350 285 L1345 315" fill="none" stroke="${alt}" stroke-width="9"/>`;
  }else if(variant==='cooling'){
   for(let i=0;i<7;i++)body+=`<circle cx="${790+i*55}" cy="${425-((t*.35+i*.13)%1)*150}" r="8" fill="${ink}" opacity=".8"/>`;
  }else{
   for(let i=0;i<9;i++){const x=710+i*62,y=460+Math.sin(i+t*.5)*22;body+=`<circle cx="${x}" cy="${y}" r="8" fill="${accent}"/>`;if(i<8)body+=`<path d="M${x} ${y} L${x+62} ${460+Math.sin(i+1+t*.5)*22}" stroke="${accent}" stroke-width="3" opacity="${p}"/>`;}
  }
  s.labels.forEach((l,i)=>{body+=lines(360+i*600,820,l,ink,27);});
 }else if(variant==='notebook'){
  body+=`<rect x="470" y="300" width="980" height="480" rx="15" fill="${ink}"/><path d="M960 315 V765" stroke="${muted}" stroke-width="5"/>`;
  s.labels.forEach((l,i)=>{body+=text(540,390+i*115,30,l,bg);body+=`<path d="M1030 ${395+i*115} H${1030+Math.min(1,Math.max(0,(t-i*.6)/2))*340}" stroke="${accent}" stroke-width="6"/>`;});
 }else if(variant==='bowls'){
  [620,1300].forEach((x,i)=>{body+=`<path d="M${x-230} 510 H${x+230} Q${x+200} 735 ${x} 735 Q${x-200} 735 ${x-230} 510 Z" fill="${alt}"/><ellipse cx="${x}" cy="510" rx="230" ry="70" fill="${ink}"/><path d="M${x-175} 490 Q${x} ${380-i*45-Math.min(t,6)*3} ${x+175} 490 Z" fill="${muted}"/>`;for(let n=0;n<5;n++)body+=`<circle cx="${x-110+n*55}" cy="${475-Math.sin(n)*15}" r="${4+Math.min(t,5)}" fill="${bg}" opacity=".35"/>`;});
  s.labels.forEach((l,i)=>{body+=text(620+i*680,365,29,l,ink,'middle');});
 }else if(variant==='letter'){
  body+=`<rect x="290" y="310" width="1340" height="440" rx="5" fill="${ink}"/><path d="M335 350 H1585 M335 710 H1585" stroke="${alt}" stroke-width="3"/>`;
  s.labels.forEach((l,i)=>{body+=text(960,460+i*150,65,l,bg,'middle');});
 }else if(variant==='cycle'){
  const points=s.labels.map((_,i)=>({x:960+Math.cos(i*Math.PI*2/3-Math.PI/2)*480,y:570+Math.sin(i*Math.PI*2/3-Math.PI/2)*220}));
  body+=`<ellipse cx="960" cy="570" rx="480" ry="220" fill="none" stroke="${muted}" stroke-width="6"/>`;
  const a=t*.6;body+=`<circle cx="${960+Math.cos(a)*480}" cy="${570+Math.sin(a)*220}" r="16" fill="${accent}"/>`;
  points.forEach((q,i)=>{body+=`<rect x="${q.x-210}" y="${q.y-45}" width="420" height="95" rx="25" fill="${bg}" stroke="${accent}" stroke-width="3"/>`+lines(q.x,q.y+6,s.labels[i],ink,28);});
 }else{
  const count=s.labels.length,w=1460/count,offset=(1920-w*(count-1))/2;
  if(variant==='map')body+=`<path d="M230 560 H1690" stroke="${muted}" stroke-width="95"/><path d="M230 560 H1690" stroke="${ink}" stroke-width="4" stroke-dasharray="20 20"/>`;
  else if(variant!=='triad')body+=`<path d="M${offset} 530 H${offset+w*(count-1)}" stroke="${muted}" stroke-width="5"/>`;
  s.labels.forEach((l,i)=>{
   const x=offset+i*w,active=Math.min(1,Math.max(0,(t-i*.48)*2)),stroke=i===Math.floor(t*.5)%count?accent:muted;
   body+=`<g opacity="${.25+.75*active}">`;
   if(f.key==='forest')body+=`<ellipse cx="${x}" cy="515" rx="${w*.43}" ry="145" fill="${bg}" stroke="${stroke}" stroke-width="4"/>`;
   else if(f.key==='clockwork')body+=`<path d="M${x-w*.42} 365 L${x+w*.39} 380 L${x+w*.43} 635 L${x-w*.4} 620 Z" fill="${ink}" stroke="${alt}" stroke-width="4"/>`;
   else if(f.key==='ferment')body+=`<ellipse cx="${x}" cy="515" rx="${w*.44}" ry="155" fill="${bg}" stroke="${muted}" stroke-width="10"/><ellipse cx="${x}" cy="515" rx="${w*.39}" ry="130" fill="none" stroke="${stroke}" stroke-width="2"/>`;
   else if(f.key==='coolcity')body+=`<path d="M${x-w*.42} 410 L${x-w*.35} 375 H${x+w*.42} V595 L${x+w*.35} 630 H${x-w*.42} Z" fill="${muted}"/><rect x="${x-w*.42}" y="410" width="${w*.77}" height="220" fill="${bg}" stroke="${stroke}" stroke-width="4"/>`;
   else body+=`<rect x="${x-w*.41}" y="390" width="${w*.82}" height="220" rx="4" fill="${bg}" stroke="${stroke}" stroke-width="2"/><path d="M${x-w*.41} 430 V390 H${x-w*.31}" fill="none" stroke="${accent}" stroke-width="8"/>`;
   body+=text(x,460,40,String(i+1).padStart(2,'0'),f.key==='clockwork'?alt:accent,'middle')+lines(x,530,l,f.key==='clockwork'?bg:ink,count===4?25:29)+'</g>';
  });
  if(variant!=='triad'){const x=offset+((t*.2)%1)*w*(count-1);body+=`<circle cx="${x}" cy="700" r="12" fill="${accent}"/><path d="M${offset} 700 H${offset+w*(count-1)}" stroke="${muted}" stroke-width="2"/>`;}
 }
 body+=text(120,870,20,'Illustrative diagram · not to scale',muted);
 return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">${body}</svg>`;
}

async function renderGraphic(f,s,seconds,out){
 const args=['-v','error','-y','-f','image2pipe','-framerate','15','-i','pipe:0','-an','-vf','tpad=stop_mode=clone:stop_duration=0.15','-r','30','-frames:v',String(Math.round(seconds*30)),'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',out];
 const child=spawn('ffmpeg',args,{stdio:['pipe','ignore','inherit']});
 const completion=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`ffmpeg ${code}`)));});
 for(let n=0;n<Math.ceil(seconds*15);n++){
  const png=new Resvg(graphic(f,s,n/15),{fitTo:{mode:'width',value:1920},font:{loadSystemFonts:true}}).render().asPng();
  if(!child.stdin.write(png))await once(child.stdin,'drain');
 }
 child.stdin.end();await completion;
}

for(const f of films.filter(f=>chosen.includes(f.key))){
 const path=join(root,idFor(f));mkdirSync(join(path,'assets'),{recursive:true});
 if(stage==='build'){
  if(existsSync(join(path,'package.json')))throw Error('Source already exists; use a fresh output directory');
  mkdirSync(join(path,'workflows'),{recursive:true});
  for(const w of ['flux3_klein_t2i','ltx25_i2v_2stage'])for(const ext of ['api.json','api.params.json'])copyFileSync(join(repo,`workflows/${w}.${ext}`),join(path,`workflows/${w}.${ext}`));
  const assets={},scenes=[];
  f.scenes.forEach((s,i)=>{
   const id=sid(i),seed=20261020+films.indexOf(f)*10000+i*71;
   let media;
   if(s.graphic){
    assets[`a_svg${i}`]=vector(path,`diagram-${i}`,graphic(f,s),f.palette);
    media={background:{procedural:{pattern:'gradient',palette:[f.palette[0],f.palette[0]]}},foreground:[{asset:`a_svg${i}`,x:.5,y:.5,w:1,anim:'none'}]};
   }else{
    const prompt=`${s.visual} ${f.style} Compose main action in upper two-thirds with calm lower margin for captions. Landscape 16:9, no written words, no labels, no watermarks, no borders.`;
    assets[`a_still${i}`]=pending('image',gen('flux3-klein','flux3_klein_t2i',{prompt,width:1024,height:576,seed,steps:16},seed));
    assets[`a_plate${i}`]=pending('video',gen('ltx25','ltx25_i2v_2stage',{prompt:`${s.action} Preserve the reference design, materials and identities. Fixed camera, no cuts, no text or overlays. ${f.style}`,image:`a_still${i}`,width:1024,height:576,frames:193,fps:24,seed,stage2_seed:seed+1,role:'background',strength:1},seed));
    media={background:{asset:`a_plate${i}`,fit:'cover',muted:true,scrim:0,loop:false,speed:1}};
   }
   if(i===0){
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect x="80" y="65" width="1760" height="180" rx="8" fill="${f.palette[0]}" opacity=".87"/>${text(120,145,54,f.title,f.palette[2])}${text(123,200,27,f.subtitle,f.palette[1])}</svg>`;
    assets.a_title=vector(path,'title',svg,f.palette);media.foreground=[{asset:'a_title',x:.5,y:.5,w:1,anim:'fade-in'}];
   }
   scenes.push({id,layout:'hero',media_only:true,preferredFrames:210,copy:{headline:s.title},narration:s.n,...media,...(i<f.scenes.length-1?{transitionOut:{type:'cut',frames:0}}:{})});
  });
  const pkg={$schema:'https://comfyrizz.example/schema/package-v1.json',schemaVersion:1,revision:1,id:`pkg_${idFor(f)}`,title:f.title,createdAt:date,format:{width:1920,height:1080,fps:30},duration:{mode:'target',targetFrames:scenes.length*210},theme:{font:'Inter',palette:f.palette,text:f.palette[2],text_muted:f.palette[4],text_on_accent:f.palette[0]},voice:{enabled:true,engine:'kokoro',voice:f.voice,speed:f.speed,language:f.voice.startsWith('b')?'en-gb':'en-us',chunking:'sentence'},captions:{style:'sentence'},scenes,assets,datasets:{},compliance:{open_weights_only:true,closed_apis_used:[],warnings:[f.key==='clockwork'?'Original fiction: Bellweather, Mara and every event are invented.':'Synthetic educational illustrations, not documentary evidence or footage. Diagrams are illustrative, not to scale.','Word timings use syllable estimates within measured sentence audio.',...f.sources.map(url=>`Background reading: ${url}`)]}};
  check(pkg);save(path,pkg);
  writeFileSync(join(path,'STORYBOARD.md'),`# ${f.title}\n\n${f.subtitle}\n\nVisual direction: ${f.style}\n\n`+f.scenes.map((s,i)=>`## ${i+1}. ${s.title}\n\n${s.n}\n\n${s.graphic?'Authored animated '+s.variant+' diagram: '+s.labels.join(' → '):s.visual+'\n\nMotion: '+s.action}\n`).join('\n')+'\n## Background reading\n\n'+f.sources.map(u=>'- '+u).join('\n'));
  console.log(JSON.stringify({film:f.key,stage,scenes:scenes.length,jobs:planJobs(pkg).jobs.length}));continue;
 }
 const pkg=JSON.parse(readFileSync(join(path,'package.json')));
 if(stage==='time'){
  pkg.compliance.warnings=[...pkg.compliance.warnings.filter(w=>!w.startsWith('Background reading:')), ...f.sources.map(url=>`Background reading: ${url}`)];
  const report=JSON.parse(readFileSync(join(path,'audio/durations.json')));
  pkg.scenes.forEach((s,i)=>{s.preferredFrames=Math.ceil(Math.max(i===0?7:6.2,report.scenes[s.id].seconds+.3)*30);});
  pkg.duration={mode:'target',targetFrames:pkg.scenes.reduce((n,s)=>n+s.preferredFrames,0)};
  const timeline=compileTimeline(pkg,narrationOptions(path));
  for(const s of timeline.scenes){const raw=pkg.scenes.find(x=>x.id===s.id),a=pkg.assets[raw.background?.asset];if(a?.kind==='video')a.gen.inputs.frames=Math.ceil(((s.durationInFrames/30+.45)*24-1)/8)*8+1;}
  check(pkg);save(path,pkg);writeFileSync(join(path,'timeline.json'),JSON.stringify(timeline,null,2));
 }
 const timeline=compileTimeline(pkg,narrationOptions(path));
 if(stage==='graphics'){
  for(const [i,original]of f.scenes.entries())if((original.graphic||repairGraphics[f.key]?.[i])&&(!graphicSelection||graphicSelection.includes(i))){
   const s={...original,...repairGraphics[f.key]?.[i]};
   pkg.assets[`a_svg${i}`]=vector(path,`diagram-${i}`,graphic(f,s),f.palette);
   const scene=timeline.scenes.find(x=>x.id===sid(i)),seconds=(scene.durationInFrames+2)/timeline.fps;
   const filename=`assets/motion-diagram-${i}.mp4`,out=join(path,filename);
   await renderGraphic(f,s,seconds,out);
   const bytes=readFileSync(out),key=`a_diagram${i}`;
   pkg.assets[key]={kind:'video',origin:'upload',status:'ready',file:filename,bytes:bytes.length,sha256:hash(bytes),redistributable:true,license:{id:'CC0-1.0'},source:{provider:'repo',title:`Original frame-driven ${s.variant} diagram: ${s.title}`,creator:'Comfyrizz original vector composition'},media:{width:1920,height:1080,fps:30,frames:scene.durationInFrames+2,durationSeconds:seconds,audio:'none'}};
   pkg.scenes[i].background={asset:key,fit:'cover',muted:true,loop:false,speed:1,scrim:0};delete pkg.scenes[i].foreground;
   console.log(JSON.stringify({film:f.key,graphic:i+1,seconds}));
  }
  check(pkg);save(path,pkg);
 }
 const coverage=timeline.scenes.map(s=>{const raw=pkg.scenes.find(x=>x.id===s.id),a=pkg.assets[raw.background?.asset],seconds=s.durationInFrames/30,sourceSeconds=a?.kind==='video'?(a.media?.durationSeconds??a.gen.inputs.frames/a.gen.inputs.fps):null;return {scene:s.id,seconds,kind:a?.kind??'svg',sourceSeconds,uncoveredSeconds:sourceSeconds===null?0:Math.max(0,seconds-sourceSeconds)};});
 if(coverage.some(c=>c.uncoveredSeconds>1/30))throw Error('Unintended footage shortfall');
 const summary={film:f.key,seconds:timeline.durationInFrames/30,frames:timeline.durationInFrames,scenes:coverage,jobs:planJobs(pkg).jobs.length};
 writeFileSync(join(path,'coverage.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({film:f.key,stage,seconds:summary.seconds,jobs:summary.jobs,maxShotSeconds:Math.max(...coverage.map(c=>c.seconds))}));
}
