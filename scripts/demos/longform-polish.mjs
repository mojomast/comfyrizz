/** Review-selected crops remove generated text while preserving normal-speed coverage. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validatePackage} from '../../packages/schema/src/index.mjs';
const root=resolve(process.argv[2]??'');
if(!process.argv[2])throw Error('Usage: longform-polish.mjs <campaign-root>');
const selected={forest:{13:'960:540:32:0',27:'864:486:80:0'},clockwork:'864:486:80:0',coolcity:'832:468:96:0',ferment:{9:'800:450:112:0',15:'864:486:80:0',19:'832:468:96:0',21:'832:468:96:0',27:'864:486:80:0'},abyss:{10:'864:486:80:90',16:'896:504:64:0',25:'864:486:80:90',26:'864:486:80:90'}};
const report=[];
for(const [key,crops]of Object.entries(selected)){
 const path=join(root,'packages',`long_${key}20261020`),file=join(path,'package.json'),pkg=JSON.parse(readFileSync(file));
 for(const [id,a]of Object.entries(pkg.assets)){
  if(a.gen?.generator!=='ltx25')continue;
  const index=Number(id.replace('a_plate',''));
  const crop=typeof crops==='string'?crops:crops[index];if(!crop)continue;
  const output=`assets/clean-${id}.mp4`;if(a.file===output){report.push({film:key,asset:id,crop,file:output,alreadyApplied:true});continue;}
  execFileSync('ffmpeg',['-v','error','-y','-i',join(path,a.file),'-vf',`crop=${crop},scale=1024:576`,'-an','-c:v','libx264','-preset','fast','-crf','16','-pix_fmt','yuv420p',join(path,output)]);
  const bytes=readFileSync(join(path,output)),original=a.file;
  a.file=output;a.bytes=bytes.length;a.sha256=createHash('sha256').update(bytes).digest('hex');a.notes=`Review crop ${crop}; original take retained in external campaign. Frame count and 1x playback retained.`;a.media.audio='none';
  report.push({film:key,asset:id,original,crop,file:output});
 }
 const v=validatePackage(pkg);if(!v.valid)throw Error(JSON.stringify(v.errors));writeFileSync(file,JSON.stringify(pkg,null,2)+'\n');
}
writeFileSync(join(root,'polish-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({cropped:report.length}));
