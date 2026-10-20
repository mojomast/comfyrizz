/** Render one representative frame per scene before committing to full CPU productions. */
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {compileTimeline} from '../../packages/planner/dist/src/index.js';
import {inlineGeneratedAssets,preparePublicDir,rendererDir,narrationOptions} from '../../apps/renderer/scripts/render-package-lib.mjs';
import {collectMediaDims} from '../../apps/renderer/src/media-dims.js';
const rendererRequire=createRequire(new URL('../../apps/renderer/package.json',import.meta.url));
const require=createRequire(rendererRequire.resolve('@remotion/cli/package.json'));
const {bundle}=require('@remotion/bundler');
const {selectComposition,renderStill,openBrowser}=require('@remotion/renderer');
const [inputArg,outArg]=process.argv.slice(2);
if(!inputArg||!outArg)throw Error('Usage: node scripts/demos/preview.mjs <applied-packages-root> <preview-directory>');
const input=resolve(inputArg),out=resolve(outArg);
const browserExecutable=process.env.REMOTION_BROWSER||'/usr/bin/google-chrome';
const browser=await openBrowser('chrome',{browserExecutable});
try{
  for(const slug of readdirSync(input)){
    const dir=join(input,slug),file=join(dir,'package.json');if(!existsSync(file))continue;
    const pkg=JSON.parse(readFileSync(file));
    const timeline=compileTimeline(pkg,narrationOptions(dir));
    const props={pkg,timeline,generatedAssets:inlineGeneratedAssets(pkg,dir),mediaDims:collectMediaDims(pkg,dir),mixAudio:false};
    if(existsSync(join(dir,'media.json')))props.media=JSON.parse(readFileSync(join(dir,'media.json')));
    const publicDir=preparePublicDir(pkg,dir);let serveUrl;
    const destination=join(out,slug);mkdirSync(destination,{recursive:true});
    try{
      serveUrl=await bundle({entryPoint:join(rendererDir,'src/index.ts'),publicDir});
      const composition=await selectComposition({serveUrl,id:'PackageDemo',inputProps:props,browserExecutable,puppeteerInstance:browser});
      for(const scene of timeline.scenes){
        const frame=scene.from+Math.floor(scene.durationInFrames*.65);
        await renderStill({serveUrl,composition,inputProps:props,output:join(destination,`${scene.id}.png`),frame,scale:.4,imageFormat:'png',browserExecutable,puppeteerInstance:browser});
      }
      writeFileSync(join(destination,'scenes.json'),JSON.stringify(pkg.scenes.map(s=>({id:s.id,title:s.copy?.headline,layout:s.layout,recipe:s.motion?.recipe})),null,2));
      console.log(JSON.stringify({packageId:pkg.id,frames:timeline.scenes.length,destination}));
    }finally{rmSync(publicDir,{recursive:true,force:true});if(serveUrl)rmSync(serveUrl,{recursive:true,force:true});}
  }
}finally{await browser.close({silent:true});}
