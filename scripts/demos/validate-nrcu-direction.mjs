// Small, isolated validation of the revised episode. Never saves the live project.
// prepare ROOT RUNTIME REVISION_DIR WEB_DIR; stills ROOT; video ROOT
// The stills stage holds the allocated session for review, with a hard watchdog.
// The video stage requires reviewed-stills.json with approved:true and videoIds.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync,appendFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createColabBackend} from '../../packages/backends/src/index.mjs';
import {packageModelLock} from '../../packages/backends/src/fasth3-profile.mjs';
import {validatePackage} from '../../packages/schema/src/index.mjs';
import {planJobs,checkJobsDoc} from '../../packages/jobs/src/index.mjs';
import {copyNamedAssets} from '../../apps/server/src/run-assets.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const [mode,rootArg,runtimeArg,revisionArg,webArg]=process.argv.slice(2);
const root=resolve(rootArg), input=join(root,'input'), scratch=join(root,'runtime');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const write=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const ids=['a11','b02','b07','c05','c06'];
const fresh=['b02','b07','c05'];
function publishMedia(web,manifest,outputDir){
  const status=read(join(web,'status.json'));
  for(const entry of manifest?.jobs??[]){
    if(!['succeeded','cached'].includes(entry.status))continue;
    const output=entry.outputs?.[0];if(!output?.relative||!output.sha256)continue;
    const file=join(outputDir,output.relative);if(!existsSync(file)||sha(file)!==output.sha256||(Number.isSafeInteger(output.bytes)&&readFileSync(file).length!==output.bytes))throw Error('Media verification failed: '+entry.job);
    const video=output.relative.endsWith('.mp4'),kind=video?'clips':'images';
    const id=entry.job.split('.')[0],name=id+'-'+output.sha256.slice(0,12)+(video?'.mp4':'.png');
    mkdirSync(join(web,kind),{recursive:true});copyFileSync(file,join(web,kind,name));
    status[kind]=[...(status[kind]??[]).filter(v=>v.id!==id),{id,title:id,url:kind+'/'+name,note:'Validation output; creative review pending'}];
  }
  status.completedShots=(status.clips??[]).length;status.updatedAt=new Date().toISOString();write(join(web,'status.json'),status);
}
function valid(pkg){const v=validatePackage(pkg);if(!v.valid)throw Error(JSON.stringify(v.errors));const jobs=planJobs(pkg);const errors=checkJobsDoc(jobs);if(errors.length)throw Error(errors.join('\n'));return jobs;}
if(mode==='prepare'){
  if(existsSync(root))throw Error('Use a fresh validation root');
  mkdirSync(input,{recursive:true});mkdirSync(scratch);mkdirSync(webArg,{recursive:true});
  const runtime=resolve(runtimeArg), revision=read(join(revisionArg,'revision-plan.json'));
  const oldRun=join(runtime,'runs/run_e73e113be46f');
  const staged=read(join(oldRun,'work/package.json'));
  const pkg=structuredClone(staged);pkg.id='pkg_nrcu_validation';pkg.revision=1;pkg.title='FastH3 direction validation';
  pkg.scenes=pkg.scenes.filter(s=>ids.includes(s.id.slice(2)));
  pkg.audio={ambience:{enabled:true,gain_db:0}};pkg.voice={enabled:false};
  for(const [id,a]of Object.entries(pkg.assets)){
    if(a.kind==='image'&&existsSync(join(oldRun,'out/assets',id+'.png'))){
      a.status='ready';a.file='assets/'+id+'.png';a.sha256=sha(join(oldRun,'out',a.file));a.bytes=readFileSync(join(oldRun,'out',a.file)).length;
      a.license={id:'CC0-1.0'};a.model_license={id:'Apache-2.0'};a.redistributable=true;
    }
  }
  for(const sid of ids){
    const shot=revision.shots.find(s=>s.id===sid),s=pkg.scenes.find(s=>s.id==='s_'+sid),a=pkg.assets[s.background.asset];
    s.preferredFrames=shot.frames;s.narration=shot.line;
    a.gen.direction=shot.direction;Object.assign(a.gen.inputs,{prompt:shot.prompt,frames:shot.sourceFrames});
    if(shot.speaker!=='hermes')a.gen.inputs.image='a_ep2_ref_'+shot.speaker;
    const voiceId='a_validation_voice_'+sid,relative='conditioning/'+sid+'.wav',file=join(revisionArg,relative);
    mkdirSync(join(input,'conditioning'),{recursive:true});copyFileSync(file,join(input,relative));
    pkg.assets[voiceId]={kind:'audio',origin:'upload',status:'ready',file:relative,sha256:sha(file),bytes:readFileSync(file).length,
      license:{id:'CC0-1.0'},redistributable:true,media:{audio:'present',durationSeconds:shot.conditioningSeconds}};
    a.gen.inputs.audio=voiceId;
    if(fresh.includes(sid)){
      const key=pkg.assets['a_ep2_key_'+sid];key.status='pending';delete key.file;delete key.sha256;delete key.bytes;
      key.gen.inputs.prompt=shot.direction.composition+' Cinematic painterly 2.5D animation, teal shadows, amber practical lighting. '+shot.direction.subject;
      if(sid==='b07'){
        key.gen.workflow='workflows/flux3_klein_t2i.api.json';key.gen.workflow_sha256=sha(join(repo,key.gen.workflow));
        key.gen.inputs={prompt:key.gen.inputs.prompt,width:1344,height:768,steps:12,seed:2026102187};
      }
    }
  }
  pkg.duration={mode:'target',targetFrames:pkg.scenes.reduce((n,s)=>n+s.preferredFrames,0)};
  const castIds=new Set(pkg.scenes.flatMap(s=>[...(s.cast??[]),s.speaker].filter(Boolean)));
  pkg.cast=(pkg.cast??[]).filter(c=>castIds.has(c.id));
  const needed=new Set([...pkg.scenes.map(s=>s.background.asset),...pkg.cast.map(c=>c.ref_asset)]);
  const visit=id=>{for(const value of Object.values(pkg.assets[id]?.gen?.inputs??{}))if(typeof value==='string'&&pkg.assets[value]&&!needed.has(value)){needed.add(value);visit(value)}};
  for(const id of needed)visit(id);
  pkg.assets=Object.fromEntries(Object.entries(pkg.assets).filter(([id])=>needed.has(id)));
  copyNamedAssets({pkg,outputDir:join(oldRun,'work'),packageDir:input});
  copyNamedAssets({pkg,outputDir:join(oldRun,'out'),packageDir:input});
  for(const a of Object.values(pkg.assets))if(a.gen?.workflow){for(const path of[a.gen.workflow,a.gen.workflow.replace('.api.json','.api.params.json')]){
    const from=existsSync(join(repo,path))?join(repo,path):join(oldRun,'work',path);mkdirSync(dirname(join(input,path)),{recursive:true});copyFileSync(from,join(input,path));
  }}
  const jobs=valid(pkg);write(join(input,'package.json'),pkg);
  const stills=structuredClone(pkg);stills.scenes=stills.scenes.map(s=>({...s,background:{asset:'a_ep2_key_'+s.id.slice(2),fit:'contain'},narration:undefined,speaker:undefined}));
  for(const [id,a]of Object.entries(stills.assets))if(a.kind==='video')delete stills.assets[id];
  valid(stills);write(join(root,'stills.json'),stills);
  write(join(root,'config.json'),{web:resolve(webArg),budgetUnits:3.5,baseline:320.73,remainingEpisodeBefore:8.89,wallMinutes:23});
  const lock=packageModelLock({packageDir:input,scratchDir:scratch,repo,defaultLock:join(repo,'colab/models.lock.json')});
  const backend=createColabBackend({packageId:pkg.id,packageDir:input,scratchDir:scratch,modelsLock:lock,budgetUnits:3.5});
  write(join(root,'estimate.json'),await backend.estimate(jobs.jobs));
  write(join(webArg,'status.json'),{phase:'Prepared',message:'Five performances; three corrected references first.',totalShots:5,completedShots:0,clips:[],images:[],events:[],budget:'Validation ceiling 3.5 credits',episodeTitle:'Direction validation',durationSeconds:pkg.duration.targetFrames/24});
  console.log(JSON.stringify({jobs:jobs.jobs.length,stills:3,videos:5,estimate:read(join(root,'estimate.json'))}));
}else if(['stills','video'].includes(mode)){
  const config=read(join(root,'config.json'));
  const review=mode==='video'?read(join(root,'reviewed-stills.json')):null;
  if(mode==='video'&&(!review.approved||!review.videoIds?.length||review.videoIds.some(id=>!ids.includes(id))))throw Error('Review and explicitly select shots before video');
  const lock=join(scratch,'package-models.lock.json');
  const backend=createColabBackend({packageId:'pkg_nrcu_validation',packageDir:input,scratchDir:scratch,modelsLock:lock,
    budgetUnits:config.budgetUnits,hfTokenPath:'/home/mojo/.config/comfyrizz-hf-token',pythonBin:'/home/mojo/projects/comfyrizz/.venv/bin/python',
    watchdogMinutes:config.wallMinutes,wallClockCapMinutes:config.wallMinutes,newAttempts:1});
  const publish=event=>{
    appendFileSync(join(root,'events.jsonl'),JSON.stringify(event)+'\n');
    const p=join(config.web,'status.json'),s=read(p);s.phase=event.phase??event.type??s.phase;
    s.message=`${mode}: ${s.phase}${typeof event.job==='string'?' · '+event.job:''}`;s.updatedAt=new Date().toISOString();
    s.events=[...(s.events??[]),s.message].slice(-40);write(p,s);
    if(event.type==='preview_ready')publishMedia(config.web,event.manifest,event.outputDir);
    if(event.event==='run_phase'||event.type==='refused')console.log(JSON.stringify(event));
  };
  let pkg=read(join(root,mode==='stills'?'stills.json':'input/package.json'));
  if(mode==='video'){
    const stills=read(join(root,'stills-result.json')).package;
    for(const sid of fresh){const id='a_ep2_key_'+sid;pkg.assets[id]=stills.assets[id];}
    pkg.scenes=pkg.scenes.filter(s=>review.videoIds.includes(s.id.slice(2)));
    const selected=new Set(pkg.scenes.map(s=>s.background.asset));
    for(const [id,a]of Object.entries(pkg.assets))if(a.kind==='video'&&!selected.has(id))delete pkg.assets[id];
    pkg.duration.targetFrames=pkg.scenes.reduce((n,s)=>n+s.preferredFrames,0);
    copyNamedAssets({pkg,outputDir:join(root,'stills-out'),packageDir:input});
    const status=read(join(config.web,'status.json'));status.totalShots=pkg.scenes.length;write(join(config.web,'status.json'),status);
  }
  try{
    if(mode==='stills'){
      const result=await backend.runPackage(pkg,{approved:true,packageDir:input,workDir:join(root,'stills-work'),outDir:join(root,'stills-out'),teardownMode:'never',onEvent:publish});
      write(join(root,'stills-result.json'),result);if(!result.ok)throw Error('Reference generation incomplete');
      await backend.collect(result.manifest,join(root,'stills-out'));
      publishMedia(config.web,result.manifest,join(root,'stills-out'));
      write(join(root,'allocated-at.json'),{at:new Date().toISOString(),watchdog:backend.state.watchdog});
      console.log('STILLS_READY_FOR_REVIEW; session watchdog remains armed');
    }else{
      const before=await backend.preflight();const spent=Math.max(0,config.baseline-before.usage.balance);
      if(spent>=config.budgetUnits)throw Error('Validation ceiling already consumed');
      // Separate continuation process: account for the first stage in its remaining ceiling.
      const next=createColabBackend({packageId:pkg.id,packageDir:input,scratchDir:scratch,modelsLock:lock,budgetUnits:config.budgetUnits-spent,
        hfTokenPath:'/home/mojo/.config/comfyrizz-hf-token',wallClockCapMinutes:config.wallMinutes,watchdogMinutes:config.wallMinutes});
      // Carry the original deadline/PID across processes so teardown can disarm it.
      const allocation=read(join(root,'allocated-at.json'));
      if(allocation.watchdog)next.state.watchdog=allocation.watchdog;
      await next.ensureUp({approved:false,onEvent:publish});
      const jobs=valid(pkg);write(join(input,'package.json'),pkg);write(join(input,'jobs.json'),jobs);
      const health=await next.health({onEvent:publish});if(!health.ok)throw Error(health.detail);
      const result=await next.run(join(input,'jobs.json'),publish);write(join(root,'video-result.json'),result);
      if(result.manifest){await next.collect(result.manifest,join(root,'video-out'));publishMedia(config.web,result.manifest,join(root,'video-out'));}
      write(join(root,'teardown.json'),await next.teardown('done'));
      if(result.manifest?.complete!==true||result.manifest?.counts?.failed>0||result.refused)throw Error('Validation footage incomplete; inspect preserved manifest');
      const status=read(join(config.web,'status.json'));Object.assign(status,{phase:'Reviewing',message:`${pkg.scenes.length} test performances collected; GPU stopped. Accuracy review in progress.`,gpu:'Colab stopped'});write(join(config.web,'status.json'),status);
      console.log('VALIDATION_COLLECTED_AND_STOPPED');
    }
  }catch(error){write(join(root,'teardown.json'),await backend.teardown('error'));throw error;}
}else throw Error('Expected prepare, stills or video');
