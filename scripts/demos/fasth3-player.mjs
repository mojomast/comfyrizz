// Private/local review player. Usage: node fasth3-player.mjs <production-directory> [port]
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2]);
const port = Number(process.argv[3] || 4193);
const clips = [
  ['s01', 'Nell — the investigation', '8-second reporter shot.'],
  ['s04', 'Ivo — Graphite Processing Unit', 'Engineer and pencil-tin demonstration.'],
  ['s03', 'Ada — meet the hardware', 'Raw painter take. The extra speech near the end has been removed from the finished short.'],
];
const files = new Map();
for (const [id] of clips) {
  const movie = join(root, 'outputs', id + '.mp4');
  const receipt = JSON.parse(readFileSync(join(root, 'outputs', id + '.json')));
  const hash = createHash('sha256').update(readFileSync(movie)).digest('hex');
  if (receipt.status !== 'succeeded' || hash !== receipt.sha256) throw new Error('Unverified clip: ' + id);
  files.set('/' + id + '.mp4', [movie, 'video/mp4']);
}
const html = () => {
  const final = existsSync(join(root, 'final/verification.json'));
  const small = final && existsSync(join(root, 'final/small-verification.json'));
  if (small) files.set('/gpu-artists-small.mp4', [join(root, 'final/gpu-artists-small.mp4'), 'video/mp4']);
  if (final) {
    files.set('/gpu-artists-1080p.mp4', [join(root, 'final/gpu-artists-1080p.mp4'), 'video/mp4']);
    files.set('/captions.srt', [join(root, 'final/captions.srt'), 'text/plain; charset=utf-8']);
    files.set('/captions.vtt', [join(root, 'final/captions.vtt'), 'text/vtt; charset=utf-8']);
  }
  const feature = final
    ? `<section><h2>The four-minute short</h2><video controls playsinline preload="metadata" src="${small ? 'gpu-artists-small.mp4' : 'gpu-artists-1080p.mp4'}"><track kind="captions" src="captions.vtt" srclang="en" label="English"></video><p>${small ? '<a href="gpu-artists-small.mp4" download>Download · 63 MB</a> · ' : ''}<a href="gpu-artists-1080p.mp4" download>1080p master · 149 MB</a> · <a href="captions.srt" download>Captions</a></p></section>`
    : '<p>The four-minute short is in production. These are raw reference-conditioned test clips at 1344×768 / 24 fps, with FastH3-generated speech and sound.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU Artists — FastH3 Omni</title><style>body{margin:0;background:#121b20;color:#eee9dc;font:17px/1.55 system-ui,sans-serif}main{max-width:1050px;margin:40px auto;padding:0 22px}h1{font-size:clamp(30px,5vw,48px);line-height:1.1}.label{color:#e9b856;letter-spacing:2px;font-size:12px}video{width:100%;max-height:70vh;background:#000;border-radius:10px}section{margin:38px 0}p{color:#b9c4c8}a{color:#e9b856}h2{margin-bottom:8px}</style></head><body><main><div class="label">COMFYRIZZ / FASTH3 OMNI</div><h1>GPU: Graphite Processing Unit</h1>${feature}${clips.map(([id,title,description])=>`<section><h2>${title}</h2><p>${description}</p><video controls playsinline preload="metadata" src="${id}.mp4"></video><p><a href="${id}.mp4" download>Download this test clip</a></p></section>`).join('')}</main></body></html>`;
};
createServer((req,res)=>{
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  const pathname = new URL(req.url,'http://localhost').pathname;
  if (pathname === '/') {
    const body=html(); res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'});
    return res.end(req.method==='HEAD'?undefined:body);
  }
  html(); // Register a newly finished export even for a direct download request.
  const entry=files.get(pathname);
  if (!entry) { res.writeHead(404); return res.end(); }
  let size;
  try { size=statSync(entry[0]).size; } catch { res.writeHead(404); return res.end(); }
  let start=0,end=size-1,status=200;
  const invalid=()=>{res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();};
  if (req.headers.range) {
    const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1]&&!m[2])) return invalid();
    if (!m[1]) { if (Number(m[2])<=0)return invalid(); start=Math.max(0,size-Number(m[2])); }
    else { start=Number(m[1]); if(m[2])end=Math.min(end,Number(m[2])); }
    if (!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size) return invalid();
    status=206;
  }
  res.writeHead(status,{'Content-Type':entry[1],'Content-Length':end-start+1,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff',...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
  if(req.method==='HEAD')return res.end();
  const stream=createReadStream(entry[0],{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}).listen(port,'127.0.0.1',()=>console.log('FastH3 review player listening on localhost:'+port));
