import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {renderPackage} from '../scripts/render-package-lib.mjs';

test('one-shot and looping background plates preserve the same title layout before the loop boundary', {timeout:120000}, t=>{
  const dir=mkdtempSync(join(tmpdir(),'nonloop-background-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'assets'));
  const clip=join(dir,'assets/clip.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=0x243056:s=320x180:r=24:d=4','-c:v','libx264','-pix_fmt','yuv420p',clip]);
  const pkg=JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json',import.meta.url)));
  pkg.voice={enabled:false,engine:'none'};
  pkg.duration={mode:'flexible'};
  pkg.assets={a_clip:{kind:'video',origin:'upload',status:'ready',file:'assets/clip.mp4',sha256:createHash('sha256').update(readFileSync(clip)).digest('hex'),license:{id:'CC0-1.0'},redistributable:true,media:{width:320,height:180,fps:24,frames:96,durationSeconds:4}}};
  pkg.scenes=[{id:'s_title',layout:'title',preferredFrames:120,copy:{headline:'Keep the title in frame',sub:'The plate must not push this copy down.'},background:{asset:'a_clip',loop:true,speed:1,scrim:.3},transitionOut:{type:'cut',frames:0}}];
  const pixels=[];
  for(const loop of [true,false]){
    pkg.scenes[0].background.loop=loop;
    const file=join(dir,'package.json'),png=join(dir,`${loop}.png`);
    writeFileSync(file,JSON.stringify(pkg));
    renderPackage(file,png,{still:true,frame:60,scale:.25,mixAudio:false});
    pixels.push(execFileSync('ffmpeg',['-v','error','-i',png,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']));
  }
  assert.deepEqual(pixels[1],pixels[0],'disabling looping must not change the background rectangle or displace the title');
});
