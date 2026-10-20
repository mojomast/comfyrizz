/** Publish a completed CPU showcase into a static directory without rebuilding the app. */
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { completedShowcase, json } from './artifacts.mjs';

const [input, destination] = process.argv.slice(2);
const preview = process.argv.includes('--preview');
if (!input || !destination) throw Error('Usage: node scripts/animation/publish-showcase.mjs <showcase-artifacts> <static-directory>');
const source = resolve(input), target = resolve(destination);
const { state, runDir, pkg, timeline } = completedShowcase(source);
const insideSource = relative(source, target);
if (!insideSource || (!insideSource.startsWith('..') && !insideSource.startsWith('/'))) throw Error('Publish outside the showcase source directory');
const marker = '.comfyrizz-animation-showcase.json';
if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !existsSync(join(target, marker)))) throw Error('Destination exists and is not a managed animation showcase directory');
const verification = JSON.parse(readFileSync(join(runDir, 'verification.json'), 'utf8'));
if (!['frames', 'dimensions', 'duration', 'narrationStream'].every(k => verification.checks?.[k] === true) || !Object.values(verification.checks).every(Boolean)) throw Error('Pipeline verification did not pass');
const exportsDir = join(runDir, 'exports', state.packageId);
for (const path of [join(runDir, 'video.mp4'), join(exportsDir, 'package.zip'), join(source, 'script.md')]) if (!existsSync(path)) throw Error(`Required publication input missing: ${path}`);
const baseline = existsSync(join(source, 'baseline.mp4'));
if (baseline) {
  const report = json(join(source, 'baseline-report.json'));
  if (report.runId !== state.runId || report.inputHash !== state.inputHash || report.frames !== timeline.durationInFrames || report.width !== timeline.width || report.height !== timeline.height || !report.sameNarration || !report.sameSceneBoundaries) throw Error('Baseline is stale or differs from this showcase; render it again');
}
const scenesById = new Map(pkg.scenes.map(scene => [scene.id, scene]));
const chapters = timeline.scenes.map(scene => {
  const original = scenesById.get(scene.id);
  if (!original) throw Error(`Timeline scene not found in package: ${scene.id}`);
  return { title: original.copy?.kicker ?? original.copy?.headline ?? scene.id, seconds: scene.from / timeline.fps, recipe: original.motion?.recipe ?? null };
});
mkdirSync(dirname(target), { recursive: true });
const out = mkdtempSync(join(dirname(target), `.${basename(target)}-publish-`));
copyFileSync(join(runDir, 'video.mp4'), join(out, 'video.mp4'));
for (const name of ['package.zip', 'captions.srt', 'captions.vtt', 'CREDITS.md']) {
  if (existsSync(join(exportsDir, name))) copyFileSync(join(exportsDir, name), join(out, name));
}
copyFileSync(join(source, 'script.md'), join(out, 'script.md'));
copyFileSync(join(runDir, 'verification.json'), join(out, 'verification.json'));
copyFileSync(join(runDir, 'work/package.json'), join(out, 'package.json'));
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
writeFileSync(join(out, 'chapters.json'), JSON.stringify(chapters, null, 2));
if (baseline) {
  copyFileSync(join(source, 'baseline.mp4'), join(out, 'baseline.mp4'));
  copyFileSync(join(source, 'baseline-report.json'), join(out, 'baseline-report.json'));
}
writeFileSync(join(out, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Comfyrizz · Animation showcase</title><style>
*{box-sizing:border-box}body{margin:0;background:#10232d;color:#f4ede2;font:17px/1.6 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:28px 20px 64px}h1{font-size:clamp(30px,5vw,54px);line-height:1.1;max-width:800px}p{max-width:850px}a{color:#f0ba78}video{width:100%;max-height:76vh;background:#08131a;border-radius:14px}nav{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0}button,.download{border:1px solid #65818b;border-radius:9px;padding:10px 14px;background:#224452;color:#f4ede2;font:inherit;text-decoration:none;cursor:pointer}button:hover,button:focus-visible,.download:hover{border-color:#f0ba78}small{color:#bed1d8}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.card{padding:16px;border:1px solid #44616d;border-radius:12px}.card h3{margin-top:0}
</style></head><body><main><small>COMFYRIZZ / CPU ANIMATION PACK${preview ? ' / WORK-IN-PROGRESS PREVIEW' : ''}</small><h1>Make motion mean something.</h1>${preview ? '<p><strong>Preview build:</strong> visual review and refinements are still in progress. This player will be updated with the polished version.</p>' : ''}<p>Six frame-driven storytelling styles, three reveal transitions, and a complete narrated production. The source package remains editable. Narration uses Kokoro on CPU; phrase timing is estimated from the measured take, not forced alignment.</p>
<video id="player" controls playsinline preload="metadata" src="video.mp4">Your browser does not support HTML video. <a href="video.mp4">Download the MP4.</a></video>
${baseline ? '<nav aria-label="Compare versions"><button data-source="video.mp4">Animation pack</button><button data-source="baseline.mp4">Original layouts · same narration</button></nav>' : ''}
<nav aria-label="Jump to a style">${chapters.map(c => `<button data-seek="${c.seconds}">${esc(c.title)}</button>`).join('')}</nav>
<nav aria-label="Downloads"><a class="download" href="video.mp4" download>Download MP4</a><a class="download" href="package.zip" download>Editable bundle</a><a class="download" href="script.md" download>Narration script</a><a class="download" href="package.json" download>Package settings</a><a class="download" href="verification.json">Technical verification</a></nav>
<div class="grid"><section class="card"><h3>Explain</h3><p>Sketchbook drawing and technical flows turn a sequence of ideas into visible relationships.</p></section><section class="card"><h3>Transform</h3><p>Layered paper and shape morphs add texture and show change with bounded, repeatable geometry.</p></section><section class="card"><h3>Direct attention</h3><p>A focus window and kinetic typography help important information land without adding a second playback clock.</p></section></div>
<p><small>${state.result.frames} frames · ${state.result.fps} fps · ${esc(state.runId)}. Technical verification passed; visual preference remains a human judgment.</small></p><p><a href="/">Open the editor</a> · <a href="/tts-expression/index.html">Voice listening lab</a> · <a href="/animation-licenses.txt">Animation software notices</a></p>
<script>const p=document.querySelector('#player');document.querySelectorAll('[data-seek]').forEach(b=>b.onclick=()=>{p.currentTime=Number(b.dataset.seek);p.play().catch(()=>{})});document.querySelectorAll('[data-source]').forEach(b=>b.onclick=()=>{const t=p.currentTime,playing=!p.paused;p.src=b.dataset.source;p.addEventListener('loadedmetadata',()=>{p.currentTime=Math.min(t,p.duration);if(playing)p.play().catch(()=>{})},{once:true})});</script></main></body></html>`);
writeFileSync(join(out, marker), JSON.stringify({ runId: state.runId, inputHash: state.inputHash }));
const backup = `${out}-previous`;
if (existsSync(target)) renameSync(target, backup);
try { renameSync(out, target); }
catch (error) { if (existsSync(backup)) renameSync(backup, target); throw error; }
if (existsSync(backup)) rmSync(backup, { recursive: true });
console.log(JSON.stringify({ out: target, chapters, baseline, frames: state.result.frames }, null, 2));
