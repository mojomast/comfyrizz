/**
 * Loopback harness for browser e2e. Starts the real server against a temp
 * project dir, then the Vite app with /api forwarded there. CPU only.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture, PACKAGE_ID } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const webPort = 4175;
const apiPort = 4391;
const token = `e2e-${randomBytes(16).toString('hex')}`;
const runtimeDir = join(tmpdir(), `comfyrizz-e2e-${process.pid}`);
const children = [];

function writeProject(fixture) {
  const packages = join(runtimeDir, 'packages');
  const editorDir = join(runtimeDir, 'editor');
  const seed = join(runtimeDir, 'seed');
  const audio = join(packages, 'audio');
  mkdirSync(audio, { recursive: true });
  mkdirSync(editorDir, { recursive: true });
  mkdirSync(seed, { recursive: true });
  mkdirSync(join(runtimeDir, 'out', 'export', PACKAGE_ID), { recursive: true });
  const packageJson = `${JSON.stringify(fixture.package, null, 2)}\n`;
  const editorJson = `${JSON.stringify(fixture.editor, null, 2)}\n`;
  const durationsJson = `${JSON.stringify(fixture.durations, null, 2)}\n`;
  writeFileSync(join(packages, `${PACKAGE_ID}.json`), packageJson);
  writeFileSync(join(editorDir, `${PACKAGE_ID}.json`), editorJson);
  writeFileSync(join(audio, 'durations.json'), durationsJson);
  writeFileSync(join(seed, 'package.json'), packageJson);
  writeFileSync(join(seed, 'editor.json'), editorJson);
  writeFileSync(join(seed, 'durations.json'), durationsJson);
  // A stub so export reuses a file instead of rendering an MP4. Social frames
  // skip a file ffmpeg cannot decode; the zip and timeline are still real.
  writeFileSync(join(runtimeDir, 'out', 'export', PACKAGE_ID, 'video.mp4'), 'not-a-real-mp4\n');
}

function start(command, args, env, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => process.stdout.write(`[${command}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${command}] ${chunk}`));
  child.on('exit', code => {
    if (code && !shuttingDown) {
      console.error(`${command} exited ${code}`);
      shutdown(1);
    }
  });
  children.push(child);
  return child;
}

async function waitFor(url, headers, ready) {
  const deadline = Date.now() + 30000;
  let last = 'not up';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      if (ready(response)) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${url} not ready (${last})`);
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  rmSync(runtimeDir, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const fixture = buildFixture();
rmSync(runtimeDir, { recursive: true, force: true });
writeProject(fixture);
writeFileSync(join(here, '.e2e-env.json'), `${JSON.stringify({
  web: `http://127.0.0.1:${webPort}`,
  api: `http://127.0.0.1:${apiPort}`,
  token,
  packageId: PACKAGE_ID,
  runtimeDir,
}, null, 2)}\n`);

start(process.execPath, ['apps/server/src/index.mjs'], {
  COMFYRIZZ_PORT: String(apiPort),
  COMFYRIZZ_RUNTIME: runtimeDir,
  COMFYRIZZ_TOKEN: token,
}, repoRoot);
await waitFor(
  `http://127.0.0.1:${apiPort}/api/package/${PACKAGE_ID}`,
  { 'x-comfyrizz-token': token, origin: `http://127.0.0.1:${apiPort}` },
  response => response.ok,
);

const webRoot = join(repoRoot, 'apps', 'web');
start(process.execPath, [join(webRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
  COMFYRIZZ_API: `http://127.0.0.1:${apiPort}`,
}, webRoot);
await waitFor(`http://127.0.0.1:${webPort}/`, {}, response => response.ok);
console.log(`e2e ready web=http://127.0.0.1:${webPort} api=http://127.0.0.1:${apiPort}`);
