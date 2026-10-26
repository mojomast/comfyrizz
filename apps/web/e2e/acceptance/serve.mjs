/**
 * UX20 acceptance harness server: the real Comfyrizz server and the Vite app,
 * isolated from `e2e/serve.mjs` (own ports, own runtime directory, own env file).
 *
 * Isolation and fail-closed rules:
 *  - loopback only; the server process preloads qa/lib/egress-preload.mjs, so any
 *    outbound connection (provider, Google Colab, the internet) throws and is
 *    appended to the egress log that every spec checks at teardown;
 *  - the environment handed to child processes is scrubbed of credentials and
 *    Google Colab settings; the session token is generated per run;
 *  - no live service, no paid backend, no GPU. The renderer is the existing CPU
 *    path and only runs if a spec asks for it.
 *
 * Also serves a directory of labelled media (WAV, PNG, MP4) with HTTP Range so
 * Chromium, Firefox and WebKit decode the same bytes.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildFixture, PACKAGE_ID } from '../fixture.mjs';
import { scrubbedEnv } from '../../../../qa/lib/egress-guard.mjs';
import { writeMediaSet } from '../../../../qa/lib/media-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const webRoot = join(repoRoot, 'apps', 'web');
const webPort = Number(process.env.QA_WEB_PORT ?? 4276);
const apiPort = Number(process.env.QA_API_PORT ?? 4492);
const mediaPort = Number(process.env.QA_MEDIA_PORT ?? 4493);
const token = `qa-${randomBytes(16).toString('hex')}`;
const runtimeDir = join(tmpdir(), `comfyrizz-qa-browser-${process.pid}`);
const mediaDir = join(runtimeDir, 'labelled-media');
const egressLog = join(runtimeDir, 'egress.jsonl');
const outputDir = join(here, '..', '.output');
const envFile = join(outputDir, 'acceptance-env.json');
const children = [];
let shuttingDown = false;

export const MEDIA_LABELS = ['take-intro-a', 'take-intro-b', 'take-outro-a', 'shot-1-plate', 'shot-2-plate'];

function writeProject(fixture) {
  const packages = join(runtimeDir, 'packages');
  const audio = join(packages, 'audio');
  const editorDir = join(runtimeDir, 'editor');
  const seed = join(runtimeDir, 'seed');
  for (const dir of [audio, editorDir, seed, join(runtimeDir, 'out', 'export', PACKAGE_ID)]) mkdirSync(dir, { recursive: true });
  const json = value => `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(join(packages, `${PACKAGE_ID}.json`), json(fixture.package));
  writeFileSync(join(editorDir, `${PACKAGE_ID}.json`), json(fixture.editor));
  writeFileSync(join(audio, 'durations.json'), json(fixture.durations));
  writeFileSync(join(seed, 'package.json'), json(fixture.package));
  writeFileSync(join(seed, 'editor.json'), json(fixture.editor));
  writeFileSync(join(seed, 'durations.json'), json(fixture.durations));
  writeFileSync(join(runtimeDir, 'out', 'export', PACKAGE_ID, 'video.mp4'), 'not-a-real-mp4\n');
  writeFileSync(egressLog, '');
}

function relay(child, name) {
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    createInterface({ input: stream }).on('line', line => output.write(`[${name}] ${line.replaceAll(token, '[redacted]')}\n`));
  }
  child.on('exit', code => {
    if (code && !shuttingDown) { console.error(`${name} exited ${code}`); shutdown(1); }
  });
  children.push(child);
}

async function waitFor(url, headers, ready) {
  const deadline = Date.now() + 40000;
  let last = 'not up';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      if (ready(response)) return;
      last = `HTTP ${response.status}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${url} not ready (${last})`);
}

const TYPES = { '.wav': 'audio/wav', '.png': 'image/png', '.mp4': 'video/mp4', '.html': 'text/html; charset=utf-8' };
function serveMedia() {
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').split('?')[0].replace(/^\/+/, ''));
    const file = join(mediaDir, name);
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('cross-origin-resource-policy', 'cross-origin');
    response.setHeader('accept-ranges', 'bytes');
    try {
      if (name.includes('..') || name.includes('/')) throw new Error('outside media root');
      const { size } = statSync(file);
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
      if (range) {
        const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
        const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(size - 1, Number(range[2]));
        response.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
        createReadStream(file, { start, end }).pipe(response);
      } else {
        response.writeHead(200, { 'content-type': type, 'content-length': size });
        createReadStream(file).pipe(response);
      }
    } catch {
      response.writeHead(404); response.end('not found');
    }
  });
  return new Promise(resolve => server.listen(mediaPort, '127.0.0.1', () => resolve(server)));
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  rmSync(runtimeDir, { recursive: true, force: true });
  rmSync(envFile, { force: true });
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

rmSync(runtimeDir, { recursive: true, force: true });
writeProject(buildFixture());
const media = writeMediaSet(mediaDir, MEDIA_LABELS, { video: true, audioSeconds: 3 });
writeFileSync(join(mediaDir, 'blank.html'), '<!doctype html><meta charset="utf-8"><title>QA media probe</title><p>labelled media probe page</p>\n');
const mediaServer = await serveMedia();
mediaServer.unref();

const clean = scrubbedEnv(process.env, {
  COMFYRIZZ_PORT: String(apiPort),
  COMFYRIZZ_RUNTIME: runtimeDir,
  COMFYRIZZ_TOKEN: token,
  NODE_OPTIONS: `--import ${join(repoRoot, 'qa', 'lib', 'egress-preload.mjs')}`,
  QA_EGRESS_LOG: egressLog,
  QA_EGRESS_LABEL: 'acceptance-server',
});

mkdirSync(outputDir, { recursive: true });
writeFileSync(envFile, `${JSON.stringify({
  web: `http://127.0.0.1:${webPort}`,
  api: `http://127.0.0.1:${apiPort}`,
  mediaBase: `http://127.0.0.1:${mediaPort}`,
  token,
  packageId: PACKAGE_ID,
  runtimeDir,
  egressLog,
  scrubbedEnvNames: clean.removed,
  media: Object.fromEntries(Object.entries(media).map(([label, entry]) => [label, {
    id: entry.id,
    png: `${label}.png`,
    wav: `${label}.wav`,
    mp4: entry.mp4 ? `${entry.id}.mp4` : null,
    mp4Skipped: entry.mp4Skipped,
  }])),
}, null, 2)}\n`, { mode: 0o600 });

const server = spawn(process.execPath, ['apps/server/src/index.mjs'], { cwd: repoRoot, env: clean.env, stdio: ['ignore', 'pipe', 'pipe'] });
relay(server, 'qa-server');
await waitFor(`http://127.0.0.1:${apiPort}/api/package/${PACKAGE_ID}`, { 'x-comfyrizz-token': token, origin: `http://127.0.0.1:${apiPort}` }, response => response.ok);

const vite = spawn(process.execPath, [join(webRoot, 'node_modules/vite/bin/vite.js'), '--config', join(here, 'vite.acceptance.config.ts'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
  cwd: webRoot,
  env: { ...clean.env, NODE_OPTIONS: '', COMFYRIZZ_API: `http://127.0.0.1:${apiPort}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
relay(vite, 'qa-vite');
await waitFor(`http://127.0.0.1:${webPort}/`, {}, response => response.ok);
console.log(`acceptance ready web=http://127.0.0.1:${webPort} api=http://127.0.0.1:${apiPort} media=http://127.0.0.1:${mediaPort}`);
