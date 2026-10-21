// Private pilot delivery. Usage: node nrcu-pilot-player.mjs PRODUCTION_DIR [4194]
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2], 'final');
const report = JSON.parse(readFileSync(join(root, 'verification.json')));
const film = JSON.parse(readFileSync(join(root, '../film.json')));
const files = new Map();
for (const [name, expected] of [
  ['hermes-the-lower-road-1080p.mp4', report],
  ['hermes-the-lower-road-small.mp4', report.compact],
]) {
  const path = join(root, name);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== expected.sha256 || statSync(path).size !== expected.bytes) throw new Error('Unverified export: ' + name);
  files.set('/' + name, [path, 'video/mp4']);
}
files.set('/captions.vtt', [join(root, 'captions.vtt'), 'text/vtt; charset=utf-8']);
files.set('/captions.srt', [join(root, 'captions.srt'), 'text/plain; charset=utf-8']);
const mb = bytes => (bytes / 1e6).toFixed(1);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hermes · The Lower Road</title><style>
body{margin:0;background:#0b141b;color:#e8edf0;font:17px/1.55 system-ui,sans-serif}main{max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:clamp(32px,5vw,56px);line-height:1.1}.label{color:#8ccdd0;letter-spacing:2px;font-size:12px}video{width:100%;background:#000;border-radius:10px}p{color:#bbc6d1}a{color:#ffca79}.links{display:flex;gap:18px;flex-wrap:wrap}.note{font-size:14px}</style></head><body><main>
<p class="label">HERMES: THE UNFINISHED DAWN / PILOT</p><h1>The Lower Road</h1><p>Winning the part. Or bringing everyone home.</p>
<video controls playsinline preload="metadata" src="hermes-the-lower-road-small.mp4?v=${report.compact.sha256.slice(0,8)}"><track kind="captions" src="captions.vtt?v=${report.compact.sha256.slice(0,8)}" srclang="en" label="English"></video>
<p>${film.seconds} seconds · ${film.shots.length} shots · 24 fps · Native FastH3 Omni motion and dialogue</p>
${film.edition === 'Rock recut v2' ? '<p>Rock recut · tighter action edit · original 144 BPM guitar, bass and drums</p>' : ''}
<p class="links"><a href="hermes-the-lower-road-small.mp4" download>Download · ${mb(report.compact.bytes)} MB</a><a href="hermes-the-lower-road-1080p.mp4" download>1080p master · ${mb(report.bytes)} MB</a><a href="captions.srt" download>Captions</a></p>
<p>Don Piedro chooses the lower road to rescue two stranded workers, while his rival Molty seizes the regulator.</p>
<p class="note">An unofficial fictional adaptation. Original synthetic performances and score. Reviewed with speech transcription and temporal frame samples; normal-speed listening review is pending.</p>
<p><a href="https://mail.tailec998.ts.net:8451/nrcu-pilot/index.html">Production references and raw takes</a> · <a href="https://mail.tailec998.ts.net:8451/">ComfyRizz</a></p>
</main></body></html>`;

createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }
  const entry = files.get(pathname);
  if (!entry) { res.writeHead(404); return res.end(); }
  const size = statSync(entry[0]).size;
  let start = 0, end = size - 1, status = 200;
  const invalid = () => { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); };
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1] && !m[2])) return invalid();
    if (!m[1]) { if (Number(m[2]) <= 0) return invalid(); start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return invalid();
    status = 206;
  }
  res.writeHead(status, { 'Content-Type': entry[1], 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff', ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(entry[0], { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}).listen(Number(process.argv[3] || 4194), '127.0.0.1', () => console.log('NRCU pilot player ready'));
