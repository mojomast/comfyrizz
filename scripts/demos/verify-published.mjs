/** Check the published players, chapter seeking and download bytes against local exports. */
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const [rootArg,baseArg]=process.argv.slice(2);
if(!rootArg||!baseArg)throw Error('Usage: node scripts/demos/verify-published.mjs <campaign-root> <app-url>');
const root=resolve(rootArg),base=new URL(baseArg);
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const {chromium}=require('@playwright/test');
const browser=await chromium.launch({headless:true});
const results=[];
try{
  const page=await browser.newPage();
  for(const name of ['ussy','hermes','ministry']){
    const errors=[];const onError=error=>errors.push(error.message);page.on('pageerror',onError);
    const receipt=JSON.parse(readFileSync(join(root,'productions',name,'result.json')));
    const run=resolve(root,'productions',name,receipt.runDir);
    const pkg=JSON.parse(readFileSync(join(run,'work/package.json')));
    const exports=join(run,'exports',pkg.id),url=new URL(`rich-${name}/index.html`,base);
    const response=await page.goto(url.href);if(!response.ok())throw Error(`${name}: player HTTP ${response.status()}`);
    await page.locator('video').evaluate(async video=>{video.muted=true;await video.play();});
    await page.waitForFunction(()=>{const v=document.querySelector('video');return v.currentTime>.3&&v.videoWidth===1920&&v.videoHeight===1080;});
    const chapters=await page.locator('[data-seek]').count();if(chapters!==12)throw Error(`${name}: expected twelve chapters`);
    await page.locator('[data-seek]').nth(6).click();
    await page.waitForFunction(()=>document.querySelector('video').currentTime>=Number(document.querySelectorAll('[data-seek]')[6].dataset.seek));
    const playback=await page.locator('video').evaluate(video=>{video.pause();return {duration:video.duration,width:video.videoWidth,height:video.videoHeight,seekedTo:video.currentTime};});
    const downloads=[];
    for(const filename of ['video.mp4','package.zip','captions.vtt','CREDITS.md']){
      const response=await fetch(new URL(filename,url));if(!response.ok)throw Error(`${name}/${filename}: HTTP ${response.status}`);
      const digest=createHash('sha256');let bytes=0;
      for await(const chunk of response.body){bytes+=chunk.length;digest.update(chunk);}
      const expected=createHash('sha256').update(readFileSync(join(exports,filename))).digest('hex');
      if(digest.digest('hex')!==expected)throw Error(`${name}/${filename}: published bytes differ`);
      downloads.push({filename,bytes,sha256:expected});
    }
    if(errors.length)throw Error(`${name}: browser errors: ${errors.join('; ')}`);
    page.removeListener('pageerror',onError);
    results.push({film:name,url:url.href,chapters,playback,downloads});
  }
}finally{await browser.close();}
writeFileSync(join(root,'published-verification.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
