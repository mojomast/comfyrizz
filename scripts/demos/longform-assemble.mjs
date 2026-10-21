/** Merge independently authored graphics/scores into collected GPU packages. */
import {copyFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {films} from './longform-stories.mjs';
import {validatePackage} from '../../packages/schema/src/index.mjs';
import {planJobs} from '../../packages/jobs/src/index.mjs';
const [rootArg]=process.argv.slice(2);
if(!rootArg)throw Error('Usage: longform-assemble.mjs <campaign-root>');
const root=resolve(rootArg),read=p=>JSON.parse(readFileSync(p));
const summary=read(join(root,'run-summary.json'));
if(!summary.ok||!summary.cleanup?.verified)throw Error('GPU collection and verified teardown must finish first');
const results=[];
for(const f of films){
 const slug=`long_${f.key}20261020`,source=join(root,'editorial',slug),out=join(root,'packages',slug);
 const pkg=read(join(out,'package.json')),edit=read(join(source,'package.json'));
 if(planJobs(pkg).jobs.length)throw Error(`${slug}: generated media incomplete`);
 if(!edit.audio?.music||!existsSync(join(source,'sound-direction.json')))throw Error(`${slug}: missing score`);
 const graphics=Object.keys(edit.assets).filter(key=>key.startsWith('a_diagram'));
 if(graphics.length<f.scenes.filter(s=>s.graphic).length)throw Error(`${slug}: missing original diagrams`);
 for(const key of graphics){
  const a=edit.assets[key];if(a?.status!=='ready')throw Error(`${slug}: missing ${key}`);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=width,height,nb_read_frames','-of','json',join(source,a.file)],{encoding:'utf8'}));
  const stream=probe.streams[0],frames=Number(stream.nb_read_frames);
  const timeline=read(join(source,'timeline.json'));
  const sceneIndex=Number(key.replace('a_diagram',''));
  if(stream.width!==1920||stream.height!==1080||frames<timeline.scenes[sceneIndex].durationInFrames)throw Error(`${key}: graphic cannot cover the scene`);
  a.media.frames=frames;a.media.durationSeconds=frames/30;
 }
 for(const [key,a]of Object.entries(edit.assets)){
  if(['flux3-klein','ltx25'].includes(a.gen?.generator))continue;
  if(a.status!=='ready'||!a.file)throw Error(`${slug}: unready authored asset ${key}`);
  const bytes=readFileSync(join(source,a.file));
  if(createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error(`${key}: authored hash mismatch`);
  copyFileSync(join(source,a.file),join(out,a.file));pkg.assets[key]=a;
 }
 f.scenes.forEach((s,i)=>{if(graphics.includes(`a_diagram${i}`))pkg.scenes[i]=edit.scenes[i];});
 pkg.audio=edit.audio;
 pkg.compliance.warnings=[...pkg.compliance.warnings.filter(w=>!w.startsWith('Background reading:')),...f.sources.map(u=>`Background reading: ${u}`)];
 const validation=validatePackage(pkg);if(!validation.valid)throw Error(JSON.stringify(validation.errors));
 for(const name of ['timeline.json','sound-direction.json'])copyFileSync(join(source,name),join(out,name));
 const storyboard=readFileSync(join(root,'source',slug,'STORYBOARD.md'),'utf8');
 writeFileSync(join(out,'STORYBOARD.md'),storyboard+'\n## Reading sources checked during production\n\n'+f.sources.map(u=>'- '+u).join('\n')+'\n');
 writeFileSync(join(out,'package.json'),JSON.stringify(pkg,null,2)+'\n');
 results.push({film:f.key,scenes:pkg.scenes.length,generatedStills:Object.values(pkg.assets).filter(a=>a.gen?.generator==='flux3-klein').length,generatedPlates:Object.values(pkg.assets).filter(a=>a.gen?.generator==='ltx25').length,motionGraphics:graphics.length});
}
writeFileSync(join(root,'assembly-report.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
