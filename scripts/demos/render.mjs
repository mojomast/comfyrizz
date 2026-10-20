/** Run the real CPU production pipeline on collected demo packages, sequentially. */
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {createPipelineController} from '../../apps/server/src/pipeline.mjs';
import {stagePipelineInputs} from '../../apps/server/src/pipeline-media.mjs';
import {fingerprint} from '../../apps/server/src/pipeline-contract.mjs';
import {planJobs} from '../../packages/jobs/src/index.mjs';
const args=process.argv.slice(2), at=args.indexOf('--root');
if(at<0||!args[at+1])throw Error('Usage: node scripts/demos/render.mjs --root <campaign-directory> [--only ussy,hermes,ministry]');
const root=resolve(args[at+1]);
const selected=args.includes('--only')?args[args.indexOf('--only')+1].split(','):['ussy','hermes','ministry'];
const input=join(root,'packages'), outputs=[];
for(const slug of readdirSync(input)){
  const source=join(input,slug), packageFile=join(source,'package.json');
  if(!existsSync(packageFile))continue;
  const pkg=JSON.parse(readFileSync(packageFile));
  const name=['ussy','hermes','ministry'].find(value=>pkg.id===`pkg_rich${value}20261020`);
  if(!name||!selected.includes(name))continue;
  if(planJobs(pkg).jobs.length)throw Error(`${name}: GPU media is still pending; CPU render will not allocate a runtime`);
  const out=join(root,'productions',name), resultFile=join(out,'result.json');
  mkdirSync(out,{recursive:true});
  if(existsSync(resultFile)){
    const previous=JSON.parse(readFileSync(resultFile));
    if(previous.state?.status==='completed'&&previous.state?.inputHash===fingerprint(pkg)){
      outputs.push({name,runDir:resolve(out,previous.runDir),reused:true});continue;
    }
  }
  let finish;
  const done=new Promise(resolve=>{finish=resolve;});
  const controller=createPipelineController({runtimeDir:join(out,'runtime'),stageInputs:stagePipelineInputs,events:{publish(event){
    if(['stage','completed','failed','warning','cancelled'].includes(event.kind))console.log(JSON.stringify({film:name,...event}));
    if(['completed','failed','cancelled'].includes(event.kind))finish();
  }}});
  const started=await controller.start(pkg,{backendId:'cpu',budgetUnits:0},source);
  if(started.status!==202){controller.close();throw Error(JSON.stringify(started));}
  const cancel=()=>controller.cancel(started.run.runId);
  process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
  const timeout=setTimeout(cancel,2*60*60*1000);timeout.unref();
  try{
    await done;
    const state=controller.get(started.run.runId),runDir=controller.directory(state.runId);
    writeFileSync(resultFile,JSON.stringify({state,runDir:relative(out,runDir)},null,2)+'\n');
    if(state.status!=='completed')throw Error(`${name}: ${JSON.stringify(state.error)}`);
    outputs.push({name,runDir,frames:state.result.frames,fps:state.result.fps});
    console.log(JSON.stringify({film:name,status:'completed',frames:state.result.frames,runDir}));
  }finally{
    clearTimeout(timeout);process.removeListener('SIGTERM',cancel);process.removeListener('SIGINT',cancel);controller.close();
  }
}
if(outputs.length!==selected.length)throw Error('Not every requested film has a collected package');
writeFileSync(join(root,'production-results.json'),JSON.stringify(outputs,null,2)+'\n');
