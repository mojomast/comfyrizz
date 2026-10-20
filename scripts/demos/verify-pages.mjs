/** Real browser checks for the repository-subpath Pages gallery and five web players. */
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
const [baseArg,manifestArg,reportArg]=process.argv.slice(2);
if(!baseArg||!manifestArg||!reportArg)throw Error('Usage: verify-pages.mjs <site-base-url> <media-manifest.json> <report.json>');
const base=new URL(baseArg.endsWith('/')?baseArg:baseArg+'/');
const manifest=JSON.parse(readFileSync(manifestArg));
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const {chromium}=require('@playwright/test');
const browser=await chromium.launch({headless:true});const results={base:base.href,gallery:[],players:[]};
try{
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const page=await browser.newPage({viewport});const response=await page.goto(base.href);
  if(!response.ok())throw Error(`Gallery HTTP ${response.status()}`);
  await page.locator('article img').last().scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>[...document.querySelectorAll('article img')].every(i=>i.complete&&i.naturalWidth>0));
  const state=await page.evaluate(()=>({cards:document.querySelectorAll('article').length,overflow:document.documentElement.scrollWidth>innerWidth,links:[...document.querySelectorAll('article h2 a')].map(a=>a.href)}));
  if(state.cards!==5||state.overflow||state.links.some(link=>!link.startsWith(base.href)))throw Error(JSON.stringify(state));
  results.gallery.push({viewport,...state});await page.close();
 }
 const page=await browser.newPage();
 for(const film of manifest.films){
  const errors=[];const onError=e=>errors.push(e.message);page.on('pageerror',onError);
  const url=new URL(`long-${film.key}/index.html`,base);const response=await page.goto(url.href);
  if(!response.ok())throw Error(`${film.key}: HTTP ${response.status()}`);
  await page.locator('video').evaluate(async v=>{v.muted=true;await v.play();});
  await page.waitForFunction(()=>{const v=document.querySelector('video');return v.videoWidth===1280&&v.videoHeight===720&&v.currentTime>.3;});
  const chapters=await page.locator('[data-seek]').count();if(chapters!==28)throw Error(`${film.key}: missing chapters`);
  const seeks=[];
  for(const index of [14,27]){
   await page.locator('[data-seek]').nth(index).click();
   await page.waitForFunction(i=>{const v=document.querySelector('video'),at=Number(document.querySelectorAll('[data-seek]')[i].dataset.seek);return !v.seeking&&v.readyState>=2&&Math.abs(v.currentTime-at)<3;},index);
   seeks.push(await page.locator('video').evaluate(v=>v.currentTime));
  }
  const state=await page.locator('video').evaluate(v=>{v.pause();return {duration:v.duration,width:v.videoWidth,height:v.videoHeight,error:v.error?.message??null};});
  if(state.error||Math.abs(state.duration-film.frames/30)>.15)throw Error(`${film.key}: invalid playback metadata`);
  const urls=await page.locator('nav[aria-label="Downloads"] a').evaluateAll(links=>links.map(a=>a.href));
  for(const d of film.downloads)if(!urls.includes(d.url))throw Error(`${film.key}: wrong download link`);
  const caption=await fetch(new URL('captions.vtt',url));if(!caption.ok||!(await caption.text()).startsWith('WEBVTT'))throw Error(`${film.key}: missing captions`);
  if(errors.length)throw Error(errors.join('\n'));
  results.players.push({film:film.key,url:url.href,chapters,seeks,...state,downloadLinks:film.downloads.map(d=>d.url)});
  page.removeListener('pageerror',onError);
 }
}finally{await browser.close();}
writeFileSync(reportArg,JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
