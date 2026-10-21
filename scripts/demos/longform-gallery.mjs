/** Build a gallery for the five verified publications; no app build or service restart. */
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {films} from './longform-stories.mjs';
const [rootArg,outArg]=process.argv.slice(2);
if(!rootArg||!outArg)throw Error('Usage: longform-gallery.mjs <campaign-root> <new-static-directory>');
const root=resolve(rootArg),out=resolve(outArg),marker=join(out,'.comfyrizz-longform-gallery.json');
if(existsSync(out)&&!existsSync(marker))throw Error('Refusing an unmanaged destination');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cards=films.map(f=>{
 const production=join(root,'productions',`long_${f.key}20261020`);
 const receipt=JSON.parse(readFileSync(join(production,'result.json')));
 if(receipt.state.status!=='completed')throw Error(`Incomplete film: ${f.key}`);
 const run=resolve(production,receipt.runDir),verification=JSON.parse(readFileSync(join(run,'verification.json')));
 if(!Object.values(verification.checks).every(x=>x===true))throw Error(`Unverified film: ${f.key}`);
 const timeline=JSON.parse(readFileSync(join(run,'work/timeline.json'))),seconds=timeline.durationInFrames/timeline.fps;
 const time=`${Math.floor(seconds/60)}:${String(Math.round(seconds%60)).padStart(2,'0')}`;
 const href=`../long-${f.key}/`;
 return `<article style="--accent:${f.palette[1]}"><a class="poster" href="${href}index.html"><img src="${href}poster.jpg" alt="${esc(f.title)} preview" loading="lazy"><span class="duration">${time}</span></a><div class="copy"><p class="kicker">${esc(f.key)} / 28 chapters</p><h2><a href="${href}index.html">${esc(f.title)}</a></h2><p>${esc(f.subtitle)}</p><nav><a href="${href}index.html">Watch film →</a><a href="${href}video.mp4" download>MP4</a><a href="${href}package.zip" download>Editable project</a></nav></div></article>`;
});
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Five Worlds · Comfyrizz</title><style>
*{box-sizing:border-box}body{margin:0;background:#10131c;color:#f4eddf;font:17px/1.6 system-ui,sans-serif}main{max-width:1380px;padding:60px 28px 90px;margin:auto}.eyebrow{font-size:12px;letter-spacing:.24em;color:#90c5ce}h1{font-size:clamp(48px,8vw,100px);line-height:1;margin:25px 0}header>p{max-width:800px;color:#b7c2cc}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:26px;margin-top:45px}article{border:1px solid #343e4d;border-top:3px solid var(--accent);border-radius:12px;overflow:hidden;background:#181f2b}.poster{position:relative;display:block;aspect-ratio:16/9;background:#080e16}.poster img{width:100%;height:100%;object-fit:cover}.duration{position:absolute;bottom:12px;right:12px;padding:2px 9px;background:#080e16dd;border-radius:4px}.copy{padding:22px}h2{font-size:27px;line-height:1.2;margin:10px 0}.kicker{text-transform:uppercase;color:var(--accent);font-size:11px;letter-spacing:.16em}.copy>p:not(.kicker){color:#bbc6cf}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}nav{display:flex;flex-wrap:wrap;gap:12px;font-size:14px;color:var(--accent)}footer{margin-top:45px;border-top:1px solid #343e4d;padding-top:20px;color:#b7c2cc}a:focus-visible{outline:3px solid #90c5ce;outline-offset:5px}
</style></head><body><main><header><p class="eyebrow">COMFYRIZZ / ORIGINAL LONG-FORM COLLECTION</p><h1>Five worlds.<br>Five ways to see.</h1><p>From the forest floor to the deep ocean: five narrated films with fresh generated motion, original animated diagrams, distinct scores, and editable project downloads.</p></header><section class="grid" aria-label="Films">${cards.join('')}</section><footer><p>Original synthetic imagery and sound. Nonfiction images are illustrative, not documentary footage. The clockmaker story is fiction. English captions and sources accompany every film.</p><nav><a href="../rich-anonymous/index.html">Anonymous, in Triplicate</a><a href="../">Open Comfyrizz</a></nav></footer></main></body></html>`;
mkdirSync(out,{recursive:true});writeFileSync(join(out,'index.html.tmp'),html);renameSync(join(out,'index.html.tmp'),join(out,'index.html'));
writeFileSync(marker,JSON.stringify({films:films.map(f=>f.key),createdAt:new Date().toISOString()},null,2));
console.log(JSON.stringify({gallery:out,films:cards.length}));
